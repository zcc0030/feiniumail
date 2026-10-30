# -*- coding: utf-8 -*-
"""FeiniuMail HTTP 服务：REST API + 静态前端。

启动参数（由 cmd/main 传入，禁止硬编码路径）：
    --host / --port / --data-dir / --etc-dir / --app-dir / --log-file
"""
import argparse
import base64
import collections
import glob
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import blobstore  # noqa: E402
import db  # noqa: E402
import htmlsanitize  # noqa: E402
import mailfetch  # noqa: E402
import mailparser  # noqa: E402
import mailsend  # noqa: E402
import providers  # noqa: E402
import repo  # noqa: E402
import scheduler  # noqa: E402
import security  # noqa: E402

APP_NAME = u"肥牛邮箱"
APP_VERSION = "1.0.26"
COOKIE_NAME = "fnmail_session"
# HTTP 请求体上限。写信时附件以 base64 随 JSON 提交，体积约为原始大小的 4/3，
# 因此该值必须留出余量：100 MB 附件 -> 约 133 MB，此处取 150 MB。
# 调整时需与 mailsend.MAX_TOTAL_ATTACHMENT 保持一致。
MAX_BODY = 150 * 1024 * 1024


# --------------------------------------------------------------------------- 上下文


class ApiError(Exception):
    def __init__(self, message, status=400):
        Exception.__init__(self, message)
        self.message = message
        self.status = status


class AppContext(object):
    def __init__(self, args):
        self.host = args.host
        self.port = int(args.port)
        self.data_dir = os.path.abspath(args.data_dir)
        self.etc_dir = os.path.abspath(args.etc_dir)
        self.app_dir = os.path.abspath(args.app_dir)
        self.log_file = args.log_file
        self.version = APP_VERSION
        self.started = int(time.time())

        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(os.path.join(self.data_dir, "tmp"), exist_ok=True)

        self.db = db.Database(os.path.join(self.data_dir, "fnmail.db"))
        self.blobs = blobstore.BlobStore(os.path.join(self.data_dir, "mailbox"))
        self.secret = self._load_secret()
        self.sync_state = {}
        self.sync_manager = None
        self.www_dir = self._resolve_www()
        try:
            os.chmod(self.data_dir, 0o700)
        except OSError:
            pass

        self._dedup_legacy_duplicates()

    def _dedup_legacy_duplicates(self):
        """一次性清理历史遗留的重复邮件（同一文件夹、同一 Message-ID）。

        早期版本发信时归档到本地「已发送」的副本没有服务器 uid，IMAP 同步又把这封
        邮件从服务器「已发送」收了回来，于是同一封邮件显示两次。此处只在首次启动时
        合并一次，避免老用户升级后仍然看到重复。
        """
        if self.db.meta_get("dedup_message_id_v1"):
            return
        try:
            removed = repo.dedup_messages_by_message_id(self)
        except Exception as exc:
            self.log("warn", "system", u"合并历史重复邮件失败：%s" % exc)
            return
        self.db.meta_set("dedup_message_id_v1", "1")
        if removed:
            self.log("info", "system", u"已合并历史重复邮件 %d 封" % removed)

    # --- 初始化 ---
    def _load_secret(self):
        path = os.path.join(self.data_dir, "master.key")
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    raw = base64.b64decode(fh.read().strip())
                if len(raw) >= 32:
                    return raw
            except Exception:
                pass
        secret = security.new_secret()
        security.secure_write(path, base64.b64encode(secret).decode("ascii"), 0o600)
        return secret

    def _resolve_www(self):
        candidates = [
            os.path.join(self.app_dir, "www"),
            os.path.join(os.path.dirname(self.app_dir), "www"),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www"),
        ]
        for path in candidates:
            path = os.path.abspath(path)
            if os.path.isdir(path):
                return path
        return os.path.abspath(candidates[0])

    # --- 口令 ---
    @property
    def setup_required(self):
        return not (self.db.meta_get("password_hash") or "")

    @property
    def password_version(self):
        return int(self.db.meta_get("password_version", "0") or 0)

    def set_password(self, password):
        self.db.meta_set("password_hash", security.hash_password(password))
        self.db.meta_set("password_version", str(self.password_version + 1))

    def verify_password(self, password):
        return security.verify_password(password or "", self.db.meta_get("password_hash") or "")

    def issue_token(self):
        return security.issue_session(self.secret, self.password_version)

    def check_token(self, token):
        return security.verify_session(self.secret, token or "", self.password_version)

    # --- 日志 ---
    def log(self, level, source, message):
        line = "%s [%s] %s: %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), level, source, message)
        try:
            print(line, flush=True)
        except Exception:
            pass
        try:
            repo.add_log(self, level, source, message)
        except Exception:
            pass


# --------------------------------------------------------------------------- 工具


def json_dumps(obj):
    return json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")


