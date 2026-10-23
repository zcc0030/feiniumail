# -*- coding: utf-8 -*-
"""邮件 HTML 正文净化。

目标：在不执行脚本、不泄露隐私的前提下尽量保留邮件原本的排版。
- 只保留白名单标签与属性；
- 移除全部 on* 事件、javascript: 链接、<script>/<iframe>/<form>/<object> 等；
- 默认阻止外部图片（追踪像素），改为占位符，用户点击「显示图片」后重新渲染；
- cid: 内嵌图片改写为本站接口地址。
"""
import html as html_mod
import re
from html.parser import HTMLParser

PLACEHOLDER_GIF = (
    "data:image/gif;base64,"
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}

DROP_TAGS = {
    "script", "iframe", "frame", "frameset", "object", "embed", "applet",
    "form", "input", "textarea", "select", "option", "button", "base",
    "link", "meta", "noscript", "template", "svg", "math", "canvas",
    "audio", "video", "source", "track", "dialog", "slot", "portal",
}

ALLOWED_TAGS = {
    "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big",
    "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup",
    "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption",
    "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "i", "img", "ins", "kbd", "label", "legend", "li", "main", "mark",
    "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span",
    "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td",
    "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "style",
}

ALLOWED_ATTRS = {
    "align", "alt", "bgcolor", "border", "cellpadding", "cellspacing",
    "class", "color", "colspan", "dir", "face", "height", "href", "id",
    "lang", "name", "rowspan", "size", "span", "start", "style", "title",
    "valign", "width", "src", "target", "rel",
}

SAFE_SCHEMES = ("http://", "https://", "mailto:", "tel:", "ftp://")
CSS_URL = re.compile(r"url\s*\([^)]*\)", re.I)
CSS_BAD = re.compile(r"(expression\s*\(|behaviou?r\s*:|javascript\s*:)", re.I)
STYLE_AT_IMPORT = re.compile(r"@import[^;]*;", re.I)


def _clean_style_value(value):
    value = CSS_URL.sub("", value or "")
    value = CSS_BAD.sub("", value)
    return value.strip()


def _clean_style_block(css):
    css = STYLE_AT_IMPORT.sub("", css or "")
    css = CSS_URL.sub("none", css)
    css = CSS_BAD.sub("", css)
    return css


def _check_url(value):
    value = (value or "").strip()
    lowered = value.lower().replace("\t", "").replace("\n", "").replace("\r", "")
    lowered = re.sub(r"[\x00-\x20]", "", lowered)
    if lowered.startswith("javascript:") or lowered.startswith("vbscript:"):
        return None
    if lowered.startswith("data:"):
        if lowered.startswith("data:image/"):
            return value
        return None
    if lowered.startswith("cid:"):
        return value
    for scheme in SAFE_SCHEMES:
        if lowered.startswith(scheme):
            return value
    if ":" in lowered.split("/")[0].split("?")[0].split("#")[0]:
        return None
    return value


