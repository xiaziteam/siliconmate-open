use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub enum RouteTarget {
    ClientAgent,
    ClientAgentWithDegradation { reason: String },
    ServerAgent { tool: String },
    ObscuraBridge,
    FeishuOutput { agent: String },
    ShrimpAgent { agent_id: String, task: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub path: String,
    pub mime_type: String,
    pub file_type: FileType,
}

#[derive(Debug, Clone, Serialize)]
pub enum FileType {
    Image,
    Office,
    Pdf,
    Text,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneState {
    pub voice_chat_active: bool,
    pub deep_think_requested: bool,
    pub visual_analysis_requested: bool,
    pub feishu_output_requested: bool,
}

impl Default for SceneState {
    fn default() -> Self {
        Self {
            voice_chat_active: false,
            deep_think_requested: false,
            visual_analysis_requested: false,
            feishu_output_requested: false,
        }
    }
}

#[tauri::command]
pub fn route_message(
    message: String,
    attachments: Vec<String>,
    scene_state: Option<SceneState>,
    server_available: Option<bool>,
) -> Result<RouteTarget, String> {
    let state = scene_state.unwrap_or_default();
    let is_server_available = server_available.unwrap_or(true);

    if state.voice_chat_active {
        return Ok(RouteTarget::ObscuraBridge);
    }

    let classified: Vec<Attachment> = attachments.iter().map(|path| {
        let file_type = classify_file(path);
        let mime_type = mime_for_file(path);
        Attachment {
            path: path.clone(),
            mime_type,
            file_type,
        }
    }).collect();

    let has_office = classified.iter().any(|a| matches!(a.file_type, FileType::Office));
    let has_image = classified.iter().any(|a| matches!(a.file_type, FileType::Image));

    if let Some((agent_id, task)) = detect_shrimp_dispatch(&message) {
        return Ok(RouteTarget::ShrimpAgent { agent_id, task });
    }

    if has_office {
        if is_server_available {
            if state.feishu_output_requested {
                return Ok(RouteTarget::FeishuOutput { agent: "office_cli".into() });
            }
            return Ok(RouteTarget::ServerAgent { tool: "server_office_read".into() });
        }
        return Ok(RouteTarget::ClientAgentWithDegradation {
            reason: "Office文件处理需要服务端支持，当前不可用".into(),
        });
    }

    if detect_deep_think(&message) || state.deep_think_requested {
        if is_server_available {
            if state.feishu_output_requested {
                return Ok(RouteTarget::FeishuOutput { agent: "agentchat".into() });
            }
            return Ok(RouteTarget::ServerAgent { tool: "server_deep_think".into() });
        }
        return Ok(RouteTarget::ClientAgentWithDegradation {
            reason: "深度思考需要服务端Agent团队支持，当前不可用".into(),
        });
    }

    if has_image && state.visual_analysis_requested {
        if is_server_available {
            return Ok(RouteTarget::ServerAgent { tool: "server_chat".into() });
        }
        return Ok(RouteTarget::ClientAgentWithDegradation {
            reason: "视觉分析需要服务端支持，已降级为OCR模式".into(),
        });
    }

    if has_image {
        return Ok(RouteTarget::ClientAgent);
    }

    if state.feishu_output_requested {
        return Ok(RouteTarget::FeishuOutput { agent: "glm_daily".into() });
    }

    Ok(RouteTarget::ClientAgent)
}

fn classify_file(path: &str) -> FileType {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" => FileType::Office,
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "tiff" => FileType::Image,
        "pdf" => FileType::Pdf,
        "txt" | "csv" | "json" | "xml" | "md" | "log" | "yaml" | "yml" | "rs" | "py" | "js" | "ts" => FileType::Text,
        _ => FileType::Other,
    }
}

fn mime_for_file(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }.into()
}

pub fn detect_deep_think(message: &str) -> bool {
    let keywords = ["深度思考", "深度分析", "复杂问题", "多角度", "agentchat", "深度", "详细分析", "深入研究", "专家", "多模型"];
    let lower = message.to_lowercase();
    keywords.iter().any(|k| lower.contains(k))
}

