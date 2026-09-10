"""账号服务 2.0 — 安全原语
任务: todo_a200a3b30119 [P0] 2.0-A3
- argon2id 密码哈希
- api_key 生成; Fernet(MASTER_KEY) 加密存储(不落明文, 可解密验HMAC)
- HMAC-SHA256 请求签名: method|path|account_id|ts|body_sha256, ±60s 防重放
规格: docs/2.0-账号服务认证协议设计.md §三
"""
import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

SIGN_WINDOW_SEC = 60

ph = PasswordHasher()
_fernet: Fernet | None = None


def _key() -> Fernet:
    global _fernet
    if _fernet is None:
        import os
        master = os.environ.get("MASTER_KEY", "master-key-dev-only")
        digest = hashlib.sha256(master.encode()).digest()
        _fernet = Fernet(base64.urlsafe_b64encode(digest))
    return _fernet


# ---------- 密码 ----------
def hash_password(pw: str) -> str:
    return ph.hash(pw)


def verify_password(pw_hash: str, pw: str) -> bool:
    try:
        ph.verify(pw_hash, pw)
        return True
    except VerifyMismatchError:
        return False


# ---------- api_key ----------
def new_api_key() -> str:
    return "sk_live_" + secrets.token_urlsafe(32)


def encrypt_api_key(key: str) -> str:
    return _key().encrypt(key.encode()).decode()


def decrypt_api_key(enc: str) -> str:
    return _key().decrypt(enc.encode()).decode()


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_account_id() -> str:
    return "acc_" + secrets.token_hex(8)


def new_session_id() -> str:
    return "sess_" + secrets.token_hex(8)


# ---------- HMAC 签名 ----------
def compute_signature(api_key: str, method: str, path: str,
                      account_id: str, ts: str, bsha: str) -> str:
    sig_input = f"{method.upper()}|{path}|{account_id}|{ts}|{bsha}"
    return hmac.new(api_key.encode(), sig_input.encode(), hashlib.sha256).hexdigest()


class AuthError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def verify_timestamp(ts: str) -> bool:
    try:
        t = datetime.fromisoformat(ts)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        delta = abs((datetime.now(timezone.utc) - t).total_seconds())
        return delta <= SIGN_WINDOW_SEC
    except (ValueError, TypeError):
        return False


def verify_request(headers, raw_body: bytes, method: str, path: str,
                   api_key_enc: str) -> None:
    """headers: starlette Headers。校验失败抛 AuthError。"""
    account_id = headers.get("x-account-id", "")
    ts = headers.get("x-sign-timestamp", "")
    sig = headers.get("x-signature", "")
    if not (account_id and ts and sig):
        raise AuthError("ERR_AUTH", "缺少 X-Account-Id / X-Sign-Timestamp / X-Signature")
    if not verify_timestamp(ts):
        raise AuthError("ERR_AUTH", "时间戳超窗±60s")
    key = decrypt_api_key(api_key_enc)
    expected = compute_signature(key, method, path, account_id, ts,
                                 hashlib.sha256(raw_body or b"").hexdigest())
    if not hmac.compare_digest(expected, sig):
        raise AuthError("ERR_SIG", "签名验证失败")
