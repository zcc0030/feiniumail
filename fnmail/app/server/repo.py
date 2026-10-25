# -*- coding: utf-8 -*-
"""数据访问层：账号、文件夹、邮件索引、附件元信息、通讯录、日志。"""
import base64
import json
import time

import security

ACCOUNT_FIELDS = (
    "name",
    "email",
    "display_name",
    "protocol",
    "in_host",
    "in_port",
    "in_security",
    "in_user",
    "in_allow_insecure",
    "pop3_keep_server",
    "imap_sync_all",
    "out_host",
    "out_port",
    "out_security",
    "out_user",
    "out_use_in_auth",
    "save_sent_to_server",
    "signature",
    "sync_enabled",
    "sync_interval",
    "sort",
)

DEFAULT_FOLDERS = (
    (u"收件箱", "inbox", 10),
    (u"草稿箱", "drafts", 20),
    (u"已发送", "sent", 30),
    (u"垃圾邮件", "junk", 40),
    (u"已删除", "trash", 50),
)

FOLDER_KIND_ORDER = {
    "inbox": 0,
    "drafts": 1,
    "sent": 2,
    "archive": 3,
    "junk": 4,
    "trash": 5,
    "custom": 9,
}


def now_ts():
    return int(time.time())


# --------------------------------------------------------------------------- 账号


def _encrypt_secret(ctx, value):
    return security.encrypt_str(ctx.secret, value or "")


def decrypt_secret(ctx, value):
    try:
        return security.decrypt_str(ctx.secret, value or "")
    except ValueError:
        return ""


def list_accounts(ctx):
    rows = ctx.db.query("SELECT * FROM accounts ORDER BY sort ASC, id ASC")
    return [account_for_client(ctx, row) for row in rows]


def get_account(ctx, account_id):
    return ctx.db.query_one("SELECT * FROM accounts WHERE id = ?", (int(account_id),))


def account_for_client(ctx, row):
    item = dict(row)
    item["in_password_set"] = bool(item.pop("in_password", ""))
    item["out_password_set"] = bool(item.pop("out_password", ""))
    item["in_user"] = item.get("in_user") or item.get("email") or ""
    return item


def account_credentials(ctx, row):
    """返回可用的收/发凭据（明文密码）。"""
    password = decrypt_secret(ctx, row.get("in_password"))
    out_password = decrypt_secret(ctx, row.get("out_password"))
    user = row.get("in_user") or row.get("email") or ""
    out_user = row.get("out_user") or user
    if row.get("out_use_in_auth") and not out_password:
        out_password = password
        out_user = out_user or user
    return {
        "user": user,
        "password": password,
        "out_user": out_user,
        "out_password": out_password,
    }