pub fn detect_visual_analysis(message: &str) -> bool {
    let keywords = ["描述图片", "图片内容", "看到了什么", "视觉分析", "照片", "视觉", "识图"];
    let lower = message.to_lowercase();
    keywords.iter().any(|k| lower.contains(k))
}

pub fn detect_feishu_output(message: &str) -> bool {
    let keywords = ["飞书", "发到飞书", "写入飞书", "feishu", "lark", "写到文档", "发文档"];
    let lower = message.to_lowercase();
    keywords.iter().any(|k| lower.contains(k))
}

pub fn detect_shrimp_dispatch(message: &str) -> Option<(String, String)> {
    let patterns: &[(&str, &str)] = &[
        ("让白龙马", "bailongma"),
        ("叫白龙马", "bailongma"),
        ("白龙马", "bailongma"),
        ("让波迪", "workbuddy"),
        ("叫波迪", "workbuddy"),
        ("波迪帮我", "workbuddy"),
        ("让锅底", "goutou"),
        ("叫锅底", "goutou"),
        ("锅底帮我", "goutou"),
        ("让爆火", "baohuo"),
        ("叫爆火", "baohuo"),
        ("让卖虾仔", "maixiazai"),
        ("叫卖虾仔", "maixiazai"),
    ];
    let lower = message.to_lowercase();
    for (keyword, agent_id) in patterns {
        if lower.contains(keyword) {
            return Some(((*agent_id).to_string(), message.to_string()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_route_default() {
        let result = route_message("你好".into(), vec![], None, None).unwrap();
        assert!(matches!(result, RouteTarget::ClientAgent));
    }

    #[test]
    fn test_route_office_file() {
        let result = route_message("分析这个".into(), vec!["report.xlsx".into()], None, None).unwrap();
        assert!(matches!(result, RouteTarget::ServerAgent { tool } if tool == "server_office_read"));
    }

    #[test]
    fn test_route_office_feishu() {
        let state = SceneState { feishu_output_requested: true, ..Default::default() };
        let result = route_message("分析这个".into(), vec!["report.xlsx".into()], Some(state), None).unwrap();
        assert!(matches!(result, RouteTarget::FeishuOutput { agent } if agent == "office_cli"));
    }

    #[test]
    fn test_route_deep_think_keyword() {
        let result = route_message("请深度思考一下架构方案".into(), vec![], None, None).unwrap();
        assert!(matches!(result, RouteTarget::ServerAgent { tool } if tool == "server_deep_think"));
    }

    #[test]
    fn test_route_feishu_output() {
        let state = SceneState { feishu_output_requested: true, ..Default::default() };
        let result = route_message("写个总结".into(), vec![], Some(state), None).unwrap();
        assert!(matches!(result, RouteTarget::FeishuOutput { agent } if agent == "glm_daily"));
    }

    #[test]
    fn test_detect_deep_think() {
        assert!(detect_deep_think("请深度思考一下"));
        assert!(detect_deep_think("这个需要深度分析"));
        assert!(!detect_deep_think("你好"));
    }

    #[test]
    fn test_detect_feishu() {
        assert!(detect_feishu_output("发到飞书"));
        assert!(detect_feishu_output("写入飞书文档"));
        assert!(!detect_feishu_output("你好"));
    }

    #[test]
    fn test_classify_file() {
        assert!(matches!(classify_file("test.docx"), FileType::Office));
        assert!(matches!(classify_file("test.png"), FileType::Image));
        assert!(matches!(classify_file("test.pdf"), FileType::Pdf));
        assert!(matches!(classify_file("test.txt"), FileType::Text));
    }

    #[test]
    fn test_route_shrimp_agent() {
        let result = route_message("让白龙马分析一下架构".into(), vec![], None, None).unwrap();
        assert!(matches!(result, RouteTarget::ShrimpAgent { agent_id, .. } if agent_id == "bailongma"));
    }

    #[test]
    fn test_detect_shrimp_dispatch() {
        assert!(detect_shrimp_dispatch("让白龙马看看").is_some());
        assert!(detect_shrimp_dispatch("叫波迪处理").is_some());
        assert!(detect_shrimp_dispatch("你好").is_none());
    }
}
