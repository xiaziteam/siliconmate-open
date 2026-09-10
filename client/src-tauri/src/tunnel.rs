//! 硅侣3.0 — 隧道管理 (统一daemon模式)
//!
//! 不再自己spawn sing-box，改为探测统一隧道daemon是否就绪
//! daemon由launchd管理，监听多端口: 18081(虾壳) 18082(硅侣) 18083(闲鱼) 18080(HTTP) 18085(PAC)
//!
//! 流程: login → probe_daemon → 设系统PAC(http://127.0.0.1:18085/proxy.pac) → Safari/浏览器

use account_client::TunnelConfig;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const SILICONMATE_PORT: u16 = 18082;
pub const DAEMON_PAC_URL: &str = "http://127.0.0.1:18085/proxy.pac";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TunnelStatus {
    Stopped,
    Running { port: u16 },
    Error(String),
}

pub struct TunnelManager {
    pub process: Mutex<Option<std::process::Child>>, // 保留接口兼容，不再使用
    pub status: Mutex<TunnelStatus>,
    config_path: Mutex<Option<String>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            status: Mutex::new(TunnelStatus::Stopped),
            config_path: Mutex::new(None),
        }
    }

    pub fn get_proxy_url_if_running(&self) -> Option<String> {
        let st = self.status.lock().unwrap();
        match &*st {
            TunnelStatus::Running { port } => Some(format!("socks5://127.0.0.1:{}", port)),
            _ => None,
        }
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Probe统一daemon端口是否就绪(不再自己spawn sing-box)
pub fn start_tunnel_internal(
    manager: &TunnelManager,
    _config: TunnelConfig, // 保留参数兼容，实际由daemon管理
) -> Result<u16, String> {
    let mut status = manager.status.lock().unwrap();

    if matches!(&*status, TunnelStatus::Running { .. }) {
        return Ok(SILICONMATE_PORT);
    }

    // 探测daemon SOCKS5端口
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", SILICONMATE_PORT).parse().unwrap();
    match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3)) {
        Ok(_) => {
            eprintln!("[tunnel] Daemon SOCKS5 on :{} is ready", SILICONMATE_PORT);
            *status = TunnelStatus::Running { port: SILICONMATE_PORT };
            Ok(SILICONMATE_PORT)
        }
        Err(e) => {
            let msg = format!(
                "隧道daemon未运行(端口:{}无法连接)。请先启动: launchctl load ~/Library/LaunchAgents/com.shrimp.tunnel.plist (错误: {})",
                SILICONMATE_PORT, e
            );
            eprintln!("[tunnel] {}", msg);
            *status = TunnelStatus::Error(msg.clone());
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn start_tunnel(
    manager: tauri::State<'_, TunnelManager>,
    config: TunnelConfig,
) -> Result<String, String> {
    let port = start_tunnel_internal(&manager, config)?;

    // 设系统PAC代理(指向daemon的HTTP PAC serve)
    set_system_proxy_for_chatgpt(true, port);

    Ok(format!("隧道已就绪, SOCKS5代理: 127.0.0.1:{}", port))
}

#[tauri::command]
pub fn stop_tunnel(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<(), String> {
    let mut status = manager.status.lock().unwrap();

    // 不再kill sing-box(daemon是独立进程)
    // 只清理系统代理设置
    set_system_proxy_for_chatgpt(false, SILICONMATE_PORT);
    *status = TunnelStatus::Stopped;

    eprintln!("[tunnel] Proxy disabled (daemon keeps running)");
    Ok(())
}

#[tauri::command]
pub fn tunnel_status(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<TunnelStatus, String> {
    Ok(manager.status.lock().unwrap().clone())
}

#[tauri::command]
pub fn get_proxy_url(
    manager: tauri::State<'_, TunnelManager>,
) -> Result<Option<String>, String> {
    let status = manager.status.lock().unwrap();
    match &*status {
        TunnelStatus::Running { port } => {
            Ok(Some(format!("socks5://127.0.0.1:{}", port)))
        }
        _ => Ok(None),
    }
}

// ============================================================================
// 系统代理设置
// ============================================================================

#[cfg(target_os = "macos")]
fn get_all_network_services() -> Vec<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .skip(1) // 第一行是标题
                .filter(|l| !l.starts_with('*') && !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .collect()
        }
        _ => vec!["Wi-Fi".into()],
    }
}

#[cfg(not(target_os = "macos"))]
fn get_all_network_services() -> Vec<String> {
    vec![]
}

#[cfg(target_os = "macos")]
fn get_auto_proxy_url(service: &str) -> Option<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-getautoproxyurl", service])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.starts_with("URL:") {
            let url = line[4..].trim();
            if !url.is_empty() && url != "(null)" {
                return Some(url.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn get_socks_proxy(service: &str) -> Option<(bool, String, u16)> {
    let output = std::process::Command::new("networksetup")
        .args(["-getsocksfirewallproxy", service])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = String::new();
    let mut port: u16 = 0;
    for line in text.lines() {
        if line.starts_with("Enabled:") {
            enabled = line[8..].trim() == "Yes";
        } else if line.starts_with("Server:") {
            server = line[7..].trim().to_string();
        } else if line.starts_with("Port:") {
            port = line[5..].trim().parse().unwrap_or(0);
        }
    }
    if !server.is_empty() && port > 0 {
        Some((enabled, server, port))
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn cleanup_leftover_proxy() {
    for service in get_all_network_services() {
        if let Some(ref url) = get_auto_proxy_url(&service) {
            if url.contains("siliconmate-tunnel") || url.contains("shrimp-tunnel") {
                eprintln!("[proxy] Found leftover PAC proxy on {} from previous session, cleaning up", service);
                let _ = std::process::Command::new("networksetup")
                    .args(["-setautoproxyurl", &service, ""])
                    .output();
                let _ = std::process::Command::new("networksetup")
                    .args(["-setautoproxystate", &service, "off"])
                    .output();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn cleanup_leftover_proxy() {}

pub fn set_system_proxy_for_chatgpt(enable: bool, _socks_port: u16) {
    #[cfg(target_os = "macos")]
    {
        let services = get_all_network_services();
        if services.is_empty() {
            eprintln!("[proxy] No network services found");
            return;
        }

        if enable {
            // Save current proxy settings first (per-service)
            let mut saved_auto = SAVED_AUTO_PROXY_URL.lock().unwrap();
            let mut saved_socks = SAVED_SOCKS_PROXY.lock().unwrap();
            // 只取第一个service的保存值(简化)
            if saved_auto.is_none() {
                *saved_auto = get_auto_proxy_url(&services[0]);
            }
            if saved_socks.is_none() {
                *saved_socks = get_socks_proxy(&services[0]);
            }

            // 设PAC到所有活跃network service — 用daemon的HTTP PAC serve
            for service in &services {
                let _ = std::process::Command::new("networksetup")
                    .args(["-setautoproxyurl", service, DAEMON_PAC_URL])
                    .output();
                let _ = std::process::Command::new("networksetup")
                    .args(["-setautoproxystate", service, "on"])
                    .output();
                // 关闭手动SOCKS5(避免跟PAC冲突)
                let _ = std::process::Command::new("networksetup")
                    .args(["-setsocksfirewallproxystate", service, "off"])
                    .output();
            }

            // 验证第一个service
            if let Ok(verify) = std::process::Command::new("networksetup")
                .args(["-getautoproxyurl", &services[0]])
                .output()
            {
                let text = String::from_utf8_lossy(&verify.stdout);
                if !text.contains("127.0.0.1:18085") {
                    eprintln!("[proxy] WARNING: PAC URL verification failed: {}", text.trim());
                }
            }

            eprintln!("[proxy] PAC proxy enabled on {} services (URL: {})", services.len(), DAEMON_PAC_URL);
        } else {
            // 恢复原始代理设置
            let saved_auto = SAVED_AUTO_PROXY_URL.lock().unwrap().take();
            let saved_socks = SAVED_SOCKS_PROXY.lock().unwrap().take();

            for service in &services {
                // 恢复auto proxy
                match &saved_auto {
                    Some(url) if !url.is_empty() => {
                        let _ = std::process::Command::new("networksetup")
                            .args(["-setautoproxyurl", service, url])
                            .output();
                    }
                    _ => {
                        let _ = std::process::Command::new("networksetup")
                            .args(["-setautoproxyurl", service, ""])
                            .output();
                        let _ = std::process::Command::new("networksetup")
                            .args(["-setautoproxystate", service, "off"])
                            .output();
                    }
                }

                // 恢复SOCKS proxy
                if let Some((enabled, host, port)) = &saved_socks {
                    let _ = std::process::Command::new("networksetup")
                        .args(["-setsocksfirewallproxy", service, host, &port.to_string()])
                        .output();
                    let state = if *enabled { "on" } else { "off" };
                    let _ = std::process::Command::new("networksetup")
                        .args(["-setsocksfirewallproxystate", service, state])
                        .output();
                }
            }

            eprintln!("[proxy] PAC proxy disabled, original settings restored");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (enable, _socks_port);
    }
}

// 保留兼容性：旧的常量和函数签名
static SAVED_AUTO_PROXY_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static SAVED_SOCKS_PROXY: std::sync::Mutex<Option<(bool, String, u16)>> = std::sync::Mutex::new(None);

// 保留find_singbox_binary用于兼容(不再实际使用)
pub fn find_singbox_binary() -> Option<String> {
    let candidates = if cfg!(target_os = "macos") {
        vec!["/usr/local/bin/sing-box", "/opt/homebrew/bin/sing-box"]
    } else {
        vec!["/usr/bin/sing-box", "/usr/local/bin/sing-box"]
    };
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}