def _normalize_int(value, default=0, low=None, high=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if low is not None and number < low:
        number = low
    if high is not None and number > high:
        number = high
    return number


def create_account(ctx, payload):
    email = (payload.get("email") or "").strip()
    protocol = payload.get("protocol") or "pop3"
    if protocol not in ("pop3", "imap"):
        protocol = "pop3"
    default_in_port = 995 if protocol == "pop3" else 993
    values = {
        "name": (payload.get("name") or email or u"新邮箱").strip(),
        "email": email,
        "display_name": (payload.get("display_name") or "").strip(),
        "protocol": protocol,
        "in_host": (payload.get("in_host") or "").strip(),
        "in_port": _normalize_int(payload.get("in_port"), default_in_port, 1, 65535),
        "in_security": payload.get("in_security") or "ssl",
        "in_user": (payload.get("in_user") or email).strip(),
        "in_allow_insecure": 1 if payload.get("in_allow_insecure") else 0,
        "pop3_keep_server": 1 if payload.get("pop3_keep_server") else 0,
        "imap_sync_all": 1 if payload.get("imap_sync_all") else 0,
        "out_host": (payload.get("out_host") or "").strip(),
        "out_port": _normalize_int(payload.get("out_port"), 465, 1, 65535),
        "out_security": payload.get("out_security") or "ssl",
        "out_user": (payload.get("out_user") or "").strip(),
        "out_use_in_auth": 1 if payload.get("out_use_in_auth", True) else 0,
        "save_sent_to_server": 1 if payload.get("save_sent_to_server") else 0,
        "signature": payload.get("signature") or "",
        "sync_enabled": 1 if payload.get("sync_enabled", True) else 0,
        "sync_interval": _normalize_int(payload.get("sync_interval"), 300, 60, 86400),
        "sort": _normalize_int(payload.get("sort"), 0),
    }
    columns = ", ".join(list(values.keys()) + ["in_password", "out_password", "created_at"])
    placeholders = ", ".join(["?"] * (len(values) + 3))
    args = list(values.values()) + [
        _encrypt_secret(ctx, payload.get("in_password") or ""),
        _encrypt_secret(ctx, payload.get("out_password") or ""),
        now_ts(),
    ]
    account_id = ctx.db.insert("INSERT INTO accounts(%s) VALUES(%s)" % (columns, placeholders), args)
    ensure_account_folders(ctx, account_id)
    return account_id


def update_account(ctx, account_id, payload):
    row = get_account(ctx, account_id)
    if row is None:
        return False
    sets = []
    args = []
    for field in ACCOUNT_FIELDS:
        if field not in payload:
            continue
        value = payload.get(field)
        if field in ("in_port", "out_port"):
            value = _normalize_int(value, row.get(field) or 0, 1, 65535)
        elif field == "sync_interval":
            value = _normalize_int(value, row.get(field) or 300, 60, 86400)
        elif field in (
            "in_allow_insecure",
            "pop3_keep_server",
            "imap_sync_all",
            "out_use_in_auth",
            "save_sent_to_server",
            "sync_enabled",
        ):
            value = 1 if value else 0
        elif field == "sort":
            value = _normalize_int(value, 0)
        else:
            value = "" if value is None else str(value)
        sets.append("%s = ?" % field)
        args.append(value)

    if "in_password" in payload and payload.get("in_password") is not None:
        password = payload.get("in_password")
        if password != "":
            sets.append("in_password = ?")
            args.append(_encrypt_secret(ctx, password))
    if "out_password" in payload and payload.get("out_password") is not None:
        password = payload.get("out_password")
        if password != "":
            sets.append("out_password = ?")
            args.append(_encrypt_secret(ctx, password))
    if not sets:
        return False
    args.append(int(account_id))
    ctx.db.update("UPDATE accounts SET %s WHERE id = ?" % ", ".join(sets), args)
    if str(payload.get("protocol") or "") in ("pop3", "imap"):
        ensure_account_folders(ctx, account_id)
    return True


def delete_account(ctx, account_id, purge=False):
    account_id = int(account_id)
    rows = ctx.db.query("SELECT eml_path FROM messages WHERE account_id = ?", (account_id,))
    for row in rows:
        try:
            ctx.blobs.remove(row["eml_path"])
        except Exception:
            pass
    ctx.db.execute("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)", (account_id,))
    ctx.db.execute("DELETE FROM messages WHERE account_id = ?", (account_id,))
    ctx.db.execute("DELETE FROM folders WHERE account_id = ?", (account_id,))
    ctx.db.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    if purge:
        try:
            ctx.blobs.remove_account(account_id)
        except Exception:
            pass
    ctx.sync_state.pop(account_id, None)
    return True


def set_account_sync_state(ctx, account_id, status, message="", error=""):
    ctx.db.update(
        "UPDATE accounts SET last_sync = ?, last_sync_status = ?, last_sync_message = ?, last_error = ? WHERE id = ?",
        (now_ts(), status, message or "", error or "", int(account_id)),
    )


# --------------------------------------------------------------------------- 文件夹


def ensure_account_folders(ctx, account_id):
    account_id = int(account_id)
    existing = ctx.db.query("SELECT name, kind FROM folders WHERE account_id = ?", (account_id,))
    names = set(row["name"] for row in existing)
    for name, kind, sort in DEFAULT_FOLDERS:
        if name in names:
            continue
        ctx.db.insert(
            "INSERT INTO folders(account_id, name, kind, sort, created_at) VALUES(?,?,?,?,?)",
            (account_id, name, kind, sort, now_ts()),
        )
    return list_folders(ctx, account_id=account_id)


def list_folders(ctx, account_id=None):
    where = ""
    args = ()
    if account_id is not None:
        where = "WHERE f.account_id = ?"
        args = (int(account_id),)
    rows = ctx.db.query(
        """
        SELECT f.*,
               (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id) AS total,
               (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.is_read = 0) AS unread,
               (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.is_starred = 1) AS starred
        FROM folders f
        %s
        ORDER BY f.account_id ASC, f.sort ASC, f.id ASC
        """
        % where,
        args,
    )
    for row in rows:
        row["kind_order"] = FOLDER_KIND_ORDER.get(row["kind"], 9)
    return rows


def get_folder(ctx, folder_id):
    return ctx.db.query_one("SELECT * FROM folders WHERE id = ?", (int(folder_id),))


def find_folder(ctx, account_id, kind=None, name=None):
    if kind:
        row = ctx.db.query_one(
            "SELECT * FROM folders WHERE account_id = ? AND kind = ? ORDER BY id ASC LIMIT 1",
            (int(account_id), kind),
        )
        if row:
            return row
    if name:
        return ctx.db.query_one(
            "SELECT * FROM folders WHERE account_id = ? AND name = ? LIMIT 1", (int(account_id), name)
        )
    return None


def create_folder(ctx, account_id, name, kind="custom", remote_name="", is_synced=1):
    name = (name or "").strip()
    if not name:
        raise ValueError("文件夹名称不能为空")
    account_id = int(account_id)
    exists = ctx.db.query_one(
        "SELECT id FROM folders WHERE account_id = ? AND name = ?", (account_id, name)
    )
    if exists:
        return exists["id"]
    max_sort = ctx.db.scalar(
        "SELECT MAX(sort) FROM folders WHERE account_id = ? AND kind = 'custom'", (account_id,), 0
    )
    return ctx.db.insert(
        "INSERT INTO folders(account_id, name, kind, remote_name, is_synced, sort, created_at) VALUES(?,?,?,?,?,?,?)",
        (account_id, name, kind, remote_name or "", 1 if is_synced else 0, int(max_sort or 0) + 1, now_ts()),
    )


def rename_folder(ctx, folder_id, name):
    name = (name or "").strip()
    if not name:
        raise ValueError("文件夹名称不能为空")
    ctx.db.update("UPDATE folders SET name = ? WHERE id = ?", (name, int(folder_id)))
    return True


def delete_folder(ctx, folder_id):
    folder_id = int(folder_id)
    folder = get_folder(ctx, folder_id)
    if folder is None:
        return False
    if folder["kind"] in ("inbox", "sent", "drafts"):
        raise ValueError("系统文件夹不可删除")
    rows = ctx.db.query("SELECT eml_path FROM messages WHERE folder_id = ?", (folder_id,))
    for row in rows:
        try:
            ctx.blobs.remove(row["eml_path"])
        except Exception:
            pass
    ctx.db.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE folder_id = ?)", (folder_id,)
    )
    ctx.db.execute("DELETE FROM messages WHERE folder_id = ?", (folder_id,))
    ctx.db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    return True


