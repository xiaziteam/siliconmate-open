"""账号服务 2.0 — FastAPI 主应用
任务: todo_a200a3b30119 [P0] 2.0-A3
规格: docs/2.0-账号服务API规格.md (A2交付, 老痴评审通过)
认证骨架: docs/2.0-账号服务认证协议设计.md (A1交付) — 海龟协议五要素
"""
import json
import os
import secrets
import string
import time
from contextlib import asynccontextmanager

import jwt as pyjwt
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import models
from models import (DEAD_AFTER_SEC, HEARTBEAT_INTERVAL, STALE_AFTER_SEC,
                    hash_password, new_account_id, new_session_id,
                    now_iso, refresh_session_statuses, sha256_hex)

def get_db():
    return models.get_db()

def init_db():
    return models.init_db()
from security import (AuthError, decrypt_api_key, encrypt_api_key,
                      new_api_key, verify_password, verify_request)

MASTER_KEY = os.environ.get("MASTER_KEY", "master-key-dev-only")
JWT_TTL_SEC = 15 * 60          # L2 下发通道短期 JWT (A1§二)
LOGIN_MAX_FAIL = 5             # A2§2.1 锁定策略
LOCKOUT_SEC = 15 * 60


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    import asyncio
    from inspector import inspector_loop
    stop = asyncio.Event()
    app.state.inspector_stop = stop
    task = asyncio.create_task(inspector_loop(stop))
    yield
    stop.set()
    task.cancel()


app = FastAPI(title="magic-chatgpt-account-service", version="1.0.0",
              lifespan=lifespan)


def ok(data=None):
    return {"ok": True, "data": data or {}}


def err(code: str, message: str, status: int = 400):
    return JSONResponse(status_code=status,
                        content={"ok": False, "error": code, "message": message})


@app.exception_handler(AuthError)
async def auth_error_handler(request: Request, exc: AuthError):
    return err(exc.code, exc.message, 401)


@app.get("/health")
async def health():
    from models import get_db as _gdb
    try:
        with _gdb() as conn:
            n = conn.execute("SELECT COUNT(*) c FROM accounts").fetchone()["c"]
        return {"ok": True, "service": "account-service", "accounts": n}
    except Exception as e:
        return JSONResponse(status_code=500,
                            content={"ok": False, "error": "ERR_DB", "message": str(e)})


# ============================== /auth/login ==============================
@app.post("/v1/auth/login")
async def auth_login(request: Request):
    body = await request.json()
    name = body.get("account_name", "")
    password = body.get("password", "")
    device_id = body.get("device_id", "")
    if not name or not password:
        return err("ERR_FORMAT", "account_name/password必填")

    with get_db() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE account_name=?",
                           (name,)).fetchone()
        if not row:
            return err("ERR_AUTH", "账号或密码错误", 401)
        now = time.time()
        if now < row["locked_until"]:
            return err("ERR_RATE_LIMIT", "账号锁定中,稍后重试", 429)
        if row["status"] == "disabled":
            return err("ERR_AUTH", "账号已禁用", 403)

        if not verify_password(row["password_hash"], password):
            fc = row["fail_count"] + 1
            locked_until = now + LOCKOUT_SEC if fc >= LOGIN_MAX_FAIL else 0
            conn.execute(
                "UPDATE accounts SET fail_count=?,locked_until=?,updated_at=? WHERE account_id=?",
                (fc, locked_until, now_iso(), row["account_id"]))
            return err("ERR_AUTH", "账号或密码错误", 401)

        conn.execute(
            "UPDATE accounts SET fail_count=0,device_id=?,updated_at=? WHERE account_id=?",
            (device_id or row["device_id"], now_iso(), row["account_id"]))
        return ok({"account_id": row["account_id"],
                   "api_key": decrypt_api_key(row["key_enc"]),
                   "expires_at": None})


