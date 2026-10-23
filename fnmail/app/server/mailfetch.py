# -*- coding: utf-8 -*-
"""邮件收取：POP3 与 IMAP 双协议同步引擎。"""
import base64
import imaplib
import os
import poplib
import re
import socket
import ssl
import time

import mailparser
import repo

SYNC_TIME_BUDGET = 240
POP3_BATCH = 200
IMAP_BATCH = 300
FLAG_REFRESH_LIMIT = 200
SOCKET_TIMEOUT = 45

SPECIAL_USE = {
    "\\sent": "sent",
    "\\drafts": "drafts",
    "\\trash": "trash",
    "\\junk": "junk",
    "\\archive": "archive",
    "\\all": "archive",
}

NAME_HINTS = (
    (("inbox", u"收件箱", u"收件"), "inbox"),
    (("sent items", "sent messages", "sent-mail", "sent", u"已发送"), "sent"),
    (("drafts", "draft", u"草稿"), "drafts"),
    (("deleted items", "deleted messages", "trash", "deleted", u"已删除", u"废纸篓"), "trash"),
    (("junk", "spam", "bulk mail", u"垃圾"), "junk"),
    (("archive", "all mail", u"归档"), "archive"),
)


class FetchError(Exception):
    pass


# --------------------------------------------------------------------------- 通用


def friendly_error(exc):
    text = str(exc) or exc.__class__.__name__
    # imaplib/poplib 的异常文本是服务端响应行的 bytes 表示，形如 b'-ERR Login fail...'
    if len(text) > 2 and text[0] == "b" and text[1] in ("'", '"') and text[-1] == text[1]:
        text = text[2:-1]
    lowered = text.lower()
    if ("fail" in lowered or "invalid" in lowered or "denied" in lowered or "incorrect" in lowered) and (
        "auth" in lowered or "login" in lowered or "password" in lowered
    ):
        return u"账号或密码不正确，请确认使用的是邮箱授权码而不是登录密码。（%s）" % text
    if "certificate" in lowered or "ssl" in lowered:
        return u"SSL/TLS 证书校验失败：如果是自建服务器，可在账号设置中开启「允许自签名证书」。（%s）" % text
    if "timed out" in lowered or "timeout" in lowered:
        return u"连接超时，请检查服务器地址、端口与网络。（%s）" % text
    if "refused" in lowered:
        return u"服务器拒绝连接，请确认端口与协议（SSL / STARTTLS）是否匹配。（%s）" % text
    if "name or service not known" in lowered or "getaddrinfo" in lowered or "nodename" in lowered:
        return u"无法解析服务器域名，请检查收/发件服务器地址。（%s）" % text
    return text


def _ssl_context(allow_insecure):
    context = ssl.create_default_context()
    if allow_insecure:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def _require(account, keys, label):
    for key in keys:
        if not (account.get(key) or "").strip() if isinstance(account.get(key), str) else not account.get(key):
            raise FetchError(u"%s配置不完整：缺少%s" % (label, key))


def _prepare(ctx, account):
    row = dict(account)
    creds = repo.account_credentials(ctx, row)
    return row, creds


# --------------------------------------------------------------------------- POP3


def _pop3_connect(row, creds):
    host = (row.get("in_host") or "").strip()
    port = int(row.get("in_port") or 995)
    if not host:
        raise FetchError(u"未填写 POP3 服务器地址")
    if not creds.get("user"):
        raise FetchError(u"未填写邮箱账号")
    context = _ssl_context(row.get("in_allow_insecure"))
    security = row.get("in_security") or "ssl"
    if security == "ssl":
        conn = poplib.POP3_SSL(host, port, timeout=SOCKET_TIMEOUT, context=context)
    else:
        conn = poplib.POP3(host, port, timeout=SOCKET_TIMEOUT)
        if security == "starttls":
            try:
                conn.stls(context=context)
            except poplib.error_proto as exc:
                raise FetchError(u"服务器不支持 STARTTLS，或需要改用 SSL 端口 995。（%s）" % exc)
    try:
        conn.user(creds["user"])
        conn.pass_(creds["password"])
    except poplib.error_proto as exc:
        try:
            conn.quit()
        except Exception:
            pass
        raise FetchError(friendly_error(exc))
    return conn