def empty_folder(ctx, folder_id):
    folder_id = int(folder_id)
    rows = ctx.db.query("SELECT eml_path FROM messages WHERE folder_id = ?", (folder_id,))
    for row in rows:
        try:
            ctx.blobs.remove(row["eml_path"])
        except Exception:
            pass
    ctx.db.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE folder_id = ?)", (folder_id,)
    )
    count = ctx.db.update("DELETE FROM messages WHERE folder_id = ?", (folder_id,))
    return count


# --------------------------------------------------------------------------- 邮件


def message_uid_index(ctx, account_id, folder_id):
    rows = ctx.db.query(
        "SELECT uid FROM messages WHERE account_id = ? AND folder_id = ? AND uid <> ''",
        (int(account_id), int(folder_id)),
    )
    return set(row["uid"] for row in rows)


def folder_uids(ctx, account_id, folder_id, limit=400):
    rows = ctx.db.query(
        """
        SELECT uid FROM messages
        WHERE account_id = ? AND folder_id = ? AND uid <> ''
        ORDER BY id DESC LIMIT ?
        """,
        (int(account_id), int(folder_id), int(limit)),
    )
    return [row["uid"] for row in rows]


def get_message(ctx, message_id):
    return ctx.db.query_one("SELECT * FROM messages WHERE id = ?", (int(message_id),))


def get_message_by_uid(ctx, account_id, folder_id, uid):
    return ctx.db.query_one(
        "SELECT * FROM messages WHERE account_id = ? AND folder_id = ? AND uid = ?",
        (int(account_id), int(folder_id), str(uid)),
    )


def get_message_by_message_id(ctx, account_id, folder_id, message_id):
    if not message_id:
        return None
    return ctx.db.query_one(
        "SELECT * FROM messages WHERE account_id = ? AND folder_id = ? AND message_id = ? ORDER BY id LIMIT 1",
        (int(account_id), int(folder_id), str(message_id)),
    )