# ======================= HMAC 认证依赖 =======================
async def require_auth(request: Request):
    """X-API-Key 等值查库 + HMAC 签名校验。返回账号行。"""
    raw_key = request.headers.get("x-api-key", "")
    if not raw_key:
        raise AuthError("ERR_AUTH", "缺少 X-API-Key")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE key_sha=?",
                           (sha256_hex(raw_key),)).fetchone()
        if not row:
            raise AuthError("ERR_AUTH", "api_key无效")
        if row["status"] != "active":
            raise AuthError("ERR_AUTH", f"账号状态{row['status']}", 403)
        verify_request(request.headers, await request.body(),
                       request.method, request.url.path, row["key_enc"])
        refresh_session_statuses(conn)
        return row


# ============================ /session/fetch ============================
def make_downstream_jwt(account_id: str, session_id: str) -> str:
    payload = {"acc": account_id, "ses": session_id,
               "exp": int(time.time()) + JWT_TTL_SEC}
    return pyjwt.encode(payload, MASTER_KEY, algorithm="HS256")


@app.post("/v1/session/fetch")
async def session_fetch(request: Request):
    account = await require_auth(request)
    aid = (await request.json()).get("account_id", "")
    if aid and aid != account["account_id"]:
        return err("ERR_AUTH", "account_id不匹配", 403)

    with get_db() as conn:
        sess = conn.execute(
            "SELECT * FROM sessions WHERE account_id=? AND status='active' "
            "ORDER BY priority ASC, created_at DESC LIMIT 1",
            (account["account_id"],)).fetchone()
        if not sess:
            return err("ERR_NOT_FOUND", "无可用session", 404)

        tun = conn.execute(
            "SELECT config_json FROM tunnel_secrets WHERE session_id=?",
            (sess["session_id"],)).fetchone()
        tunnel_config = json.loads(tun["config_json"]) if tun else None
        if tun:  # 用后即焚 (A4铁律: 隧道凭证一次性下发不入库)
            conn.execute("DELETE FROM tunnel_secrets WHERE session_id=?",
                         (sess["session_id"],))

        return ok({
            "chatgpt_session": {
                "access_token": sess["access_token"],
                "expires": sess["expires_at"],
                "cookies": json.loads(sess["cookies_json"]),
                "downstream_jwt": make_downstream_jwt(
                    account["account_id"], sess["session_id"]),
            },
            "tunnel_config": tunnel_config,
            "session_id": sess["session_id"],
            "heartbeat_url": "/v1/session/heartbeat",
            "heartbeat_interval_sec": HEARTBEAT_INTERVAL,
        })


# ========================== /session/heartbeat ==========================
@app.post("/v1/session/heartbeat")
async def session_heartbeat(request: Request):
    account = await require_auth(request)
    sid = (await request.json()).get("session_id", "")
    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM sessions WHERE session_id=? AND account_id=?",
            (sid, account["account_id"])).fetchone()
        if not row:
            return err("ERR_NOT_FOUND", "session不存在", 404)
        conn.execute("UPDATE sessions SET last_heartbeat=? WHERE session_id=?",
                     (time.time(), sid))
        return ok({"status": "alive" if row["status"] == "active" else row["status"],
                   "next_beat_sec": HEARTBEAT_INTERVAL})


# ============================== admin 面 ==============================
def require_master(request: Request):
    import hmac as _h
    mk = request.headers.get("x-master-key", "")
    if not _h.compare_digest(mk, MASTER_KEY):
        raise AuthError("ERR_AUTH", "master_key无效")


@app.post("/v1/admin/account")
async def admin_account(request: Request):
    require_master(request)
    body = await request.json()
    action = body.get("action", "create")
    with get_db() as conn:
        if action == "create":
            name = body.get("account_name", "")
            pw = body.get("password", "")
            if not name or not pw:
                return err("ERR_FORMAT", "account_name/password必填")
            if conn.execute("SELECT 1 FROM accounts WHERE account_name=?", (name,)).fetchone():
                return err("ERR_FORMAT", "账号名已存在")
            aid = new_account_id()
            key = new_api_key()
            conn.execute(
                "INSERT INTO accounts(account_id,account_name,password_hash,key_sha,key_enc,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (aid, name, hash_password(pw), sha256_hex(key),
                 encrypt_api_key(key), now_iso(), now_iso()))
            return ok({"account_id": aid, "api_key": key})
        if action == "list":
            rows = conn.execute(
                "SELECT account_id,account_name,status,created_at FROM accounts").fetchall()
            return ok({"accounts": [dict(r) for r in rows]})
        return err("ERR_FORMAT", f"未知action:{action}")


