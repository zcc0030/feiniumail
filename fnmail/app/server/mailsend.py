# -*- coding: utf-8 -*-
"""邮件发送：SMTP 发信、保存已发送副本、草稿保存。

发信成功后始终把完整原文归档到本地「已发送」文件夹（.eml），
若账号使用 IMAP 且开启了「同步已发送到服务器」，再通过 IMAP APPEND 追加一份。
"""
import base64
import smtplib
import time
from email import encoders
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid

import mailfetch
import mailparser
import repo

SOCKET_TIMEOUT = 45
# 附件总大小上限（按解码后的真实字节数计算）。
# 修改此处时需同步调整 main.py 的 MAX_BODY：请求体是 base64 编码，约为 4/3 倍。
MAX_TOTAL_ATTACHMENT = 100 * 1024 * 1024


class SendError(Exception):
    pass


# --------------------------------------------------------------------------- 工具


def _is_ascii(text):
    try:
        (text or "").encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _header(value):
    value = value or ""
    return value if _is_ascii(value) else Header(value, "utf-8")


def _addr_list(value):
    """把前端传来的收件人整理成 [(显示名, 地址)]。"""
    items = value if isinstance(value, (list, tuple)) else ([value] if value else [])
    pairs = []
    for item in items:
        if isinstance(item, dict):
            name = (item.get("name") or "").strip()
            addr = (item.get("addr") or item.get("email") or "").strip()
            if name or addr:
                pairs.append((name, addr))
            continue
        text = str(item or "").strip()
        if not text:
            continue
        for parsed in mailparser.parse_addresses(text):
            pairs.append((parsed.get("name") or "", parsed.get("addr") or ""))

    result = []
    seen = set()
    for name, addr in pairs:
        if not addr and "<" in name and ">" in name:
            for parsed in mailparser.parse_addresses(name):
                name, addr = parsed.get("name") or "", parsed.get("addr") or ""
                break
        addr = (addr or "").strip()
        if not addr and not name:
            continue
        key = addr.lower()
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        result.append((name, addr))
    return result


