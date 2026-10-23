# -*- coding: utf-8 -*-
"""邮件原文（.eml）落盘存储。

邮件原文是唯一数据源：数据库只保存索引，正文与附件在读取时按需从 .eml 解析，
避免同一份内容重复存储。
"""
import hashlib
import os
import re
import time

_SAFE = re.compile(r"[^0-9A-Za-z._\u4e00-\u9fff-]+")


def safe_name(text, fallback="item", limit=80):
    text = (text or "").strip()
    text = _SAFE.sub("_", text)
    text = text.strip("._")
    if not text:
        text = fallback
    return text[:limit]


class BlobStore(object):
    def __init__(self, root):
        self.root = root
        os.makedirs(self.root, exist_ok=True)

    def ensure(self):
        os.makedirs(self.root, exist_ok=True)

    def abspath(self, relpath):
        if not relpath:
            return None
        candidate = os.path.normpath(os.path.join(self.root, relpath))
        root = os.path.normpath(self.root)
        if candidate != root and not candidate.startswith(root + os.sep):
            raise ValueError("非法的邮件存储路径")
        return candidate

    def _folder_dir(self, account_id, folder_kind, folder_id, stamp):
        rel = os.path.join(
            "acc-%d" % int(account_id),
            "%s-%d" % (safe_name(folder_kind, "custom", 24), int(folder_id)),
            time.strftime("%Y-%m", time.localtime(stamp)),
        )
        absolute = os.path.join(self.root, rel)
        os.makedirs(absolute, exist_ok=True)
        try:
            os.chmod(absolute, 0o700)
        except OSError:
            pass
        return rel

    def save_eml(self, account_id, folder_kind, folder_id, key, raw, stamp=None, prefix=None):
        stamp = int(stamp or time.time())
        rel_dir = self._folder_dir(account_id, folder_kind, folder_id, stamp)
        digest = hashlib.sha1((key or str(stamp)).encode("utf-8", "ignore")).hexdigest()[:12]
        name = "%s-%s-%s.eml" % (time.strftime("%Y%m%d%H%M%S", time.localtime(stamp)), prefix or "m", digest)
        rel = os.path.join(rel_dir, name)
        absolute = os.path.join(self.root, rel)
        tmp = absolute + ".part"
        with open(tmp, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, absolute)
        try:
            os.chmod(absolute, 0o600)
        except OSError:
            pass
        return rel

    def read(self, relpath):
        path = self.abspath(relpath)
        if not path or not os.path.isfile(path):
            return None
        with open(path, "rb") as fh:
            return fh.read()

    def remove(self, relpath):
        path = self.abspath(relpath)
        if path and os.path.isfile(path):
            try:
                os.remove(path)
                return True
            except OSError:
                return False
        return False

    def remove_account(self, account_id):
        rel = "acc-%d" % int(account_id)
        path = self.abspath(rel)
        if not path or not os.path.isdir(path):
            return
        for current, dirs, files in os.walk(path, topdown=False):
            for name in files:
                try:
                    os.remove(os.path.join(current, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(current, name))
                except OSError:
                    pass
        try:
            os.rmdir(path)
        except OSError:
            pass
