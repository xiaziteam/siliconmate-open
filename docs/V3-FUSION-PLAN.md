# 硅侣V3.0 融合规划

> 日期：2026-09-03
> 作者：华虾(deveco)
> 仓库：xiaziteam/siliconmate (PRIVATE)
> 状态：执行中

## 1. 背景

硅侣产品代码分散在两个仓库，功能重叠但架构各异，需融合为统一产品V3.0：

| 仓库 | 代号 | 核心优势 | 前端 |
|------|------|---------|------|
| magic-chatgpt-app | V1 | 账号服务(Ops级)、CDP透传、Cookie注入、ChatGPT编排、sing-box隧道 | Vanilla HTML/JS |
| siliconmate-v2 | V2 | 场景路由、输出过滤、MCP代理、AgentChat技能、双Agent架构、OCR、React UI | React+TS+Vite |

## 2. 融合原则

1. **V2为基座**：React+TS+Vite前端 + Rust Tauri2后端，架构更现代完整
2. **V1资产迁入**：V1独有的功能模块迁移到V2架构中，保持代码统一
3. **去重合并**：两仓库重叠部分(account-client/Obscura/login)取V2版本
4. **单一仓库**：所有代码归入 `xiaziteam/siliconmate`，旧仓库冻结归档

## 3. 功能融合矩阵

| 功能 | V1 | V2 | V3处理 | 归属模块 |
|------|----|----|--------|---------|
| **Tauri2桌面壳** | ✅ | ✅ | 取V2(更完整) | client/ |
| **React前端(聊天)** | ❌ | ✅ | 保留 | client/src/ |
| **Login登录界面** | ✅(HTML) | ✅(React) | 取V2+补guest模式 | client/src/login.tsx |
| **访客模式** | ✅ guest_enter | ❌ | 迁入V2 | client/src-tauri/src/account.rs |
| **Account-Client(Rust)** | ✅ | ✅ | 取V2(一致) | client/account-client/ |
| **Account-Service(FastAPI)** | ✅ 部署VPS2 | ❌ | 迁入(已在线运行) | server/account-service/ |
| **Obscura CDP Sidecar** | ✅ :9333 | ✅ :9222 | 取V2(含cookie注入) | client/src-tauri/src/obscura.rs |
| **ChatGPT CDP Screencast** | ✅ chatgpt.html | ✅ chatgpt.html | 取V2 | client/chatgpt.html |
| **ChatGPT编排器** | ✅ nuphus_chatgpt.py | ❌ | 迁入 | server/nuphus_chatgpt.py |
| **Cookie同步** | ✅ cookie_sync.py | ❌ | 迁入 | server/cookie_sync.py |
| **WS Bridge** | ✅ siliconmate-bridge.py | ❌ | 废弃(V2用MCP Proxy替代) | — |
| **场景路由** | ❌ | ✅ 7级优先级 | 保留 | client/src-tauri/src/scene_router.rs |
| **输出过滤** | ❌ | ✅ SDK→Display | 保留 | client/src-tauri/src/output_filter.rs |
| **MCP Proxy桥** | ❌ | ✅ 6工具 | 保留 | shared/siliconmate-proxy/ |
| **GLM Fetch Adapter** | ❌ | ✅ Anthropic↔OpenAI | 保留 | shared/glm-fetch-adapter/ |
| **AgentChat技能** | ❌ | ✅ OneWeb+Sub+Independent | 保留 | server/skills/ |
| **VPS2部署脚本** | ❌ | ✅ deploy.sh | 保留 | server/deploy.sh |
| **OCR** | ❌ | ✅ Tesseract | 保留 | client/src-tauri/src/ocr.rs |
| **语音输入** | ✅ Web Speech | ✅ Web Speech | 取V2 | client/src/voice.tsx |
| **图片上传** | ❌ | ✅ 拖放+选择 | 保留 | client/src/upload.tsx |
| **sing-box隧道** | ✅ tunnel.rs | ❌ | 迁入 | client/src-tauri/src/tunnel.rs |
| **VM黄金母盘脚本** | ✅ gold-master-chain/ | ❌ | 迁入(归档性质) | archive/gold-master-chain/ |
| **Proxy路由切换** | ✅ switch-proxy-route.sh | ❌ | 迁入 | scripts/ |

