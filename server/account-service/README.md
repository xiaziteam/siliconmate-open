# account-service — 账号服务 2.0

任务: todo_a200a3b30119 [P0] 2.0-A3 | 规格: `docs/2.0-账号服务API规格.md` | 认证: `docs/2.0-账号服务认证协议设计.md`

## 运行

```bash
pip install -r requirements.txt
MASTER_KEY=<生产密钥> uvicorn app:app --host 0.0.0.0 --port 8710
```

环境变量:
- `ACCOUNT_DB` — SQLite 路径, 默认 `data/account.db`(已gitignore)
- `MASTER_KEY` — admin面签名密钥 + api_key静态加密 + 下发JWT签名, **生产必须改**

## 端点 (v1)

| 端点 | 认证 | 用途 |
|------|------|------|
| POST /v1/auth/login | 无(密码) | L1登录→api_key; 5次错锁15min |
| POST /v1/session/fetch | X-API-Key+HMAC | 一次握手全下发: session+tunnel_config(一次性) |
| POST /v1/session/heartbeat | X-API-Key+HMAC | 30s心跳; 90s stale / 5min dead |
| POST /v1/admin/account | x-master-key | 创建/列出L1账号 |
| POST /v1/admin/bind | x-master-key | L2 session绑定L1(可带一次性tunnel_config) |
| POST /v1/admin/revoke | x-master-key | 吊销 api_key/session/account |

## HMAC 签名 (客户端示例)

```python
import hashlib, hmac, json, time

def sign_and_post(url, api_key, account_id, body):
    raw = json.dumps(body, separators=(",", ":")).encode()   # 必须紧凑序列化!
    ts = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    sig_input = f"POST|/v1/session/fetch|{account_id}|{ts}|{hashlib.sha256(raw).hexdigest()}"
    sig = hmac.new(api_key.encode(), sig_input.encode(), hashlib.sha256).hexdigest()
    import httpx
    return httpx.post(url, content=raw, headers={
        "X-API-Key": api_key, "X-Account-Id": account_id,
        "X-Sign-Timestamp": ts, "X-Signature": sig,
        "Content-Type": "application/json"})
```

⚠️ body哈希基于**实际发送字节**(httpx默认紧凑分隔符), 序列化不一致会 ERR_SIG。

## 巡检 (A5)

`inspector.py` 随服务启动(lifespan挂载):
- 每30s扫描sessions: >90s无心跳→stale, stale>5min→dead, 异常写 `logs/service.log`
- `PROBE_ENABLED=1` 开启ChatGPT探活: 对active session抽样GET `chatgpt.com/api/auth/session`, 401/403直接判dead进隔离区
- 环境变量: `INSPECT_INTERVAL`(默认30) / `PROBE_ENABLED`(默认0, 测试与无外网环境关闭)

## 测试

```bash
python -m pytest tests/ -q   # 12项: 8项API + 4项巡检(5min判dead/探活401判死+隔离/探活存活不动/stale状态)
```

## 实现注记

- api_key 不落明文: 库内 `key_sha=sha256(key)` 快速查找 + `key_enc=Fernet(MASTER_KEY)` 供HMAC验签解密 (规格§四)
- tunnel_config 存 `tunnel_secrets` 表, fetch 后即删 (A4铁律: 用后即焚不入库下发通道之外的地方)
- revoked session 进 `quarantined_sessions` 隔离区表
- 心跳判死为惰性巡检(fetch/heartbeat时刷新状态); A5任务补后台定时巡检+探活ChatGPT
