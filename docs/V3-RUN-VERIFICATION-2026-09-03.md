# 硅侣 V3.0 全链路跑通验证报告

- **日期**: 2026-09-03
- **验证人**: 智虾(zhixia) — 代华虾(deveco)执行，华虾忙别的事
- **对应任务**: 2026-09-03.md 日记"下一步"第1条 — Tauri dev 实际运行测试
- **验证环境**: macOS 14.6 (darwin 22.6.0 x64) · node v22.23.2 · npm 10.9.8 · cargo/rustc 1.98.0
- **修订**: 2026-09-03 第二轮 — 用户实测发现聊天502，已定位修复（见 §六）

## 结论

✅ **客户端桌面应用跑通 + 服务端 account-service 跑通**。全新 clone 到跑起来全程无阻，代码仓库处于可用状态。
🔧 **第二轮**: 用户实测聊天报 502 → 根因定位 + 修复 + 实测通过（commit fb4f8ed）→ **聊天链路现已真正可用**。

## 一、客户端（Tauri2 + Rust + React）

| 步骤 | 命令 | 结果 |
|------|------|------|
| 1. 依赖安装 | `cd client && npm install` | ✅ 一次通过，无 peer 冲突 |
| 2. Rust 编译 | `npm run tauri dev`（自动触发 cargo） | ✅ 444/445 包，**5m28s 零错误**（dev profile，首次全量） |
| 3. 桌面启动 | 同上 | ✅ `target/debug/siliconmate` 进程稳定运行，窗口"硅侣 — 硅基生命数字人伴侣" |
| 4. 前端服务 | vite dev `http://localhost:5173` | ✅ HTTP 200，页面标题渲染正常 |

**验证细节**：
- 进程验证：`ps` 确认 PID 存活 10+ 分钟，CPU 0%（空闲态），内存 0.3%，无崩溃重启循环
- macOS 日志出现 TSM 键盘事件（`TSM AdjustCapsLockLEDForKeyTransitionHandling`）= 窗口正常接收输入事件
- 13 个 Rust 模块全部编译链接通过：scene_router / ocr / voice_input / tunnel / account / obscura / server_connector / agent_manager / output_filter / main 等

## 二、服务端 account-service（FastAPI）

```bash
cd server/account-service
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # ✅ Python 3.14.7 一次通过
MASTER_KEY=master-key-dev-only ./.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8710
```

| 验证项 | 结果 |
|--------|------|
| 服务启动 | ✅ Uvicorn 8710 端口，inspector 后台巡检启动（interval=30s） |
| API 注册 | ✅ 7 端点：`/health` `/v1/admin/account` `/v1/admin/bind` `/v1/admin/revoke` `/v1/auth/login` `/v1/session/fetch` `/v1/session/heartbeat` |
| 建号 | ✅ `x-master-key` header 认证通过，返回 `acc_*` ID + `sk_live_*` 密钥 |
| 登录 | ✅ 正确密码返回 api_key；错误密码 401 `ERR_AUTH` 拒绝 |
| 参数格式 | ⚠️ 注意：body 字段名是 **`account_name`**（不是 username），master key 走 **`x-master-key` header**（不是 body） |

**实测记录**（测试账号 `zhixia_test`，接手后可在 DB 里删掉）：
```
POST /v1/admin/account → {"ok":true,"data":{"account_id":"acc_0f59fd7179b2bbe4","api_key":"sk_live_…"}}
POST /v1/auth/login    → {"ok":true,…}
POST /v1/auth/login(错密码) → 401 {"ok":false,"error":"ERR_AUTH"}
```

## 三、边界说明（接手前必读）

1. **`server/deploy.sh` 未执行** — 这是往 VPS2(鬼子虾2号 <VPS_IP>) 部署 free-code + AgentChat + systemd 的生产脚本，按协作铁律生产/外发操作需 [APPROVE]，留待华虾/麦克决定。
2. **场景路由 7 级中的服务端 3 级**（Office读取/Office创建/深度思考）依赖 VPS 上的 free-code 服务，本地验证时不可用会降级；本地 4 级（语音/视觉/OCR/普通文本）不受影响。
3. **深度思考等本地级** 依赖 `claude -p`（GLM-4-Flash），需本机已登录 free-code。
4. account-service 的 `MASTER_KEY` 默认 `master-key-dev-only` 仅为开发用，生产部署走 deploy.sh 注入。

## 四、快速启动（接手者复制即用）

```bash
# 终端1 — 客户端（首次约6分钟编译，之后增量秒级）
cd client && npm install && npm run tauri dev

# 终端2 — 账号服务（登录/建号用）
cd server/account-service
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
MASTER_KEY=master-key-dev-only ./.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8710

# 验证: curl http://127.0.0.1:8710/health
```

## 五、遗留待办

- [x] ~~GUI聊天502修复~~（第二轮已修复，commit fb4f8ed）
- [ ] Obscura binary + zhipu-bridge 就位后的语音直通链路验证（日记"下一步"第2条）
- [ ] 语音(voice_input)/OCR(ocr.rs) 真机功能级验证（本次验证到编译+启动层）
- [ ] macOS dmg 打包（`npm run tauri build`，未执行以节省时间）
- [ ] 客户端 login 界面连 account-service 的地址确认（本地 8710 vs VPS 网关 8444）

## 六、第二轮：用户实测502修复记录（2026-09-03）

### 现象
用户在桌面窗口发消息，收到 `API Error: 502 Payment Required ... check your inference gateway (127.0.0.1:15721)`。
（证据: /tmp/siliconmate-stdout.txt stream-json 输出）

### 根因
`~/.claude/settings.json` 的 env 里有全局覆盖：
```json
{"ANTHROPIC_BASE_URL": "http://127.0.0.1:15721", "ANTHROPIC_AUTH_TOKEN": "sk-loc-agnes-bridge"}
```
GUI spawn 的 claude-code 启动时读了它 → 请求被劫持到 15721 托管代理 → 对 dummy key + glm-4-flash 返回 502。
华虾在 `~/.agents/free-code` wrapper 注释里早就总结过这个坑（"关键隔离: 用独立 CLAUDE_CONFIG_DIR"），但 agent_manager.rs 从 magic-chatgpt-app 移植时没带上这层隔离。

### 修复（client/src-tauri/src/agent_manager.rs, commit fb4f8ed）
spawn 命令注入 `CLAUDE_CONFIG_DIR=/tmp/siliconmate-claude-config`（隔离目录，无 settings 覆盖）+ `ANTHROPIC_AUTH_TOKEN=dummy` 双保险。
实测修复后同款命令（含 node24 npx、cwd=src-tauri）→ 走 zhipu-bridge:15731 返回真实回复 ✅

### 经验铁律
**凡是 spawn claude-code/free-code 子进程，必须设 CLAUDE_CONFIG_DIR 隔离**，否则本机全局 settings.json 的 env 会劫持 ANTHROPIC_BASE_URL。此坑在 wrapper（08-27）、GUI agent_manager（09-03）两次踩中，移植代码时配置隔离逻辑必须一并带走。

### 顺手提醒：两种打开方式别搞混
- **桌面 App**（`npm run tauri dev` 起的窗口）= 真实 AI。dev 模式自动跳过登录直接进聊天。
- **浏览器开 http://localhost:5173** = 演示模式（无 Tauri 环境），发消息只会得到写死的假回复"这是硅侣2.0的演示回复…"，登录会报"Tauri环境未就绪"。这不是 bug，是 App.tsx 里的降级设计。