## 4. V3.0 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│                   硅侣V3.0 客户端 (Tauri2)                    │
│                                                              │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌───────┐ │
│  │ Login  │  │ Chat   │  │ Voice  │  │ Upload │  │CDPView│ │
│  │(React) │  │(React) │  │(Obscur)│  │(React) │  │iframe │ │
│  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘  └──┬────┘ │
│      │           │           │            │          │      │
│  ┌───▼───────────▼───────────▼────────────▼──────────▼────┐ │
│  │              Scene Router (7级优先级)                    │ │
│  └───┬───────────┬───────────┬────────────┬──────────────┘ │
│      │           │           │            │                 │
│  ┌───▼────┐ ┌───▼────┐ ┌───▼────┐ ┌────▼─────┐           │
│  │Client  │ │Server  │ │Obscura │ │  OCR     │           │
│  │Agent   │ │Agent   │ │Sidecar │ │Tesseract │           │
│  │claude-p│ │MCP→SSH │ │CDP:9222│ │          │           │
│  │  ↓     │ │  ↓     │ │        │ │          │           │
│  │zhipu   │ │zhipu   │ │        │ │          │           │
│  │bridge  │ │bridge  │ │        │ │          │           │
│  │  ↓     │ │  ↓     │ │        │ │          │           │
│  │GLM-4   │ │GLM-4   │ │        │ │          │           │
│  │Flash   │ │Flash   │ │        │ │          │           │
│  └───┬────┘ └───┬────┘ └────────┘ └──────────┘           │
│      │           │                                          │
│  ┌───▼───────────▼──────────────────────────────────────┐  │
│  │              Output Filter (只显示结论)                │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────┐  ┌────────────────┐                  │
│  │ Account Client   │  │ Tunnel(sing-box)│ ← V1迁入        │
│  │ HMAC-SHA256      │  │ VLESS配置构建   │                  │
│  └──────────────────┘  └────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
                    │ MCP Proxy (WebSocket)
                    │ 6 tools
┌───────────────────▼──────────────────────────────────────────┐
│                   VPS2 服务端                                 │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐ │
│  │ Server Agent │  │ AgentChat     │  │ Account Service  │ │
│  │ claude -p    │  │ OneWeb(8链)   │  │ FastAPI :8444    │ │
│  │ +GLM Adapter │  │ SubAgent(6步) │  │ HMAC+TLS        │ │
│  │ +MCP工具     │  │ Independent   │  │ 已在线运行       │ │
│  └──────────────┘  └───────────────┘  └──────────────────┘ │
│  ┌──────────────┐  ┌───────────────┐                        │
│  │ ChatGPT编排器│  │ Cookie同步    │  ← V1迁入             │
│  │ nuphus_mcp   │  │ macOS Keychain│                        │
│  └──────────────┘  └───────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

## 5. 目录结构

```
siliconmate/                        # V3.0 统一仓库
├── client/                         # Tauri2桌面客户端
│   ├── src-tauri/                  # Rust后端
│   │   ├── src/
│   │   │   ├── main.rs             # Tauri入口+命令注册
│   │   │   ├── scene_router.rs     # 场景路由
│   │   │   ├── agent_manager.rs    # claude -p子进程管理
│   │   │   ├── server_connector.rs # SSH→VPS2连接
│   │   │   ├── account.rs          # 登录/会话/心跳/访客
│   │   │   ├── obscura.rs          # CDP sidecar+cookie注入
│   │   │   ├── ocr.rs              # Tesseract包装
│   │   │   ├── output_filter.rs    # SDK→Display过滤
│   │   │   ├── voice_input.rs      # 平台语音检测
│   │   │   └── tunnel.rs           # sing-box隧道 ← V1迁入
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── src/                        # React前端
│   │   ├── App.tsx
│   │   ├── chat.tsx
│   │   ├── login.tsx               # +补guest模式
│   │   ├── voice.tsx
│   │   └── upload.tsx
│   ├── chatgpt.html               # CDP screencast视图
│   ├── index.html
│   ├── account-client/            # Rust HMAC-SHA256客户端
│   ├── package.json / vite.config.ts / tsconfig.json
│   └── scripts/
│       └── local-agent.py          # 备用GLM SDK Agent
├── server/                         # VPS2服务端
│   ├── account-service/            # 账号服务 ← V1迁入
│   │   ├── app.py
│   │   ├── models.py
│   │   ├── security.py
│   │   ├── inspector.py
│   │   ├── requirements.txt
│   │   └── deploy/
│   ├── nuphus_chatgpt.py           # ChatGPT编排器 ← V1迁入
│   ├── cookie_sync.py              # Cookie同步 ← V1迁入
│   ├── agentchat/                  # AgentChat库
│   ├── skills/                     # AgentChat技能
│   ├── config/                     # free-code/MCP配置
│   └── deploy.sh                   # VPS2一键部署
├── shared/                         # 共享模块
│   ├── siliconmate-proxy/          # MCP代理桥
│   └── glm-fetch-adapter/          # API格式转换
├── scripts/                        # 工具脚本
│   └── switch-proxy-route.sh       # ← V1迁入
├── archive/                        # 归档
│   └── gold-master-chain/          # VM黄金母盘 ← V1迁入
├── docs/                           # 文档
│   └── V3-FUSION-PLAN.md           # 本文件
└── spec/                           # 规范
```