class MailHTMLSanitizer(HTMLParser):
    def __init__(self, allow_images=False, cid_map=None, message_id=None, url_suffix=""):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.allow_images = bool(allow_images)
        self.cid_map = cid_map or {}
        self.message_id = message_id
        self.url_suffix = url_suffix or ""
        self.parts = []
        self.stack = []
        self.skip_depth = 0
        self.in_style = 0
        self.remote_images = []
        self.blocked_count = 0

    # --- 工具 ---
    def _url_for_cid(self, cid):
        index = self.cid_map.get(cid.strip().lower())
        if index is None:
            return None
        return "/api/messages/%s/parts/%s%s" % (self.message_id, index, self.url_suffix)

    def _rewrite_src(self, value):
        checked = _check_url(value)
        if checked is None:
            return None, False
        lowered = checked.lower()
        if lowered.startswith("cid:"):
            mapped = self._url_for_cid(checked[4:])
            return mapped, False
        if lowered.startswith("data:"):
            return checked, False
        if lowered.startswith("http://") or lowered.startswith("https://") or lowered.startswith("//"):
            if self.allow_images:
                return checked, False
            self.blocked_count += 1
            if len(self.remote_images) < 50 and checked not in self.remote_images:
                self.remote_images.append(checked)
            return PLACEHOLDER_GIF, True
        return None, False

    # --- HTMLParser 回调 ---
    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_TAGS:
            if tag not in VOID_TAGS:
                self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "style":
            # <style> 开标签必须一并输出：若只保留 CSS 内容与 </style>，
            # 浏览器会把这段声明当成正文纯文本显示出来（邮件里出现
            # “body { line-height: 1.5; }” 这类提示就是这个原因）。
            self.parts.append("<style>")
            self.in_style += 1
            return
        if tag not in ALLOWED_TAGS:
            return

        out_attrs = []
        for name, value in attrs:
            name = (name or "").lower()
            if name not in ALLOWED_ATTRS:
                continue
            if name.startswith("on"):
                continue
            value = value if value is not None else ""
            if name == "style":
                cleaned = _clean_style_value(value)
                if cleaned:
                    out_attrs.append(("style", cleaned))
                continue
            if name in ("href", "src"):
                if name == "src":
                    new_value, blocked = self._rewrite_src(value)
                    if new_value is None:
                        continue
                    if blocked:
                        out_attrs.append(("data-fnmail-remote", value))
                        out_attrs.append(("class", "fnmail-blocked-img"))
                    out_attrs.append(("src", new_value))
                    continue
                checked = _check_url(value)
                if checked is None:
                    continue
                out_attrs.append(("href", checked))
                out_attrs.append(("target", "_blank"))
                out_attrs.append(("rel", "noopener noreferrer nofollow"))
                continue
            out_attrs.append((name, value))

        self.parts.append("<" + tag)
        for name, value in out_attrs:
            self.parts.append(' %s="%s"' % (name, html_mod.escape(str(value), quote=True)))
        self.parts.append(">")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag == "style":
            if self.in_style:
                self.in_style -= 1
                self.parts.append("</style>")
            return
        if tag not in ALLOWED_TAGS:
            return
        if tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                top = self.stack.pop()
                self.parts.append("</%s>" % top)
                if top == tag:
                    break

    def handle_data(self, data):
        if self.skip_depth or not data:
            return
        if self.in_style:
            css = _clean_style_block(data)
            if css.strip():
                self.parts.append(css)
            return
        self.parts.append(html_mod.escape(data, quote=False))

    def handle_comment(self, data):
        return

    def handle_decl(self, decl):
        return

    def handle_pi(self, data):
        return

    def unknown_decl(self, data):
        return

    # --- 输出 ---
    def result(self):
        return "".join(self.parts)

    def close_all(self):
        while self.stack:
            top = self.stack.pop()
            self.parts.append("</%s>" % top)


BASE_STYLE = """
html,body{margin:0;padding:0;background:#ffffff;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
     font-size:14px;line-height:1.7;color:#1f2329;word-break:break-word;overflow-wrap:anywhere;padding:16px 20px 40px;}
img{max-width:100%;height:auto;}
table{max-width:100%;border-collapse:collapse;}
a{color:#2b6cf6;}
blockquote{border-left:3px solid #dfe3e8;margin:8px 0;padding:2px 12px;color:#5c6470;}
pre,code{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.fnmail-blocked-img{background:#f2f4f7;border:1px dashed #d0d5dd;min-width:24px;min-height:24px;}
"""


def sanitize_mail_html(raw_html, allow_images=False, cid_map=None, message_id=None, url_suffix=""):
    """返回 (净化后的正文片段, 被拦截的外链图片列表)。"""
    parser = MailHTMLSanitizer(
        allow_images=allow_images, cid_map=cid_map, message_id=message_id, url_suffix=url_suffix
    )
    try:
        parser.feed(raw_html or "")
        parser.close()
    except Exception:
        pass
    parser.close_all()
    body = parser.result()
    return body, parser.remote_images


def build_document(body_fragment, title=""):
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<meta name=\"referrer\" content=\"no-referrer\">"
        "<title>%s</title><style>%s</style></head><body>%s</body></html>"
        % (html_mod.escape(title or ""), BASE_STYLE, body_fragment)
    )


def text_to_document(text):
    escaped = html_mod.escape(text or "", quote=False)
    return build_document('<pre class="fnmail-plain">%s</pre>' % escaped)


def text_to_fragment(text):
    return '<pre class="fnmail-plain">%s</pre>' % html_mod.escape(text or "", quote=False)
