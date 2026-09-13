//! SMCP v0.1 客户端 — 硅侣通讯协议
//!
//! 电脑端SMCP节点: 注册/消息收发/好友管理/权限控制
//! 中继服务器: https://example.com/v1/smcp

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;
use tokio::sync::RwLock;

const RELAY_BASE: &str = "https://example.com/v1/smcp";

// --- 数据结构 ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmcpConfig {
    pub user_id: String,
    pub agent_id: String,
    pub role: String,
    pub device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmcpMessage {
    pub msg_id: String,
    pub from_agent: String,
    pub to_agent: String,
    pub to_user: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub method: String,
    pub params: Value,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendInfo {
    pub friend_id: String,
    pub friend_user_id: String,
    pub status: String,
    pub granted_perms: Value,
    pub received_perms: Value,
    pub alias: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRequest {
    pub request_id: String,
    pub from_user_id: String,
    pub message: String,
    pub proposed_perms: Value,
    pub created_at: String,
}

pub struct SmcpState {
    pub config: RwLock<Option<SmcpConfig>>,
    pub http: reqwest::Client,
}

impl SmcpState {
    pub fn new() -> Self {
        Self {
            config: RwLock::new(None),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }
}

// --- API调用 ---

async fn smcp_post(state: &SmcpState, path: &str, user_id: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}{}", RELAY_BASE, path);
    let resp = state
        .http
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Account-Id", user_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;
    let json: Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;
    Ok(json)
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn smcp_register(
    state: State<'_, SmcpState>,
    user_id: String,
    agent_id: String,
    role: String,
    device: String,
) -> Result<Value, String> {
    let body = serde_json::json!({
        "user_id": user_id,
        "agent_id": agent_id,
        "role": role,
        "device": device,
        "capabilities": ["im", "tunnel", "notify"],
    });
    let result = smcp_post(&state, "/agent/register", &user_id, body).await?;
    if result["ok"].as_bool().unwrap_or(false) {
        *state.config.write().await = Some(SmcpConfig {
            user_id,
            agent_id,
            role,
            device,
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn smcp_agent_list(state: State<'_, SmcpState>, user_id: String) -> Result<Value, String> {
    smcp_post(&state, "/agent/list", &user_id, serde_json::json!({"user_id": user_id})).await
}

#[tauri::command]
pub async fn smcp_message_send(
    state: State<'_, SmcpState>,
    from_agent: String,
    to_agent: String,
    to_user: String,
    msg_type: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({
        "from_agent": from_agent,
        "to_agent": to_agent,
        "to_user": to_user,
        "type": msg_type,
        "method": method,
        "params": params,
    });
    smcp_post(&state, "/message/send", uid, body).await
}

#[tauri::command]
pub async fn smcp_message_poll(
    state: State<'_, SmcpState>,
    agent_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({
        "agent_id": agent_id,
        "limit": limit.unwrap_or(50),
    });
    smcp_post(&state, "/message/poll", uid, body).await
}

#[tauri::command]
pub async fn smcp_friend_request(
    state: State<'_, SmcpState>,
    to_user_id: String,
    message: String,
    permissions: Value,
    to_silicon_id: Option<String>,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let mut body = serde_json::json!({
        "to_user_id": to_user_id,
        "message": message,
        "permissions": permissions,
    });
    if let Some(sid) = to_silicon_id {
        if !sid.is_empty() {
            body["to_silicon_id"] = serde_json::Value::String(sid);
        }
    }
    smcp_post(&state, "/friend/request", uid, body).await
}

#[tauri::command]
pub async fn smcp_friend_accept(
    state: State<'_, SmcpState>,
    request_id: String,
    permissions: Value,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({
        "request_id": request_id,
        "permissions": permissions,
    });
    smcp_post(&state, "/friend/accept", uid, body).await
}

#[tauri::command]
pub async fn smcp_friend_list(state: State<'_, SmcpState>) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/friend/list", uid, serde_json::json!({})).await
}

#[tauri::command]
pub async fn smcp_friend_set_permissions(
    state: State<'_, SmcpState>,
    friend_user_id: String,
    permissions: Value,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({
        "user_id": friend_user_id,
        "permissions": permissions,
    });
    smcp_post(&state, "/friend/setPermissions", uid, body).await
}

#[tauri::command]
pub async fn smcp_friend_remove(
    state: State<'_, SmcpState>,
    friend_user_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({"user_id": friend_user_id});
    smcp_post(&state, "/friend/remove", uid, body).await
}

#[tauri::command]
pub async fn smcp_friend_requests(state: State<'_, SmcpState>) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/friend/requests", uid, serde_json::json!({})).await
}

#[tauri::command]
pub async fn smcp_ping() -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/ping", RELAY_BASE))
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;
    resp.json().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn smcp_lookup(
    state: State<'_, SmcpState>,
    silicon_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let body = serde_json::json!({
        "silicon_id": silicon_id,
    });
    smcp_post(&state, "/lookup", uid, body).await
}

#[tauri::command]
pub async fn smcp_message_unread(state: State<'_, SmcpState>) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/message/unread", uid, serde_json::json!({})).await
}

#[tauri::command]
 pub async fn smcp_message_read(
     state: State<'_, SmcpState>,
     msg_ids: Vec<String>,
 ) -> Result<Value, String> {
     let cfg = state.config.read().await;
     let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
     smcp_post(&state, "/message/read", uid, serde_json::json!({ "msg_ids": msg_ids })).await
 }

// ===== 群聊 =====

#[tauri::command]
pub async fn smcp_group_create(
    state: State<'_, SmcpState>,
    name: String,
    member_ids: Vec<String>,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/create", uid, serde_json::json!({ "name": name, "member_ids": member_ids })).await
}

#[tauri::command]
pub async fn smcp_group_list(state: State<'_, SmcpState>) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/list", uid, serde_json::json!({})).await
}

#[tauri::command]
pub async fn smcp_group_info(
    state: State<'_, SmcpState>,
    group_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/info", uid, serde_json::json!({ "group_id": group_id })).await
}

#[tauri::command]
pub async fn smcp_group_invite(
    state: State<'_, SmcpState>,
    group_id: String,
    user_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/invite", uid, serde_json::json!({ "group_id": group_id, "user_id": user_id })).await
}

#[tauri::command]
pub async fn smcp_group_leave(
    state: State<'_, SmcpState>,
    group_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/leave", uid, serde_json::json!({ "group_id": group_id })).await
}

#[tauri::command]
pub async fn smcp_group_message_send(
    state: State<'_, SmcpState>,
    from_agent: String,
    group_id: String,
    r#type: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/message/send", uid, serde_json::json!({
        "from_agent": from_agent,
        "group_id": group_id,
        "type": r#type,
        "method": method,
        "params": params,
    })).await
}

// ===== 群管理 =====

#[tauri::command]
pub async fn smcp_group_kick(
    state: State<'_, SmcpState>,
    group_id: String,
    user_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/kick", uid, serde_json::json!({ "group_id": group_id, "user_id": user_id })).await
}

#[tauri::command]
pub async fn smcp_group_transfer(
    state: State<'_, SmcpState>,
    group_id: String,
    user_id: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/transfer", uid, serde_json::json!({ "group_id": group_id, "user_id": user_id })).await
}

#[tauri::command]
pub async fn smcp_group_set_role(
    state: State<'_, SmcpState>,
    group_id: String,
    user_id: String,
    role: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/group/setRole", uid, serde_json::json!({ "group_id": group_id, "user_id": user_id, "role": role })).await
}

#[tauri::command]
pub async fn smcp_group_update(
    state: State<'_, SmcpState>,
    group_id: String,
    name: Option<String>,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    let mut body = serde_json::json!({ "group_id": group_id });
    if let Some(n) = name {
        body["name"] = serde_json::Value::String(n);
    }
    smcp_post(&state, "/group/update", uid, body).await
}

// ===== 文件传输 =====

#[tauri::command]
pub async fn smcp_file_upload(
    state: State<'_, SmcpState>,
    filename: String,
    data: String,
    content_type: String,
) -> Result<Value, String> {
    let cfg = state.config.read().await;
    let uid = cfg.as_ref().map(|c| c.user_id.as_str()).unwrap_or("");
    smcp_post(&state, "/file/upload", uid, serde_json::json!({
        "filename": filename,
        "data": data,
        "content_type": content_type,
    })).await
}

// ===== 文件读取辅助 =====

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use std::fs;
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