def store_message(ctx, account_id, folder_id, folder_kind, uid, parsed, raw, is_read=0, is_starred=0,
                  is_draft=0, remote_flags="", blob_key=None, prefix=None, stamp=None):
    account_id = int(account_id)
    folder_id = int(folder_id)
    existing = None
    if uid:
        existing = get_message_by_uid(ctx, account_id, folder_id, uid)
    # 本客户端发信时会先把副本归档到本地「已发送」（没有服务器 uid），而邮件服务商
    # 通常也会在它自己的「已发送」里留一份；IMAP 同步把服务器那份收回来时，两者的
    # Message-ID 完全相同，但本地那份没有 uid，只按 uid 去重就漏掉了，
    # 于是同一封邮件在「已发送」里显示两次。这里再按 Message-ID 归并一次。
    if existing is None:
        existing = get_message_by_message_id(ctx, account_id, folder_id, parsed.get("message_id"))
    date_ts = int(parsed.get("date_ts") or 0) or now_ts()
    from_list = parsed.get("from_list") or []
    from_name = from_list[0]["name"] if from_list else ""
    from_addr = from_list[0]["addr"] if from_list else ""
    preview = parsed.get("preview")
    if preview is None:
        import mailparser

        source = parsed.get("text") or mailparser.strip_html(parsed.get("html") or "")
        preview = mailparser.make_preview(source)
    attachments = parsed.get("attachments") or []

    if existing is not None:
        message_id = existing["id"]
        if raw is not None and not existing["eml_path"]:
            rel = ctx.blobs.save_eml(account_id, folder_kind, folder_id, blob_key or uid, raw, stamp, prefix)
            ctx.db.update("UPDATE messages SET eml_path = ?, size = ? WHERE id = ?", (rel, len(raw), message_id))
        # 同步回来的副本带着服务器 uid：把它补到本地那条记录上，
        # 下次同步就能按 uid 直接跳过，不会再重复收取。
        if uid and not existing["uid"]:
            ctx.db.update("UPDATE messages SET uid = ? WHERE id = ?", (str(uid), message_id))
        # 重复归档同一封邮件时只保留「已读 / 星标」的最新有效状态，
        # 不能用远端标志把用户本地标记的已读覆盖回未读。
        ctx.db.update(
            "UPDATE messages SET is_read = ?, is_starred = ?, remote_flags = ? WHERE id = ?",
            (
                max(int(existing["is_read"] or 0), 1 if is_read else 0),
                max(int(existing["is_starred"] or 0), 1 if is_starred else 0),
                remote_flags or "",
                message_id,
            ),
        )
        return message_id, False

    rel = ""
    size = len(raw) if raw else 0
    if raw is not None:
        rel = ctx.blobs.save_eml(account_id, folder_kind, folder_id, blob_key or uid or parsed.get("message_id"),
                                 raw, stamp, prefix)

    message_id = ctx.db.insert(
        """
        INSERT INTO messages(
            account_id, folder_id, uid, message_id, subject, from_name, from_addr,
            to_addrs, cc_addrs, bcc_addrs, reply_to, date_ts, size, has_attach,
            is_read, is_starred, is_draft, remote_flags, body_preview, eml_path, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            account_id,
            folder_id,
            str(uid or ""),
            parsed.get("message_id") or "",
            parsed.get("subject") or "",
            from_name,
            from_addr,
            json.dumps(parsed.get("to_list") or [], ensure_ascii=False),
            json.dumps(parsed.get("cc_list") or [], ensure_ascii=False),
            json.dumps(parsed.get("bcc_list") or [], ensure_ascii=False),
            parsed.get("reply_to") or "",
            date_ts,
            size,
            1 if attachments else 0,
            1 if is_read else 0,
            1 if is_starred else 0,
            1 if is_draft else 0,
            remote_flags or "",
            preview,
            rel,
            now_ts(),
        ),
    )
    for item in attachments:
        ctx.db.insert(
            """
            INSERT INTO attachments(message_id, part_index, filename, content_type, size, content_id, is_inline)
            VALUES(?,?,?,?,?,?,?)
            """,
            (
                message_id,
                int(item.get("part_index") or 0),
                item.get("filename") or "",
                item.get("content_type") or "application/octet-stream",
                int(item.get("size") or 0),
                item.get("content_id") or "",
                1 if item.get("is_inline") else 0,
            ),
        )
    return message_id, True


def dedup_messages_by_message_id(ctx):
    """合并历史遗留的重复邮件：同一账号、同一文件夹、同一 Message-ID 只保留一条。

    早期版本发信时会把副本归档到本地「已发送」（没有服务器 uid），而邮件服务商
    也会在服务器「已发送」保留一份，IMAP 同步把这封邮件收回来时就多出一条记录。
    这里做一次性清理，避免老用户升级后仍然看到重复。

    保留规则：优先保留本地那份（uid 为空，正文忠实于实际发出的内容），并把服务器
    uid 补到它上面，其余记录连同附件与 .eml 原文一并删除。返回清理掉的条数。
    """
    groups = ctx.db.query(
        """
        SELECT account_id, folder_id, message_id
        FROM messages
        WHERE message_id <> '' AND is_draft = 0
        GROUP BY account_id, folder_id, message_id
        HAVING COUNT(*) > 1
        """
    )
    removed = 0
    for group in groups:
        rows = ctx.db.query(
            """
            SELECT * FROM messages
            WHERE account_id = ? AND folder_id = ? AND message_id = ? AND is_draft = 0
            ORDER BY (uid <> '') ASC, id ASC
            """,
            (group["account_id"], group["folder_id"], group["message_id"]),
        )
        if len(rows) < 2:
            continue
        keep = rows[0]
        donor_uid = next((row["uid"] for row in rows[1:] if row["uid"]), "")
        # 先删重复记录再补 uid：messages 上有 (account_id, folder_id, uid) 唯一索引，
        # 顺序颠倒会与尚未删除的那条冲突。
        for row in rows[1:]:
            ctx.db.execute("DELETE FROM attachments WHERE message_id = ?", (row["id"],))
            ctx.db.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
            if row["eml_path"] and row["eml_path"] != keep["eml_path"]:
                ctx.blobs.remove(row["eml_path"])
            removed += 1
        if donor_uid and not keep["uid"]:
            ctx.db.update("UPDATE messages SET uid = ? WHERE id = ?", (donor_uid, keep["id"]))
    return removed


def refresh_message_index(ctx, message_id, parsed, folder_kind, folder_id, raw=None):
    message_id = int(message_id)
    row = get_message(ctx, message_id)
    if row is None:
        return
    rel = row["eml_path"]
    if raw is not None and not rel:
        rel = ctx.blobs.save_eml(row["account_id"], folder_kind, folder_id, str(message_id), raw)
    ctx.db.update(
        """
        UPDATE messages SET subject = ?, from_name = ?, from_addr = ?, to_addrs = ?, cc_addrs = ?,
            bcc_addrs = ?, reply_to = ?, date_ts = ?, size = ?, has_attach = ?, body_preview = ?,
            message_id = ?, eml_path = ?
        WHERE id = ?
        """,
        (
            parsed.get("subject") or "",
            (parsed.get("from_list") or [{}])[0].get("name", "") if parsed.get("from_list") else "",
            (parsed.get("from_list") or [{}])[0].get("addr", "") if parsed.get("from_list") else "",
            json.dumps(parsed.get("to_list") or [], ensure_ascii=False),
            json.dumps(parsed.get("cc_list") or [], ensure_ascii=False),
            json.dumps(parsed.get("bcc_list") or [], ensure_ascii=False),
            parsed.get("reply_to") or "",
            int(parsed.get("date_ts") or 0) or now_ts(),
            len(raw) if raw else row["size"],
            1 if parsed.get("attachments") else 0,
            parsed.get("preview") or "",
            parsed.get("message_id") or "",
            rel,
            message_id,
        ),
    )
    ctx.db.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
    for item in parsed.get("attachments") or []:
        ctx.db.insert(
            """
            INSERT INTO attachments(message_id, part_index, filename, content_type, size, content_id, is_inline)
            VALUES(?,?,?,?,?,?,?)
            """,
            (
                message_id,
                int(item.get("part_index") or 0),
                item.get("filename") or "",
                item.get("content_type") or "application/octet-stream",
                int(item.get("size") or 0),
                item.get("content_id") or "",
                1 if item.get("is_inline") else 0,
            ),
        )


def list_attachments(ctx, message_id):
    return ctx.db.query(
        "SELECT id, part_index, filename, content_type, size, content_id, is_inline FROM attachments "
        "WHERE message_id = ? ORDER BY part_index ASC",
        (int(message_id),),
    )


LIST_COLUMNS = (
    "m.id, m.account_id, m.folder_id, m.subject, m.from_name, m.from_addr, m.to_addrs, m.date_ts, "
    "m.size, m.has_attach, m.is_read, m.is_starred, m.is_draft, m.body_preview, m.uid"
)


def list_messages(ctx, folder_id=None, account_id=None, kind=None, query=None, filter_by="all",
                  page=1, size=50):
    where = []
    args = []
    if folder_id is not None:
        where.append("m.folder_id = ?")
        args.append(int(folder_id))
    else:
        if account_id is not None:
            where.append("m.account_id = ?")
            args.append(int(account_id))
        if kind:
            if isinstance(kind, (list, tuple)):
                where.append("f.kind IN (%s)" % ",".join(["?"] * len(kind)))
                args.extend(list(kind))
            else:
                where.append("f.kind = ?")
                args.append(kind)
    if query:
        like = "%" + query.strip() + "%"
        where.append(
            "(m.subject LIKE ? OR m.from_name LIKE ? OR m.from_addr LIKE ? OR m.body_preview LIKE ? OR m.to_addrs LIKE ?)"
        )
        args.extend([like] * 5)
    if filter_by == "unread":
        where.append("m.is_read = 0")
    elif filter_by == "read":
        where.append("m.is_read = 1")
    elif filter_by == "starred":
        where.append("m.is_starred = 1")
    elif filter_by == "attach":
        where.append("m.has_attach = 1")
    elif filter_by == "draft":
        where.append("m.is_draft = 1")

    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = ctx.db.scalar(
        "SELECT COUNT(*) FROM messages m JOIN folders f ON f.id = m.folder_id %s" % clause, tuple(args), 0
    )
    page = max(1, int(page or 1))
    size = min(200, max(1, int(size or 50)))
    offset = (page - 1) * size
    rows = ctx.db.query(
        """
        SELECT %s, f.name AS folder_name, f.kind AS folder_kind, a.email AS account_email, a.name AS account_name
        FROM messages m
        JOIN folders f ON f.id = m.folder_id
        LEFT JOIN accounts a ON a.id = m.account_id
        %s
        ORDER BY m.date_ts DESC, m.id DESC
        LIMIT ? OFFSET ?
        """
        % (LIST_COLUMNS, clause),
        tuple(args) + (size, offset),
    )
    for row in rows:
        row["to_list"] = _loads(row.pop("to_addrs", "[]"))
        row["from"] = {"name": row["from_name"], "addr": row["from_addr"]}
    return {"total": total, "page": page, "size": size, "items": rows}


def _loads(text, default=None):
    try:
        return json.loads(text) if text else (default if default is not None else [])
    except Exception:
        return default if default is not None else []


def mark_read(ctx, message_id, is_read=True):
    ctx.db.update("UPDATE messages SET is_read = ? WHERE id = ?", (1 if is_read else 0, int(message_id)))
    return True


def mark_starred(ctx, message_id, is_starred=True):
    ctx.db.update(
        "UPDATE messages SET is_starred = ? WHERE id = ?", (1 if is_starred else 0, int(message_id))
    )
    return True


def move_message(ctx, message_id, folder_id):
    ctx.db.update("UPDATE messages SET folder_id = ? WHERE id = ?", (int(folder_id), int(message_id)))
    return True


def delete_message(ctx, message_id):
    row = get_message(ctx, message_id)
    if row is None:
        return False
    try:
        ctx.blobs.remove(row["eml_path"])
    except Exception:
        pass
    ctx.db.execute("DELETE FROM attachments WHERE message_id = ?", (int(message_id),))
    ctx.db.execute("DELETE FROM messages WHERE id = ?", (int(message_id),))
    return True


def batch_update(ctx, ids, action, folder_id=None):
    ids = [int(item) for item in (ids or []) if str(item).strip().isdigit()]
    if not ids:
        return 0
    marks = ",".join(["?"] * len(ids))
    if action == "read":
        return ctx.db.update("UPDATE messages SET is_read = 1 WHERE id IN (%s)" % marks, ids)
    if action == "unread":
        return ctx.db.update("UPDATE messages SET is_read = 0 WHERE id IN (%s)" % marks, ids)
    if action == "star":
        return ctx.db.update("UPDATE messages SET is_starred = 1 WHERE id IN (%s)" % marks, ids)
    if action == "unstar":
        return ctx.db.update("UPDATE messages SET is_starred = 0 WHERE id IN (%s)" % marks, ids)
    if action == "move" and folder_id:
        return ctx.db.update(
            "UPDATE messages SET folder_id = ? WHERE id IN (%s)" % marks, [int(folder_id)] + ids
        )
    if action in ("delete", "purge"):
        count = 0
        for message_id in ids:
            if delete_message(ctx, message_id):
                count += 1
        return count
    raise ValueError("不支持的批量操作：%s" % action)


def unread_summary(ctx):
    rows = ctx.db.query(
        """
        SELECT f.account_id, f.kind, COUNT(m.id) AS unread
        FROM folders f JOIN messages m ON m.folder_id = f.id AND m.is_read = 0
        GROUP BY f.account_id, f.kind
        """
    )
    total = 0
    per_account = {}
    for row in rows:
        if row["kind"] in ("inbox", "junk"):
            total += row["unread"]
            per_account[row["account_id"]] = per_account.get(row["account_id"], 0) + row["unread"]
    return {"total": total, "per_account": per_account}


# --------------------------------------------------------------------------- 通讯录


def _normalize_groups(value):
    if isinstance(value, (list, tuple)):
        items = [str(item).strip() for item in value]
    else:
        items = [part.strip() for part in str(value or "").split(",")]
    items = [item for item in items if item]
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def contact_for_client(row):
    item = dict(row)
    item["groups"] = [g for g in (item.get("groups") or "").split(",") if g]
    return item


def list_contacts(ctx, query=None, group=None, favorite=None):
    where = []
    args = []
    if query:
        like = "%" + query.strip() + "%"
        where.append("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR note LIKE ?)")
        args.extend([like] * 5)
    if group:
        where.append("(',' || groups || ',') LIKE ?")
        args.append(",%s," % group.strip())
    if favorite:
        where.append("is_favorite = 1")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = ctx.db.query(
        "SELECT * FROM contacts %s ORDER BY is_favorite DESC, (name = '') ASC, name COLLATE NOCASE ASC, id ASC" % clause,
        tuple(args),
    )
    return [contact_for_client(row) for row in rows]


def get_contact(ctx, contact_id):
    row = ctx.db.query_one("SELECT * FROM contacts WHERE id = ?", (int(contact_id),))
    return contact_for_client(row) if row else None


def find_contact_by_email(ctx, email):
    return ctx.db.query_one(
        "SELECT * FROM contacts WHERE lower(email) = ? LIMIT 1", ((email or "").strip().lower(),)
    )


def create_contact(ctx, payload):
    groups = ",".join(_normalize_groups(payload.get("groups")))
    stamp = now_ts()
    contact_id = ctx.db.insert(
        """
        INSERT INTO contacts(name, email, phone, company, title, groups, note, color, is_favorite, source,
                             created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            (payload.get("name") or "").strip(),
            (payload.get("email") or "").strip(),
            (payload.get("phone") or "").strip(),
            (payload.get("company") or "").strip(),
            (payload.get("title") or "").strip(),
            groups,
            payload.get("note") or "",
            payload.get("color") or "",
            1 if payload.get("is_favorite") else 0,
            payload.get("source") or "manual",
            stamp,
            stamp,
        ),
    )
    return contact_id


