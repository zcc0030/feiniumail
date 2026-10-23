# -*- coding: utf-8 -*-
"""常见邮箱服务商预设，用于新建账号时自动填服务器地址与端口。"""

PROVIDERS = [
    {
        "id": "qq",
        "name": "QQ 邮箱 / Foxmail",
        "domains": ["qq.com", "foxmail.com", "vip.qq.com"],
        "note": "需在 QQ 邮箱设置中开启 POP3/SMTP 或 IMAP/SMTP，密码填写「授权码」",
        "pop3": {"host": "pop.qq.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.qq.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.qq.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "163",
        "name": "网易 163 邮箱",
        "domains": ["163.com", "vip.163.com", "yeah.net"],
        "note": "需开启 POP3/SMTP/IMAP 服务，客户端密码填写授权码",
        "pop3": {"host": "pop.163.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.163.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.163.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "126",
        "name": "网易 126 邮箱",
        "domains": ["126.com"],
        "note": "需开启 POP3/SMTP/IMAP 服务，客户端密码填写授权码",
        "pop3": {"host": "pop.126.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.126.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.126.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "aliyun",
        "name": "阿里云邮箱",
        "domains": ["aliyun.com", "aliyun.cn", "mails.aliyun.com"],
        "note": "",
        "pop3": {"host": "pop3.aliyun.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.aliyun.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.aliyun.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "sina",
        "name": "新浪邮箱",
        "domains": ["sina.com", "sina.cn"],
        "note": "",
        "pop3": {"host": "pop.sina.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.sina.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.sina.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "sohu",
        "name": "搜狐邮箱",
        "domains": ["sohu.com"],
        "note": "",
        "pop3": {"host": "pop3.sohu.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.sohu.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.sohu.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "139",
        "name": "中国移动 139 邮箱",
        "domains": ["139.com"],
        "note": "",
        "pop3": {"host": "pop.139.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.139.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.139.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "gmail",
        "name": "Gmail",
        "domains": ["gmail.com", "googlemail.com"],
        "note": "需要先在 Google 账号中开启两步验证并生成「应用专用密码」",
        "pop3": {"host": "pop.gmail.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.gmail.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.gmail.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "outlook",
        "name": "Outlook / Hotmail",
        "domains": ["outlook.com", "hotmail.com", "live.com", "live.cn", "msn.com"],
        "note": "通常需要在微软账号中开启两步验证并使用应用密码",
        "pop3": {"host": "outlook.office365.com", "port": 995, "security": "ssl"},
        "imap": {"host": "outlook.office365.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.office365.com", "port": 587, "security": "starttls"},
    },
    {
        "id": "icloud",
        "name": "iCloud 邮箱",
        "domains": ["icloud.com", "me.com", "mac.com"],
        "note": "需要在 Apple ID 中生成 App 专用密码",
        "pop3": {"host": "pop.mail.me.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.mail.me.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.mail.me.com", "port": 587, "security": "starttls"},
    },
    {
        "id": "exmail",
        "name": "腾讯企业邮箱",
        "domains": ["exmail.qq.com"],
        "note": "",
        "pop3": {"host": "pop.exmail.qq.com", "port": 995, "security": "ssl"},
        "imap": {"host": "imap.exmail.qq.com", "port": 993, "security": "ssl"},
        "smtp": {"host": "smtp.exmail.qq.com", "port": 465, "security": "ssl"},
    },
    {
        "id": "custom",
        "name": "自定义 / 自建邮件服务器",
        "domains": [],
        "note": "手动填写服务器地址、端口与加密方式",
        "pop3": None,
        "imap": None,
        "smtp": None,
    },
]

_BY_DOMAIN = {}
for _provider in PROVIDERS:
    for _domain in _provider["domains"]:
        _BY_DOMAIN[_domain] = _provider


def guess_provider(email):
    if not email or "@" not in email:
        return None
    domain = email.rsplit("@", 1)[1].strip().lower()
    if domain in _BY_DOMAIN:
        return _BY_DOMAIN[domain]
    for candidate, provider in _BY_DOMAIN.items():
        if domain.endswith("." + candidate):
            return provider
    return None


def apply_preset(payload):
    """根据邮箱地址填充服务器默认值，仅在用户未填写时生效。"""
    provider = guess_provider(payload.get("email", ""))
    if not provider:
        return payload, None
    protocol = payload.get("protocol") or "pop3"
    incoming = provider.get(protocol) or provider.get("pop3")
    outgoing = provider.get("smtp")
    if incoming:
        payload.setdefault("in_host", incoming["host"])
        payload.setdefault("in_port", incoming["port"])
        payload.setdefault("in_security", incoming["security"])
    if outgoing:
        payload.setdefault("out_host", outgoing["host"])
        payload.setdefault("out_port", outgoing["port"])
        payload.setdefault("out_security", outgoing["security"])
    return payload, provider["id"]
