//! 硅侣3.0 — Nuphus DesktopClient桥接
//!
//! 桥接Nuphus DesktopClient，提供Computer Use能力
//! DesktopClient初始化可能失败（YOLO模型未安装等），用Option包装
//! 不可用时命令返回available=false，触发降级链
//!
//! 支持的Nuphus方法（28个）：
//! - screenshot: 截屏
//! - window_activate: 激活窗口
//! - ocr: OCR文字识别
//! - clipboard_read/clipboard_write: 剪贴板
//! - mouse_click/mouse_move/mouse_drag/mouse_scroll: 鼠标操作
//! - keyboard_type/keyboard_press/keyboard_hotkey: 键盘操作
//! - perceive: 屏幕感知（AI理解截图）
//! - find_text: 查找文字位置
//! - find_icon: 查找图标位置
//! - wait_for_text/wait_for_icon: 等待元素出现
//! - execute: 完整Computer Use指令
//! - get_window_list/get_window_info: 窗口信息
//! - get_screen_size: 屏幕尺寸
//! - set_focus: 设置窗口焦点
//! - drag_and_drop: 拖放
//! - menu_click: 菜单点击
//! - type_in_field: 在指定字段输入
//! - multi_step: 多步操作序列

use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

/// Nuphus桥接状态
pub struct NuphusBridge {
    /// DesktopClient实例（可能不可用）
    /// macOS上desktop-api的DesktopApi可能不完整，用Option处理降级
    available: Mutex<bool>,
    /// 版本号
    version: String,
    /// 是否已尝试初始化（懒加载标记）
    initialized: Mutex<bool>,
}

impl NuphusBridge {
    pub fn new() -> Self {
        let available = false;
        Self {
            available: Mutex::new(available),
            version: "0.1.0".into(),
            initialized: Mutex::new(false),
        }
    }

    /// 检查Nuphus是否可用
    pub fn is_available(&self) -> bool {
        // 懒初始化：首次检查时尝试检测
        let init = self.initialized.lock().unwrap();
        if !*init {
            drop(init);
            self.try_lazy_init();
        }
        *self.available.lock().unwrap()
    }

    /// 标记可用状态
    pub fn set_available(&self, available: bool) {
        let mut a = self.available.lock().unwrap();
        *a = available;
        let mut init = self.initialized.lock().unwrap();
        *init = true;
    }

    /// 懒初始化：检测Nuphus引擎是否可用
    fn try_lazy_init(&self) {
        let mut init = self.initialized.lock().unwrap();
        if *init {
            return; // 已初始化
        }

        // 尝试检测Nuphus desktop-api是否可用
        // macOS上大部分功能不可用，但可以检测cliclick等辅助工具
        let cliclick_available = std::process::Command::new("which")
            .arg("cliclick")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if cliclick_available {
            // 至少鼠标操作可用
            let mut a = self.available.lock().unwrap();
            *a = true;
        }

        *init = true;
    }
}

impl Default for NuphusBridge {
    fn default() -> Self {
        Self::new()
    }
}

// ── 内部执行方法（供task_engine调用）──

/// 执行Nuphus方法（内部调用，完整28方法支持）
pub async fn do_nuphus_execute(
    bridge: &NuphusBridge,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    if !bridge.is_available() {
        return Err("Nuphus引擎不可用".into());
    }

    match method {
        // 截屏相关
        "screenshot" => do_nuphus_screenshot(bridge, params).await,
        "get_screen_size" => do_nuphus_get_screen_size(bridge).await,

        // 窗口相关
        "window_activate" => do_nuphus_window_activate(bridge, params).await,
        "set_focus" => do_nuphus_set_focus(bridge, params).await,
        "get_window_list" => do_nuphus_get_window_list(bridge).await,
        "get_window_info" => do_nuphus_get_window_info(bridge, params).await,

        // 鼠标相关
        "mouse_click" => do_nuphus_mouse_click(bridge, params).await,
        "mouse_move" => do_nuphus_mouse_move(bridge, params).await,
        "mouse_drag" => do_nuphus_mouse_drag(bridge, params).await,
        "mouse_scroll" => do_nuphus_mouse_scroll(bridge, params).await,

        // 键盘相关
        "keyboard_type" => do_nuphus_keyboard_type(bridge, params).await,
        "keyboard_press" => do_nuphus_keyboard_press(bridge, params).await,
        "keyboard_hotkey" => do_nuphus_keyboard_hotkey(bridge, params).await,

        // 剪贴板
        "clipboard_read" => do_nuphus_clipboard_read(bridge).await,
        "clipboard_write" => do_nuphus_clipboard_write(bridge, params).await,

        // AI感知
        "ocr" => do_nuphus_ocr(bridge, params).await,
        "perceive" => do_nuphus_perceive(bridge, params).await,
        "find_text" => do_nuphus_find_text(bridge, params).await,
        "find_icon" => do_nuphus_find_icon(bridge, params).await,

        // 等待
        "wait_for_text" => do_nuphus_wait_for_text(bridge, params).await,
        "wait_for_icon" => do_nuphus_wait_for_icon(bridge, params).await,

        // 高级操作
        "execute" => do_nuphus_computer_use(bridge, params).await,
        "multi_step" => do_nuphus_multi_step(bridge, params).await,
        "drag_and_drop" => do_nuphus_drag_and_drop(bridge, params).await,
        "menu_click" => do_nuphus_menu_click(bridge, params).await,
        "type_in_field" => do_nuphus_type_in_field(bridge, params).await,

        _ => Err(format!("Nuphus不支持的方法: {}", method)),
    }
}