def test_pop3(row, creds):
    conn = _pop3_connect(row, creds)
    try:
        count, total_size = conn.stat()
        return u"连接成功：服务器上共有 %d 封邮件（约 %.1f MB）" % (count, total_size / 1024.0 / 1024.0)
    finally:
        try:
            conn.quit()
        except Exception:
            pass


def _pop3_uidl_map(conn):
    try:
        _resp, listing, _octets = conn.uidl()
    except poplib.error_proto as exc:
        raise FetchError(u"服务器不支持 UIDL 命令，无法做增量收取。建议改用 IMAP 协议。（%s）" % exc)
    pairs = []
    for line in listing or []:
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            number = int(parts[0])
        except ValueError:
            continue
        pairs.append((number, parts[1].decode("ascii", "replace")))
    return pairs


def sync_pop3(ctx, account_id, progress=None):
    row, creds = _prepare(ctx, repo.get_account(ctx, account_id))
    inbox = repo.find_folder(ctx, row["id"], kind="inbox")
    if inbox is None:
        inbox = repo.find_folder(ctx, row["id"], name=u"收件箱")
    if inbox is None:
        raise FetchError(u"账号缺少收件箱文件夹，请重新保存账号配置。")

    keep_server = bool(row.get("pop3_keep_server"))
    conn = _pop3_connect(row, creds)
    fetched = 0
    failed = 0
    delete_list = []
    started = time.time()
    try:
        count, total_size = conn.stat()
        if progress:
            progress(u"已连接 POP3", u"服务器上共 %d 封邮件" % count, 0, count)
        pairs = _pop3_uidl_map(conn)
        known = repo.message_uid_index(ctx, row["id"], inbox["id"])
        pending = [item for item in pairs if item[1] not in known]
        if progress:
            progress(u"比对完成", u"发现 %d 封新邮件" % len(pending), 0, max(1, len(pending)))

        while pending:
            batch, pending = pending[:POP3_BATCH], pending[POP3_BATCH:]
            for number, uid in batch:
                if time.time() - started > SYNC_TIME_BUDGET:
                    pending = []
                    break
                try:
                    _resp, lines, _octets = conn.retr(number)
                except poplib.error_proto as exc:
                    failed += 1
                    repo.add_log(ctx, "warn", "pop3", u"读取邮件失败 uid=%s: %s" % (uid, exc))
                    continue
                raw = b"\r\n".join(lines)
                parsed = mailparser.parse_message(raw)
                parse_ok = True
                try:
                    repo.store_message(
                        ctx,
                        row["id"],
                        inbox["id"],
                        inbox["kind"],
                        uid,
                        parsed,
                        raw,
                        blob_key=uid,
                        prefix="p",
                    )
                    fetched += 1
                except Exception as exc:  # 单封邮件失败不影响整体
                    parse_ok = False
                    failed += 1
                    repo.add_log(ctx, "error", "pop3", u"归档邮件失败 uid=%s: %s" % (uid, exc))
                if parse_ok and not keep_server:
                    delete_list.append(number)
                if progress:
                    progress(
                        u"正在收取邮件",
                        parsed.get("subject") or u"(无主题)",
                        fetched + failed,
                        fetched + failed + len(pending) + len(batch),
                    )
    finally:
        try:
            if delete_list and not keep_server:
                for number in delete_list:
                    try:
                        conn.dele(number)
                    except Exception:
                        pass
            conn.quit()
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
    return {
        "protocol": "pop3",
        "fetched": fetched,
        "failed": failed,
        "server_total": count,
        "server_size": total_size,
        "deleted_from_server": len(delete_list) if not keep_server else 0,
    }


# --------------------------------------------------------------------------- IMAP


def imap_utf7_decode(value):
    if isinstance(value, bytes):
        value = value.decode("ascii", "replace")
    result = []
    index = 0
    length = len(value)
    while index < length:
        char = value[index]
        if char != "&":
            result.append(char)
            index += 1
            continue
        end = value.find("-", index)
        if end < 0:
            end = length
        chunk = value[index + 1 : end]
        if chunk == "":
            result.append("&")
        else:
            padded = chunk.replace(",", "/")
            padded += "=" * (-len(padded) % 4)
            try:
                result.append(base64.b64decode(padded).decode("utf-16-be"))
            except Exception:
                result.append(chunk)
        index = end + 1
    return "".join(result)