## 6. 执行阶段

### Phase 1: 基座搭建 (Day 1)
- [ ] 从siliconmate-v2复制全部代码到新仓库
- [ ] 验证cargo build + tsc + vite build全过
- [ ] 验证Tauri dev能启动
- [ ] 推GitHub作为V3.0基线

### Phase 2: V1资产迁入 (Day 1)
- [ ] 迁入account-service/(app.py+models.py+security.py+inspector.py+deploy/)
- [ ] 迁入tunnel.rs到client/src-tauri/src/
- [ ] 迁入nuphus_chatgpt.py到server/
- [ ] 迁入cookie_sync.py到server/
- [ ] 迁入switch-proxy-route.sh到scripts/
- [ ] 迁入gold-master-chain/到archive/
- [ ] 补充guest模式到login.tsx + account.rs
- [ ] 每步cargo build验证，推GitHub

### Phase 3: 架构统一 (Day 2)
- [ ] 合并两版main.rs命令注册(统一invoke_handler)
- [ ] 统一Obscura管理(obscura.rs + tunnel.rs协调)
- [ ] 废弃siliconmate-bridge.py(V2的MCP Proxy完全替代)
- [ ] 统一chatgpt.html(V2版本为主)
- [ ] cargo build + tsc + vite build验证
- [ ] 推GitHub

### Phase 4: E2E验证 (Day 2)
- [ ] Mac本地：Tauri dev → 登录/访客 → GLM聊天 → 场景路由 → OCR → 语音
- [ ] VPS2：deploy.sh → 服务端Agent → AgentChat OneWeb回退
- [ ] Obscura：CDP cookie注入 → ChatGPT加载 → 语音直通
- [ ] 修复E2E中发现的问题
- [ ] 推GitHub + 双桥记忆灌注

### Phase 5: 闭环 (Day 3)
- [ ] 旧仓库归档(冻结，不删)
- [ ] MEMORY.md更新
- [ ] LoopX任务闭环
- [ ] 最终GitHub同步

## 7. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| cargo build失败(依赖冲突) | 中 | V2基座已验证通过，迁入模块独立编译 |
| React前端编译错误 | 低 | V2前端已验证通过 |
| V1 Python脚本与V2架构不兼容 | 中 | 先迁入不改，后续迭代适配 |
| zhipu-bridge 503 | 已知 | 免费模型瞬断，非代码问题 |

## 8. 旧仓库处理

| 仓库 | 处理 | 时机 |
|------|------|------|
| magic-chatgpt-app | 冻结(archive)，不删 | Phase 5 |
| siliconmate-v2 | 冻结(archive)，不删 | Phase 5 |
| siliconmate-agent | 已归档 | — |
| siliconmate-archive | 已归档 | — |

## 9. 验收标准

1. ✅ 单一仓库 xiaziteam/siliconmate 包含所有功能代码
2. ✅ cargo build 0 error
3. ✅ tsc + vite build 0 error
4. ✅ Tauri dev能启动+登录+聊天
5. ✅ V1独有功能全部迁入(account-service/tunnel/nuphus/cookie/guest模式)
6. ✅ GitHub PRIVATE + 全程同步
7. ✅ 双桥记忆灌注