def update_contact(ctx, contact_id, payload):
    fields = []
    args = []
    for key in ("name", "email", "phone", "company", "title", "note", "color"):
        if key in payload:
            fields.append("%s = ?" % key)
            args.append((payload.get(key) or "").strip() if key != "note" else (payload.get(key) or ""))
    if "groups" in payload:
        fields.append("groups = ?")
        args.append(",".join(_normalize_groups(payload.get("groups"))))
    if "is_favorite" in payload:
        fields.append("is_favorite = ?")
        args.append(1 if payload.get("is_favorite") else 0)
    if not fields:
        return False
    fields.append("updated_at = ?")
    args.append(now_ts())
    args.append(int(contact_id))
    ctx.db.update("UPDATE contacts SET %s WHERE id = ?" % ", ".join(fields), args)
    return True


def delete_contact(ctx, contact_id):
    ctx.db.execute("DELETE FROM contacts WHERE id = ?", (int(contact_id),))
    return True


def delete_contacts(ctx, ids):
    ids = [int(item) for item in (ids or []) if str(item).strip().isdigit()]
    if not ids:
        return 0
    marks = ",".join(["?"] * len(ids))
    return ctx.db.update("DELETE FROM contacts WHERE id IN (%s)" % marks, ids)


def upsert_contact(ctx, payload):
    email = (payload.get("email") or "").strip()
    if email:
        existing = find_contact_by_email(ctx, email)
        if existing:
            if payload.get("_update"):
                update_contact(ctx, existing["id"], payload)
            elif payload.get("groups"):
                merged = _normalize_groups(existing.get("groups"))
                merged.extend(_normalize_groups(payload.get("groups")))
                update_contact(ctx, existing["id"], {"groups": merged})
            return existing["id"], False
    return create_contact(ctx, payload), True