def imap_utf7_encode(value):
    result = []
    buffer = []

    def flush():
        if buffer:
            raw = "".join(buffer).encode("utf-16-be")
            encoded = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
            result.append("&" + encoded + "-")
            del buffer[:]

    for char in value or "":
        code = ord(char)
        if 0x20 <= code <= 0x7E:
            flush()
            result.append("&-" if char == "&" else char)
        else:
            buffer.append(char)
    flush()
    return "".join(result)


def _quote_mailbox(raw_name):
    if raw_name is None:
        return None
    needs = any(ch in raw_name for ch in ' ()[]{}"\\*%') or raw_name == ""
    if not needs:
        return raw_name
    return '"' + raw_name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _imap_connect(row, creds):
    host = (row.get("in_host") or "").strip()
    port = int(row.get("in_port") or 993)
    if not host:
        raise FetchError(u"未填写 IMAP 服务器地址")
    if not creds.get("user"):
        raise FetchError(u"未填写邮箱账号")
    context = _ssl_context(row.get("in_allow_insecure"))
    security = row.get("in_security") or "ssl"
    try:
        if security == "ssl":
            conn = imaplib.IMAP4_SSL(host, port, ssl_context=context, timeout=SOCKET_TIMEOUT)
        else:
            conn = imaplib.IMAP4(host, port, timeout=SOCKET_TIMEOUT)
            if security == "starttls":
                conn.starttls(ssl_context=context)
    except (imaplib.IMAP4.error, ssl.SSLError, socket.error, OSError) as exc:
        raise FetchError(friendly_error(exc))
    try:
        conn.login(creds["user"], creds["password"])
    except imaplib.IMAP4.error as exc:
        try:
            conn.logout()
        except Exception:
            pass
        raise FetchError(friendly_error(exc))
    return conn


def test_imap(row, creds):
    conn = _imap_connect(row, creds)
    try:
        typ, data = conn.select("INBOX", readonly=True)
        if typ != "OK":
            raise FetchError(u"无法打开收件箱：%s" % data)
        count = 0
        if data and data[0]:
            try:
                count = int(data[0])
            except (TypeError, ValueError):
                count = 0
        folders = _list_remote_folders(conn)
        return u"连接成功：收件箱 %d 封，服务器共 %d 个文件夹" % (count, len(folders))
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def _list_remote_folders(conn):
    try:
        typ, data = conn.list()
    except imaplib.IMAP4.error as exc:
        raise FetchError(friendly_error(exc))
    if typ != "OK":
        return []
    folders = []
    pattern = re.compile(r'^\((?P<flags>[^)]*)\)\s+"?(?P<delim>[^"]*)"?\s+(?P<name>.*)$')
    for raw in data or []:
        if not raw:
            continue
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        line = line.strip()
        match = pattern.match(line)
        if not match:
            continue
        flags = match.group("flags") or ""
        name = match.group("name").strip()
        if name.startswith('"') and name.endswith('"') and len(name) >= 2:
            name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        folders.append(
            {
                "raw": name,
                "name": imap_utf7_decode(name),
                "flags": flags,
                "selectable": "\\Noselect" not in flags and "\\NonExistent" not in flags,
            }
        )
    return folders


def _kind_for_folder(folder):
    flags = (folder.get("flags") or "").lower()
    for token, kind in SPECIAL_USE.items():
        if token in flags:
            return kind
    name = (folder.get("name") or "").strip().lower()
    if name == "inbox":
        return "inbox"
    for keywords, kind in NAME_HINTS:
        for keyword in keywords:
            if keyword in name:
                return kind
    return None


def _folder_sort_key(folder):
    kind = _kind_for_folder(folder) or "custom"
    return (repo.FOLDER_KIND_ORDER.get(kind, 9), folder.get("name") or "")