def check_port(port):
    """端口可用性探测，被占用时尽量返回占用进程信息（需 /proc）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", int(port)))
        return True, ""
    except OSError:
        return False, port_owner(port)
    finally:
        try:
            sock.close()
        except Exception:
            pass


def port_owner(port):
    hexport = "%04X" % int(port)
    inodes = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                next(fh, None)
                for line in fh:
                    parts = line.split()
                    if len(parts) > 9 and parts[1].endswith(":" + hexport) and parts[3] == "0A":
                        inodes.add(parts[9])
        except OSError:
            continue
    if not inodes:
        return ""
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                fds = os.listdir("/proc/%s/fd" % pid)
            except OSError:
                continue
            for fd in fds:
                try:
                    target = os.readlink("/proc/%s/fd/%s" % (pid, fd))
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    try:
                        with open("/proc/%s/comm" % pid, "r", encoding="utf-8", errors="ignore") as fh:
                            name = fh.read().strip()
                    except OSError:
                        name = "unknown"
                    return "%s (PID %s)" % (name, pid)
    except OSError:
        pass
    return ""


def content_disposition(filename, inline=False):
    filename = filename or "attachment"
    try:
        ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "attachment"
    except Exception:
        ascii_name = "attachment"
    ascii_name = ascii_name.replace('"', "_").replace("\\", "_")
    disposition = "inline" if inline else "attachment"
    return "%s; filename=\"%s\"; filename*=UTF-8''%s" % (disposition, ascii_name, quote(filename))


# --------------------------------------------------------------------------- 附件导出
#
# 邮件附件平时只存在于 .eml 内部，没有独立的文件路径，系统无法用默认应用打开它。
# 这里在用户点「用系统默认应用打开」时把附件落到应用声明的共享目录里，再把真实
# 路径交给前端的 fnOS SDK openFile()。共享目录由 config/resource 的 data-share
# 声明，安装后位于 <应用根目录>/shares/ 下。

EXPORT_SHARE_NAME = "fnmail/mailbox"


def export_root(ctx):
    """附件导出目录。

    附件只为「用默认应用打开」而临时落盘：系统需要的是 /vol?/@appshare/…
    这样真实存在的物理路径，所以必须写进 config/resource 声明的共享目录。
    安装卷不固定、shares 下又是软链接，因此按候选顺序探测第一个存在的目录。
    """
    app_root = os.path.dirname(os.path.abspath(ctx.app_dir))
    candidates = [
        os.path.join(app_root, "shares", *EXPORT_SHARE_NAME.split("/")),
        os.path.join(app_root, "shares", EXPORT_SHARE_NAME.split("/")[-1]),
    ]
    candidates.extend(sorted(glob.glob("/vol*/@appshare/" + EXPORT_SHARE_NAME)))
    for base in candidates:
        if os.path.isdir(base):
            return os.path.join(base, "attachments")
    return os.path.join(candidates[0], "attachments")


def safe_filename(name):
    """把附件名收敛成一个安全的单层文件名。"""
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name).strip(". ")
    return (name or "attachment")[:120]


# --------------------------------------------------------------------------- 数据装配


def account_public(row):
    return repo.account_for_client(None, row)


def build_bootstrap(ctx):
    accounts = repo.list_accounts(ctx)
    folders = repo.list_folders(ctx)
    states = {}
    for account in accounts:
        raw = repo.get_account(ctx, account["id"])
        states[str(account["id"])] = ctx.sync_manager.state(account["id"], raw)
    return {
        "app": {
            "name": APP_NAME,
            "version": ctx.version,
            "port": ctx.port,
            "data_dir": ctx.data_dir,
            "started": ctx.started,
        },
        "accounts": accounts,
        "folders": folders,
        "unread": repo.unread_summary(ctx),
        "groups": repo.list_groups(ctx),
        "providers": providers.PROVIDERS,
        "sync": states,
        "now": int(time.time()),
    }


def message_detail(ctx, message_id):
    row = ctx.db.query_one(
        """
        SELECT m.*, f.name AS folder_name, f.kind AS folder_kind, a.email AS account_email
        FROM messages m
        LEFT JOIN folders f ON f.id = m.folder_id
        LEFT JOIN accounts a ON a.id = m.account_id
        WHERE m.id = ?
        """,
        (int(message_id),),
    )
    if row is None:
        raise ApiError(u"邮件不存在或已被删除", 404)
    row["to_list"] = _loads(row.pop("to_addrs", "[]"))
    row["cc_list"] = _loads(row.pop("cc_addrs", "[]"))
    row["bcc_list"] = _loads(row.pop("bcc_addrs", "[]"))
    row["from"] = {"name": row.get("from_name") or "", "addr": row.get("from_addr") or ""}

    parsed = parse_message_cached(ctx, row)
    detail = {
        "id": row["id"],
        "account_id": row["account_id"],
        "folder_id": row["folder_id"],
        "folder_name": row.get("folder_name") or "",
        "folder_kind": row.get("folder_kind") or "",
        "account_email": row.get("account_email") or "",
        "subject": row.get("subject") or "",
        "from": row["from"],
        "to": row["to_list"],
        "cc": row["cc_list"],
        "bcc": row["bcc_list"],
        "reply_to": row.get("reply_to") or "",
        "date_ts": row.get("date_ts") or 0,
        "size": row.get("size") or 0,
        "is_read": row.get("is_read") or 0,
        "is_starred": row.get("is_starred") or 0,
        "is_draft": row.get("is_draft") or 0,
        "message_id": row.get("message_id") or "",
        "attachments": repo.list_attachments(ctx, row["id"]),
        "has_eml": bool(parsed),
        "has_html": False,
        "text": "",
        "preview": row.get("body_preview") or "",
        "remote_images": 0,
    }
    if parsed:
        detail["has_html"] = bool(parsed.get("html"))
        detail["text"] = parsed.get("text") or ""
        detail["in_reply_to"] = parsed.get("in_reply_to") or ""
        detail["references"] = parsed.get("references") or ""
        if parsed.get("html"):
            _fragment, remote = htmlsanitize.sanitize_mail_html(
                parsed["html"], allow_images=False, message_id=row["id"]
            )
            detail["remote_images"] = len(remote)
            detail["remote_image_list"] = remote[:20]
        if row.get("is_draft"):
            detail["draft"] = {
                "to": detail["to"],
                "cc": detail["cc"],
                "bcc": detail["bcc"],
                "subject": detail["subject"],
                "text": detail["text"],
                "html": parsed.get("html") or "",
            }
    return detail


def render_body(ctx, message_id, allow_images, url_suffix):
    row = repo.get_message(ctx, message_id)
    if row is None:
        raise ApiError(u"邮件不存在或已被删除", 404)
    parsed = parse_message_cached(ctx, row)
    if not parsed:
        raise ApiError(u"邮件原文缺失，可能已被手动删除", 404)
    cid_map = {}
    for item in repo.list_attachments(ctx, row["id"]):
        if item.get("content_id"):
            cid_map[item["content_id"].strip().lower()] = item["part_index"]
    if parsed.get("html"):
        fragment, _remote = htmlsanitize.sanitize_mail_html(
            parsed["html"],
            allow_images=allow_images,
            cid_map=cid_map,
            message_id=row["id"],
            url_suffix=url_suffix,
        )
    else:
        fragment = htmlsanitize.text_to_fragment(parsed.get("text") or u"（此邮件没有正文内容）")
    return htmlsanitize.build_document(fragment, row.get("subject") or u"邮件正文")


def _loads(text, default=None):
    try:
        return json.loads(text) if text else (default if default is not None else [])
    except Exception:
        return default if default is not None else []


# --------------------------------------------------------------------------- 解析缓存

# 打开一封邮件会先后请求「详情」与「正文」两个接口，各自解析一次邮件原文。
# 大附件邮件的 MIME 遍历开销明显，这里缓存解析结果，避免同一封邮件重复解析；
# 带过期时间是为了让草稿等被改写过的邮件不会长期返回旧内容。
_PARSE_CACHE = collections.OrderedDict()
_PARSE_CACHE_LOCK = threading.Lock()
_PARSE_CACHE_LIMIT = 6
_PARSE_CACHE_TTL = 120


def parse_message_cached(ctx, row):
    """读取并解析邮件原文，结果在同一次阅读的多个请求之间复用。"""
    if not row or not row.get("eml_path"):
        return None
    key = (int(row["id"]), row.get("eml_path") or "", int(row.get("size") or 0))
    now = time.time()
    with _PARSE_CACHE_LOCK:
        cached = _PARSE_CACHE.get(key)
        if cached is not None:
            if now - cached[0] < _PARSE_CACHE_TTL:
                _PARSE_CACHE.move_to_end(key)
                return cached[1]
            _PARSE_CACHE.pop(key, None)
    raw = ctx.blobs.read(row.get("eml_path"))
    if not raw:
        return None
    parsed = mailparser.parse_message(raw)
    with _PARSE_CACHE_LOCK:
        _PARSE_CACHE[key] = (time.time(), parsed)
        while len(_PARSE_CACHE) > _PARSE_CACHE_LIMIT:
            _PARSE_CACHE.popitem(last=False)
    return parsed


# --------------------------------------------------------------------------- 路由


ROUTES = []


def route(method, pattern, auth=True):
    compiled = re.compile("^" + pattern + "$")

    def decorator(fn):
        ROUTES.append((method, compiled, auth, fn))
        return fn

    return decorator


class Request(object):
    def __init__(self, handler, method, path, query, body, token):
        self.handler = handler
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.token = token
        self.params = {}

    # --- 请求参数 ---
    def json(self):
        if not self.body:
            return {}
        try:
            data = json.loads(self.body.decode("utf-8"))
        except Exception:
            raise ApiError(u"请求数据格式错误（不是合法的 JSON）")
        if not isinstance(data, dict):
            raise ApiError(u"请求数据格式错误（应为对象）")
        return data

    def param(self, name, default=None):
        if name in self.params:
            return self.params[name]
        values = self.query.get(name)
        return values[0] if values else default

    def int_param(self, name, default=None):
        value = self.param(name)
        if value is None or value == "":
            return default
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ApiError(u"参数 %s 必须是整数" % name)

    def require_int(self, name):
        value = self.int_param(name)
        if value is None:
            raise ApiError(u"缺少参数 %s" % name)
        return value

    # --- 响应 ---
    def send_json(self, obj, status=200):
        self.handler.send_bytes(json_dumps(obj), "application/json; charset=utf-8", status)

    def send_error_json(self, message, status=400):
        self.handler.send_bytes(json_dumps({"error": message}), "application/json; charset=utf-8", status)


# --------------------------------------------------------------------------- 会话


@route("GET", r"/api/session", auth=False)
def api_session_state(ctx, req, params):
    token = req.token
    authenticated = bool(token and ctx.check_token(token))
    req.send_json(
        {
            "setup_required": ctx.setup_required,
            "authenticated": authenticated,
            "app": {"name": APP_NAME, "version": ctx.version, "port": ctx.port},
            "now": int(time.time()),
        }
    )


@route("POST", r"/api/session/setup", auth=False)
def api_session_setup(ctx, req, params):
    if not ctx.setup_required:
        raise ApiError(u"访问口令已经设置过了，请直接登录", 409)
    payload = req.json()
    password = (payload.get("password") or "").strip()
    if len(password) < 6:
        raise ApiError(u"口令至少需要 6 位")
    ctx.set_password(password)
    token = ctx.issue_token()
    req.handler.set_cookie(token)
    ctx.log("info", "auth", u"首次访问口令已设置")
    req.send_json({"ok": True, "token": token})


@route("POST", r"/api/session/login", auth=False)
def api_session_login(ctx, req, params):
    if ctx.setup_required:
        raise ApiError(u"尚未设置访问口令", 409)
    payload = req.json()
    password = payload.get("password") or ""
    if not ctx.verify_password(password):
        ctx.log("warn", "auth", u"登录失败：口令错误")
        raise ApiError(u"口令不正确", 401)
    token = ctx.issue_token()
    req.handler.set_cookie(token)
    req.send_json({"ok": True, "token": token})


@route("POST", r"/api/session/logout", auth=False)
def api_session_logout(ctx, req, params):
    req.handler.clear_cookie()
    req.send_json({"ok": True})


@route("POST", r"/api/password")
def api_change_password(ctx, req, params):
    payload = req.json()
    old = payload.get("old_password") or ""
    new = (payload.get("new_password") or "").strip()
    if not ctx.verify_password(old):
        raise ApiError(u"原口令不正确", 401)
    if len(new) < 6:
        raise ApiError(u"新口令至少需要 6 位")
    ctx.set_password(new)
    token = ctx.issue_token()
    req.handler.set_cookie(token)
    ctx.log("info", "auth", u"访问口令已修改，旧会话已失效")
    req.send_json({"ok": True, "token": token})


# --------------------------------------------------------------------------- 概览


@route("GET", r"/api/bootstrap")
def api_bootstrap(ctx, req, params):
    req.send_json(build_bootstrap(ctx))


@route("GET", r"/api/providers")
def api_providers(ctx, req, params):
    req.send_json({"providers": providers.PROVIDERS})


@route("GET", r"/api/env")
def api_env(ctx, req, params):
    req.send_json(
        {
            "app": {"name": APP_NAME, "version": ctx.version, "port": ctx.port},
            "python": sys.version.split()[0],
            "data_dir": ctx.data_dir,
            "www_dir": ctx.www_dir,
            "mailbox_dir": ctx.blobs.root,
            "db_path": ctx.db.path,
            "started": ctx.started,
        }
    )


@route("GET", r"/api/port-check", auth=False)
def api_port_check(ctx, req, params):
    port = req.int_param("port")
    if port is None:
        port = ctx.port
    if port < 1 or port > 65535:
        raise ApiError(u"端口号必须在 1-65535 之间")
    free, owner = check_port(port)
    current = int(port) == int(ctx.port)
    if free:
        message = u"端口 %d 可用" % port
    elif current:
        message = u"端口 %d 正被本应用使用（FeiniuMail 服务端口）" % port
    elif owner:
        message = u"端口 %d 已被占用（占用进程：%s）" % (port, owner)
    else:
        message = u"端口 %d 已被占用" % port
    req.send_json(
        {
            "port": port,
            "free": bool(free),
            "is_current": current,
            "owner": owner,
            "message": message,
        }
    )


# --------------------------------------------------------------------------- 账号


@route("GET", r"/api/accounts")
def api_accounts(ctx, req, params):
    req.send_json({"accounts": repo.list_accounts(ctx)})


@route("POST", r"/api/accounts")
def api_account_create(ctx, req, params):
    payload = req.json()
    if not (payload.get("email") or "").strip():
        raise ApiError(u"请填写邮箱地址")
    payload, provider_id = providers.apply_preset(payload)
    account_id = repo.create_account(ctx, payload)
    ctx.log("info", "account", u"新增账号 %s" % payload.get("email"))
    if payload.get("sync_enabled", True) and ctx.sync_manager:
        ctx.sync_manager.trigger(account_id, manual=True)
    req.send_json({"ok": True, "id": account_id, "provider": provider_id})


@route("GET", r"/api/accounts/(?P<account_id>\d+)")
def api_account_get(ctx, req, params):
    row = repo.get_account(ctx, params["account_id"])
    if row is None:
        raise ApiError(u"账号不存在", 404)
    data = account_public(row)
    if ctx.sync_manager:
        data["sync"] = ctx.sync_manager.state(row["id"], row)
    req.send_json({"account": data})


@route("PUT", r"/api/accounts/(?P<account_id>\d+)")
def api_account_update(ctx, req, params):
    account_id = int(params["account_id"])
    payload = req.json()
    if repo.get_account(ctx, account_id) is None:
        raise ApiError(u"账号不存在", 404)
    repo.update_account(ctx, account_id, payload)
    ctx.log("info", "account", u"更新账号配置 #%d" % account_id)
    req.send_json({"ok": True, "id": account_id})


@route("DELETE", r"/api/accounts/(?P<account_id>\d+)")
def api_account_delete(ctx, req, params):
    account_id = int(params["account_id"])
    purge = req.param("purge") == "1"
    if repo.get_account(ctx, account_id) is None:
        raise ApiError(u"账号不存在", 404)
    repo.delete_account(ctx, account_id, purge=purge)
    ctx.log("info", "account", u"删除账号 #%d（含本地邮件）" % account_id)
    req.send_json({"ok": True})


@route("POST", r"/api/accounts/(?P<account_id>\d+)/sync")
def api_account_sync(ctx, req, params):
    account_id = int(params["account_id"])
    if repo.get_account(ctx, account_id) is None:
        raise ApiError(u"账号不存在", 404)
    started = ctx.sync_manager.trigger(account_id, manual=True) if ctx.sync_manager else False
    req.send_json({"ok": True, "started": started, "state": ctx.sync_manager.state(account_id)})


@route("GET", r"/api/accounts/(?P<account_id>\d+)/sync")
def api_account_sync_state(ctx, req, params):
    account_id = int(params["account_id"])
    row = repo.get_account(ctx, account_id)
    if row is None:
        raise ApiError(u"账号不存在", 404)
    req.send_json({"state": ctx.sync_manager.state(account_id, row)})


@route("POST", r"/api/accounts/(?P<account_id>\d+)/test")
def api_account_test_saved(ctx, req, params):
    account_id = int(params["account_id"])
    row = repo.get_account(ctx, account_id)
    if row is None:
        raise ApiError(u"账号不存在", 404)
    # 不带出已加密的密码字段，未显式填写时由后端回退到已保存的凭据
    payload = {key: value for key, value in row.items() if key not in ("in_password", "out_password")}
    payload["id"] = account_id
    payload.update(req.json())
    result = {}
    try:
        result["incoming"] = mailfetch.test_incoming(ctx, payload)
    except Exception as exc:
        result["incoming_error"] = mailfetch.friendly_error(exc)
    if (payload.get("out_host") or "").strip():
        try:
            result["outgoing"] = mailsend.test_smtp(ctx, payload)
        except Exception as exc:
            result["outgoing_error"] = mailfetch.friendly_error(exc)
    req.send_json({"ok": not (result.get("incoming_error") or result.get("outgoing_error")), **result})


@route("POST", r"/api/accounts/test-incoming", auth=True)
def api_test_incoming(ctx, req, params):
    payload = req.json()
    payload, _provider = providers.apply_preset(payload)
    try:
        message = mailfetch.test_incoming(ctx, payload)
    except Exception as exc:
        raise ApiError(mailfetch.friendly_error(exc))
    req.send_json({"ok": True, "message": message})


@route("POST", r"/api/accounts/test-outgoing")
def api_test_outgoing(ctx, req, params):
    payload = req.json()
    payload, _provider = providers.apply_preset(payload)
    try:
        message = mailsend.test_smtp(ctx, payload)
    except Exception as exc:
        raise ApiError(mailfetch.friendly_error(exc))
    req.send_json({"ok": True, "message": message})


# --------------------------------------------------------------------------- 文件夹


@route("GET", r"/api/folders")
def api_folders(ctx, req, params):
    req.send_json({"folders": repo.list_folders(ctx, account_id=req.int_param("account_id"))})


@route("POST", r"/api/folders")
def api_folder_create(ctx, req, params):
    payload = req.json()
    account_id = payload.get("account_id")
    if not account_id:
        raise ApiError(u"缺少账号")
    name = (payload.get("name") or "").strip()
    try:
        folder_id = repo.create_folder(ctx, int(account_id), name, kind="custom")
    except ValueError as exc:
        raise ApiError(str(exc))
    req.send_json({"ok": True, "id": folder_id})


@route("PUT", r"/api/folders/(?P<folder_id>\d+)")
def api_folder_update(ctx, req, params):
    payload = req.json()
    name = (payload.get("name") or "").strip()
    if not name:
        raise ApiError(u"文件夹名称不能为空")
    if repo.get_folder(ctx, params["folder_id"]) is None:
        raise ApiError(u"文件夹不存在", 404)
    repo.rename_folder(ctx, params["folder_id"], name)
    req.send_json({"ok": True})


@route("DELETE", r"/api/folders/(?P<folder_id>\d+)")
def api_folder_delete(ctx, req, params):
    try:
        ok = repo.delete_folder(ctx, params["folder_id"])
    except ValueError as exc:
        raise ApiError(str(exc))
    if not ok:
        raise ApiError(u"文件夹不存在", 404)
    req.send_json({"ok": True})


@route("POST", r"/api/folders/(?P<folder_id>\d+)/empty")
def api_folder_empty(ctx, req, params):
    count = repo.empty_folder(ctx, params["folder_id"])
    ctx.log("info", "folder", u"清空文件夹 #%s，删除 %d 封邮件" % (params["folder_id"], count))
    req.send_json({"ok": True, "deleted": count})


# --------------------------------------------------------------------------- 邮件


@route("GET", r"/api/messages")
def api_messages(ctx, req, params):
    result = repo.list_messages(
        ctx,
        folder_id=req.int_param("folder_id"),
        account_id=req.int_param("account_id"),
        kind=req.param("kind"),
        query=req.param("q"),
        filter_by=req.param("filter", "all"),
        page=req.int_param("page", 1),
        size=req.int_param("size", 50),
    )
    req.send_json(result)


@route("GET", r"/api/messages/(?P<message_id>\d+)")
def api_message_get(ctx, req, params):
    req.send_json({"message": message_detail(ctx, params["message_id"])})


@route("GET", r"/api/messages/(?P<message_id>\d+)/body")
def api_message_body(ctx, req, params):
    allow_images = req.param("images") == "1"
    suffix = "?inline=1&_t=%s" % quote(req.token or "")
    document = render_body(ctx, params["message_id"], allow_images, suffix)
    req.handler.send_bytes(document, "text/html; charset=utf-8")


@route("GET", r"/api/messages/(?P<message_id>\d+)/raw")
def api_message_raw(ctx, req, params):
    row = repo.get_message(ctx, params["message_id"])
    if row is None:
        raise ApiError(u"邮件不存在", 404)
    raw = ctx.blobs.read(row.get("eml_path"))
    if not raw:
        raise ApiError(u"邮件原文缺失", 404)
    name = "%s.eml" % (row.get("subject") or ("message-%s" % row["id"]))[:80]
    req.handler.send_bytes(
        raw,
        "message/rfc822",
        extra_headers={"Content-Disposition": content_disposition(name)},
    )


@route("GET", r"/api/messages/(?P<message_id>\d+)/parts/(?P<index>\d+)")
def api_message_part(ctx, req, params):
    row = repo.get_message(ctx, params["message_id"])
    if row is None:
        raise ApiError(u"邮件不存在", 404)
    raw = ctx.blobs.read(row.get("eml_path"))
    if not raw:
        raise ApiError(u"邮件原文缺失", 404)
    part = mailparser.part_payload_safe(raw, int(params["index"]))
    if part is None:
        raise ApiError(u"附件不存在", 404)
    inline = req.param("inline") == "1"
    headers = {"Content-Disposition": content_disposition(part["filename"], inline=inline)}
    req.handler.send_bytes(part["data"], part["content_type"] or "application/octet-stream", extra_headers=headers)


@route("POST", r"/api/messages/(?P<message_id>\d+)/parts/(?P<index>\d+)/export")
def api_message_part_export(ctx, req, params):
    """把附件落成一个真实文件，返回它的绝对路径，供系统用默认应用打开。"""
    row = repo.get_message(ctx, params["message_id"])
    if row is None:
        raise ApiError(u"邮件不存在", 404)
    raw = ctx.blobs.read(row.get("eml_path"))
    if not raw:
        raise ApiError(u"邮件原文缺失", 404)
    part = mailparser.part_payload_safe(raw, int(params["index"]))
    if part is None:
        raise ApiError(u"附件不存在", 404)

    name = safe_filename(part["filename"])
    folder = os.path.join(export_root(ctx), "%s_%s" % (row["id"], params["index"]))
    try:
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, name)
        with open(target, "wb") as fh:
            fh.write(part["data"])
    except OSError as exc:
        raise ApiError(u"导出附件失败：%s" % exc, 500)
    req.send_json({"path": os.path.realpath(target), "name": name, "size": len(part["data"])})


@route("POST", r"/api/messages/(?P<message_id>\d+)/read")
def api_message_read(ctx, req, params):
    payload = req.json()
    is_read = payload.get("is_read", True)
    repo.mark_read(ctx, params["message_id"], bool(is_read))
    req.send_json({"ok": True})


@route("POST", r"/api/messages/(?P<message_id>\d+)/star")
def api_message_star(ctx, req, params):
    payload = req.json()
    is_starred = payload.get("is_starred", True)
    repo.mark_starred(ctx, params["message_id"], bool(is_starred))
    req.send_json({"ok": True})


@route("POST", r"/api/messages/(?P<message_id>\d+)/move")
def api_message_move(ctx, req, params):
    payload = req.json()
    folder_id = payload.get("folder_id")
    if not folder_id:
        raise ApiError(u"缺少目标文件夹")
    if repo.get_folder(ctx, folder_id) is None:
        raise ApiError(u"目标文件夹不存在", 404)
    repo.move_message(ctx, params["message_id"], folder_id)
    req.send_json({"ok": True})


@route("POST", r"/api/messages/(?P<message_id>\d+)/delete")
def api_message_delete(ctx, req, params):
    if not repo.delete_message(ctx, params["message_id"]):
        raise ApiError(u"邮件不存在", 404)
    req.send_json({"ok": True})


@route("POST", r"/api/messages/batch")
def api_messages_batch(ctx, req, params):
    payload = req.json()
    action = payload.get("action") or ""
    try:
        count = repo.batch_update(ctx, payload.get("ids") or [], action, folder_id=payload.get("folder_id"))
    except ValueError as exc:
        raise ApiError(str(exc))
    ctx.log("info", "message", u"批量操作 %s，影响 %d 封" % (action, count))
    req.send_json({"ok": True, "affected": count})


@route("POST", r"/api/messages/send")
def api_message_send(ctx, req, params):
    payload = req.json()
    account_id = payload.get("account_id")
    if not account_id:
        raise ApiError(u"请先选择发件账号")
    draft_id = payload.get("draft_id")
    if draft_id:
        existing = repo.get_message(ctx, draft_id)
        if existing is not None and existing.get("is_draft"):
            repo.delete_message(ctx, existing["id"])
    try:
        result = mailsend.send_mail(ctx, int(account_id), payload)
    except mailsend.SendError as exc:
        ctx.log("error", "smtp", u"发信失败：%s" % exc)
        raise ApiError(str(exc))
    req.send_json(result)


@route("POST", r"/api/drafts")
def api_draft_save(ctx, req, params):
    payload = req.json()
    account_id = payload.get("account_id")
    if not account_id:
        raise ApiError(u"请先选择账号")
    try:
        result = mailsend.save_draft(ctx, int(account_id), payload, draft_id=payload.get("draft_id"))
    except mailsend.SendError as exc:
        raise ApiError(str(exc))
    req.send_json(result)


@route("GET", r"/api/drafts/(?P<message_id>\d+)")
def api_draft_get(ctx, req, params):
    try:
        payload = mailsend.draft_to_payload(ctx, params["message_id"])
    except mailsend.SendError as exc:
        raise ApiError(str(exc), 404)
    req.send_json({"draft": payload})


# --------------------------------------------------------------------------- 通讯录


@route("GET", r"/api/contacts")
def api_contacts(ctx, req, params):
    contacts = repo.list_contacts(
        ctx,
        query=req.param("q"),
        group=req.param("group"),
        favorite=(req.param("favorite") == "1"),
    )
    req.send_json({"contacts": contacts, "groups": repo.list_groups(ctx)})


@route("POST", r"/api/contacts")
def api_contact_create(ctx, req, params):
    payload = req.json()
    if not (payload.get("email") or "").strip() and not (payload.get("name") or "").strip():
        raise ApiError(u"请至少填写姓名或邮箱")
    contact_id = repo.create_contact(ctx, payload)
    req.send_json({"ok": True, "id": contact_id})


@route("PUT", r"/api/contacts/(?P<contact_id>\d+)")
def api_contact_update(ctx, req, params):
    payload = req.json()
    if repo.get_contact(ctx, params["contact_id"]) is None:
        raise ApiError(u"联系人不存在", 404)
    repo.update_contact(ctx, params["contact_id"], payload)
    req.send_json({"ok": True})


@route("DELETE", r"/api/contacts/(?P<contact_id>\d+)")
def api_contact_delete(ctx, req, params):
    repo.delete_contact(ctx, params["contact_id"])
    req.send_json({"ok": True})


@route("POST", r"/api/contacts/batch")
def api_contacts_batch(ctx, req, params):
    payload = req.json()
    action = payload.get("action")
    if action != "delete":
        raise ApiError(u"不支持的批量操作")
    count = repo.delete_contacts(ctx, payload.get("ids") or [])
    req.send_json({"ok": True, "affected": count})


@route("POST", r"/api/contacts/import")
def api_contacts_import(ctx, req, params):
    payload = req.json()
    rows = payload.get("contacts")
    if not isinstance(rows, list):
        raise ApiError(u"导入数据格式不正确，应为联系人数组")
    if len(rows) > 5000:
        raise ApiError(u"单次最多导入 5000 个联系人，请分批导入")
    result = repo.import_contacts(ctx, rows)
    ctx.log(
        "info",
        "contact",
        u"导入通讯录：新增 %d，更新 %d，跳过 %d" % (result["added"], result["updated"], result["skipped"]),
    )
    req.send_json(dict({"ok": True}, **result))


@route("POST", r"/api/contacts/harvest")
def api_contacts_harvest(ctx, req, params):
    payload = req.json()
    result = repo.harvest_contacts_from_mail(ctx, account_id=payload.get("account_id"))
    ctx.log("info", "contact", u"从邮件中收集联系人：新增 %d，已存在 %d" % (result["added"], result["skipped"]))
    req.send_json({"ok": True, **result})


@route("GET", r"/api/contact-groups")
def api_contact_groups(ctx, req, params):
    req.send_json({"groups": repo.list_groups(ctx)})


@route("POST", r"/api/contact-groups")
def api_contact_group_create(ctx, req, params):
    payload = req.json()
    try:
        group_id = repo.create_group(ctx, payload.get("name"))
    except ValueError as exc:
        raise ApiError(str(exc))
    req.send_json({"ok": True, "id": group_id})


@route("PUT", r"/api/contact-groups/(?P<group_id>\d+)")
def api_contact_group_update(ctx, req, params):
    payload = req.json()
    try:
        ok = repo.rename_group(ctx, params["group_id"], payload.get("name"))
    except ValueError as exc:
        raise ApiError(str(exc))
    if not ok:
        raise ApiError(u"分组不存在", 404)
    req.send_json({"ok": True})


@route("DELETE", r"/api/contact-groups/(?P<group_id>\d+)")
def api_contact_group_delete(ctx, req, params):
    if not repo.delete_group(ctx, params["group_id"]):
        raise ApiError(u"分组不存在", 404)
    req.send_json({"ok": True})


# --------------------------------------------------------------------------- 日志


@route("GET", r"/api/logs")
def api_logs(ctx, req, params):
    limit = req.int_param("limit", 200) or 200
    req.send_json({"logs": repo.list_logs(ctx, limit=min(1000, max(1, limit)))})


# --------------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "FeiniuMail/" + APP_VERSION
    protocol_version = "HTTP/1.1"
    ctx = None

    # --- 基础 ---
    def log_message(self, fmt, *args):  # 屏蔽默认的每请求日志
        return

    def _token(self, query):
        header = self.headers.get("Authorization") or ""
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        cookie = self.headers.get("Cookie") or ""
        for chunk in cookie.split(";"):
            name, _, value = chunk.strip().partition("=")
            if name == COOKIE_NAME:
                return value
        values = query.get("_t")
        if values:
            return values[0]
        return ""

    def set_cookie(self, token):
        self._cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
            COOKIE_NAME,
            token,
            security.SESSION_TTL,
        )

    def clear_cookie(self):
        self._cookie = "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % COOKIE_NAME

    def send_bytes(self, data, content_type, status=200, extra_headers=None):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        cookie = getattr(self, "_cookie", None)
        if cookie:
            self.send_header("Set-Cookie", cookie)
            self._cookie = None
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        cookie = getattr(self, "_cookie", None)
        if cookie:
            self.send_header("Set-Cookie", cookie)
            self._cookie = None
        self.end_headers()

    # --- 分发 ---
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        ctx = self.ctx
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._send_error(u"请求体过大", 413)
            return
        body = self.rfile.read(length) if length else b""
        token = self._token(query)

        if path.startswith("/api/"):
            self._handle_api(ctx, method, path, query, body, token)
            return
        self._handle_static(method, path)

    def _handle_api(self, ctx, method, path, query, body, token):
        allowed = []
        for route_method, pattern, needs_auth, handler in ROUTES:
            match = pattern.match(path)
            if not match:
                continue
            if route_method != method:
                allowed.append(route_method)
                continue
            if needs_auth:
                payload = ctx.check_token(token)
                if payload is None:
                    self._send_error(
                        u"访问口令未设置，请先完成初始化" if ctx.setup_required else u"登录状态已失效，请重新登录",
                        401 if not ctx.setup_required else 428,
                    )
                    return
            request = Request(self, method, path, query, body, token)
            request.params = {key: value for key, value in match.groupdict().items()}
            try:
                handler(ctx, request, request.params)
            except ApiError as exc:
                self._send_error(exc.message, exc.status)
            except BrokenPipeError:
                pass
            except Exception as exc:
                ctx.log("error", "api", u"%s %s 处理失败：%s" % (method, path, traceback.format_exc(limit=3)))
                self._send_error(u"服务器内部错误：%s" % exc, 500)
            return
        if allowed:
            self._send_error(u"请求方法不被支持：%s" % method, 405)
            return
        self._send_error(u"接口不存在：%s" % path, 404)

    def _send_error(self, message, status=400):
        self.send_bytes(json_dumps({"error": message}), "application/json; charset=utf-8", status)

    # --- 静态资源 ---
    def _static_target(self, rel):
        """在 www 目录与 ui 目录中查找静态资源，返回绝对路径或 None。"""
        ctx = self.ctx
        roots = [ctx.www_dir, os.path.join(ctx.app_dir, "ui")]
        for root in roots:
            root = os.path.normpath(root)
            target = os.path.normpath(os.path.join(root, rel))
            if target != root and not target.startswith(root + os.sep):
                continue
            if os.path.isfile(target):
                return target
        return None

    def _handle_static(self, method, path):
        ctx = self.ctx
        if method != "GET":
            self._send_error(u"不支持的请求方法", 405)
            return
        if path in ("/", "/index.html"):
            rel = "index.html"
        elif path == "/favicon.ico":
            rel = "images/icon_64.png"
        else:
            rel = path.lstrip("/")
        target = self._static_target(rel)
        if target is None and not os.path.splitext(rel)[1]:
            target = self._static_target("index.html")
        if target is None:
            self._send_error(u"页面不存在：%s" % path, 404)
            return
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            self._send_error(u"读取资源失败", 500)
            return
        headers = {}
        if rel in ("index.html",) or ctype.startswith("text/html"):
            headers["Cache-Control"] = "no-store"
        self.send_bytes(data, ctype, extra_headers=headers)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, ctx):
        ThreadingHTTPServer.__init__(self, address, handler)
        self.ctx = ctx


# --------------------------------------------------------------------------- 入口


def parse_args(argv):
    parser = argparse.ArgumentParser(description="FeiniuMail 服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7300)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--etc-dir", required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--log-file", default="")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    ctx = AppContext(args)
    Handler.ctx = ctx

    ctx.log(
        "info",
        "server",
        u"FeiniuMail %s 启动：host=%s port=%s data=%s www=%s python=%s"
        % (APP_VERSION, ctx.host, ctx.port, ctx.data_dir, ctx.www_dir, sys.version.split()[0]),
    )

    ctx.sync_manager = scheduler.SyncManager(ctx)
    ctx.sync_manager.start()
    ctx.log("info", "scheduler", u"后台收信调度已启动")

    server = Server((ctx.host, ctx.port), Handler, ctx)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            ctx.sync_manager.stop()
        except Exception:
            pass
        ctx.log("info", "server", u"FeiniuMail 服务已退出")
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
