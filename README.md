# 硅侣 SiliconMate V3.0

AI助手桌面应用 — Tauri2 + Rust + React

## 架构

- **客户端**: Tauri2桌面壳 + React前端 + Rust后端
- **服务端**: VPS2部署 (free-code + zhipu-bridge + AgentChat)
- **通信**: MCP Proxy WebSocket + SSH exec

## 场景路由 (7级优先级)

1. 语音 → Obscura CDP (ChatGPT Voice直通)
2. Office读取 → 服务端 (server_office_read)
3. Office创建 → 服务端 (server_office_create)
4. 视觉分析 → 本地 (claude -p + 图片base64)
5. 图片OCR → 本地 (Tesseract)
6. 深度思考 → 服务端 (server_deep_think)
7. 普通文本 → 本地 (claude -p → GLM-4-Flash)

## 快速开始

```bash
# 客户端开发
cd client
npm install
cd src-tauri && cargo build && cd ..
npm run tauri dev

# 服务端部署
cd server
bash deploy.sh
```

## V3.0 融合来源

- **siliconmate-v2**: 场景路由 + 输出过滤 + MCP代理 + AgentChat + React UI
- **magic-chatgpt-app**: 账号服务 + ChatGPT编排器 + Cookie同步 + sing-box隧道

详见 `docs/V3-FUSION-PLAN.md`
