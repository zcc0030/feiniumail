# -*- coding: utf-8 -*-
"""后台收信调度：定时同步账号，并提供手动同步与进度状态查询。"""
import threading
import time

import mailfetch
import repo


class SyncManager(object):
    """按账号串行执行收信任务，避免同一账号并发拉取。

    - 定时轮询：每个账号按 sync_interval 触发；
    - 手动触发：接口调用 trigger()，若该账号正在收取则直接返回 False；
    - 进度状态写入 ctx.sync_state[account_id]，供前端实时展示。
    """

    def __init__(self, ctx, tick=20):
        self.ctx = ctx
        self.tick = max(5, int(tick))
        self._stop = threading.Event()
        self._thread = None
        self._guard = threading.Lock()
        self._busy = set()

    # ---------------------------------------------------------------- 生命周期
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="fnmail-sync", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=5)

    # ---------------------------------------------------------------- 调度
    def _loop(self):
        # 启动稍作等待，避免与服务启动争抢资源
        if self._stop.wait(8):
            return
        while not self._stop.wait(self.tick):
            try:
                self.tick_once()
            except Exception as exc:  # 调度线程不允许异常退出
                try:
                    repo.add_log(self.ctx, "error", "scheduler", u"调度异常：%s" % exc)
                except Exception:
                    pass

    def tick_once(self):
        rows = self.ctx.db.query(
            "SELECT id, sync_enabled, sync_interval, last_sync FROM accounts "
            "WHERE sync_enabled = 1 AND protocol <> '' ORDER BY sort ASC, id ASC"
        )
        now = int(time.time())
        for row in rows:
            interval = max(60, int(row.get("sync_interval") or 300))
            if row.get("last_sync") and now - int(row["last_sync"]) < interval:
                continue
            self.trigger(row["id"], manual=False)

    # ---------------------------------------------------------------- 触发
    def trigger(self, account_id, manual=False):
        account_id = int(account_id)
        with self._guard:
            if account_id in self._busy:
                return False
            self._busy.add(account_id)
        thread = threading.Thread(
            target=self._run, args=(account_id, manual), name="fnmail-sync-%d" % account_id, daemon=True
        )
        thread.start()
        return True

    def is_running(self, account_id):
        with self._guard:
            return int(account_id) in self._busy

    def state(self, account_id, account=None):
        account_id = int(account_id)
        state = self.ctx.sync_state.get(account_id)
        if state is None:
            state = {
                "running": False,
                "stage": "",
                "message": "",
                "current": 0,
                "total": 0,
                "started": 0,
                "finished": 0,
                "result": None,
                "error": "",
            }
        data = dict(state)
        data["busy"] = self.is_running(account_id)
        if account is not None:
            data["last_sync"] = account.get("last_sync") or 0
            data["last_sync_status"] = account.get("last_sync_status") or ""
            data["last_sync_message"] = account.get("last_sync_message") or ""
            data["last_error"] = account.get("last_error") or ""
        return data

    # ---------------------------------------------------------------- 执行
    def _run(self, account_id, manual):
        ctx = self.ctx
        state = {
            "running": True,
            "stage": u"准备中",
            "message": "",
            "current": 0,
            "total": 0,
            "started": int(time.time()),
            "finished": 0,
            "result": None,
            "error": "",
            "manual": bool(manual),
        }
        ctx.sync_state[account_id] = state

        def progress(stage, message, current, total):
            state["stage"] = stage or ""
            state["message"] = message or ""
            state["current"] = int(current or 0)
            state["total"] = int(total or 0)

        try:
            account = repo.get_account(ctx, account_id)
            if account is None:
                raise mailfetch.FetchError(u"账号已被删除")
            repo.set_account_sync_state(ctx, account_id, "running", u"正在收取邮件…")
            if (account.get("protocol") or "pop3").lower() == "imap":
                result = mailfetch.sync_imap(ctx, account_id, progress=progress)
            else:
                result = mailfetch.sync_pop3(ctx, account_id, progress=progress)

            state["result"] = result
            summary = _summary(result)
            repo.set_account_sync_state(ctx, account_id, "ok", summary)
            repo.add_log(ctx, "info", "sync", u"账号 #%d 收取完成：%s" % (account_id, summary))
        except Exception as exc:
            message = mailfetch.friendly_error(exc)
            state["error"] = message
            repo.set_account_sync_state(ctx, account_id, "error", "", message)
            repo.add_log(ctx, "error", "sync", u"账号 #%d 收取失败：%s" % (account_id, message))
        finally:
            state["running"] = False
            state["stage"] = u"完成" if not state["error"] else u"失败"
            state["finished"] = int(time.time())
            with self._guard:
                self._busy.discard(account_id)
            try:
                repo.trim_logs(ctx)
            except Exception:
                pass


def _summary(result):
    if not result:
        return u"无变化"
    protocol = (result.get("protocol") or "").upper()
    fetched = int(result.get("fetched") or 0)
    failed = int(result.get("failed") or 0)
    parts = [u"新收 %d 封" % fetched]
    if failed:
        parts.append(u"失败 %d 封" % failed)
    if protocol == "IMAP":
        parts.append(u"同步 %d 个文件夹" % int(result.get("folders") or 0))
    elif protocol == "POP3" and result.get("deleted_from_server"):
        parts.append(u"服务器清理 %d 封" % int(result["deleted_from_server"]))
    return u"%s：%s" % (protocol, u"，".join(parts))
