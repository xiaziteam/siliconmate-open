# 硅侣 SiliconMate

AI助手 + SMCP即时通讯 — macOS + Android 跨平台应用

## 功能

- **AI对话**: 多模型路由（ChatGPT/GLM/DeepSeek）
- **SMCP通讯**: 好友聊天、群聊、文件传输
- **OCR识别**: 截图识别文字（中英双语）
- **跨平台**: macOS (Tauri2) + Android (Kotlin + WebView)

## 技术栈

- **前端**: React + TypeScript
- **macOS壳**: Tauri2 + Rust
- **Android壳**: Kotlin + WebView + NativeBridge
- **服务端**: Node.js + SQLite

## 构建

### macOS

```bash
cd client
npm install
npx tauri build
```

### Android

```bash
cd android
./gradlew assembleDebug
```

## 配置

复制 `.env.example` 为 `.env`，填入你的服务端地址和API密钥：

```bash
cp .env.example .env
# 编辑 .env 填入真实值
```

所有 `<YOUR_SERVER_HOST>` 占位符需替换为你的实际服务器域名或IP。

## 许可证

MIT