def import_contacts(ctx, rows):
    """批量导入联系人。按邮箱去重：已存在则只补充空缺字段并合并分组。"""
    added = 0
    updated = 0
    skipped = 0
    for row in rows or []:
        if not isinstance(row, dict):
            skipped += 1
            continue
        payload = {}
        for key in ("name", "email", "phone", "company", "title", "note"):
            value = row.get(key)
            value = value.strip() if isinstance(value, str) else (value or "")
            if value:
                payload[key] = value
        groups = _normalize_groups(row.get("groups"))
        if groups:
            payload["groups"] = groups
        if not payload.get("email") and not payload.get("name"):
            skipped += 1
            continue
        email = (payload.get("email") or "").strip()
        existing = find_contact_by_email(ctx, email) if email else None
        if existing is None:
            create_contact(ctx, payload)
            added += 1
            continue
        patch = {}
        for key, value in payload.items():
            if key == "groups":
                continue
            if not (existing.get(key) or ""):
                patch[key] = value
        if groups:
            current = _normalize_groups(existing.get("groups"))
            merged = current + [item for item in groups if item not in current]
            if merged != current:
                patch["groups"] = merged
        if patch:
            update_contact(ctx, existing["id"], patch)
            updated += 1
        else:
            skipped += 1
    return {"added": added, "updated": updated, "skipped": skipped, "total": len(rows or [])}