@app.post("/v1/admin/bind")
async def admin_bind(request: Request):
    require_master(request)
    body = await request.json()
    aid = body.get("account_id", "")
    cs = body.get("chatgpt_session") or {}
    priority = int(body.get("priority", 1))
    tunnel_config = body.get("tunnel_config")  # 有则入一次性下发队列(A4联调用)
    if not aid or not cs.get("access_token"):
        return err("ERR_FORMAT", "account_id/chatgpt_session.access_token必填")
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM accounts WHERE account_id=?", (aid,)).fetchone():
            return err("ERR_NOT_FOUND", "账号不存在", 404)
        sid = new_session_id()
        conn.execute(
            "INSERT INTO sessions(session_id,account_id,access_token,cookies_json,"
            "expires_at,priority,status,last_heartbeat,created_at)"
            " VALUES(?,?,?,?,?,?,'active',?,?)",
            (sid, aid, cs["access_token"], json.dumps(cs.get("cookies") or {}),
             cs.get("expires") or now_iso(), priority,
             time.time(), now_iso()))
        if tunnel_config:
            conn.execute(
                "INSERT OR REPLACE INTO tunnel_secrets(session_id,config_json,created_at)"
                " VALUES(?,?,?)", (sid, json.dumps(tunnel_config), now_iso()))
        return ok({"session_id": sid, "bound": True})


@app.post("/v1/admin/revoke")
async def admin_revoke(request: Request):
    require_master(request)
    body = await request.json()
    ttype = body.get("target_type", "")
    tid = body.get("target_id", "")
    with get_db() as conn:
        if ttype in ("api_key", "account"):
            conn.execute(
                "UPDATE accounts SET status='disabled',updated_at=? WHERE account_id=?",
                (now_iso(), tid))
            if ttype == "account":
                conn.execute("DELETE FROM sessions WHERE account_id=?", (tid,))
        elif ttype == "session":
            conn.execute("DELETE FROM sessions WHERE session_id=?", (tid,))
            conn.execute("DELETE FROM tunnel_secrets WHERE session_id=?", (tid,))
            conn.execute(
                "INSERT OR IGNORE INTO quarantined_sessions(session_id) VALUES(?)", (tid,))
        else:
            return err("ERR_FORMAT", "target_type须为api_key|session|account")
        return ok({"revoked": True})


# ========================== 激活码管理 ==========================
def _gen_code() -> str:
    chars = string.ascii_uppercase + string.digits
    return "XK-" + "".join(secrets.choice(chars) for _ in range(3)) + "-" + \
           "".join(secrets.choice(chars) for _ in range(4))


@app.post("/v1/admin/activation/create")
async def admin_activation_create(request: Request):
    require_master(request)
    body = await request.json()
    plan = body.get("plan", "basic")
    if plan not in ("basic", "pro"):
        return err("ERR_FORMAT", "plan须为basic|pro")
    note = body.get("note", "")
    code = _gen_code()
    code_hash = sha256_hex(code)
    code_id = "act_" + secrets.token_hex(8)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO activation_codes(code_id,code_hash,plan,note,created_at)"
            " VALUES(?,?,?,?,?)",
            (code_id, code_hash, plan, note, now_iso()))
    return ok({"code": code, "code_id": code_id, "plan": plan})


@app.post("/v1/admin/activation/list")
async def admin_activation_list(request: Request):
    require_master(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT code_id,plan,status,bound_device,used_at,expires_at,note,created_at"
            " FROM activation_codes ORDER BY created_at DESC").fetchall()
    return ok({"codes": [dict(r) for r in rows]})