def _map_remote_folders(ctx, row, remote_folders):
    mapping = []
    used_kinds = set()
    sync_all = bool(row.get("imap_sync_all"))

    candidates = [f for f in remote_folders if f.get("selectable")]
    candidates.sort(key=_folder_sort_key)

    for folder in candidates:
        kind = _kind_for_folder(folder)
        if kind and kind in used_kinds:
            kind = None
        if kind is None and not sync_all:
            continue
        if kind is None:
            kind = "custom"
        if kind != "custom":
            used_kinds.add(kind)

        local = repo.find_folder(ctx, row["id"], kind=kind) if kind != "custom" else None
        if local is None:
            local_id = repo.create_folder(
                ctx,
                row["id"],
                name=folder["name"] or folder["raw"],
                kind=kind,
                remote_name=folder["raw"],
            )
            local = repo.get_folder(ctx, local_id)
            if local and kind != "custom" and not local.get("remote_name"):
                ctx.db.update("UPDATE folders SET remote_name = ? WHERE id = ?", (folder["raw"], local["id"]))
                local["remote_name"] = folder["raw"]
        else:
            ctx.db.update("UPDATE folders SET remote_name = ? WHERE id = ?", (folder["raw"], local["id"]))
            local["remote_name"] = folder["raw"]
        mapping.append((local, folder["raw"]))
    return mapping


def _mailbox_arg(raw_name):
    return _quote_mailbox(raw_name)


def _fetch_full(conn, uid):
    typ, data = conn.uid("fetch", uid, "(BODY.PEEK[] FLAGS)")
    if typ != "OK":
        return None, ""
    raw = None
    flags = ""
    for item in data or []:
        if isinstance(item, tuple) and len(item) >= 2:
            meta = item[0]
            if isinstance(meta, bytes):
                meta = meta.decode("utf-8", "replace")
            match = re.search(r"FLAGS \(([^)]*)\)", meta or "", re.I)
            if match:
                flags = match.group(1)
            payload = item[1]
            if isinstance(payload, bytes) and len(payload) > 0:
                raw = payload
        elif isinstance(item, bytes):
            match = re.search(rb"FLAGS \(([^)]*)\)", item, re.I)
            if match:
                flags = match.group(1).decode("utf-8", "replace")
    return raw, flags


def _parse_flag_batch(data):
    result = {}
    for item in data or []:
        if not item:
            continue
        text = item.decode("utf-8", "replace") if isinstance(item, bytes) else str(item)
        for match in re.finditer(r"(?:FLAGS \(([^)]*)\)[^)]*?UID (\d+)|UID (\d+)[^)]*?FLAGS \(([^)]*)\))", text, re.I):
            if match.group(2):
                result[match.group(2)] = match.group(1)
            elif match.group(3):
                result[match.group(3)] = match.group(4)
    return result


def _sync_imap_folder(ctx, row, conn, local, remote_name, progress, counter):
    typ, data = conn.select(_mailbox_arg(remote_name), readonly=True)
    if typ != "OK":
        raise FetchError(u"无法打开文件夹 %s：%s" % (local["name"], data))
    try:
        typ, data = conn.uid("search", None, "ALL")
    except imaplib.IMAP4.error as exc:
        raise FetchError(friendly_error(exc))
    if typ != "OK":
        return 0, 0
    raw_uids = data[0].split() if data and data[0] else []
    uids = [item.decode("ascii", "replace") for item in raw_uids]

    known = repo.message_uid_index(ctx, row["id"], local["id"])
    pending = [uid for uid in uids if uid not in known]
    fetched = 0
    failed = 0
    started = time.time()

    while pending:
        batch, pending = pending[:IMAP_BATCH], pending[IMAP_BATCH:]
        for uid in batch:
            if time.time() - started > SYNC_TIME_BUDGET:
                return fetched, failed
            raw, flags = _fetch_full(conn, uid)
            if raw is None:
                failed += 1
                continue
            parsed = mailparser.parse_message(raw)
            is_read = 1 if "\\seen" in (flags or "").lower() else 0
            is_starred = 1 if "\\flagged" in (flags or "").lower() else 0
            try:
                repo.store_message(
                    ctx,
                    row["id"],
                    local["id"],
                    local["kind"],
                    uid,
                    parsed,
                    raw,
                    is_read=is_read,
                    is_starred=is_starred,
                    remote_flags=flags or "",
                    blob_key=uid,
                    prefix="i",
                )
                fetched += 1
            except Exception as exc:
                failed += 1
                repo.add_log(ctx, "error", "imap", u"归档邮件失败 uid=%s: %s" % (uid, exc))
            if progress:
                progress(
                    u"正在收取 %s" % local["name"],
                    parsed.get("subject") or u"(无主题)",
                    counter[0] + fetched + failed,
                    counter[1],
                )
    return fetched, failed