def list_groups(ctx):
    rows = ctx.db.query("SELECT * FROM contact_groups ORDER BY sort ASC, id ASC")
    counts = {}
    for row in ctx.db.query("SELECT groups FROM contacts"):
        for group in _normalize_groups(row.get("groups")):
            counts[group] = counts.get(group, 0) + 1
    known = set()
    for row in rows:
        known.add(row["name"])
        row["count"] = counts.get(row["name"], 0)
    for name, count in counts.items():
        if name not in known:
            row = ctx.db.query_one("SELECT * FROM contact_groups WHERE name = ?", (name,))
            if row is None:
                ctx.db.insert(
                    "INSERT INTO contact_groups(name, sort, created_at) VALUES(?,?,?)",
                    (name, 100, now_ts()),
                )
                rows.append({"id": 0, "name": name, "sort": 100, "count": count})
    return rows


def create_group(ctx, name):
    name = (name or "").strip()
    if not name:
        raise ValueError("分组名称不能为空")
    exists = ctx.db.query_one("SELECT id FROM contact_groups WHERE name = ?", (name,))
    if exists:
        return exists["id"]
    return ctx.db.insert("INSERT INTO contact_groups(name, sort, created_at) VALUES(?,?,?)", (name, 100, now_ts()))


def rename_group(ctx, group_id, name):
    name = (name or "").strip()
    if not name:
        raise ValueError("分组名称不能为空")
    row = ctx.db.query_one("SELECT * FROM contact_groups WHERE id = ?", (int(group_id),))
    if row is None:
        return False
    old = row["name"]
    ctx.db.update("UPDATE contact_groups SET name = ? WHERE id = ?", (name, int(group_id)))
    for contact in ctx.db.query("SELECT id, groups FROM contacts WHERE (',' || groups || ',') LIKE ?", (",%s," % old,)):
        groups = _normalize_groups(contact["groups"])
        groups = [name if item == old else item for item in groups]
        ctx.db.update("UPDATE contacts SET groups = ? WHERE id = ?", (",".join(groups), contact["id"]))
    return True


