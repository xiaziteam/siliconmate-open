"""账号服务 2.0 — 会话健康巡检后台任务 (A5)
任务: todo_a200a5b30131 [P1]
- 每30s扫描sessions表刷新 active→stale→dead 状态(海龟协议90s判死/5min死亡)
- PROBE_ENABLED=1 时对active session抽样探活 chatgpt.com/api/auth/session:
  401/403 直接判dead(不等心跳超时)
- 异常写日志 logs/service.log (不含token明文)
"""
import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

import models
from models import DEAD_AFTER_SEC, get_db, refresh_session_statuses

INSPECT_INTERVAL_SEC = int(os.environ.get("INSPECT_INTERVAL", "30"))
PROBE_ENABLED = os.environ.get("PROBE_ENABLED", "0") == "1"
PROBE_TIMEOUT_SEC = float(os.environ.get("PROBE_TIMEOUT", "8"))
PROBE_URL = "https://chatgpt.com/api/auth/session"

os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    handlers=[logging.FileHandler("logs/service.log"), logging.StreamHandler()],
)
log = logging.getLogger("inspector")

# 探活结果回调钩子(A6部署后可挂告警/聊天室通知)
on_dead_hooks = []


def _mask_cookie(cookie_val: str) -> str:
    return cookie_val[:8] + "...<masked>" if len(cookie_val) > 8 else "<masked>"


async def probe_session(sess) -> str | None:
    """GET chatgpt.com/api/auth/session。返回'alive'|'dead'|None(网络错误)。"""
    cookies = json.loads(sess["cookies_json"] or "{}")
    if not cookies:
        return None
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SEC) as client:
            r = await client.get(PROBE_URL, cookies=cookies, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Authorization": f"Bearer {sess['access_token']}",
            })
    except Exception as e:
        log.warning("probe %s network error: %s", sess["session_id"], str(e)[:120])
        return None
    if r.status_code in (401, 403):
        return "dead"
    if r.status_code == 200:
        try:
            body = r.json()
        except Exception:
            return None
        # ChatGPT session接口: 未登录返回 {} 或 user=null
        if isinstance(body, dict) and body.get("user"):
            return "alive"
    return None


async def inspect_once():
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_db() as conn:
        refresh_session_statuses(conn)  # 惰性→主动巡检
        newly_stale = conn.execute(
            "SELECT session_id,account_id FROM sessions WHERE status='stale'"
            " AND last_heartbeat>0").fetchall()
        if newly_stale:
            log.warning("[stale] %d session超90s无心跳: %s",
                        len(newly_stale),
                        ",".join(r["session_id"] for r in newly_stale[:10]))
        if PROBE_ENABLED:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE status='active' LIMIT 20").fetchall()
            for sess in rows:
                verdict = await probe_session(sess)
                if verdict == "dead":
                    conn.execute(
                        "UPDATE sessions SET status='dead' WHERE session_id=?",
                        (sess["session_id"],))
                    conn.execute(
                        "INSERT OR IGNORE INTO quarantined_sessions(session_id,quarantined_at)"
                        " VALUES(?,?)", (sess["session_id"], now_iso))
                    log.error("[dead] %s (account=%s) ChatGPT探活判死",
                              sess["session_id"], sess["account_id"])
                    for hook in on_dead_hooks:
                        try:
                            hook(sess["session_id"], sess["account_id"])
                        except Exception as e:
                            log.warning("hook error: %s", e)
                elif verdict == "alive":
                    log.info("[alive] %s 探活正常", sess["session_id"])
        dead_cnt = conn.execute(
            "SELECT COUNT(*) c FROM sessions WHERE status='dead'").fetchone()["c"]
        if dead_cnt:
            log.info("[pool] 当前dead=%d (含历史)", dead_cnt)


async def inspector_loop(stop_event: asyncio.Event):
    log.info("inspector启动 interval=%ds probe=%s", INSPECT_INTERVAL_SEC, PROBE_ENABLED)
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(inspect_once(), timeout=INSPECT_INTERVAL_SEC - 1)
        except asyncio.TimeoutError:
            log.warning("inspect单轮超时(%ds), 跳过", INSPECT_INTERVAL_SEC)
        except Exception as e:
            log.exception("inspect异常: %s", e)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=INSPECT_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass


def start_inspector(app):
    stop = asyncio.Event()
    app.state.inspector_stop = stop
    app.state.inspector_task = asyncio.get_event_loop().create_task(
        inspector_loop(stop))


def stop_inspector(app):
    if hasattr(app.state, "inspector_stop"):
        app.state.inspector_stop.set()