def _refresh_imap_flags(ctx, conn, row, local):
    recent = repo.folder_uids(ctx, row["id"], local["id"], limit=FLAG_REFRESH_LIMIT)
    if not recent:
        return 0
    try:
        typ, data = conn.uid("fetch", ",".join(recent), "(FLAGS)")
    except imaplib.IMAP4.error:
        return 0
    if typ != "OK":
        return 0
    mapping = _parse_flag_batch(data)
    changed = 0
    for uid, flags in mapping.items():
        existing = repo.get_message_by_uid(ctx, row["id"], local["id"], uid)
        if existing is None:
            continue
        remote_read = 1 if "\\seen" in flags.lower() else 0
        remote_star = 1 if "\\flagged" in flags.lower() else 0
        # 只接受远端「已读 / 星标」的升级，不用远端标志把本地状态改回未读。
        # 本客户端不会把 \Seen 写回服务端，若完全以远端标志为准，
        # 用户刚标记的已读会在下一次同步时被重置为未读。
        is_read = max(int(existing["is_read"] or 0), remote_read)
        is_starred = max(int(existing["is_starred"] or 0), remote_star)
        if existing["is_read"] != is_read or existing["is_starred"] != is_starred:
            ctx.db.update(
                "UPDATE messages SET is_read = ?, is_starred = ?, remote_flags = ? WHERE id = ?",
                (is_read, is_starred, flags, existing["id"]),
            )
            changed += 1
    return changed


def sync_imap(ctx, account_id, progress=None):
    row, creds = _prepare(ctx, repo.get_account(ctx, account_id))
    conn = _imap_connect(row, creds)
    fetched = 0
    failed = 0
    folders_synced = 0
    try:
        remote_folders = _list_remote_folders(conn)
        mapping = _map_remote_folders(ctx, row, remote_folders)
        if not mapping:
            mapping = []
            inbox = repo.find_folder(ctx, row["id"], kind="inbox")
            if inbox:
                mapping.append((inbox, "INBOX"))
        if progress:
            progress(u"已连接 IMAP", u"待同步 %d 个文件夹" % len(mapping), 0, len(mapping))

        counter = [0, 0]
        for local, remote_name in mapping:
            if not local.get("is_synced", 1):
                continue
            counter[0] = fetched + failed
            counter[1] = fetched + failed + IMAP_BATCH
            try:
                new_count, fail_count = _sync_imap_folder(ctx, row, conn, local, remote_name, progress, counter)
                fetched += new_count
                failed += fail_count
                folders_synced += 1
                _refresh_imap_flags(ctx, conn, row, local)
            except FetchError as exc:
                failed += 1
                repo.add_log(ctx, "warn", "imap", u"文件夹 %s 同步失败：%s" % (local["name"], exc))
    finally:
        try:
            conn.logout()
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
    return {
        "protocol": "imap",
        "fetched": fetched,
        "failed": failed,
        "folders": folders_synced,
    }


# --------------------------------------------------------------------------- 统一入口


def test_incoming(ctx, payload):
    """使用临时配置测试收件服务器，无需先保存账号。"""
    row = dict(payload)
    if row.get("id") and (not row.get("in_password")):
        stored = repo.get_account(ctx, row["id"])
        if stored:
            row["in_password"] = repo.decrypt_secret(ctx, stored.get("in_password"))
    creds = {
        "user": (row.get("in_user") or row.get("email") or "").strip(),
        "password": row.get("in_password") or "",
    }
    protocol = row.get("protocol") or "pop3"
    if protocol == "imap":
        return test_imap(row, creds)
    return test_pop3(row, creds)


def sync_account(ctx, account_id):
    row = repo.get_account(ctx, account_id)
    if row is None:
        raise FetchError(u"账号不存在")
    if row.get("protocol") == "imap":
        return sync_imap(ctx, account_id)
    return sync_pop3(ctx, account_id)
