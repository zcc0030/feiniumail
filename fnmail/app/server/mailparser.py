# -*- coding: utf-8 -*-
"""邮件原文解析：头部解码、正文提取、附件元信息、按需取附件内容。"""
import email.utils
import re
from email import policy
from email.parser import BytesParser

POLICY = policy.default

_CHARSET_FALLBACK = ("utf-8", "gb18030", "big5", "shift_jis", "latin-1")
_WS = re.compile(r"[ \t\u00a0]+")
_NEWLINE = re.compile(r"[\r\n]+")
_TAG = re.compile(r"<[^>]+>")


def header_text(value):
    if value is None:
        return ""
    try:
        text = str(value)
    except Exception:
        try:
            text = value.encode("utf-8", "replace").decode("utf-8", "replace")
        except Exception:
            text = ""
    return _NEWLINE.sub(" ", text).strip()


def parse_addresses(value):
    if not value:
        return []
    raw = header_text(value)
    if not raw:
        return []
    result = []
    try:
        pairs = email.utils.getaddresses([raw])
    except Exception:
        pairs = [(raw, "")]
    for name, addr in pairs:
        name = (name or "").strip()
        addr = (addr or "").strip()
        if not name and not addr:
            continue
        if not addr and "@" in name:
            addr, name = name, ""
        result.append({"name": name, "addr": addr})
    return result


def _decode_payload(part):
    try:
        data = part.get_payload(decode=True)
    except Exception:
        data = None
    if data is None:
        payload = part.get_payload()
        return payload if isinstance(payload, str) else ""
    charset = part.get_content_charset()
    candidates = []
    if charset:
        candidates.append(charset)
    candidates.extend(_CHARSET_FALLBACK)
    for enc in candidates:
        try:
            return data.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", "replace")


def _part_size(part):
    """估算部件解码后的字节数，用于附件列表展示。

    这里刻意不调用 get_payload(decode=True)：那会为统计一个大小而把整个附件
    在内存里还原一遍（100 MB 邮件等于多分配一份等量内存，并拖慢后续 GC）。
    按编码后的文本长度换算即可：base64 结果精确（仅需扣除补位符），
    其他编码同样只需一次编码转换，不做多余的拷贝。
    """
    payload = part.get_payload()
    if isinstance(payload, list):
        return 0
    if isinstance(payload, bytes):
        return len(payload)
    cte = (part.get("Content-Transfer-Encoding") or "").strip().lower()
    if cte == "base64":
        compact = payload.replace("\r", "").replace("\n", "").strip()
        pad = len(compact) - len(compact.rstrip("="))
        return max(0, (len(compact) * 3) // 4 - pad)
    return len(payload.encode("utf-8", "replace")) if payload else 0


def parse_date(value):
    if not value:
        return 0
    try:
        parsed = email.utils.parsedate_to_datetime(header_text(value))
    except Exception:
        return 0
    if parsed is None:
        return 0
    try:
        if parsed.tzinfo is None:
            import time as _time

            return int(_time.mktime(parsed.timetuple()))
        return int(parsed.timestamp())
    except Exception:
        return 0


def strip_html(html):
    if not html:
        return ""
    import html as html_mod

    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|li|h[1-6])>", "\n", text)
    text = _TAG.sub(" ", text)
    text = html_mod.unescape(text)
    text = _WS.sub(" ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def make_preview(text, limit=240):
    text = (text or "").strip()
    text = _WS.sub(" ", text)
    text = _NEWLINE.sub(" ", text)
    return text[:limit]


def parse_message(raw, with_bodies=True):
    """解析原始邮件，返回索引字段与正文。"""
    msg = BytesParser(policy=POLICY).parsebytes(raw)
    info = {
        "subject": header_text(msg.get("Subject")),
        "from_list": parse_addresses(msg.get("From")),
        "to_list": parse_addresses(msg.get("To")),
        "cc_list": parse_addresses(msg.get("Cc")),
        "bcc_list": parse_addresses(msg.get("Bcc")),
        "reply_to": header_text(msg.get("Reply-To")),
        "message_id": header_text(msg.get("Message-ID")),
        "in_reply_to": header_text(msg.get("In-Reply-To")),
        "references": header_text(msg.get("References")),
        "date_ts": parse_date(msg.get("Date")),
        "text": "",
        "html": "",
        "attachments": [],
        "has_attach": 0,
    }

    texts = []
    htmls = []
    attachments = []
    if with_bodies:
        for index, part in enumerate(msg.walk()):
            if part.is_multipart():
                continue
            ctype = (part.get_content_type() or "text/plain").lower()
            disposition = (part.get_content_disposition() or "").lower()
            filename = header_text(part.get_filename())
            content_id = header_text(part.get("Content-ID")).strip("<>").strip()
            size = _part_size(part)
            is_body = (
                disposition != "attachment"
                and not filename
                and ctype in ("text/plain", "text/html")
                and not content_id
            )
            if is_body:
                if ctype == "text/html":
                    htmls.append(_decode_payload(part))
                else:
                    texts.append(_decode_payload(part))
                continue
            attachments.append(
                {
                    "part_index": index,
                    "filename": filename or (u"附件-%d" % (len(attachments) + 1)),
                    "content_type": ctype,
                    "size": size,
                    "content_id": content_id,
                    "is_inline": 1 if (disposition == "inline" or content_id) else 0,
                }
            )

    info["text"] = "\n".join(part for part in texts if part).strip()
    info["html"] = "\n".join(part for part in htmls if part).strip()
    info["attachments"] = attachments
    info["has_attach"] = 1 if attachments else 0
    return info


def iter_parts(raw):
    """按 walk() 顺序枚举所有非 multipart 部件，索引与 parse_message 保持一致。"""
    msg = BytesParser(policy=POLICY).parsebytes(raw)
    for index, part in enumerate(msg.walk()):
        yield index, part


def get_part_payload(raw, index):
    """取出指定索引部件的 (文件名, MIME 类型, 内容字节)。"""
    for current, part in iter_parts(raw):
        if current != index:
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            payload = None
        if payload is None:
            text = part.get_payload()
            payload = text.encode("utf-8", "replace") if isinstance(text, str) else b""
        return {
            "filename": header_text(part.get_filename()),
            "content_type": (part.get_content_type() or "application/octet-stream"),
            "data": payload,
            "content_id": header_text(part.get("Content-ID")).strip("<>").strip(),
        }
    return None


def part_payload_safe(raw, index):
    """用于附件下载的包装，解析异常时返回 None。"""
    if index is None or index < 0:
        return None
    try:
        return get_part_payload(raw, int(index))
    except Exception:
        return None