@app.post("/v1/admin/activation/revoke")
async def admin_activation_revoke(request: Request):
    require_master(request)
    body = await request.json()
    code_id = body.get("code_id", "")
    if not code_id:
        return err("ERR_FORMAT", "code_id必填")
    with get_db() as conn:
        row = conn.execute("SELECT status FROM activation_codes WHERE code_id=?",
                           (code_id,)).fetchone()
        if not row:
            return err("ERR_NOT_FOUND", "激活码不存在", 404)
        if row["status"] == "revoked":
            return err("ERR_FORMAT", "已吊销")
        conn.execute("UPDATE activation_codes SET status='revoked' WHERE code_id=?",
                     (code_id,))
    return ok({"revoked": True})


@app.post("/v1/admin/tunnel/set")
async def admin_tunnel_set(request: Request):
    require_master(request)
    body = await request.json()
    plan = body.get("plan", "")
    if plan not in ("basic", "pro"):
        return err("ERR_FORMAT", "plan须为basic|pro")
    server = body.get("server", "")
    server_port = body.get("server_port", 443)
    uuid = body.get("uuid", "")
    flow = body.get("flow", "xtls-rprx-vision")
    server_name = body.get("server_name", "www.cloudflare.com")
    public_key = body.get("public_key", "")
    short_id = body.get("short_id", "")
    route_domains = body.get("route_domains", [])
    note = body.get("note", "")
    if not server or not uuid or not public_key or not short_id or not route_domains:
        return err("ERR_FORMAT", "server/uuid/public_key/short_id/route_domains必填")
    config_id = "tc_" + secrets.token_hex(4)
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO tunnel_configs"
            "(config_id,plan,server,server_port,uuid,flow,server_name,public_key,short_id,route_domains,note,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (config_id, plan, server, server_port, uuid, flow, server_name,
             public_key, short_id, json.dumps(route_domains), note, now_iso()))
    return ok({"config_id": config_id, "plan": plan})


@app.post("/v1/admin/tunnel/list")
async def admin_tunnel_list(request: Request):
    require_master(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT config_id,plan,server,server_port,uuid,flow,server_name,"
            "public_key,short_id,note,updated_at FROM tunnel_configs").fetchall()
    return ok({"configs": [dict(r) for r in rows]})


@app.post("/v1/code/validate")
async def code_validate(request: Request):
    body = await request.json()
    code = body.get("code", "").strip().upper()
    if not code:
        return err("ERR_FORMAT", "激活码必填")
    code_hash = sha256_hex(code)
    with get_db() as conn:
        row = conn.execute(
            "SELECT code_id,plan,status,expires_at FROM activation_codes WHERE code_hash=?",
            (code_hash,)).fetchone()
        if not row:
            return err("ERR_INVALID", "激活码无效", 401)
        if row["status"] != "active":
            return err("ERR_INVALID", "激活码已" + row["status"], 401)
        if row["expires_at"]:
            from datetime import datetime as _dt, timezone as _tz
            try:
                exp = _dt.fromisoformat(row["expires_at"]).astimezone(_tz.utc)
                if _dt.now(_tz.utc) > exp:
                    return err("ERR_EXPIRED", "激活码已过期", 401)
            except Exception:
                pass
        plan = row["plan"]
        device_id = body.get("device_id", "")
        if device_id and row["status"] == "active":
            conn.execute(
                "UPDATE activation_codes SET bound_device=?,used_at=?,status='used' WHERE code_id=?",
                (device_id, now_iso(), row["code_id"]))

        tc = conn.execute(
            "SELECT server,server_port,uuid,flow,server_name,public_key,short_id,route_domains"
            " FROM tunnel_configs WHERE plan=?", (plan,)).fetchone()
        tunnel = None
        if tc:
            tunnel = {
                "server": tc["server"],
                "server_port": tc["server_port"],
                "uuid": tc["uuid"],
                "flow": tc["flow"],
                "server_name": tc["server_name"],
                "public_key": tc["public_key"],
                "short_id": tc["short_id"],
                "route_domains": json.loads(tc["route_domains"]),
            }

        return ok({"plan": plan, "code_id": row["code_id"], "tunnel": tunnel})


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8710)
