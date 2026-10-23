# -*- coding: utf-8 -*-
"""口令哈希、凭据加解密与会话令牌。

设计说明：
- 登录口令使用 scrypt 派生后加盐存储，不可逆。
- 邮箱密码等敏感字段使用「HMAC-SHA256 计数器模式密钥流 + Encrypt-then-MAC」加密，
  主密钥随机生成并保存在应用私有数据库中（文件权限 600）。
- 会话令牌为 HMAC 签名的自包含令牌，服务重启后仍然有效，
  修改口令会递增 pv（口令版本）从而让所有旧令牌立即失效。
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

SCRYPT_N = 1 << 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SESSION_TTL = 7 * 24 * 3600


def b64e(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64d(text):
    text = text.strip()
    text += "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN
    )
    return "scrypt$%d$%s$%s" % (SCRYPT_N, b64e(salt), b64e(dk))


def verify_password(password, encoded):
    if not encoded:
        return False
    try:
        algo, n, salt, dk = encoded.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(
            password.encode("utf-8"),
            salt=b64d(salt),
            n=int(n),
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=SCRYPT_DKLEN,
        )
        return hmac.compare_digest(calc, b64d(dk))
    except Exception:
        return False


def new_secret():
    return secrets.token_bytes(32)


def _keystream(key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def encrypt_str(key, plaintext):
    if not plaintext:
        return ""
    data = plaintext.encode("utf-8")
    nonce = secrets.token_bytes(16)
    stream = _keystream(key, nonce, len(data))
    cipher = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(key, b"fnmail-tag" + nonce + cipher, hashlib.sha256).digest()[:16]
    return "v1$" + b64e(nonce + cipher + tag)


def decrypt_str(key, blob):
    if not blob:
        return ""
    if not blob.startswith("v1$"):
        return ""
    raw = b64d(blob[3:])
    if len(raw) < 32:
        return ""
    nonce, rest = raw[:16], raw[16:]
    cipher, tag = rest[:-16], rest[-16:]
    expect = hmac.new(key, b"fnmail-tag" + nonce + cipher, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, expect):
        raise ValueError("凭据解密失败：数据损坏或主密钥已变更，请重新填写邮箱密码。")
    stream = _keystream(key, nonce, len(cipher))
    return bytes(a ^ b for a, b in zip(cipher, stream)).decode("utf-8")


def issue_session(key, password_version, ttl=SESSION_TTL, now=None):
    now = int(now if now is not None else time.time())
    payload = {"pv": int(password_version), "iat": now, "exp": now + int(ttl), "n": secrets.token_hex(8)}
    body = b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(key, b"fnmail-session:" + body.encode("ascii"), hashlib.sha256).digest()
    return body + "." + b64e(sig)


def verify_session(key, token, password_version, now=None):
    if not token or "." not in token:
        return None
    body, _, sig = token.partition(".")
    expect = hmac.new(key, b"fnmail-session:" + body.encode("ascii"), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(b64d(sig), expect):
            return None
        payload = json.loads(b64d(body).decode("utf-8"))
    except Exception:
        return None
    now = int(now if now is not None else time.time())
    if int(payload.get("exp", 0)) < now:
        return None
    if int(payload.get("pv", -1)) != int(password_version):
        return None
    return payload


def secure_write(path, data, mode=0o600):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(data)
    try:
        os.chmod(tmp, mode)
    except OSError:
        pass
    os.replace(tmp, path)
