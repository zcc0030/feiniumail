# -*- coding: utf-8 -*-
"""SQLite 访问层：连接管理 + 建表。"""
import os
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS accounts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL DEFAULT '',
    email                 TEXT    NOT NULL DEFAULT '',
    display_name          TEXT    NOT NULL DEFAULT '',
    protocol              TEXT    NOT NULL DEFAULT 'pop3',
    in_host               TEXT    NOT NULL DEFAULT '',
    in_port               INTEGER NOT NULL DEFAULT 110,
    in_security           TEXT    NOT NULL DEFAULT 'ssl',
    in_user               TEXT    NOT NULL DEFAULT '',
    in_password           TEXT    NOT NULL DEFAULT '',
    in_allow_insecure     INTEGER NOT NULL DEFAULT 0,
    pop3_keep_server      INTEGER NOT NULL DEFAULT 0,
    imap_sync_all         INTEGER NOT NULL DEFAULT 0,
    out_host              TEXT    NOT NULL DEFAULT '',
    out_port              INTEGER NOT NULL DEFAULT 465,
    out_security          TEXT    NOT NULL DEFAULT 'ssl',
    out_user              TEXT    NOT NULL DEFAULT '',
    out_password          TEXT    NOT NULL DEFAULT '',
    out_use_in_auth       INTEGER NOT NULL DEFAULT 1,
    save_sent_to_server   INTEGER NOT NULL DEFAULT 0,
    signature             TEXT    NOT NULL DEFAULT '',
    sync_enabled          INTEGER NOT NULL DEFAULT 1,
    sync_interval         INTEGER NOT NULL DEFAULT 300,
    last_sync             INTEGER NOT NULL DEFAULT 0,
    last_sync_status      TEXT    NOT NULL DEFAULT '',
    last_sync_message     TEXT    NOT NULL DEFAULT '',
    last_error            TEXT    NOT NULL DEFAULT '',
    sort                  INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    kind         TEXT    NOT NULL DEFAULT 'custom',
    remote_name  TEXT    NOT NULL DEFAULT '',
    is_synced    INTEGER NOT NULL DEFAULT 1,
    sort         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_uniq ON folders(account_id, name);
CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id, sort, id);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    INTEGER NOT NULL,
    folder_id     INTEGER NOT NULL,
    uid           TEXT    NOT NULL DEFAULT '',
    message_id    TEXT    NOT NULL DEFAULT '',
    subject       TEXT    NOT NULL DEFAULT '',
    from_name     TEXT    NOT NULL DEFAULT '',
    from_addr     TEXT    NOT NULL DEFAULT '',
    to_addrs      TEXT    NOT NULL DEFAULT '[]',
    cc_addrs      TEXT    NOT NULL DEFAULT '[]',
    bcc_addrs     TEXT    NOT NULL DEFAULT '[]',
    reply_to      TEXT    NOT NULL DEFAULT '',
    date_ts       INTEGER NOT NULL DEFAULT 0,
    size          INTEGER NOT NULL DEFAULT 0,
    has_attach    INTEGER NOT NULL DEFAULT 0,
    is_read       INTEGER NOT NULL DEFAULT 0,
    is_starred    INTEGER NOT NULL DEFAULT 0,
    is_draft      INTEGER NOT NULL DEFAULT 0,
    remote_flags  TEXT    NOT NULL DEFAULT '',
    body_preview  TEXT    NOT NULL DEFAULT '',
    eml_path      TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_uid ON messages(account_id, folder_id, uid) WHERE uid <> '';
CREATE INDEX IF NOT EXISTS idx_msg_folder ON messages(folder_id, date_ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_msg_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_msg_messageid ON messages(message_id);

CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL,
    part_index   INTEGER NOT NULL DEFAULT 0,
    filename     TEXT    NOT NULL DEFAULT '',
    content_type TEXT    NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL DEFAULT 0,
    content_id   TEXT    NOT NULL DEFAULT '',
    is_inline    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attach_msg ON attachments(message_id, part_index);

CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL DEFAULT '',
    email       TEXT    NOT NULL DEFAULT '',
    phone       TEXT    NOT NULL DEFAULT '',
    company     TEXT    NOT NULL DEFAULT '',
    title       TEXT    NOT NULL DEFAULT '',
    groups      TEXT    NOT NULL DEFAULT '',
    note        TEXT    NOT NULL DEFAULT '',
    color       TEXT    NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    source      TEXT    NOT NULL DEFAULT 'manual',
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

CREATE TABLE IF NOT EXISTS contact_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cgroup_name ON contact_groups(name);

CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL DEFAULT 0,
    level   TEXT    NOT NULL DEFAULT 'info',
    source  TEXT    NOT NULL DEFAULT '',
    message TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
"""


class Database(object):
    def __init__(self, path):
        self.path = path
        self._local = threading.local()
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.init_schema()

    def conn(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=15000")
            self._local.conn = conn
        return conn

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

    def init_schema(self):
        conn = self.conn()
        conn.executescript(SCHEMA)

    def execute(self, sql, args=()):
        return self.conn().execute(sql, args)

    def executemany(self, sql, seq):
        return self.conn().executemany(sql, seq)

    def query(self, sql, args=()):
        return [dict(row) for row in self.conn().execute(sql, args).fetchall()]

    def query_one(self, sql, args=()):
        row = self.conn().execute(sql, args).fetchone()
        return dict(row) if row is not None else None

    def scalar(self, sql, args=(), default=None):
        row = self.conn().execute(sql, args).fetchone()
        if row is None:
            return default
        value = row[0]
        return default if value is None else value

    def insert(self, sql, args=()):
        return self.conn().execute(sql, args).lastrowid

    def update(self, sql, args=()):
        cursor = self.conn().execute(sql, args)
        return cursor.rowcount

    def meta_get(self, key, default=None):
        row = self.query_one("SELECT value FROM meta WHERE key = ?", (key,))
        return default if row is None else row["value"]

    def meta_set(self, key, value):
        self.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, "" if value is None else str(value)),
        )