def delete_group(ctx, group_id):
    row = ctx.db.query_one("SELECT * FROM contact_groups WHERE id = ?", (int(group_id),))
    if row is None:
        return False
    old = row["name"]
    for contact in ctx.db.query("SELECT id, groups FROM contacts WHERE (',' || groups || ',') LIKE ?", (",%s," % old,)):
        groups = [item for item in _normalize_groups(contact["groups"]) if item != old]
        ctx.db.update("UPDATE contacts SET groups = ? WHERE id = ?", (",".join(groups), contact["id"]))
    ctx.db.execute("DELETE FROM contact_groups WHERE id = ?", (int(group_id),))
    return True


def harvest_contacts_from_mail(ctx, account_id=None):
    """从已归档邮件中收集往来地址，补充到通讯录。"""
    where = "WHERE 1=1"
    args = []
    if account_id:
        where += " AND account_id = ?"
        args.append(int(account_id))
    rows = ctx.db.query(
        "SELECT from_name, from_addr, to_addrs, cc_addrs FROM messages %s" % where, tuple(args)
    )
    seen = {}
    for row in rows:
        candidates = [(row["from_name"], row["from_addr"])]
        for key in ("to_addrs", "cc_addrs"):
            for item in _loads(row.get(key), []):
                if isinstance(item, dict):
                    candidates.append((item.get("name") or "", item.get("addr") or ""))
        for name, addr in candidates:
            addr = (addr or "").strip().lower()
            if not addr or "@" not in addr:
                continue
            if addr not in seen:
                seen[addr] = (name or "").strip()
            elif not seen[addr] and name:
                seen[addr] = name.strip()
    added = 0
    skipped = 0
    for addr, name in seen.items():
        if find_contact_by_email(ctx, addr):
            skipped += 1
            continue
        create_contact(
            ctx,
            {"name": name or addr.split("@")[0], "email": addr, "source": "mail"},
        )
        added += 1
    return {"added": added, "skipped": skipped, "scanned": len(seen)}


# --------------------------------------------------------------------------- 日志


def add_log(ctx, level, source, message):
    ctx.db.insert(
        "INSERT INTO logs(ts, level, source, message) VALUES(?,?,?,?)",
        (now_ts(), level, source, (message or "")[:2000]),
    )


def list_logs(ctx, limit=200):
    return ctx.db.query(
        "SELECT id, ts, level, source, message FROM logs ORDER BY id DESC LIMIT ?", (int(limit),)
    )


def trim_logs(ctx, keep=3000):
    ctx.db.execute(
        "DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?", (int(keep),)
    )