def _collect_attachments(payload):
    result = []
    total = 0
    for item in payload.get("attachments") or []:
        if not isinstance(item, dict):
            continue
        name = (item.get("filename") or item.get("name") or "attachment").strip() or "attachment"
        ctype = (item.get("content_type") or "application/octet-stream").strip()
        data = item.get("data")
        if data is None:
            data = item.get("content") or ""
        if isinstance(data, str):
            text = data.strip()
            if text.startswith("data:") and "," in text:
                text = text.split(",", 1)[1]
            try:
                raw = base64.b64decode(text)
            except Exception:
                raw = text.encode("utf-8", "replace")
        elif isinstance(data, (bytes, bytearray)):
            raw = bytes(data)
        else:
            raw = b""
        total += len(raw)
        if total > MAX_TOTAL_ATTACHMENT:
            raise SendError(u"附件总大小超过 %d MB，请改用其他方式传输大文件。" % (MAX_TOTAL_ATTACHMENT // 1024 // 1024))
        result.append({"filename": name, "content_type": ctype, "data": raw})
    return result


# --------------------------------------------------------------------------- 组装


def build_mime_message(account, payload, attachments=None):
    """组装完整的 RFC822 邮件字节流。"""
    to_list = _addr_list(payload.get("to"))
    cc_list = _addr_list(payload.get("cc"))
    bcc_list = _addr_list(payload.get("bcc"))
    if not (to_list or cc_list or bcc_list):
        raise SendError(u"请至少填写一个收件人")

    from_addr = (payload.get("from_addr") or account.get("email") or account.get("out_user") or "").strip()
    if not from_addr or "@" not in from_addr:
        raise SendError(u"发件人地址无效，请在账号设置中填写正确的邮箱地址")
    from_name = (payload.get("from_name") or account.get("display_name") or account.get("name") or "").strip()

    subject = (payload.get("subject") or "").strip()
    text = payload.get("text") or ""
    html = payload.get("html") or ""
    attachments = attachments if attachments is not None else _collect_attachments(payload)

    body_parts = []
    if text:
        body_parts.append(MIMEText(text, "plain", "utf-8"))
    if html:
        body_parts.append(MIMEText(html, "html", "utf-8"))
    if not body_parts:
        body_parts.append(MIMEText("", "plain", "utf-8"))

    if attachments:
        root = MIMEMultipart("mixed")
        if len(body_parts) == 1:
            root.attach(body_parts[0])
        else:
            alternative = MIMEMultipart("alternative")
            for part in body_parts:
                alternative.attach(part)
            root.attach(alternative)
        for item in attachments:
            ctype = item["content_type"] or "application/octet-stream"
            maintype, _, subtype = ctype.partition("/")
            part = MIMEBase(maintype or "application", subtype or "octet-stream")
            part.set_payload(item["data"])
            encoders.encode_base64(part)
            filename = item["filename"]
            if _is_ascii(filename):
                part.add_header("Content-Disposition", "attachment", filename=filename)
            else:
                part.add_header(
                    "Content-Disposition", "attachment", filename=("utf-8", "", filename)
                )
            root.attach(part)
    elif len(body_parts) == 1:
        root = body_parts[0]
    else:
        root = MIMEMultipart("alternative")
        for part in body_parts:
            root.attach(part)

    root["From"] = formataddr((from_name, from_addr)) if from_name else from_addr
    root["To"] = ", ".join(formataddr(pair) for pair in to_list)
    if cc_list:
        root["Cc"] = ", ".join(formataddr(pair) for pair in cc_list)
    if bcc_list:
        root["Bcc"] = ", ".join(formataddr(pair) for pair in bcc_list)
    root["Subject"] = _header(subject)
    root["Date"] = formatdate(localtime=True)
    domain = from_addr.rsplit("@", 1)[-1] if "@" in from_addr else None
    root["Message-ID"] = make_msgid(domain=domain)
    in_reply_to = (payload.get("in_reply_to") or "").strip()
    if in_reply_to:
        root["In-Reply-To"] = in_reply_to
    references = (payload.get("references") or "").strip()
    if references:
        root["References"] = references
    root["X-Mailer"] = "FeiniuMail"

    raw = root.as_string(unixfrom=False).encode("utf-8", "replace")
    raw = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return raw, {
        "from": from_addr,
        "from_name": from_name,
        "to": to_list,
        "cc": cc_list,
        "bcc": bcc_list,
    }


def _strip_bcc_header(raw):
    """保存副本时去掉 Bcc 头，避免把密送对象留在归档里。"""
    out = []
    skipping = False
    for line in raw.split(b"\n"):
        if skipping:
            if line[:1] in (b" ", b"\t"):
                continue
            skipping = False
        if line.lower().startswith(b"bcc:"):
            skipping = True
            continue
        out.append(line)
    return b"\n".join(out)


# --------------------------------------------------------------------------- 连接


def _plain_secret(ctx, value):
    """取回明文密码。

    数据库行里的密码是密文，前端表单提交的是明文；
    解密函数对非密文一律返回空串，因此“解得开就是密文，解不开就是明文”。
    """
    if not value:
        return ""
    return repo.decrypt_secret(ctx, value) or value


def _resolve_creds(ctx, row):
    """解析发件凭据，未显式填写时回退到收件密码。

    row 既可能是数据库原始行（密码为密文），也可能是前端提交的表单（明文）。
    """
    user = (row.get("out_user") or row.get("in_user") or row.get("email") or "").strip()
    password = _plain_secret(ctx, row.get("out_password"))
    in_password = _plain_secret(ctx, row.get("in_password"))
    if row.get("id"):
        stored = repo.get_account(ctx, row.get("id"))
        if stored:
            if not user:
                user = (stored.get("out_user") or stored.get("in_user") or stored.get("email") or "").strip()
            if not password:
                password = repo.decrypt_secret(ctx, stored.get("out_password"))
            if not in_password:
                in_password = repo.decrypt_secret(ctx, stored.get("in_password"))
    use_in_auth = row.get("out_use_in_auth")
    if use_in_auth is None or use_in_auth:
        if not password:
            password = in_password
    return {"user": user, "password": password}


def _smtp_connect(row, creds):
    host = (row.get("out_host") or "").strip()
    port = int(row.get("out_port") or 465)
    security = (row.get("out_security") or "ssl").lower()
    if not host:
        raise SendError(u"未填写 SMTP 服务器地址")
    if not creds.get("user"):
        raise SendError(u"未填写发件账号")

    context = mailfetch._ssl_context(row.get("in_allow_insecure"))
    try:
        if security == "ssl":
            conn = smtplib.SMTP_SSL(host, port, timeout=SOCKET_TIMEOUT, context=context)
        else:
            conn = smtplib.SMTP(host, port, timeout=SOCKET_TIMEOUT)
            conn.ehlo()
            if security == "starttls":
                try:
                    conn.starttls(context=context)
                except smtplib.SMTPException as exc:
                    raise SendError(u"服务器不支持 STARTTLS，请改用 SSL 端口 465。（%s）" % exc)
                conn.ehlo()
    except SendError:
        raise
    except Exception as exc:
        raise SendError(mailfetch.friendly_error(exc))

    try:
        if creds.get("password"):
            conn.login(creds["user"], creds["password"])
        else:
            raise SendError(u"未填写发件密码 / 授权码")
    except SendError:
        try:
            conn.quit()
        except Exception:
            pass
        raise
    except smtplib.SMTPException as exc:
        try:
            conn.quit()
        except Exception:
            pass
        raise SendError(mailfetch.friendly_error(exc))
    return conn


def test_smtp(ctx, payload):
    row = dict(payload)
    creds = _resolve_creds(ctx, row)
    conn = _smtp_connect(row, creds)
    try:
        code, banner = conn.noop()
        return u"连接成功：SMTP 服务器 %s:%s 登录正常" % (row.get("out_host"), row.get("out_port") or 465)
    except smtplib.SMTPException as exc:
        raise SendError(mailfetch.friendly_error(exc))
    finally:
        try:
            conn.quit()
        except Exception:
            pass


# --------------------------------------------------------------------------- 归档


def _folder_for(ctx, account_id, kind):
    folder = repo.find_folder(ctx, account_id, kind=kind)
    if folder is None:
        folder = repo.find_folder(ctx, account_id, name=u"收件箱")
    if folder is None:
        raise SendError(u"账号缺少 %s 文件夹，请重新保存账号配置" % kind)
    return folder


def _store_copy(ctx, account, raw, kind, is_read=1, is_draft=0, prefix="s", uid="", blob_key=None, stamp=None):
    folder = _folder_for(ctx, account["id"], kind)
    parsed = mailparser.parse_message(raw)
    message_id, created = repo.store_message(
        ctx,
        account["id"],
        folder["id"],
        folder["kind"],
        uid,
        parsed,
        raw,
        is_read=is_read,
        is_draft=is_draft,
        blob_key=blob_key or ("%s:%s" % (kind, parsed.get("message_id") or time.time())),
        prefix=prefix,
        stamp=stamp,
    )
    return message_id, parsed


def _append_remote_sent(ctx, account, creds, raw):
    """把已发送副本通过 IMAP APPEND 追加到服务器（仅 IMAP 账号可用）。"""
    if (account.get("protocol") or "").lower() != "imap":
        return False, u"当前账号使用 POP3 收信，无法把已发送同步到服务器"
    folder = repo.find_folder(ctx, account["id"], kind="sent")
    remote = (folder or {}).get("remote_name") or ""
    if not remote:
        return False, u"未找到服务器上的「已发送」文件夹"
    conn = mailfetch._imap_connect(
        account, {"user": creds.get("user") or "", "password": creds.get("password") or ""}
    )
    try:
        typ, data = conn.append(remote, "(\\Seen)", None, raw)
        if typ != "OK":
            return False, u"服务器拒绝保存已发送副本：%s" % (data,)
        return True, u"已同步到服务器「已发送」"
    except Exception as exc:
        return False, mailfetch.friendly_error(exc)
    finally:
        try:
            conn.logout()
        except Exception:
            pass


# --------------------------------------------------------------------------- 对外接口


def send_mail(ctx, account_id, payload):
    account = repo.get_account(ctx, account_id)
    if account is None:
        raise SendError(u"发件账号不存在")

    attachments = _collect_attachments(payload)
    raw, envelope = build_mime_message(account, payload, attachments)
    creds = _resolve_creds(ctx, account)

    recipients = [addr for _name, addr in (envelope["to"] + envelope["cc"] + envelope["bcc"]) if addr]
    if not recipients:
        raise SendError(u"收件人地址为空")

    # 传输副本必须去掉 Bcc 头，否则收件人能看到密送名单；密送地址仍通过信封收件人投递
    saved_raw = _strip_bcc_header(raw)

    conn = _smtp_connect(account, creds)
    try:
        refused = conn.sendmail(envelope["from"], recipients, saved_raw) or {}
    except smtplib.SMTPException as exc:
        raise SendError(mailfetch.friendly_error(exc))
    finally:
        try:
            conn.quit()
        except Exception:
            pass

    message_id, parsed = _store_copy(ctx, account, saved_raw, "sent", is_read=1, prefix="s")

    server_synced = False
    server_message = ""
    if account.get("save_sent_to_server"):
        try:
            server_synced, server_message = _append_remote_sent(ctx, account, creds, saved_raw)
        except Exception as exc:
            server_message = mailfetch.friendly_error(exc)
        repo.add_log(
            ctx,
            "info" if server_synced else "warn",
            "smtp",
            u"已发送同步到服务器：%s" % (server_message or "未执行"),
        )

    repo.add_log(
        ctx,
        "info",
        "smtp",
        u"已发送邮件「%s」-> %s" % (parsed.get("subject") or u"(无主题)", ", ".join(recipients)),
    )
    return {
        "ok": True,
        "message_id": message_id,
        "recipients": recipients,
        "refused": refused,
        "server_synced": server_synced,
        "server_message": server_message,
        "subject": parsed.get("subject") or payload.get("subject") or "",
    }


def save_draft(ctx, account_id, payload, draft_id=None):
    account = repo.get_account(ctx, account_id)
    if account is None:
        raise SendError(u"账号不存在")

    attachments = _collect_attachments(payload)
    # 草稿允许没有收件人
    to_list = _addr_list(payload.get("to"))
    if not to_list:
        payload = dict(payload)
        payload["to"] = [{"name": "", "addr": account.get("email") or "draft@local"}]
    raw, _envelope = build_mime_message(account, payload, attachments)

    if draft_id:
        existing = repo.get_message(ctx, draft_id)
        if existing is not None and existing.get("is_draft"):
            repo.delete_message(ctx, existing["id"])

    message_id, parsed = _store_copy(
        ctx, account, raw, "drafts", is_read=1, is_draft=1, prefix="d", blob_key="draft:%s" % time.time()
    )
    return {"ok": True, "message_id": message_id, "subject": parsed.get("subject") or ""}


def draft_to_payload(ctx, message_id):
    """把已保存的草稿还原成写信界面需要的结构。"""
    row = repo.get_message(ctx, message_id)
    if row is None:
        raise SendError(u"草稿不存在")
    raw = ctx.blobs.read(row.get("eml_path"))
    parsed = mailparser.parse_message(raw or b"")
    return {
        "id": row["id"],
        "account_id": row["account_id"],
        "to": parsed.get("to_list") or [],
        "cc": parsed.get("cc_list") or [],
        "bcc": parsed.get("bcc_list") or [],
        "subject": parsed.get("subject") or "",
        "text": parsed.get("text") or "",
        "html": parsed.get("html") or "",
        "attachments": [
            {"filename": item.get("filename"), "content_type": item.get("content_type"), "size": item.get("size")}
            for item in (parsed.get("attachments") or [])
        ],
    }