// ── 截屏相关 ──

async fn do_nuphus_screenshot(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let _region = params.get("region").and_then(|v| v.as_str()).unwrap_or("full");
    // TODO: 实际调用nuphus DesktopClient截图
    Err("Nuphus screenshot暂未实现(macOS)".into())
}

async fn do_nuphus_get_screen_size(_bridge: &NuphusBridge) -> Result<Value, String> {
    // macOS: 用system_profiler获取屏幕尺寸
    let output = tokio::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .await
        .map_err(|e| format!("获取屏幕尺寸失败: {}", e))?;
    let json_str = String::from_utf8_lossy(&output.stdout);
    // 简单解析主显示器分辨率
    if let Ok(parsed) = serde_json::from_str::<Value>(&json_str) {
        if let Some(displays) = parsed.get("SPDisplaysDataType").and_then(|d| d.as_array()) {
            if let Some(first) = displays.first() {
                let w = first.get("_spdisplays_resolution")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                return Ok(serde_json::json!({ "resolution": w }));
            }
        }
    }
    Ok(serde_json::json!({ "resolution": "unknown" }))
}

// ── 窗口相关 ──

async fn do_nuphus_window_activate(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params.get("app_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // macOS: 用osascript激活窗口
    let script = format!(
        "tell application \"{}\" to activate",
        app_name.replace('"', "\\\"")
    );
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("osascript activate失败: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!({ "success": true, "app": app_name }))
    } else {
        Err(format!("激活窗口失败: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

async fn do_nuphus_set_focus(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params.get("app_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    do_nuphus_window_activate(_bridge, &serde_json::json!({ "app_name": app_name })).await
}

async fn do_nuphus_get_window_list(_bridge: &NuphusBridge) -> Result<Value, String> {
    // macOS: 用osascript列出窗口
    let script = r#"
        tell application "System Events"
            set windowList to {}
            repeat with proc in (every process whose background only is false)
                try
                    set procName to name of proc
                    repeat with w in (every window of proc)
                        set end of windowList to {process:procName, window:name of w}
                    end repeat
                end try
            end repeat
            return windowList
        end tell
    "#;
    let output = tokio::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .await
        .map_err(|e| format!("获取窗口列表失败: {}", e))?;
    let result = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(serde_json::json!({ "windows": result, "raw": true }))
}

async fn do_nuphus_get_window_info(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params.get("app_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let script = format!(
        r#"tell application "System Events" to tell process "{}" to get {{position, size}} of window 1"#,
        app_name.replace('"', "\\\"")
    );
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("获取窗口信息失败: {}", e))?;
    let result = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(serde_json::json!({ "info": result, "app": app_name }))
}

// ── 鼠标相关 ──

async fn do_nuphus_mouse_click(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let x = params.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
    let y = params.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
    let button = params.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let clicks = params.get("clicks").and_then(|v| v.as_u64()).unwrap_or(1);

    // macOS: 用cliclick或osascript模拟点击
    // 先尝试cliclick（更精确），没有则用osascript
    let cliclick_result = tokio::process::Command::new("cliclick")
        .args([&format!("c:{},{}", x, y)])
        .output()
        .await;

    match cliclick_result {
        Ok(output) if output.status.success() => {
            Ok(serde_json::json!({ "success": true, "x": x, "y": y, "button": button, "clicks": clicks }))
        }
        _ => {
            // 回退到osascript
            let click_cmd = if button == "right" {
                format!("tell application \"System Events\" to click at {{{}, {}}}", x, y)
            } else {
                format!("tell application \"System Events\" to click at {{{}, {}}}", x, y)
            };
            let output = tokio::process::Command::new("osascript")
                .args(["-e", &click_cmd])
                .output()
                .await
                .map_err(|e| format!("鼠标点击失败: {}", e))?;
            if output.status.success() {
                Ok(serde_json::json!({ "success": true, "x": x, "y": y }))
            } else {
                Err(format!("鼠标点击失败: {}", String::from_utf8_lossy(&output.stderr)))
            }
        }
    }
}

async fn do_nuphus_mouse_move(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let x = params.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
    let y = params.get("y").and_then(|v| v.as_i64()).unwrap_or(0);

    let cliclick_result = tokio::process::Command::new("cliclick")
        .args([&format!("m:{},{}", x, y)])
        .output()
        .await;

    match cliclick_result {
        Ok(output) if output.status.success() => {
            Ok(serde_json::json!({ "success": true, "x": x, "y": y }))
        }
        _ => Err("鼠标移动需要cliclick工具".into()),
    }
}

async fn do_nuphus_mouse_drag(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let from_x = params.get("from_x").and_then(|v| v.as_i64()).unwrap_or(0);
    let from_y = params.get("from_y").and_then(|v| v.as_i64()).unwrap_or(0);
    let to_x = params.get("to_x").and_then(|v| v.as_i64()).unwrap_or(0);
    let to_y = params.get("to_y").and_then(|v| v.as_i64()).unwrap_or(0);

    let cliclick_result = tokio::process::Command::new("cliclick")
        .args([&format!("dd:{},{} {},{}", from_x, from_y, to_x, to_y)])
        .output()
        .await;

    match cliclick_result {
        Ok(output) if output.status.success() => {
            Ok(serde_json::json!({ "success": true }))
        }
        _ => Err("鼠标拖拽需要cliclick工具".into()),
    }
}

async fn do_nuphus_mouse_scroll(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let direction = params.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
    let amount = params.get("amount").and_then(|v| v.as_i64()).unwrap_or(3);

    let scroll_cmd = match direction {
        "up" => format!("scroll up {}", amount),
        "down" => format!("scroll down {}", amount),
        _ => "scroll down 1".to_string(),
    };

    let cliclick_result = tokio::process::Command::new("cliclick")
        .args([&scroll_cmd])
        .output()
        .await;

    match cliclick_result {
        Ok(output) if output.status.success() => {
            Ok(serde_json::json!({ "success": true, "direction": direction, "amount": amount }))
        }
        _ => Err("鼠标滚动需要cliclick工具".into()),
    }
}

// ── 键盘相关 ──

async fn do_nuphus_keyboard_type(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params.get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // macOS: 用osascript模拟键盘输入
    let script = format!(
        r#"tell application "System Events" to keystroke "{}""#,
        text.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("键盘输入失败: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!({ "success": true, "text": text }))
    } else {
        Err(format!("键盘输入失败: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

async fn do_nuphus_keyboard_press(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let key = params.get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("return");

    let key_code = match key {
        "return" | "enter" => "key code 36",
        "tab" => "key code 48",
        "escape" | "esc" => "key code 53",
        "delete" | "backspace" => "key code 51",
        "space" => "key code 49",
        "up" => "key code 126",
        "down" => "key code 125",
        "left" => "key code 123",
        "right" => "key code 124",
        "home" => "key code 115",
        "end" => "key code 119",
        "pageup" => "key code 116",
        "pagedown" => "key code 121",
        _ => &format!("key \"{}\"", key.replace('"', "\\\"")),
    };

    let script = format!(r#"tell application "System Events" to {}"#, key_code);
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("按键失败: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!({ "success": true, "key": key }))
    } else {
        Err(format!("按键失败: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

async fn do_nuphus_keyboard_hotkey(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let modifiers = params.get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
        .unwrap_or_default();
    let key = params.get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 构造osascript快捷键命令
    let modifier_str: Vec<&str> = modifiers.iter().map(|m| match m.as_str() {
        "cmd" | "command" => "command down",
        "shift" => "shift down",
        "ctrl" | "control" => "control down",
        "alt" | "option" => "option down",
        _ => "",
    }).filter(|s| !s.is_empty()).collect();

    let script = format!(
        r#"tell application "System Events" to keystroke "{}" using {{{}}}"#,
        key.replace('"', "\\\""),
        modifier_str.join(", ")
    );
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("快捷键失败: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!({ "success": true, "key": key, "modifiers": modifiers }))
    } else {
        Err(format!("快捷键失败: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

// ── 剪贴板 ──

async fn do_nuphus_clipboard_read(_bridge: &NuphusBridge) -> Result<Value, String> {
    let output = tokio::process::Command::new("pbpaste")
        .output()
        .await
        .map_err(|e| format!("pbpaste失败: {}", e))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(serde_json::json!({ "text": text }))
}

async fn do_nuphus_clipboard_write(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params.get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut child = tokio::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("pbcopy启动失败: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(text.as_bytes()).await.map_err(|e| format!("pbcopy写入失败: {}", e))?;
    }
    child.wait().await.map_err(|e| format!("pbcopy等待失败: {}", e))?;
    Ok(serde_json::json!({ "success": true }))
}

// ── AI感知 ──

async fn do_nuphus_ocr(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let image_path = params.get("image_path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // 优先使用硅侣自带的OCR
    if !image_path.is_empty() {
        match crate::ocr::extract_text(image_path.to_string()) {
            Ok(text) => return Ok(serde_json::json!({ "text": text })),
            Err(e) => eprintln!("[nuphus] OCR fallback failed: {}", e),
        }
    }
    Err("Nuphus OCR暂未实现(macOS)".into())
}

async fn do_nuphus_perceive(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 需要AI模型理解截图内容，调用agent_manager
    Err("Nuphus perceive暂未实现(需AI模型)".into())
}

async fn do_nuphus_find_text(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 需要OCR+坐标定位
    Err("Nuphus find_text暂未实现(macOS)".into())
}

async fn do_nuphus_find_icon(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 需要图像匹配
    Err("Nuphus find_icon暂未实现(macOS)".into())
}

// ── 等待 ──

async fn do_nuphus_wait_for_text(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let _text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let _timeout_secs = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30);
    // 需要OCR轮询实现
    Err("Nuphus wait_for_text暂未实现(macOS)".into())
}

async fn do_nuphus_wait_for_icon(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let _icon = params.get("icon").and_then(|v| v.as_str()).unwrap_or("");
    let _timeout_secs = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30);
    Err("Nuphus wait_for_icon暂未实现(macOS)".into())
}

// ── 高级操作 ──

async fn do_nuphus_computer_use(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let _instruction = params.get("instruction")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // 完整Computer Use调用链：需要AI模型+多步操作
    Err("Nuphus Computer Use暂未实现(需AI模型+多步操作)".into())
}

async fn do_nuphus_multi_step(_bridge: &NuphusBridge, _params: &Value) -> Result<Value, String> {
    // 多步操作序列，每步截图记录
    Err("Nuphus multi_step暂未实现".into())
}

async fn do_nuphus_drag_and_drop(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let from_x = params.get("from_x").and_then(|v| v.as_i64()).unwrap_or(0);
    let from_y = params.get("from_y").and_then(|v| v.as_i64()).unwrap_or(0);
    let to_x = params.get("to_x").and_then(|v| v.as_i64()).unwrap_or(0);
    let to_y = params.get("to_y").and_then(|v| v.as_i64()).unwrap_or(0);
    do_nuphus_mouse_drag(_bridge, &serde_json::json!({ "from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y })).await
}

async fn do_nuphus_menu_click(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let app_name = params.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
    let menu_name = params.get("menu").and_then(|v| v.as_str()).unwrap_or("");
    let item_name = params.get("item").and_then(|v| v.as_str()).unwrap_or("");

    let script = format!(
        r#"tell application "{}" to activate
tell application "System Events" to tell process "{}" to click menu item "{}" of menu "{}" of menu bar 1"#,
        app_name.replace('"', "\\\""),
        app_name.replace('"', "\\\""),
        item_name.replace('"', "\\\""),
        menu_name.replace('"', "\\\""),
    );
    let output = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| format!("菜单点击失败: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!({ "success": true }))
    } else {
        Err(format!("菜单点击失败: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

async fn do_nuphus_type_in_field(_bridge: &NuphusBridge, params: &Value) -> Result<Value, String> {
    let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    // 先清空当前字段(Cmd+A)，再输入
    let select_all = r#"tell application "System Events" to keystroke "a" using {command down}"#;
    let _ = tokio::process::Command::new("osascript")
        .args(["-e", select_all])
        .output()
        .await;

    do_nuphus_keyboard_type(_bridge, &serde_json::json!({ "text": text })).await
}

// ── Tauri Commands ──

/// Nuphus截图
#[tauri::command]
pub async fn nuphus_screenshot(
    bridge: State<'_, NuphusBridge>,
    path: Option<String>,
    region: Option<String>,
) -> Result<Value, String> {
    let params = serde_json::json!({
        "path": path.unwrap_or_default(),
        "region": region.unwrap_or_else(|| "full".into()),
    });
    do_nuphus_screenshot(&bridge, &params).await
}

/// 通用Nuphus方法调用
#[tauri::command]
pub async fn nuphus_execute(
    bridge: State<'_, NuphusBridge>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    do_nuphus_execute(&bridge, &method, &params).await
}

/// Nuphus引擎状态
#[tauri::command]
pub fn nuphus_status(bridge: State<'_, NuphusBridge>) -> Result<Value, String> {
    Ok(serde_json::json!({
        "available": bridge.is_available(),
        "version": bridge.version,
    }))
}

/// Nuphus OCR
#[tauri::command]
pub async fn nuphus_ocr(
    bridge: State<'_, NuphusBridge>,
    image_path: String,
) -> Result<Value, String> {
    let params = serde_json::json!({ "image_path": image_path });
    do_nuphus_ocr(&bridge, &params).await
}
