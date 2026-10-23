/* 肥牛邮箱（FeiniuMail）· 前端逻辑（原生 JavaScript，无第三方依赖） */
'use strict';

/* ===================================================================== 基础 */

var TOKEN_KEY = 'fnmail_token';

var state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  boot: null,
  view: 'mail',
  target: { accountId: null, kind: 'inbox', folderId: null },
  filter: 'all',
  query: '',
  page: 1,
  list: null,
  selection: {},
  current: null,
  allowImages: false,
  compose: null,
  syncTimer: null,
  refreshTimer: null
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function fmtDate(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '-' + pad2(d.getDate());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fmtFull(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function addrText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.name && item.addr) return item.name + ' <' + item.addr + '>';
  return item.name || item.addr || '';
}

function addrList(list) {
  if (!list || !list.length) return '';
  return list.map(addrText).join(', ');
}

function firstAddr(list) {
  if (!list || !list.length) return '';
  return list[0].addr || '';
}

function parseAddressInput(text) {
  if (!text) return [];
  // 换行同样视为分隔符：收件人框是多行输入，按回车换行后仍能正确拆出每个地址。
  return String(text).split(/[,;，；\r\n]/).map(function (part) {
    return part.trim();
  }).filter(function (part) { return part.length > 0; });
}

var FOLDER_ICONS = {
  inbox: '📥', drafts: '📝', sent: '📤', junk: '🚫', trash: '🗑', archive: '🗄', custom: '📁'
};

/* ===================================================================== API */

function api(path, options) {
  options = options || {};
  var url = new URL(path, location.origin);
  if (options.params) {
    Object.keys(options.params).forEach(function (key) {
      var value = options.params[key];
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, value);
    });
  }
  var headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  var body;
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return fetch(url.toString(), { method: options.method || 'GET', headers: headers, body: body })
    .then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { error: text.slice(0, 300) }; } }
        if (!res.ok) {
          if (res.status === 401 || res.status === 428) handleUnauthorized(data.error, res.status);
          var err = new Error(data.error || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
}

function handleUnauthorized(message, status) {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  stopTimers();
  showSplash(status === 428 ? 'setup' : 'login', message || '');
}

function toast(message, kind) {
  var root = $('#toastRoot');
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(function () {
    el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 250);
  }, kind === 'err' ? 5200 : 2600);
}

/* ===================================================================== 弹层 */

var modalStack = [];

function openModal(html, options) {
  options = options || {};
  var root = $('#modalRoot');
  var layer = document.createElement('div');
  layer.className = 'modal-layer';
  var wrapper = document.createElement('div');
  wrapper.className = 'modal' + (options.wide ? ' wide' : '') + (options.cls ? ' ' + options.cls : '');
  wrapper.innerHTML = html;
  layer.appendChild(wrapper);
  // 追加新的一层而不是替换：写信时再打开通讯录选择等场景需要保留下层弹窗。
  root.appendChild(layer);
  root.classList.remove('hidden');
  modalStack.push({ layer: layer, wrapper: wrapper, options: options });
  // 弹窗只在点击「关闭 / 取消」按钮时关闭：点击遮罩空白处不关闭，避免误触丢失已填内容。
  if (options.onMount) options.onMount(wrapper);
  return wrapper;
}

function closeModal() {
  var top = modalStack.pop();
  if (top && top.layer && top.layer.parentNode) top.layer.parentNode.removeChild(top.layer);
  if (!modalStack.length) {
    $('#modalRoot').classList.add('hidden');
    $('#modalRoot').innerHTML = '';
  }
}

function closeAllModals() {
  while (modalStack.length) closeModal();
}

function modalHeader(title, extra) {
  return '<div class="modal-head"><h3>' + esc(title) + '</h3>' +
    (extra || '') + '<div class="spacer"></div>' +
    '<button class="btn ghost small" data-act="close-modal">关闭</button></div>';
}

/* ===================================================================== 启动 */

function showSplash(mode, message) {
  $('#shell').classList.add('hidden');
  $('#splash').classList.remove('hidden');
  var isSetup = mode === 'setup';
  $('#splashConfirmField').style.display = isSetup ? '' : 'none';
  $('#splashLabel').textContent = isSetup ? '设置访问口令' : '访问口令';
  $('#splashHint').textContent = isSetup
    ? '首次使用请设置一个访问口令（至少 6 位），用于保护本机上的邮件数据。'
    : '请输入访问口令进入肥牛邮箱。';
  $('#splashSubmit').textContent = isSetup ? '设置并进入' : '登录';
  $('#splashError').textContent = message || '';
  $('#splashPassword').value = '';
  $('#splashConfirm').value = '';
  $('#splashPassword').focus();
  $('#splashForm').dataset.mode = isSetup ? 'setup' : 'login';
}

function submitSplash(event) {
  event.preventDefault();
  var mode = $('#splashForm').dataset.mode;
  var password = $('#splashPassword').value;
  var confirm = $('#splashConfirm').value;
  if (!password) { $('#splashError').textContent = '请输入口令'; return; }
  if (mode === 'setup') {
    if (password.length < 6) { $('#splashError').textContent = '口令至少需要 6 位'; return; }
    if (password !== confirm) { $('#splashError').textContent = '两次输入的口令不一致'; return; }
  }
  $('#splashError').textContent = '';
  $('#splashSubmit').disabled = true;
  var path = mode === 'setup' ? '/api/session/setup' : '/api/session/login';
  api(path, { method: 'POST', body: { password: password } })
    .then(function (data) {
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      return enterApp();
    })
    .catch(function (err) { $('#splashError').textContent = err.message; })
    .then(function () { $('#splashSubmit').disabled = false; });
}

function enterApp() {
  return reload().then(function () {
    $('#splash').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    if (!state.boot.accounts.length) {
      setView('accounts');
      toast('还没有邮箱账号，请先添加一个账号', '');
    } else {
      var first = state.boot.accounts[0];
      state.target = { accountId: first.id, kind: 'inbox', folderId: null };
      setView('mail');
    }
    startTimers();
  });
}

function reload() {
  return api('/api/bootstrap').then(function (data) {
    state.boot = data;
    renderSidebar();
    return data;
  });
}

function startTimers() {
  stopTimers();
  state.refreshTimer = setInterval(function () {
    if (state.view !== 'mail') return;
    reload().catch(function () { });
  }, 45000);
  state.syncTimer = setInterval(pollSync, 1800);
}

function stopTimers() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.syncTimer) clearInterval(state.syncTimer);
  state.refreshTimer = null;
  state.syncTimer = null;
}

function doLogout() {
  api('/api/session/logout', { method: 'POST' }).catch(function () { }).then(function () {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    stopTimers();
    state.boot = null;
    state.list = null;
    state.current = null;
    state.selection = {};
    state.allowImages = false;
    closeAllModals();
    showSplash('login', '');
  });
}

/* ===================================================================== 独立打开 */

function openExternal() {
  var url = location.origin + '/';
  var win = null;
  try { win = window.open(url, '_blank'); } catch (e) { win = null; }
  if (win) { toast('已在新窗口打开', 'ok'); return; }
  // 桌面窗口（iframe/webview）里可能被拦截，退化为给出可复制地址。
  openModal(modalHeader('在独立网页中打开') +
    '<div class="modal-body">' +
    '  <p>当前环境拦截了新窗口，请在浏览器中手动打开下面的地址：</p>' +
    '  <div class="field"><input id="extUrl" type="text" readonly value="' + esc(url) + '"></div>' +
    '</div>' +
    '<div class="modal-foot">' +
    '  <button class="btn primary" data-ext="copy">复制链接</button>' +
    '  <div class="spacer"></div>' +
    '  <button class="btn ghost" data-act="close-modal">关闭</button>' +
    '</div>', {
    onMount: function (wrapper) {
      var box = $('#extUrl', wrapper);
      if (box) box.select();
      wrapper.addEventListener('click', function (event) {
        if (!event.target.closest('[data-ext="copy"]')) return;
        copyText(url).then(function () { toast('已复制链接', 'ok'); })
          .catch(function () { toast('复制失败，请手动选中后复制', 'err'); });
      });
    }
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // 非 https/localhost 环境下 Clipboard API 不可用，退回 execCommand。
  return new Promise(function (resolve, reject) {
    var box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.top = '-1000px';
    document.body.appendChild(box);
    box.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    box.remove();
    if (ok) resolve(); else reject(new Error('copy failed'));
  });
}

function anySyncing() {
  if (!state.boot) return false;
  var keys = Object.keys(state.boot.sync || {});
  return keys.some(function (key) { return state.boot.sync[key].busy || state.boot.sync[key].running; });
}

function pollSync() {
  if (!state.boot) return;
  var keys = Object.keys(state.boot.sync || {});
  var busy = keys.filter(function (k) { return state.boot.sync[k].busy || state.boot.sync[k].running; });
  if (!busy.length) {
    if (state.lastBusy) {
      state.lastBusy = false;
      reload().then(function () { renderAccountStatus(); loadMessages(); }).catch(function () { });
    }
    return;
  }
  state.lastBusy = true;
  busy.forEach(function (key) {
    api('/api/accounts/' + key + '/sync').then(function (data) {
      state.boot.sync[key] = data.state;
      renderAccountStatus();
    }).catch(function () { });
  });
}

/* ===================================================================== 视图切换 */

function setView(view) {
  state.view = view;
  $$('.view-btn').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.dataset.view === view);
  });
  $('#listPane').classList.remove('hidden');
  $('#readPane').classList.remove('hidden');
  $('#main').classList.remove('reading');
  renderSidebar();
  if (view === 'mail') renderMail();
  else if (view === 'contacts') renderContacts();
  else if (view === 'accounts') renderAccounts();
  else if (view === 'logs') renderLogs();
  else if (view === 'tools') renderTools();
}

/* ===================================================================== 侧栏 */

function renderSidebar() {
  var side = $('#sidebar');
  if (!state.boot) { side.innerHTML = ''; return; }
  var accounts = state.boot.accounts;
  var html = '<div class="side-block">';
  html += '<div class="side-title">全部账号</div>';
  var unread = state.boot.unread || { per_account: {} };
  html += sideItem({
    active: state.target.accountId === null && state.target.kind === 'inbox' && state.view === 'mail',
    icon: '📬', label: '聚合收件箱', count: unread.total || 0,
    attrs: 'data-kind="inbox"'
  });
  if (!accounts.length) {
    html += '<div class="hint" style="padding:6px 8px">尚未添加账号</div>';
  }
  accounts.forEach(function (account) {
    var count = (unread.per_account || {})[account.id] || 0;
    html += '<div class="side-item' + (state.target.accountId === account.id && state.view === 'mail' ? ' is-active' : '') + '"' +
      ' data-account="' + account.id + '" data-kind="inbox">' +
      '<span class="ico">✉️</span>' +
      '<span class="label" title="' + esc(account.email || account.name) + '">' + esc(account.name || account.email) + '</span>' +
      (count ? '<span class="badge">' + count + '</span>' : '<span class="count">' + esc(account.protocol.toUpperCase()) + '</span>') +
      '</div>';
  });
  html += '</div>';

  if (state.view === 'mail' && state.target.accountId !== null) {
    var folders = (state.boot.folders || []).filter(function (f) { return f.account_id === state.target.accountId; });
    html += '<div class="side-block"><div class="side-title">文件夹</div>';
    folders.forEach(function (folder) {
      html += sideItem({
        active: state.target.folderId === folder.id,
        icon: FOLDER_ICONS[folder.kind] || '📁',
        label: folder.name,
        count: folder.unread ? folder.unread : '',
        attrs: 'data-folder="' + folder.id + '" data-account="' + folder.account_id + '"'
      });
    });
    html += '<div class="side-item" data-act="new-folder"><span class="ico">＋</span><span class="label">新建文件夹</span></div>';
    html += '</div>';
  } else if (state.view === 'mail') {
    html += '<div class="side-block"><div class="side-title">文件夹</div>' +
      '<div class="hint" style="padding:6px 8px">选择一个账号查看其文件夹</div></div>';
  }

  html += '<div class="side-foot">' +
    '<button class="btn small" data-act="add-account">新建账号</button>' +
    '<button class="btn small" data-act="goto-contacts">通讯录</button>' +
    '<button class="btn small" data-act="goto-tools">端口检测</button>' +
    '</div>';
  side.innerHTML = html;
}

function sideItem(opt) {
  return '<button class="side-item' + (opt.active ? ' is-active' : '') + '" ' + (opt.attrs || '') + '>' +
    '<span class="ico">' + opt.icon + '</span>' +
    '<span class="label">' + esc(opt.label) + '</span>' +
    (opt.count ? '<span class="count">' + esc(opt.count) + '</span>' : '') +
    '</button>';
}

function onSidebarClick(event) {
  var item = event.target.closest('[data-folder],[data-account],[data-act],[data-kind]');
  if (!item) return;
  if (item.dataset.act === 'new-folder') { promptNewFolder(); return; }
  if (item.dataset.act === 'add-account') { setView('accounts'); openAccountModal(null); return; }
  if (item.dataset.act === 'goto-contacts') { setView('contacts'); return; }
  if (item.dataset.act === 'goto-tools') { setView('tools'); return; }
  if (item.dataset.folder) {
    state.target = { accountId: Number(item.dataset.account), folderId: Number(item.dataset.folder), kind: null };
    state.page = 1; state.selection = {};
    setView('mail');
    return;
  }
  if (item.dataset.account) {
    state.target = { accountId: Number(item.dataset.account), folderId: null, kind: item.dataset.kind || 'inbox' };
    state.page = 1; state.selection = {};
    setView('mail');
    return;
  }
  // 聚合收件箱：不限定账号，汇总所有账号收件箱中的邮件。
  // 它只有 data-kind，没有 data-account，因此必须单独识别，
  // 否则点击时匹配不到任何可点元素、看上去像“没反应”。
  if (item.dataset.kind) {
    state.target = { accountId: null, folderId: null, kind: item.dataset.kind };
    state.page = 1; state.selection = {};
    setView('mail');
  }
}

/* ===================================================================== 邮件列表 */

function renderMail() {
  var pane = $('#listPane');
  var html = '' +
    '<div class="list-toolbar">' +
    '  <div class="seg" id="filterSeg">' +
    ['all:全部', 'unread:未读', 'starred:星标', 'attach:附件'].map(function (item) {
      var parts = item.split(':');
      return '<button data-filter="' + parts[0] + '"' + (state.filter === parts[0] ? ' class="is-active"' : '') + '>' + parts[1] + '</button>';
    }).join('') +
    '  </div>' +
    '  <input class="search" id="searchInput" type="search" placeholder="搜索发件人、主题或正文" value="' + esc(state.query) + '">' +
    '  <button class="btn small" data-act="do-search">搜索</button>' +
    '  <div class="spacer"></div>' +
    '  <button class="btn small" data-act="sync-current">收取此账号</button>' +
    '  <button class="btn small" data-act="refresh-list">刷新</button>' +
    '</div>' +
    '<div id="batchBar"></div>' +
    '<div class="list-body" id="listBody"></div>' +
    '<div class="pager" id="pager"></div>';
  pane.innerHTML = html;
  loadMessages();
}

function currentFolderRow() {
  if (state.target.folderId === null) return null;
  return (state.boot.folders || []).filter(function (f) { return f.id === state.target.folderId; })[0] || null;
}

function currentFolderName() {
  var folder = currentFolderRow();
  if (folder) return folder.name;
  if (state.target.accountId === null) return '聚合收件箱';
  var account = (state.boot.accounts || []).filter(function (a) { return a.id === state.target.accountId; })[0];
  return (account ? (account.name || account.email) : '') + ' · 收件箱';
}

function loadMessages() {
  var body = $('#listBody');
  if (!body) return;
  body.innerHTML = '<div class="empty">正在加载…</div>';
  var params = {
    page: state.page,
    size: 50,
    filter: state.filter,
    q: state.query
  };
  if (state.target.folderId !== null) params.folder_id = state.target.folderId;
  else {
    if (state.target.accountId !== null) params.account_id = state.target.accountId;
    params.kind = state.target.kind || 'inbox';
  }
  api('/api/messages', { params: params }).then(function (data) {
    state.list = data;
    renderMessageList();
  }).catch(function (err) {
    body.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
  });
}

function renderMessageList() {
  var body = $('#listBody');
  var data = state.list;
  if (!data || !data.items.length) {
    body.innerHTML = '<div class="empty"><div class="big">没有邮件</div>' +
      '<div>' + esc(currentFolderName()) + ' 中暂时没有符合条件的邮件</div></div>';
    renderPager();
    renderBatchBar();
    return;
  }
  body.innerHTML = data.items.map(function (item) {
    var checked = state.selection[item.id] ? ' checked' : '';
    return '<div class="msg-row' + (item.is_read ? '' : ' unread') + (state.current && state.current.id === item.id ? ' is-active' : '') + '" data-id="' + item.id + '">' +
      '<input type="checkbox" data-check="' + item.id + '"' + checked + '>' +
      (item.is_read ? '<span style="width:7px;flex:none"></span>' : '<span class="dot"></span>') +
      '<button class="star-btn' + (item.is_starred ? ' on' : '') + '" data-star="' + item.id + '" title="星标">' + (item.is_starred ? '★' : '☆') + '</button>' +
      '<div class="msg-main">' +
      '  <div class="msg-line1">' +
      '    <span class="msg-from">' + esc(item.from_name || item.from_addr || '(未知发件人)') + '</span>' +
      '    <span class="msg-subject">' + esc(item.subject || '(无主题)') + '</span>' +
      '    <span class="msg-date">' + esc(fmtDate(item.date_ts)) + '</span>' +
      '  </div>' +
      '  <div class="msg-preview">' + esc(item.body_preview || '') + '</div>' +
      '  <div class="msg-flags">' +
      '    <span class="tag gray">' + esc(item.folder_name || '') + '</span>' +
      (item.has_attach ? '<span>📎 附件</span>' : '') +
      (item.is_draft ? '<span class="tag warn">草稿</span>' : '') +
      '    <span>' + esc(fmtSize(item.size)) + '</span>' +
      '  </div>' +
      '</div></div>';
  }).join('');
  renderPager();
  renderBatchBar();
}

function renderPager() {
  var pager = $('#pager');
  if (!pager) return;
  var data = state.list;
  if (!data) { pager.innerHTML = ''; return; }
  var pages = Math.max(1, Math.ceil(data.total / data.size));
  pager.innerHTML = '<button class="btn small" data-page="prev"' + (data.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span>第 ' + data.page + ' / ' + pages + ' 页 · 共 ' + data.total + ' 封</span>' +
    '<button class="btn small" data-page="next"' + (data.page >= pages ? ' disabled' : '') + '>下一页</button>';
}

function selectedIds() {
  return Object.keys(state.selection).filter(function (k) { return state.selection[k]; }).map(Number);
}

function renderBatchBar() {
  var bar = $('#batchBar');
  if (!bar) return;
  var ids = selectedIds();
  if (!ids.length) { bar.innerHTML = ''; return; }
  var folder = currentFolderRow();
  var isTrash = folder && folder.kind === 'trash';
  bar.innerHTML = '<div class="batchbar">已选择 ' + ids.length + ' 封' +
    '<button class="btn small" data-batch="read">标记已读</button>' +
    '<button class="btn small" data-batch="unread">标记未读</button>' +
    '<button class="btn small" data-batch="star">加星标</button>' +
    '<button class="btn small" data-batch="unstar">取消星标</button>' +
    '<button class="btn small" data-batch="move">移动到…</button>' +
    '<button class="btn small danger" data-batch="delete">' + (isTrash ? '彻底删除' : '删除') + '</button>' +
    '<button class="btn small ghost" data-batch="clear">取消选择</button>' +
    '</div>';
}

function onListPaneClick(event) {
  var target = event.target;
  var pageBtn = target.closest('[data-page]');
  if (pageBtn) {
    state.page += pageBtn.dataset.page === 'next' ? 1 : -1;
    state.page = Math.max(1, state.page);
    loadMessages();
    return;
  }
  var filterBtn = target.closest('[data-filter]');
  if (filterBtn) { state.filter = filterBtn.dataset.filter; state.page = 1; renderMail(); return; }

  var star = target.closest('[data-star]');
  if (star) {
    event.stopPropagation();
    var id = Number(star.dataset.star);
    var on = star.classList.contains('on');
    api('/api/messages/' + id + '/star', { method: 'POST', body: { is_starred: !on } }).then(function () {
      star.classList.toggle('on', !on);
      star.textContent = !on ? '★' : '☆';
      if (state.list) {
        state.list.items.forEach(function (m) { if (m.id === id) m.is_starred = !on ? 1 : 0; });
      }
    }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }

  var checkbox = target.closest('[data-check]');
  if (checkbox) {
    event.stopPropagation();
    var cid = Number(checkbox.dataset.check);
    state.selection[cid] = checkbox.checked;
    renderBatchBar();
    return;
  }

  var batch = target.closest('[data-batch]');
  if (batch) { handleBatch(batch.dataset.batch); return; }

  if (target.closest('[data-act="do-search"]')) { doSearch(); return; }
  if (target.closest('[data-act="refresh-list"]')) { loadMessages(); return; }
  if (target.closest('[data-act="sync-current"]')) { syncCurrent(); return; }

  var row = target.closest('.msg-row');
  if (row) openMessage(Number(row.dataset.id));
}

function doSearch() {
  state.query = $('#searchInput').value.trim();
  state.page = 1;
  loadMessages();
}

function handleBatch(action) {
  if (action === 'clear') { state.selection = {}; renderMessageList(); return; }
  var ids = selectedIds();
  if (!ids.length) return;
  if (action === 'move') {
    var folder = currentFolderRow();
    openFolderPicker(function (folderId) {
      api('/api/messages/batch', { method: 'POST', body: { ids: ids, action: 'move', folder_id: folderId } })
        .then(function () { state.selection = {}; toast('已移动', 'ok'); loadMessages(); reload(); })
        .catch(function (err) { toast(err.message, 'err'); });
    }, folder ? folder.account_id : state.target.accountId);
    return;
  }
  if (action === 'delete') {
    confirmBox('删除邮件', '确定要删除选中的 ' + ids.length + ' 封邮件吗？本地归档文件会一并删除。', function () {
      api('/api/messages/batch', { method: 'POST', body: { ids: ids, action: 'delete' } })
        .then(function (data) { state.selection = {}; toast('已删除 ' + data.affected + ' 封', 'ok'); loadMessages(); reload(); })
        .catch(function (err) { toast(err.message, 'err'); });
    });
    return;
  }
  api('/api/messages/batch', { method: 'POST', body: { ids: ids, action: action } })
    .then(function (data) { state.selection = {}; toast('操作完成（' + data.affected + ' 封）', 'ok'); loadMessages(); })
    .catch(function (err) { toast(err.message, 'err'); });
}

function openFolderPicker(onPick, accountId) {
  var folders = (state.boot.folders || []).filter(function (f) { return accountId === null || f.account_id === accountId; });
  openModal(modalHeader('选择文件夹') +
    '<div class="modal-body">' + (folders.length ? folders.map(function (f) {
      return '<button class="side-item" data-pick="' + f.id + '"><span class="ico">' +
        (FOLDER_ICONS[f.kind] || '📁') + '</span><span class="label">' + esc(f.name) + '</span></button>';
    }).join('') : '<div class="empty">没有可用文件夹</div>') + '</div>', {
    onMount: function (wrapper) {
      wrapper.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-pick]');
        if (btn) { closeModal(); onPick(Number(btn.dataset.pick)); }
      });
    }
  });
}

function syncCurrent() {
  var ids = state.target.accountId !== null ? [state.target.accountId] : (state.boot.accounts || []).map(function (a) { return a.id; });
  if (!ids.length) { toast('请先添加邮箱账号', 'err'); return; }
  Promise.all(ids.map(function (id) {
    return api('/api/accounts/' + id + '/sync', { method: 'POST' });
  })).then(function () {
    toast('已开始收信', 'ok');
    setTimeout(pollSync, 800);
  }).catch(function (err) { toast(err.message, 'err'); });
}

/* ===================================================================== 阅读 */

function openMessage(id) {
  api('/api/messages/' + id).then(function (data) {
    state.current = data.message;
    state.allowImages = false;
    renderReader();
    $('#main').classList.add('reading');
    if (!data.message.is_read) {
      api('/api/messages/' + id + '/read', { method: 'POST', body: { is_read: true } }).then(function () {
        data.message.is_read = 1;
        if (state.list) {
          state.list.items.forEach(function (m) { if (m.id === id) m.is_read = 1; });
          // 列表此时仍然可见，必须重绘，否则未读小圆点会一直留在原处。
          renderMessageList();
        }
        var toggle = $('[data-act="toggle-read"]');
        if (toggle) toggle.textContent = '标记为未读';
        if (state.boot) refreshUnreadLocal();
      }).catch(function () { });
    }
  }).catch(function (err) { toast(err.message, 'err'); });
}

function refreshUnreadLocal() { reload().catch(function () { }); }

function renderReader() {
  var msg = state.current;
  var pane = $('#readPane');
  if (!msg) { pane.innerHTML = ''; return; }
  var token = encodeURIComponent(state.token);
  var bodyUrl = '/api/messages/' + msg.id + '/body?images=' + (state.allowImages ? 1 : 0) + '&_t=' + token;
  var toList = msg.to || [], ccList = msg.cc || [], bccList = msg.bcc || [];
  // 群发邮件下收件人可达成百上千条，默认只占一行，其余内容折叠，需要时再展开。
  var rcpCount = toList.length + ccList.length + bccList.length;
  var rcpLines = '<div class="rcp-line" title="' + esc(addrList(toList)) + '">收件人：' + esc(addrList(toList) || '—') + '</div>' +
    (ccList.length ? '<div class="rcp-line" title="' + esc(addrList(ccList)) + '">抄送：' + esc(addrList(ccList)) + '</div>' : '') +
    (bccList.length ? '<div class="rcp-line" title="' + esc(addrList(bccList)) + '">密送：' + esc(addrList(bccList)) + '</div>' : '');
  var html = '' +
    '<div class="read-head">' +
    '  <button class="btn small" data-act="close-read">← 返回</button>' +
    '  <div class="read-subject">' + esc(msg.subject || '(无主题)') + '</div>' +
    '  <div class="read-meta">' +
    '    <div class="meta-top">' +
    '      <span class="who">' + esc(addrText(msg.from) || '(未知发件人)') + '</span>' +
    (rcpCount > 1 ? '<button class="btn small meta-toggle" data-act="toggle-recipients">收件人详情 ▾</button>' : '') +
    '    </div>' +
    '    <div class="meta-recipients">' + rcpLines + '</div>' +
    '    <div class="meta-sub">' + esc(fmtFull(msg.date_ts)) + ' · ' + esc(fmtSize(msg.size)) + ' · ' +
    '<span class="tag gray">' + esc(msg.account_email || '') + '</span> ' +
    '<span class="tag gray">' + esc(msg.folder_name || '') + '</span></div>' +
    '  </div>' +
    '</div>' +
    '<div class="read-actions">' +
    '  <button class="btn small primary" data-act="reply">回复</button>' +
    '  <button class="btn small" data-act="forward">转发</button>' +
    '  <button class="btn small" data-act="toggle-star">' + (msg.is_starred ? '★ 取消星标' : '☆ 加星标') + '</button>' +
    '  <button class="btn small" data-act="toggle-read">标记为' + (msg.is_read ? '未读' : '已读') + '</button>' +
    '  <button class="btn small" data-act="move-msg">移动到…</button>' +
    (msg.is_draft ? '<button class="btn small primary" data-act="edit-draft">继续编辑</button>' : '') +
    '  <div class="spacer"></div>' +
    '  <a class="btn small" href="/api/messages/' + msg.id + '/raw?_t=' + token + '">下载原邮件</a>' +
    '  <button class="btn small danger" data-act="delete-msg">删除</button>' +
    '</div>';
  if (msg.remote_images) {
    html += '<div class="read-banner"><span>此邮件包含 ' + msg.remote_images + ' 张外部图片，已默认阻止以避免被追踪。</span>' +
      '<button class="btn small" data-act="show-images">显示图片</button></div>';
  }
  if (msg.attachments && msg.attachments.length) {
    html += '<div class="attach-box"><div class="muted">附件（' + msg.attachments.length + '）</div><div class="attach-list">' +
      msg.attachments.map(function (a) {
        return '<a class="attach-item" href="/api/messages/' + msg.id + '/parts/' + a.part_index + '?_t=' + token + '">' +
          '<span>📎</span><span class="name" title="' + esc(a.filename) + '">' + esc(a.filename || '附件') + '</span>' +
          '<span class="muted">' + esc(fmtSize(a.size)) + '</span></a>';
      }).join('') + '</div></div>';
  }
  html += '<div class="read-body"><iframe id="bodyFrame" sandbox="allow-popups allow-popups-to-escape-sandbox" src="' + bodyUrl + '"></iframe></div>';
  pane.innerHTML = html;
}

function onReaderClick(event) {
  var btn = event.target.closest('[data-act]');
  if (!btn) return;
  var act = btn.dataset.act;
  var msg = state.current;
  if (act === 'close-read') { $('#main').classList.remove('reading'); state.current = null; return; }
  if (!msg) return;
  var token = encodeURIComponent(state.token);
  if (act === 'toggle-recipients') {
    // 直接切换样式类，避免重绘整个阅读区（重绘会重新加载正文 iframe）。
    var meta = $('.read-meta');
    if (!meta) return;
    var expanded = meta.classList.toggle('is-expanded');
    btn.textContent = expanded ? '收件人详情 ▴' : '收件人详情 ▾';
    return;
  }
  if (act === 'show-images') {
    state.allowImages = true;
    $('#bodyFrame').src = '/api/messages/' + msg.id + '/body?images=1&_t=' + token;
    var banner = $('.read-banner'); if (banner) banner.remove();
    return;
  }
  if (act === 'toggle-star') {
    api('/api/messages/' + msg.id + '/star', { method: 'POST', body: { is_starred: !msg.is_starred } }).then(function () {
      msg.is_starred = msg.is_starred ? 0 : 1;
      renderReader();
      loadMessages();
    }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  if (act === 'toggle-read') {
    api('/api/messages/' + msg.id + '/read', { method: 'POST', body: { is_read: !msg.is_read } }).then(function () {
      msg.is_read = msg.is_read ? 0 : 1;
      renderReader();
      loadMessages();
      reload().catch(function () { });
    }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  if (act === 'move-msg') {
    openFolderPicker(function (folderId) {
      api('/api/messages/' + msg.id + '/move', { method: 'POST', body: { folder_id: folderId } }).then(function () {
        toast('已移动', 'ok');
        $('#main').classList.remove('reading');
        state.current = null;
        loadMessages();
        reload().catch(function () { });
      }).catch(function (err) { toast(err.message, 'err'); });
    }, msg.account_id);
    return;
  }
  if (act === 'delete-msg') {
    confirmBox('删除邮件', '确定要删除这封邮件吗？本地归档文件会一并删除。', function () {
      api('/api/messages/' + msg.id + '/delete', { method: 'POST' }).then(function () {
        toast('已删除', 'ok');
        $('#main').classList.remove('reading');
        state.current = null;
        loadMessages();
        reload().catch(function () { });
      }).catch(function (err) { toast(err.message, 'err'); });
    });
    return;
  }
  if (act === 'edit-draft') {
    openCompose({
      accountId: msg.account_id, draftId: msg.id,
      to: addrList(msg.to), cc: addrList(msg.cc), bcc: addrList(msg.bcc),
      subject: msg.subject, html: (msg.draft && msg.draft.html) || '', text: (msg.draft && msg.draft.text) || ''
    });
    return;
  }
  if (act === 'reply' || act === 'forward') {
    var isReply = act === 'reply';
    var subject = msg.subject || '';
    if (isReply) {
      openCompose({
        accountId: msg.account_id,
        to: addrText(msg.from),
        subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject,
        html: quoteHtml(msg, false),
        inReplyTo: msg.message_id || '',
        references: (msg.references ? msg.references + ' ' : '') + (msg.message_id || '')
      });
    } else {
      openCompose({
        accountId: msg.account_id,
        subject: /^fwd:/i.test(subject) ? subject : 'Fwd: ' + subject,
        html: quoteHtml(msg, true)
      });
    }
    return;
  }
}

function quoteHtml(msg, withHeader) {
  var head = '';
  if (withHeader) {
    head = '<div><br></div><div>---------- 转发的邮件 ----------</div>' +
      '<div>发件人：' + esc(addrText(msg.from)) + '</div>' +
      '<div>收件人：' + esc(addrList(msg.to)) + '</div>' +
      '<div>日期：' + esc(fmtFull(msg.date_ts)) + '</div>' +
      '<div>主题：' + esc(msg.subject || '') + '</div><div><br></div>';
  }
  var body = msg.text ? '<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #dfe3e8">' +
    esc(msg.text).replace(/\n/g, '<br>') + '</blockquote>'
    : '<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #dfe3e8">（原邮件为 HTML 正文，已保留在本地归档中）</blockquote>';
  return head + '<div><br></div>' + body;
}

/* ===================================================================== 写信 */

function openCompose(opts) {
  opts = opts || {};
  var accounts = (state.boot && state.boot.accounts) || [];
  if (!accounts.length) { toast('请先添加邮箱账号', 'err'); setView('accounts'); return; }
  var accountId = opts.accountId || state.target.accountId || accounts[0].id;
  if (!accounts.some(function (a) { return a.id === accountId; })) accountId = accounts[0].id;
  var compose = {
    accountId: accountId,
    draftId: opts.draftId || null,
    attachments: [],
    inReplyTo: opts.inReplyTo || '',
    references: opts.references || ''
  };
  state.compose = compose;

  var signature = (accounts.filter(function (a) { return a.id === accountId; })[0] || {}).signature || '';
  var initialHtml = opts.html || '';

  openModal(modalHeader('写邮件') +
    '<div class="modal-body compose-body">' +
    '  <div class="field-row">' +
    '    <div class="field"><label>发件账号</label><select id="cmpAccount">' +
    accounts.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === accountId ? ' selected' : '') + '>' +
        esc(a.email || a.name) + (a.display_name ? '（' + esc(a.display_name) + '）' : '') + '</option>';
    }).join('') + '</select></div>' +
    '    <div class="field" style="flex:0 0 auto;align-self:flex-end">' +
    '      <button class="btn small" data-cmp="pick-contact">从通讯录选择</button></div>' +
    '  </div>' +
    '  <div class="field"><label>收件人</label>' +
    '<textarea id="cmpTo" class="addr-box" rows="1" spellcheck="false" placeholder="输入姓名或邮箱，多人用逗号分隔">' +
    esc(opts.to || '') + '</textarea></div>' +
    '  <div class="field">' +
    '    <a href="javascript:void(0)" data-cmp="toggle-cc" id="cmpToggle">显示抄送 / 密送</a>' +
    '    <div id="cmpCcWrap" style="display:none;margin-top:8px">' +
    '      <div class="field"><label>抄送</label><input id="cmpCc" type="text" value="' + esc(opts.cc || '') + '"></div>' +
    '      <div class="field"><label>密送</label><input id="cmpBcc" type="text" value="' + esc(opts.bcc || '') + '"></div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="field"><label>主题</label><input id="cmpSubject" type="text" value="' + esc(opts.subject || '') + '"></div>' +
    '  <div class="field field-editor"><label>正文</label>' +
    '    <div class="editor-toolbar">' +
    '      <button data-cmd="bold" title="加粗"><b>B</b></button>' +
    '      <button data-cmd="italic" title="斜体"><i>I</i></button>' +
    '      <button data-cmd="underline" title="下划线"><u>U</u></button>' +
    '      <span class="tb-sep"></span>' +
    '      <select class="tb-select" data-style="fontName" title="字体">' +
    '        <option value="">字体</option>' +
    '        <option value="Microsoft YaHei">微软雅黑</option>' +
    '        <option value="SimSun">宋体</option>' +
    '        <option value="SimHei">黑体</option>' +
    '        <option value="KaiTi">楷体</option>' +
    '        <option value="FangSong">仿宋</option>' +
    '        <option value="Arial">Arial</option>' +
    '        <option value="Times New Roman">Times New Roman</option>' +
    '        <option value="Courier New">Courier New</option>' +
    '      </select>' +
    '      <select class="tb-select" data-style="fontSize" title="字号（像素）">' +
    '        <option value="">字号</option>' +
    '        <option value="12">12</option>' +
    '        <option value="14">14</option>' +
    '        <option value="16">16</option>' +
    '        <option value="18">18</option>' +
    '        <option value="20">20</option>' +
    '        <option value="24">24</option>' +
    '        <option value="32">32</option>' +
    '      </select>' +
    '      <label class="tb-color" title="文字颜色">字色' +
    '        <input type="color" data-style="foreColor" value="#d93025"></label>' +
    '      <label class="tb-color" title="文字底色 / 高亮">底色' +
    '        <input type="color" data-style="backColor" value="#fff3a3"></label>' +
    '      <span class="tb-sep"></span>' +
    '      <button data-cmd="insertUnorderedList" title="项目符号">• 列表</button>' +
    '      <button data-cmd="insertOrderedList" title="编号列表">1. 列表</button>' +
    '      <button data-cmd="createLink" title="插入链接">链接</button>' +
    '      <span class="tb-sep"></span>' +
    '      <button data-tbl-toggle="1" title="插入表格 / 表格设置">▦ 表格</button>' +
    '      <button data-cmd="removeFormat" title="清除格式">清格式</button>' +
    '      <div class="tbl-panel hidden" id="cmpTblPanel"></div>' +
    '    </div>' +
    '    <div class="editor" id="cmpBody" contenteditable="true" data-placeholder="在此输入邮件正文…"></div>' +
    '  </div>' +
    '  <div class="field"><label>附件</label>' +
    '    <input id="cmpFile" type="file" multiple>' +
    '    <div class="hint">也可以直接把文件拖到本窗口任意位置添加</div>' +
    '    <div class="chips" id="cmpAttachChips"></div>' +
    '  </div>' +
    '</div>' +
    '<div class="modal-foot">' +
    '  <button class="btn primary" data-cmp="send">发送</button>' +
    '  <button class="btn" data-cmp="save-draft">保存草稿</button>' +
    '  <div class="spacer"></div>' +
    '  <span class="hint" id="cmpStatus"></span>' +
    '  <button class="btn ghost" data-act="close-modal">取消</button>' +
    '</div>', {
    wide: true,
    cls: 'compose',
    onMount: function (wrapper) {
      var editor = $('#cmpBody', wrapper);
      var body = initialHtml || '';
      if (!body && signature) {
        body = '<div><br></div><div>-- </div><div>' + esc(signature).replace(/\n/g, '<br>') + '</div>';
      }
      editor.innerHTML = body;

      // --- 正文富文本：光标位置、字体 / 字号 / 颜色 / 底色、表格 ---
      var caretRange = null;
      var toolbar = $('.editor-toolbar', wrapper);
      var tblPanel = $('#cmpTblPanel', wrapper);

      function rememberCaret() {
        var saved = captureEditorRange(editor);
        if (saved) caretRange = saved;
      }
      function recallCaret() {
        caretRange = restoreEditorRange(editor, caretRange);
        return caretRange;
      }
      editor.addEventListener('keyup', rememberCaret);
      editor.addEventListener('mouseup', rememberCaret);
      editor.addEventListener('input', rememberCaret);
      editor.addEventListener('blur', rememberCaret);
      // Excel / Word 粘进来的表格带着一堆私有样式，先清理再插入，后续才改得动框线和底色。
      editor.addEventListener('paste', function (event) { handleEditorPaste(event, editor); });

      // 点工具栏按钮时不要把焦点抢走，否则正文里的光标位置会丢。
      toolbar.addEventListener('mousedown', function (event) {
        if (event.target.closest('button')) event.preventDefault();
      });
      toolbar.addEventListener('click', function (event) {
        if (event.target.closest('[data-tbl-toggle]')) {
          tblPanel.classList.toggle('hidden');
          return;
        }
        var tblBtn = event.target.closest('[data-tbl]');
        if (!tblBtn) return;
        event.preventDefault();
        var act = tblBtn.dataset.tbl;
        var ok = applyTableAction(editor, editorTableContext(editor, caretRange), act, tblPanel);
        if (ok) {
          rememberCaret();
        } else {
          toast('请先把光标放进表格，再调整行 / 列、框线或底色', 'err');
        }
      });
      $$('[data-style]', toolbar).forEach(function (ctl) {
        var applyStyle = function () {
          applyEditorStyle(editor, caretRange, ctl.dataset.style, ctl.value);
          rememberCaret();
          if (ctl.tagName === 'SELECT') ctl.selectedIndex = 0;
        };
        ctl.addEventListener('change', applyStyle);
        if (ctl.type === 'color') ctl.addEventListener('input', applyStyle);
      });
      renderTablePanel(tblPanel, function (rows, cols) {
        tblPanel.classList.add('hidden');
        insertEditorTable(editor, caretRange, rows, cols);
        rememberCaret();
      });

      wrapper.addEventListener('click', function (event) {
        var cmdBtn = event.target.closest('[data-cmd]');
        if (cmdBtn) {
          event.preventDefault();
          var cmd = cmdBtn.dataset.cmd;
          recallCaret();
          if (cmd === 'createLink') {
            var href = prompt('请输入链接地址', 'https://');
            if (href) document.execCommand('createLink', false, href);
          } else {
            document.execCommand(cmd, false, null);
          }
          return;
        }
        var action = event.target.closest('[data-cmp]');
        if (!action) return;
        var act = action.dataset.cmp;
        if (act === 'toggle-cc') {
          var wrap = $('#cmpCcWrap', wrapper);
          wrap.style.display = wrap.style.display === 'none' ? '' : 'none';
          return;
        }
        if (act === 'pick-contact') { openContactPicker(function (list) { appendRecipients(list); }); return; }
        if (act === 'send') { sendCompose(false); return; }
        if (act === 'save-draft') { sendCompose(true); return; }
      });
      // 选文件与拖拽共用同一段读取逻辑，保证两条路径下的附件结构完全一致。
      function addComposeFiles(files, autoSubject) {
        var list = Array.prototype.slice.call(files || []);
        if (!list.length) return;
        list.forEach(function (file) {
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = String(reader.result);
            compose.attachments.push({
              filename: file.name,
              content_type: file.type || 'application/octet-stream',
              size: file.size,
              data: dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : dataUrl
            });
            renderAttachChips();
          };
          reader.readAsDataURL(file);
        });
        // 拖文件进来时顺手把主题补成文件名，省得再手敲一遍；
        // 已经写过主题就不覆盖用户的内容。
        if (autoSubject) {
          var subject = $('#cmpSubject', wrapper);
          if (subject && !subject.value.trim()) subject.value = list[0].name;
        }
      }

      $('#cmpFile', wrapper).addEventListener('change', function (event) {
        addComposeFiles(event.target.files, false);
        event.target.value = '';
      });

      // 直接把文件拖进写信窗口即可添加附件。只处理“拖的是文件”的情况，
      // 避免影响正文里拖选文字、拖拽图片等正常编辑操作。
      function dragHasFiles(event) {
        var dt = event.dataTransfer;
        if (!dt) return false;
        var types = dt.types || [];
        for (var i = 0; i < types.length; i++) {
          if (types[i] === 'Files') return true;
        }
        return !!(dt.files && dt.files.length);
      }
      wrapper.addEventListener('dragenter', function (event) {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        wrapper.classList.add('drag-over');
      });
      wrapper.addEventListener('dragover', function (event) {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      wrapper.addEventListener('dragleave', function (event) {
        // 移到子元素上也会触发 dragleave，只有真正离开窗口才取消高亮。
        if (wrapper.contains(event.relatedTarget)) return;
        wrapper.classList.remove('drag-over');
      });
      wrapper.addEventListener('drop', function (event) {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        wrapper.classList.remove('drag-over');
        addComposeFiles(event.dataTransfer.files, true);
      });
      $('#cmpAccount', wrapper).addEventListener('change', function () {
        compose.accountId = Number(this.value);
      });
      // 收件人 / 抄送 / 密送都支持输入即从通讯录联想，首次打开时预取一次联系人。
      ['#cmpTo', '#cmpCc', '#cmpBcc'].forEach(function (sel) {
        var box = $(sel, wrapper);
        if (box) attachContactSuggest(box);
      });
      loadSuggestContacts();
      // 收件人框 1 行起步，随收件人增多自动长高（最多 5 行），把下方的正文区往下挤。
      var addrBox = $('#cmpTo', wrapper);
      addrBox.addEventListener('input', function () { autoGrowAddrBox(addrBox); });
      autoGrowAddrBox(addrBox);
    }
  });

  function renderAttachChips() {
    var chips = $('#cmpAttachChips');
    if (!chips) return;
    chips.innerHTML = compose.attachments.map(function (item, index) {
      return '<span class="chip">' + esc(item.filename) + ' <span class="muted">' + esc(fmtSize(item.size)) + '</span>' +
        '<button data-rm-attach="' + index + '">×</button></span>';
    }).join('');
    $$('[data-rm-attach]', chips).forEach(function (btn) {
      btn.onclick = function () {
        compose.attachments.splice(Number(btn.dataset.rmAttach), 1);
        renderAttachChips();
      };
    });
  }

  function appendRecipients(list) {
    var input = $('#cmpTo');
    var parts = parseAddressInput(input.value).concat(list);
    input.value = parts.join(', ');
    autoGrowAddrBox(input);
  }
}

/* 收件人框自动增高：1 行起步，随内容长高，最多 ADDR_BOX_ROWS 行，再多就在框内滚动。
   上限按实际行高 + 内边距 + 边框换算，避免写死像素值在缩放/不同字体下错位。
   行数压到 3 行，把省下的高度留给下方正文编辑器。 */
var ADDR_BOX_ROWS = 3;

function autoGrowAddrBox(box) {
  if (!box) return;
  var style = window.getComputedStyle(box);
  var lineHeight = parseFloat(style.lineHeight) || 20;
  var chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
    parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  var maxHeight = Math.round(lineHeight * ADDR_BOX_ROWS + chrome);
  box.style.height = 'auto';
  var needed = box.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  box.style.height = Math.min(needed, maxHeight) + 'px';
  box.style.overflowY = needed - maxHeight > 1 ? 'auto' : 'hidden';
}

/* ===================================================================== 正文编辑器 */

/* 记录 / 还原正文里的光标位置。点工具栏、取色器或表格面板都会让编辑区失焦，
   不还原的话「改字号」「插表格」就会落到错误的位置。 */
function captureEditorRange(editor) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (range.startContainer !== editor && !editor.contains(range.startContainer)) return null;
  return range.cloneRange();
}

function restoreEditorRange(editor, range) {
  var work = range;
  if (!work) {
    // 没有记录到位置时退到正文末尾，保证命令仍然有落点。
    work = document.createRange();
    work.selectNodeContents(editor);
    work.collapse(false);
  }
  editor.focus();
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(work);
  return work;
}

/* 字体、文字颜色、文字底色用 execCommand；字号它只认 1~7 档、给不了像素值，
   所以字号单独用 <span style="font-size:Npx"> 包一层。 */
function applyEditorStyle(editor, range, kind, value) {
  if (!value) return;
  restoreEditorRange(editor, range);
  if (kind === 'fontSize') {
    wrapEditorSelection('font-size', value + 'px');
    return;
  }
  document.execCommand('styleWithCSS', false, true);
  if (kind === 'fontName') document.execCommand('fontName', false, value);
  else if (kind === 'foreColor') document.execCommand('foreColor', false, value);
  else if (kind === 'backColor') document.execCommand('backColor', false, value);
}

function wrapEditorSelection(prop, value) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  var span = document.createElement('span');
  span.style[prop] = value;
  if (range.collapsed) {
    // 没选中文字时插入零宽字符并把光标停在 span 内，做到「先设字号再输入」。
    span.appendChild(document.createTextNode('\u200b'));
    range.insertNode(span);
    var caret = document.createRange();
    caret.setStart(span.firstChild, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    return;
  }
  try {
    range.surroundContents(span);
  } catch (err) {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  var next = document.createRange();
  next.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(next);
}

/* ---------------------------------------------------------------- 表格 */

var TABLE_CELL_STYLE = 'border:1px solid #c9d2de;padding:5px 9px;min-width:44px;vertical-align:top;';
var TABLE_BORDER_PRESETS = {
  thin: '1px solid #c9d2de',
  medium: '2px solid #94a3b8',
  dashed: '1px dashed #94a3b8',
  double: '3px double #94a3b8',
  none: 'none'
};
var TABLE_GRID_ROWS = 6;
var TABLE_GRID_COLS = 8;
var COLOR_HEX = /^#[0-9a-fA-F]{6}$/;

function editorTableContext(editor, range) {
  var node = range ? range.startContainer : null;
  if (!node) {
    var sel = window.getSelection();
    node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  }
  if (!node) return { table: null, cell: null };
  if (node.nodeType === 3) node = node.parentNode;
  if (!node || node.nodeType !== 1 || (node !== editor && !editor.contains(node))) {
    return { table: null, cell: null };
  }
  var cell = node.closest('td, th');
  var table = cell ? cell.closest('table') : node.closest('table');
  return { table: table || null, cell: cell || null };
}

function focusEditorCell(editor, cell) {
  if (!cell) return null;
  editor.focus();
  var range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

function buildEditorTableHtml(rows, cols) {
  var tds = '';
  for (var c = 0; c < cols; c++) tds += '<td style="' + TABLE_CELL_STYLE + '"><br></td>';
  var trs = '';
  for (var r = 0; r < rows; r++) trs += '<tr>' + tds + '</tr>';
  return '<table style="border-collapse:collapse;margin:6px 0"><tbody>' + trs + '</tbody></table>';
}

function insertEditorTable(editor, range, rows, cols) {
  var work = restoreEditorRange(editor, range);
  if (!work.collapsed) work.deleteContents();
  var holder = document.createElement('div');
  holder.innerHTML = buildEditorTableHtml(rows, cols) + '<p><br></p>';
  var table = holder.querySelector('table');
  var frag = document.createDocumentFragment();
  while (holder.firstChild) frag.appendChild(holder.firstChild);
  work.insertNode(frag);
  if (table && table.rows[0] && table.rows[0].cells[0]) focusEditorCell(editor, table.rows[0].cells[0]);
}

function editorTableRows(table) {
  return Array.prototype.slice.call(table.rows);
}

function applyTableAction(editor, ctx, act, panel) {
  if (act === 'row-add') return tableInsertRow(editor, ctx);
  if (act === 'row-del') return tableDeleteRow(editor, ctx);
  if (act === 'col-add') return tableInsertColumn(editor, ctx);
  if (act === 'col-del') return tableDeleteColumn(editor, ctx);
  if (act === 'drop') return tableRemove(editor, ctx);
  if (!ctx.table) return false;
  if (act === 'border-cell' || act === 'border-table') {
    var borderSel = panel ? panel.querySelector('#cmpTblBorder') : null;
    return applyTableBorder(ctx, borderSel ? borderSel.value : 'thin', act === 'border-cell' ? 'cell' : 'table');
  }
  if (act === 'bg-cell' || act === 'bg-table') {
    var bg = panel ? panel.querySelector('#cmpTblBg') : null;
    if (!bg || !COLOR_HEX.test(bg.value)) return false;
    return applyTableBackground(ctx, bg.value, act === 'bg-cell' ? 'cell' : 'table');
  }
  return false;
}

function tableInsertRow(editor, ctx) {
  if (!ctx.table) return false;
  var refRow = ctx.cell ? ctx.cell.parentNode : ctx.table.rows[ctx.table.rows.length - 1];
  if (!refRow) refRow = null;
  var index = refRow ? refRow.rowIndex + 1 : ctx.table.rows.length;
  var count = refRow ? refRow.cells.length : 1;
  var row = ctx.table.insertRow(index);
  for (var i = 0; i < count; i++) {
    var src = refRow && refRow.cells[i] ? refRow.cells[i] : null;
    var td = row.insertCell(-1);
    // 新单元格沿用参考行的框线与底色，插入后不用再重新刷一遍样式。
    td.setAttribute('style', (src && src.getAttribute('style')) || TABLE_CELL_STYLE);
    td.innerHTML = '<br>';
  }
  focusEditorCell(editor, row.cells[0]);
  return true;
}

function tableDeleteRow(editor, ctx) {
  if (!ctx.table) return false;
  var row = ctx.cell ? ctx.cell.parentNode : null;
  if (!row) return false;
  if (ctx.table.rows.length <= 1) return tableRemove(editor, ctx);
  var next = row.nextElementSibling || row.previousElementSibling;
  row.parentNode.removeChild(row);
  if (next && next.cells && next.cells.length) focusEditorCell(editor, next.cells[0]);
  return true;
}

function tableInsertColumn(editor, ctx) {
  if (!ctx.table) return false;
  var want = ctx.cell ? ctx.cell.cellIndex + 1 : 0;
  editorTableRows(ctx.table).forEach(function (row) {
    var index = Math.min(want, row.cells.length);
    var src = row.cells[Math.min(Math.max(index - 1, 0), row.cells.length - 1)] || null;
    var td = row.insertCell(index);
    td.setAttribute('style', (src && src.getAttribute('style')) || TABLE_CELL_STYLE);
    td.innerHTML = '<br>';
  });
  var first = ctx.table.rows[0];
  if (first && first.cells.length) {
    focusEditorCell(editor, first.cells[Math.min(want, first.cells.length - 1)]);
  }
  return true;
}

function tableDeleteColumn(editor, ctx) {
  if (!ctx.table || !ctx.cell) return false;
  var index = ctx.cell.cellIndex;
  var rows = editorTableRows(ctx.table);
  if (rows[0] && rows[0].cells.length <= 1) return tableRemove(editor, ctx);
  rows.forEach(function (row) { if (row.cells[index]) row.deleteCell(index); });
  var first = ctx.table.rows[0];
  if (first && first.cells.length) {
    focusEditorCell(editor, first.cells[Math.min(index, first.cells.length - 1)]);
  }
  return true;
}

function tableRemove(editor, ctx) {
  if (!ctx.table) return false;
  var host = ctx.table.parentNode;
  ctx.table.parentNode.removeChild(ctx.table);
  if (host) {
    var range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  editor.focus();
  return true;
}

function tableTargetCells(ctx, scope) {
  if (scope === 'cell') return ctx.cell ? [ctx.cell] : [];
  if (!ctx.table) return [];
  var cells = [];
  editorTableRows(ctx.table).forEach(function (row) {
    Array.prototype.forEach.call(row.cells, function (cell) { cells.push(cell); });
  });
  return cells;
}

/* 框线与底色都写成单元格的内联样式：邮件客户端不加载外部 CSS，只有内联样式才带得过去。 */
function applyTableBorder(ctx, preset, scope) {
  var border = TABLE_BORDER_PRESETS[preset];
  if (border === undefined) return false;
  var cells = tableTargetCells(ctx, scope);
  if (!cells.length) return false;
  cells.forEach(function (cell) { cell.style.border = border; });
  if (ctx.table) ctx.table.style.borderCollapse = 'collapse';
  return true;
}

function applyTableBackground(ctx, color, scope) {
  var cells = tableTargetCells(ctx, scope);
  if (!cells.length) return false;
  cells.forEach(function (cell) { cell.style.backgroundColor = color; });
  return true;
}

function renderTablePanel(panel, onPick) {
  if (!panel) return;
  panel.innerHTML = '' +
    '<div class="tbl-row tbl-head">按住选行列，点一下即插入 <b id="cmpTblPickLabel"></b></div>' +
    '<div class="tbl-grid" id="cmpTblGrid"></div>' +
    '<div class="tbl-row">' +
    '  <button data-tbl="row-add" title="在当前行下方插入一行">＋行</button>' +
    '  <button data-tbl="row-del" title="删除当前行">－行</button>' +
    '  <button data-tbl="col-add" title="在当前列右侧插入一列">＋列</button>' +
    '  <button data-tbl="col-del" title="删除当前列">－列</button>' +
    '  <button data-tbl="drop" class="danger" title="删除整个表格">删除表格</button>' +
    '</div>' +
    '<div class="tbl-row"><label>框线</label>' +
    '  <select id="cmpTblBorder">' +
    '    <option value="thin">细实线</option>' +
    '    <option value="medium">粗实线</option>' +
    '    <option value="dashed">虚线</option>' +
    '    <option value="double">双线</option>' +
    '    <option value="none">无框线</option>' +
    '  </select>' +
    '  <button data-tbl="border-cell">单元格</button>' +
    '  <button data-tbl="border-table">整表</button>' +
    '</div>' +
    '<div class="tbl-row"><label>底色</label>' +
    '  <input type="color" id="cmpTblBg" value="#fff3cd">' +
    '  <button data-tbl="bg-cell">单元格</button>' +
    '  <button data-tbl="bg-table">整表</button>' +
    '</div>' +
    '<div class="hint">先把光标放进表格再调整；从 Excel / Word 粘进来的表格同样可以这样改。</div>';
  initTableGrid(panel.querySelector('#cmpTblGrid'), panel.querySelector('#cmpTblPickLabel'), onPick);
}

function initTableGrid(grid, label, onPick) {
  if (!grid || !label) return;
  var html = '';
  for (var r = 1; r <= TABLE_GRID_ROWS; r++) {
    for (var c = 1; c <= TABLE_GRID_COLS; c++) html += '<i data-cell="' + r + '-' + c + '"></i>';
  }
  grid.style.gridTemplateColumns = 'repeat(' + TABLE_GRID_COLS + ', 16px)';
  grid.innerHTML = html;
  var cells = $$('[data-cell]', grid);

  function highlight(rows, cols) {
    cells.forEach(function (cell) {
      var pos = cell.dataset.cell.split('-');
      cell.classList.toggle('on', Number(pos[0]) <= rows && Number(pos[1]) <= cols);
    });
    label.textContent = rows + ' × ' + cols;
  }
  function locate(event) {
    var cell = event.target.closest('[data-cell]');
    if (!cell) return null;
    var pos = cell.dataset.cell.split('-');
    highlight(Number(pos[0]), Number(pos[1]));
    return [Number(pos[0]), Number(pos[1])];
  }
  grid.addEventListener('mouseover', locate);
  grid.addEventListener('mouseleave', function () { highlight(2, 3); });
  grid.addEventListener('click', function (event) {
    var pos = locate(event);
    if (pos) onPick(pos[0], pos[1]);
  });
  highlight(2, 3);
}

/* Excel / Word 复制过来的表格带着 <style>、条件注释和 mso-* 私有样式，直接插入会
   让结构难以维护。这里把样式拍平到元素上，只保留常见排版属性，并强制表格合并边框。 */
var PASTE_STYLE_PROPS = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'text-align', 'vertical-align', 'white-space', 'line-height',
  'padding', 'margin', 'width', 'height',
  'border-color', 'border-width', 'border-style', 'border-collapse'
];
var PASTE_KEEP_ATTRS = ['href', 'src', 'alt', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign'];

function normalizePastedHtml(html) {
  var box = document.createElement('div');
  box.innerHTML = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  Array.prototype.forEach.call(box.querySelectorAll('script,style,meta,link,title,iframe,object,embed'), function (node) {
    node.parentNode.removeChild(node);
  });
  Array.prototype.forEach.call(box.querySelectorAll('*'), function (el) {
    var keepStyles = [];
    PASTE_STYLE_PROPS.forEach(function (prop) {
      var value = el.style.getPropertyValue(prop);
      if (!value) return;
      if (/expression|javascript:|url\s*\(/i.test(value)) return;
      keepStyles.push(prop + ':' + value.replace(/windowtext/gi, '#000000').trim());
    });
    var keepAttrs = {};
    PASTE_KEEP_ATTRS.forEach(function (name) {
      if (el.hasAttribute(name)) keepAttrs[name] = el.getAttribute(name);
    });
    // 先清空属性再按白名单写回，class / id / mso 私有标记一并丢掉。
    Array.prototype.slice.call(el.attributes).forEach(function (attr) {
      el.removeAttribute(attr.name);
    });
    Object.keys(keepAttrs).forEach(function (name) { el.setAttribute(name, keepAttrs[name]); });
    if (keepStyles.length) el.setAttribute('style', keepStyles.join(';'));
    if (el.tagName === 'TABLE') {
      el.style.borderCollapse = 'collapse';
      el.style.margin = '6px 0';
    }
  });
  return box.innerHTML;
}

function handleEditorPaste(event, editor) {
  var clip = event.clipboardData || window.clipboardData;
  if (!clip || !clip.getData) return;
  var html = clip.getData('text/html');
  if (!html) return;  // 纯文本交给浏览器默认粘贴
  event.preventDefault();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('insertHTML', false, normalizePastedHtml(html));
  editor.focus();
}

function collectCompose(editor) {
  var html = editor.innerHTML;
  var text = editor.innerText || '';
  if (!text.trim() && !html.replace(/<[^>]*>/g, '').trim()) {
    html = '';
  }
  return { html: html, text: text };
}

/* ===================================================================== 收件人联想 */

// 写信时在收件人 / 抄送 / 密送里输入姓名或邮箱前缀，自动从通讯录里给出候选。
var suggestContacts = null;

function loadSuggestContacts() {
  return api('/api/contacts').then(function (data) {
    suggestContacts = (data && data.contacts) || [];
    return suggestContacts;
  }).catch(function () { return suggestContacts || []; });
}

function suggestCandidates(word) {
  var q = (word || '').trim().toLowerCase();
  if (!q || !suggestContacts) return [];
  var hits = [];
  suggestContacts.forEach(function (c) {
    var name = (c.name || '').toLowerCase();
    var email = (c.email || '').toLowerCase();
    var nameAt = name.indexOf(q);
    var mailAt = email.indexOf(q);
    if (nameAt < 0 && mailAt < 0) return;
    // 前缀命中的排在包含命中之前，同组内保持通讯录原有顺序。
    var rank = (nameAt === 0 || mailAt === 0) ? 0 : 1;
    hits.push({ rank: rank, order: hits.length, contact: c });
  });
  hits.sort(function (a, b) { return a.rank - b.rank || a.order - b.order; });
  return hits.slice(0, 8).map(function (item) { return item.contact; });
}

function attachContactSuggest(input) {
  var field = input.parentNode;
  field.style.position = 'relative';
  var box = document.createElement('div');
  box.className = 'suggest hidden';
  field.appendChild(box);
  var items = [];
  var active = -1;

  function hide() {
    box.classList.add('hidden');
    box.innerHTML = '';
    items = [];
    active = -1;
  }

  function highlight() {
    $$('[data-index]', box).forEach(function (row) {
      row.classList.toggle('on', Number(row.dataset.index) === active);
    });
  }

  function render(list) {
    items = list;
    active = list.length ? 0 : -1;
    box.innerHTML = list.map(function (c, index) {
      return '<div class="suggest-item' + (index === active ? ' on' : '') + '" data-index="' + index + '">' +
        '<span class="suggest-name">' + esc(c.name || c.email || '') + '</span>' +
        '<span class="suggest-mail">' + esc(c.email || '') + '</span></div>';
    }).join('');
    box.classList.toggle('hidden', !list.length);
  }

  function currentWord() {
    var parts = parseAddressInput(input.value);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function choose(index) {
    var contact = items[index];
    if (!contact || !contact.email) return;
    var parts = parseAddressInput(input.value);
    parts[parts.length - 1] = addrText({ name: contact.name || '', addr: contact.email });
    // 末尾补一个逗号，方便连续选择下一个人。
    input.value = parts.join(', ') + ', ';
    hide();
    // 直接改 value 不会触发 input 事件，这里补一次，让收件人框的自动增高重新量高度。
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function refresh() {
    var word = currentWord();
    // 已经是一个完整邮箱地址时不再提示，避免干扰手工输入。
    if (!word || word.indexOf('@') >= 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(word)) { hide(); return; }
    render(suggestCandidates(word));
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('keydown', function (event) {
    if (box.classList.contains('hidden')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      active += event.key === 'ArrowDown' ? 1 : -1;
      if (active < 0) active = items.length - 1;
      if (active >= items.length) active = 0;
      highlight();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(active);
      return;
    }
    if (event.key === 'Escape') {
      // 只收起候选框，不要顺手关掉写信窗口。
      event.stopPropagation();
      hide();
    }
  });
  box.addEventListener('mousedown', function (event) {
    var row = event.target.closest('[data-index]');
    if (!row) return;
    event.preventDefault();  // 阻止输入框失焦，选择后还能继续输入
    choose(Number(row.dataset.index));
  });
  box.addEventListener('mousemove', function (event) {
    var row = event.target.closest('[data-index]');
    if (!row) return;
    active = Number(row.dataset.index);
    highlight();
  });
  input.addEventListener('blur', function () { setTimeout(hide, 150); });
}

function sendCompose(asDraft) {
  var compose = state.compose;
  if (!compose) return;
  var editor = $('#cmpBody');
  var body = collectCompose(editor);
  var accountId = Number($('#cmpAccount').value);
  var payload = {
    account_id: accountId,
    to: parseAddressInput($('#cmpTo').value),
    cc: parseAddressInput($('#cmpCc') ? $('#cmpCc').value : ''),
    bcc: parseAddressInput($('#cmpBcc') ? $('#cmpBcc').value : ''),
    subject: $('#cmpSubject').value,
    html: body.html,
    text: body.text,
    attachments: compose.attachments,
    draft_id: compose.draftId,
    in_reply_to: compose.inReplyTo,
    references: compose.references
  };
  if (!asDraft && !payload.to.length) { toast('请填写收件人', 'err'); return; }
  var status = $('#cmpStatus');
  if (status) status.textContent = asDraft ? '正在保存草稿…' : '正在发送…';
  $$('[data-cmp="send"],[data-cmp="save-draft"]').forEach(function (b) { b.disabled = true; });
  var promise = asDraft
    ? api('/api/drafts', { method: 'POST', body: payload })
    : api('/api/messages/send', { method: 'POST', body: payload });
  promise.then(function (data) {
    closeModal();
    state.compose = null;
    if (asDraft) {
      toast('草稿已保存', 'ok');
    } else {
      var extra = '';
      if (typeof data.recipients !== 'undefined') extra = '（' + data.recipients.length + ' 个收件人）';
      toast('邮件已发送' + extra, 'ok');
      if (data.server_message && data.server_synced === false) toast(data.server_message, '');
    }
    reload().then(function () { if (state.view === 'mail') loadMessages(); });
  }).catch(function (err) {
    if (status) status.textContent = '';
    $$('[data-cmp="send"],[data-cmp="save-draft"]').forEach(function (b) { b.disabled = false; });
    toast(err.message, 'err');
  });
}

/* ===================================================================== 通讯录 */

function renderContacts() {
  var pane = $('#listPane');
  var groups = (state.boot && state.boot.groups) || [];
  pane.innerHTML = '' +
    '<div class="list-toolbar">' +
    '  <input class="search" id="contactSearch" type="search" placeholder="搜索姓名、邮箱、电话或公司" value="' + esc(state.contactQuery || '') + '">' +
    '  <select id="contactGroup" style="max-width:170px"><option value="">全部分组</option>' +
    groups.map(function (g) { return '<option value="' + esc(g.name) + '">' + esc(g.name) + '（' + (g.count || 0) + '）</option>'; }).join('') +
    '  </select>' +
    '  <button class="btn small" data-act="contact-search">搜索</button>' +
    '  <div class="spacer"></div>' +
    '  <button class="btn small primary" data-act="contact-new">新增联系人</button>' +
    '  <button class="btn small" data-act="contact-harvest">从邮件中收集</button>' +
    '  <button class="btn small" data-act="contact-groups">分组管理</button>' +
    '  <button class="btn small" data-act="contact-import">导入 CSV</button>' +
    '  <button class="btn small" data-act="contact-template">下载模板</button>' +
    '  <button class="btn small" data-act="contact-export">导出 CSV</button>' +
    '  <input type="file" id="contactFile" accept=".csv,text/csv" class="hidden">' +
    '</div>' +
    '<div class="list-body" id="contactList"></div>';
  loadContacts();
}

function loadContacts() {
  var list = $('#contactList');
  if (!list) return;
  list.innerHTML = '<div class="empty">正在加载…</div>';
  api('/api/contacts', {
    params: { q: state.contactQuery || '', group: ($('#contactGroup') && $('#contactGroup').value) || '' }
  }).then(function (data) {
    state.contacts = data.contacts;
    state.boot.groups = data.groups;
    if (!data.contacts.length) {
      list.innerHTML = '<div class="empty"><div class="big">通讯录为空</div>' +
        '<div>可以手动新增联系人，或点击「从邮件中收集」自动整理往来地址。</div></div>';
      return;
    }
    list.innerHTML = data.contacts.map(function (c) {
      var initial = (c.name || c.email || '?').trim().charAt(0).toUpperCase();
      return '<div class="contact-item" data-id="' + c.id + '">' +
        '<div class="avatar">' + esc(initial) + '</div>' +
        '<div class="contact-main">' +
        '  <div class="contact-name">' + esc(c.name || c.email) + (c.is_favorite ? ' <span class="tag">常用</span>' : '') + '</div>' +
        '  <div class="contact-sub">' + esc(c.email || '') +
        (c.phone ? ' · ' + esc(c.phone) : '') +
        (c.company ? ' · ' + esc(c.company) + (c.title ? ' ' + esc(c.title) : '') : '') + '</div>' +
        '</div>' +
        '<div class="hint">' + esc((c.groups || []).join(' / ')) + '</div>' +
        '<button class="btn small" data-mail="' + esc(c.email) + '">写信</button>' +
        '<button class="btn small" data-edit="' + c.id + '">编辑</button>' +
        '<button class="btn small danger" data-remove="' + c.id + '">删除</button>' +
        '</div>';
    }).join('');
  }).catch(function (err) { list.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>'; });
}

function onContactsClick(event) {
  var target = event.target;
  if (target.closest('[data-act="contact-search"]')) { state.contactQuery = $('#contactSearch').value.trim(); loadContacts(); return; }
  if (target.closest('[data-act="contact-new"]')) { openContactModal(null); return; }
  if (target.closest('[data-act="contact-groups"]')) { openGroupManager(); return; }
  if (target.closest('[data-act="contact-export"]')) { exportContacts(); return; }
  if (target.closest('[data-act="contact-template"]')) { downloadContactTemplate(); return; }
  if (target.closest('[data-act="contact-import"]')) {
    var file = $('#contactFile');
    if (file) { file.value = ''; file.click(); }
    return;
  }
  if (target.closest('[data-act="contact-harvest"]')) {
    api('/api/contacts/harvest', { method: 'POST', body: {} }).then(function (data) {
      toast('收集完成：新增 ' + data.added + ' 个，已存在 ' + data.skipped + ' 个', 'ok');
      loadContacts();
    }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  var mail = target.closest('[data-mail]');
  if (mail) { openCompose({ to: mail.dataset.mail }); return; }
  var edit = target.closest('[data-edit]');
  if (edit) {
    var contact = (state.contacts || []).filter(function (c) { return c.id === Number(edit.dataset.edit); })[0];
    openContactModal(contact);
    return;
  }
  var remove = target.closest('[data-remove]');
  if (remove) {
    var id = Number(remove.dataset.remove);
    confirmBox('删除联系人', '确定要删除这个联系人吗？', function () {
      api('/api/contacts/' + id, { method: 'DELETE' }).then(function () {
        toast('已删除', 'ok');
        loadContacts();
      }).catch(function (err) { toast(err.message, 'err'); });
    });
  }
}

function openContactModal(contact) {
  contact = contact || {};
  var groups = (state.boot && state.boot.groups) || [];
  openModal(modalHeader(contact.id ? '编辑联系人' : '新增联系人') +
    '<div class="modal-body">' +
    '  <div class="field-row">' +
    '    <div class="field"><label>姓名</label><input id="ctName" type="text" value="' + esc(contact.name || '') + '"></div>' +
    '    <div class="field"><label>邮箱</label><input id="ctEmail" type="text" value="' + esc(contact.email || '') + '"></div>' +
    '  </div>' +
    '  <div class="field-row">' +
    '    <div class="field"><label>电话</label><input id="ctPhone" type="text" value="' + esc(contact.phone || '') + '"></div>' +
    '    <div class="field"><label>公司</label><input id="ctCompany" type="text" value="' + esc(contact.company || '') + '"></div>' +
    '  </div>' +
    '  <div class="field-row">' +
    '    <div class="field"><label>职务</label><input id="ctTitle" type="text" value="' + esc(contact.title || '') + '"></div>' +
    '    <div class="field"><label>分组（用逗号分隔）</label><input id="ctGroups" type="text" value="' + esc((contact.groups || []).join(', ')) + '" list="ctGroupList">' +
    '      <datalist id="ctGroupList">' + groups.map(function (g) { return '<option value="' + esc(g.name) + '"></option>'; }).join('') + '</datalist>' +
    '    </div>' +
    '  </div>' +
    '  <div class="field"><label>备注</label><textarea id="ctNote" rows="3">' + esc(contact.note || '') + '</textarea></div>' +
    '  <div class="switch-row"><input type="checkbox" id="ctFav"' + (contact.is_favorite ? ' checked' : '') + '>' +
    '    <label for="ctFav">标记为常用联系人</label></div>' +
    '</div>' +
    '<div class="modal-foot">' +
    '  <button class="btn primary" data-ct="save">保存</button>' +
    (contact.email ? '<button class="btn" data-ct="write">写邮件</button>' : '') +
    '  <div class="spacer"></div>' +
    '  <button class="btn ghost" data-act="close-modal">取消</button>' +
    '</div>', {
    onMount: function (wrapper) {
      wrapper.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-ct]');
        if (!btn) return;
        if (btn.dataset.ct === 'write') { closeModal(); openCompose({ to: contact.email }); return; }
        var payload = {
          name: $('#ctName').value.trim(),
          email: $('#ctEmail').value.trim(),
          phone: $('#ctPhone').value.trim(),
          company: $('#ctCompany').value.trim(),
          title: $('#ctTitle').value.trim(),
          groups: $('#ctGroups').value,
          note: $('#ctNote').value,
          is_favorite: $('#ctFav').checked
        };
        if (!payload.name && !payload.email) { toast('请至少填写姓名或邮箱', 'err'); return; }
        var promise = contact.id
          ? api('/api/contacts/' + contact.id, { method: 'PUT', body: payload })
          : api('/api/contacts', { method: 'POST', body: payload });
        promise.then(function () {
          closeModal();
          toast('已保存', 'ok');
          loadContacts();
        }).catch(function (err) { toast(err.message, 'err'); });
      });
    }
  });
}

function openGroupManager() {
  var groups = (state.boot && state.boot.groups) || [];
  openModal(modalHeader('分组管理') +
    '<div class="modal-body">' +
    '  <div class="field-row"><input id="grpName" type="text" placeholder="新分组名称">' +
    '    <button class="btn" data-grp="add" style="flex:0 0 auto">新增分组</button></div>' +
    '  <div id="grpList">' + (groups.length ? groups.map(function (g) {
      return '<div class="contact-item"><div class="contact-main"><div class="contact-name">' + esc(g.name) + '</div>' +
        '<div class="contact-sub">' + (g.count || 0) + ' 个联系人</div></div>' +
        '<button class="btn small" data-grp-rename="' + g.id + '" data-name="' + esc(g.name) + '">重命名</button>' +
        '<button class="btn small danger" data-grp-remove="' + g.id + '">删除</button></div>';
    }).join('') : '<div class="empty">暂无分组</div>') + '</div>' +
    '</div>', {
    onMount: function (wrapper) {
      wrapper.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-grp],[data-grp-rename],[data-grp-remove]');
        if (!btn) return;
        if (btn.dataset.grp === 'add') {
          var name = $('#grpName').value.trim();
          if (!name) { toast('请输入分组名称', 'err'); return; }
          api('/api/contact-groups', { method: 'POST', body: { name: name } }).then(function () {
            closeModal(); refreshGroups(); toast('已新增分组', 'ok');
          }).catch(function (err) { toast(err.message, 'err'); });
          return;
        }
        if (btn.dataset.grpRename) {
          var newName = prompt('新的分组名称', btn.dataset.name);
          if (!newName) return;
          api('/api/contact-groups/' + btn.dataset.grpRename, { method: 'PUT', body: { name: newName } }).then(function () {
            closeModal(); refreshGroups(); toast('已重命名', 'ok');
          }).catch(function (err) { toast(err.message, 'err'); });
          return;
        }
        if (btn.dataset.grpRemove) {
          api('/api/contact-groups/' + btn.dataset.grpRemove, { method: 'DELETE' }).then(function () {
            closeModal(); refreshGroups(); toast('已删除分组', 'ok');
          }).catch(function (err) { toast(err.message, 'err'); });
        }
      });
    }
  });
}

function refreshGroups() {
  api('/api/contact-groups').then(function (data) {
    state.boot.groups = data.groups;
    if (state.view === 'contacts') loadContacts();
  }).catch(function () { });
}

var CONTACT_CSV_HEADER = ['姓名', '邮箱', '电话', '公司', '职务', '分组', '备注'];

// 表头兼容中英文两种写法，方便用户直接改写模板或沿用已有表格。
var CONTACT_CSV_COLUMNS = {
  '姓名': 'name', 'name': 'name',
  '邮箱': 'email', '邮件地址': 'email', 'email': 'email', 'e-mail': 'email',
  '电话': 'phone', '手机': 'phone', 'phone': 'phone', 'mobile': 'phone',
  '公司': 'company', '单位': 'company', 'company': 'company',
  '职务': 'title', '职位': 'title', 'title': 'title',
  '分组': 'groups', '分类': 'groups', 'group': 'groups', 'groups': 'groups',
  '备注': 'note', 'note': 'note', 'notes': 'note'
};

function toCsv(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) { return '"' + String(cell === null || cell === undefined ? '' : cell).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
}

function downloadCsv(rows, filename) {
  var blob = new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
}

function exportContacts() {
  var rows = [CONTACT_CSV_HEADER];
  (state.contacts || []).forEach(function (c) {
    rows.push([c.name || '', c.email || '', c.phone || '', c.company || '', c.title || '', (c.groups || []).join('/'), (c.note || '').replace(/\n/g, ' ')]);
  });
  downloadCsv(rows, 'fnmail-contacts.csv');
}

function downloadContactTemplate() {
  downloadCsv([CONTACT_CSV_HEADER, ['张三', 'zhangsan@example.com', '13800000000', '示例科技有限公司', '客户经理', '客户/同事', '示例行，导入前可删除']],
    'fnmail-contacts-template.csv');
}

function parseCsvRows(text) {
  var rows = [];
  var row = [];
  var cell = '';
  var quoted = false;
  var i = 0;
  while (i < text.length) {
    var ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue; }
    cell += ch; i += 1;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(function (item) {
    return item.some(function (value) { return String(value).trim() !== ''; });
  });
}

function decodeCsvBuffer(buffer) {
  var bytes = new Uint8Array(buffer);
  var text = '';
  try { text = new TextDecoder('utf-8').decode(bytes); } catch (e) { text = ''; }
  // Excel 直接另存的 CSV 多为 GBK 编码，UTF-8 解码失败时用 GBK 重试。
  if (text.indexOf('\ufffd') >= 0 && typeof TextDecoder !== 'undefined') {
    try { text = new TextDecoder('gbk').decode(bytes); } catch (e2) { /* 保留 UTF-8 结果 */ }
  }
  return text.replace(/^\ufeff/, '');
}

function parseContactsCsv(text) {
  var table = parseCsvRows(text);
  if (table.length < 2) return [];
  var keys = table[0].map(function (head) {
    return CONTACT_CSV_COLUMNS[String(head).trim().toLowerCase()] || '';
  });
  if (keys.indexOf('name') < 0 && keys.indexOf('email') < 0) return [];
  var contacts = [];
  for (var i = 1; i < table.length; i++) {
    var contact = {};
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      if (!key) continue;
      var value = String(table[i][j] === undefined ? '' : table[i][j]).trim();
      if (!value) continue;
      if (key === 'groups') {
        contact.groups = (contact.groups || []).concat(value.split(/[,\/;，；、]/).map(function (g) { return g.trim(); }).filter(Boolean));
      } else {
        contact[key] = value;
      }
    }
    if (contact.name || contact.email) contacts.push(contact);
  }
  return contacts;
}

function importContactsFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var contacts = parseContactsCsv(decodeCsvBuffer(reader.result));
    if (!contacts.length) {
      toast('未解析到有效数据，请下载模板后按格式填写', 'err');
      return;
    }
    api('/api/contacts/import', { method: 'POST', body: { contacts: contacts } }).then(function (data) {
      toast('导入完成：新增 ' + data.added + '，更新 ' + data.updated + '，跳过 ' + data.skipped, 'ok');
      state.contactQuery = '';
      refreshGroups();
      loadContacts();
    }).catch(function (err) { toast(err.message, 'err'); });
  };
  reader.onerror = function () { toast('读取文件失败', 'err'); };
  reader.readAsArrayBuffer(file);
}

function openContactPicker(onPick) {
  api('/api/contacts').then(function (data) {
    openModal(modalHeader('选择联系人') +
      '<div class="modal-body">' +
      '  <input id="pickSearch" type="search" placeholder="搜索联系人…">' +
      '  <div id="pickList" style="margin-top:10px;max-height:44vh;overflow:auto">' +
      data.contacts.map(function (c) {
        return '<label class="contact-item" data-key="' + esc((c.name + c.email).toLowerCase()) + '">' +
          '<input type="checkbox" value="' + esc(addrText({ name: c.name, addr: c.email })) + '">' +
          '<div class="contact-main"><div class="contact-name">' + esc(c.name || c.email) + '</div>' +
          '<div class="contact-sub">' + esc(c.email || '') + '</div></div></label>';
      }).join('') + '</div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn primary" data-pick="ok">确定</button>' +
      '<div class="spacer"></div><button class="btn ghost" data-act="close-modal">取消</button></div>', {
      onMount: function (wrapper) {
        $('#pickSearch', wrapper).addEventListener('input', function () {
          var q = this.value.trim().toLowerCase();
          $$('[data-key]', wrapper).forEach(function (row) {
            row.style.display = !q || row.dataset.key.indexOf(q) >= 0 ? '' : 'none';
          });
        });
        wrapper.addEventListener('click', function (event) {
          if (!event.target.closest('[data-pick="ok"]')) return;
          var values = $$('input[type=checkbox]:checked', wrapper).map(function (box) { return box.value; });
          closeModal();
          if (values.length) onPick(values);
        });
      }
    });
  }).catch(function (err) { toast(err.message, 'err'); });
}

/* ===================================================================== 账号 */

function renderAccounts() {
  var pane = $('#listPane');
  var accounts = (state.boot && state.boot.accounts) || [];
  var html = '<div class="panel"><div class="panel-head"><h2>邮箱账号</h2>' +
    '<div class="spacer"></div>' +
    '<button class="btn small primary" data-act="account-new">新增账号</button>' +
    '<button class="btn small" data-act="account-refresh">刷新状态</button></div>';
  if (!accounts.length) {
    html += '<div class="card"><div class="empty"><div class="big">还没有邮箱账号</div>' +
      '<div>支持的收信协议：POP3 / IMAP；发信协议：SMTP。' +
      '<br>QQ、163、Gmail 等请使用「授权码」而不是登录密码。</div>' +
      '<div style="margin-top:14px"><button class="btn primary" data-act="account-new">立即添加账号</button></div></div></div>';
  } else {
    html += '<div class="grid-2">' + accounts.map(function (a) {
      var sync = (state.boot.sync || {})[String(a.id)] || {};
      var status = sync.running
        ? '<span class="tag">收信中…</span>'
        : (a.last_sync_status === 'error'
          ? '<span class="tag danger">上次失败</span>'
          : (a.last_sync ? '<span class="tag ok">' + esc(fmtDate(a.last_sync)) + '</span>' : '<span class="tag gray">未收取</span>'));
      return '<div class="card" data-account-card="' + a.id + '">' +
        '<div class="card-title">' + esc(a.name || a.email) + status +
        '<span class="tag gray">' + esc((a.protocol || '').toUpperCase()) + '</span></div>' +
        '<div class="hint">' + esc(a.email || '') + '</div>' +
        '<div class="hint">收信：' + esc(a.in_host || '-') + ':' + esc(a.in_port) + '（' + esc(a.in_security) + '）' +
        ' · 发信：' + esc(a.out_host || '-') + ':' + esc(a.out_port) + '</div>' +
        (a.last_sync_message ? '<div class="hint">最近一次：' + esc(a.last_sync_message) + '</div>' : '') +
        (a.last_error ? '<div class="hint" style="color:#e5484d">错误：' + esc(a.last_error) + '</div>' : '') +
        '<div class="progress"><i style="width:' + (sync.running ? progressPercent(sync) : (a.last_sync ? 100 : 0)) + '%"></i></div>' +
        (sync.running ? '<div class="hint">' + esc(sync.stage || '') + ' ' + esc(sync.message || '') + '</div>' : '') +
        '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn small" data-acc-sync="' + a.id + '">立即收信</button>' +
        '<button class="btn small" data-acc-test="' + a.id + '">连接测试</button>' +
        '<button class="btn small" data-acc-edit="' + a.id + '">编辑</button>' +
        '<button class="btn small danger" data-acc-remove="' + a.id + '">删除</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }
  html += '</div>';
  pane.innerHTML = html;
}

function progressPercent(sync) {
  if (!sync.total) return sync.running ? 8 : 0;
  return Math.min(100, Math.round((sync.current / sync.total) * 100));
}

function renderAccountStatus() {
  if (state.view !== 'accounts') return;
  var pane = $('#listPane');
  if (!pane) return;
  (state.boot.accounts || []).forEach(function (a) {
    var card = pane.querySelector('[data-account-card="' + a.id + '"]');
    if (!card) return;
    var sync = (state.boot.sync || {})[String(a.id)] || {};
    var bar = card.querySelector('.progress > i');
    if (bar) bar.style.width = (sync.running ? progressPercent(sync) : 100) + '%';
  });
}

function onAccountsClick(event) {
  var target = event.target;
  if (target.closest('[data-act="account-new"]')) { openAccountModal(null); return; }
  if (target.closest('[data-act="account-refresh"]')) {
    reload().then(renderAccounts).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  var sync = target.closest('[data-acc-sync]');
  if (sync) {
    api('/api/accounts/' + sync.dataset.accSync + '/sync', { method: 'POST' }).then(function () {
      toast('已开始收信', 'ok');
      setTimeout(pollSync, 600);
    }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  var test = target.closest('[data-acc-test]');
  if (test) {
    var btn = test;
    btn.disabled = true; btn.textContent = '测试中…';
    api('/api/accounts/' + btn.dataset.accTest + '/test', { method: 'POST', body: {} }).then(function (data) {
      var lines = [];
      if (data.incoming) lines.push('收信：' + data.incoming);
      if (data.incoming_error) lines.push('收信失败：' + data.incoming_error);
      if (data.outgoing) lines.push('发信：' + data.outgoing);
      if (data.outgoing_error) lines.push('发信失败：' + data.outgoing_error);
      openModal(modalHeader('连接测试结果') + '<div class="modal-body">' +
        lines.map(function (line) { return '<div class="field">' + esc(line) + '</div>'; }).join('') + '</div>');
    }).catch(function (err) { toast(err.message, 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = '连接测试'; });
    return;
  }
  var edit = target.closest('[data-acc-edit]');
  if (edit) {
    var account = state.boot.accounts.filter(function (a) { return a.id === Number(edit.dataset.accEdit); })[0];
    openAccountModal(account);
    return;
  }
  var remove = target.closest('[data-acc-remove]');
  if (remove) {
    var id = Number(remove.dataset.accRemove);
    confirmBox('删除账号', '删除账号会同时删除该账号在本地归档的全部邮件（.eml 文件），且不可恢复。是否继续？', function () {
      api('/api/accounts/' + id + '?purge=1', { method: 'DELETE' }).then(function () {
        toast('账号已删除', 'ok');
        reload().then(function () {
          if (state.target.accountId === id) {
            state.target = { accountId: (state.boot.accounts[0] || {}).id || null, folderId: null, kind: 'inbox' };
          }
          renderAccounts();
        });
      }).catch(function (err) { toast(err.message, 'err'); });
    });
  }
}

var SECURITY_OPTIONS = [['ssl', 'SSL / TLS（推荐）'], ['starttls', 'STARTTLS'], ['none', '不加密']];

function securityOptions(current) {
  return SECURITY_OPTIONS.map(function (item) {
    return '<option value="' + item[0] + '"' + (current === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
  }).join('');
}

function openAccountModal(account) {
  account = account || { protocol: 'pop3', in_security: 'ssl', out_security: 'ssl', in_port: 995, out_port: 465, sync_interval: 300, out_use_in_auth: 1, sync_enabled: 1 };
  var isNew = !account.id;
  var providerList = (state.boot.providers || []).map(function (p) {
    return '<option value="' + p.id + '">' + esc(p.name) + '</option>';
  }).join('');
  openModal(modalHeader(isNew ? '新增邮箱账号' : '编辑邮箱账号') +
    '<div class="modal-body">' +
    '  <div class="field-row">' +
    '    <div class="field"><label>邮箱服务商</label><select id="acProvider"><option value="">自动识别 / 自定义</option>' + providerList + '</select></div>' +
    '    <div class="field"><label>账号备注名</label><input id="acName" type="text" value="' + esc(account.name || '') + '" placeholder="例如：工作邮箱"></div>' +
    '  </div>' +
    '  <div class="field-row">' +
    '    <div class="field"><label>邮箱地址 *</label><input id="acEmail" type="text" value="' + esc(account.email || '') + '" placeholder="you@example.com"></div>' +
    '    <div class="field"><label>发件显示名</label><input id="acDisplayName" type="text" value="' + esc(account.display_name || '') + '"></div>' +
    '  </div>' +
    '  <hr style="border:none;border-top:1px solid #e4e8ee;margin:6px 0 14px">' +
    '  <div class="field-row">' +
    '    <div class="field"><label>收信协议</label><select id="acProtocol">' +
    '<option value="pop3"' + (account.protocol === 'pop3' ? ' selected' : '') + '>POP3</option>' +
    '<option value="imap"' + (account.protocol === 'imap' ? ' selected' : '') + '>IMAP</option></select></div>' +
    '    <div class="field grow-2"><label>收信服务器</label><input id="acInHost" type="text" value="' + esc(account.in_host || '') + '"></div>' +
    '    <div class="field"><label>端口</label><input id="acInPort" type="number" value="' + esc(account.in_port || '') + '"></div>' +
    '    <div class="field"><label>加密</label><select id="acInSecurity">' + securityOptions(account.in_security) + '</select></div>' +
    '  </div>' +
    '  <div class="field-row">' +
    '    <div class="field"><label>收信用户名</label><input id="acInUser" type="text" value="' + esc(account.in_user || '') + '" placeholder="留空则使用邮箱地址"></div>' +
    '    <div class="field"><label>收信密码 / 授权码' + (isNew ? '' : '（留空表示不修改）') + '</label><input id="acInPassword" type="password" placeholder="' + (account.in_password_set ? '已保存，留空不修改' : '') + '"></div>' +
    '  </div>' +
    '  <div class="switch-row"><input type="checkbox" id="acInsecure"' + (account.in_allow_insecure ? ' checked' : '') + '>' +
    '    <label for="acInsecure">允许自签名 / 无效证书（自建服务器）</label></div>' +
    '  <div class="switch-row"><input type="checkbox" id="acKeep"' + (account.pop3_keep_server ? ' checked' : '') + '>' +
    '    <label for="acKeep">POP3：保留服务器上的邮件副本<small class="hint">不勾选则收信成功后从服务器删除</small></label></div>' +
    '  <div class="switch-row"><input type="checkbox" id="acSyncAll"' + (account.imap_sync_all ? ' checked' : '') + '>' +
    '    <label for="acSyncAll">IMAP：同步全部文件夹<small class="hint">不勾选则只同步收件箱、已发送、草稿、垃圾、已删除等标准文件夹</small></label></div>' +
    '  <hr style="border:none;border-top:1px solid #e4e8ee;margin:6px 0 14px">' +
    '  <div class="field-row">' +
    '    <div class="field grow-2"><label>发信服务器（SMTP）</label><input id="acOutHost" type="text" value="' + esc(account.out_host || '') + '"></div>' +
    '    <div class="field"><label>端口</label><input id="acOutPort" type="number" value="' + esc(account.out_port || '') + '"></div>' +
    '    <div class="field"><label>加密</label><select id="acOutSecurity">' + securityOptions(account.out_security) + '</select></div>' +
    '  </div>' +
    '  <div class="field-row">' +
    '    <div class="field"><label>发信用户名</label><input id="acOutUser" type="text" value="' + esc(account.out_user || '') + '"></div>' +
    '    <div class="field"><label>发信密码 / 授权码' + (isNew ? '' : '（留空表示不修改）') + '</label><input id="acOutPassword" type="password" placeholder="' + (account.out_password_set ? '已保存，留空不修改' : '') + '"></div>' +
    '  </div>' +
    '  <div class="switch-row"><input type="checkbox" id="acUseIn"' + (account.out_use_in_auth ? ' checked' : '') + '>' +
    '    <label for="acUseIn">发信时使用与收信相同的用户名和密码</label></div>' +
    '  <div class="switch-row"><input type="checkbox" id="acSaveSent"' + (account.save_sent_to_server ? ' checked' : '') + '>' +
    '    <label for="acSaveSent">发信后把副本同步到服务器「已发送」（仅 IMAP）</label></div>' +
    '  <hr style="border:none;border-top:1px solid #e4e8ee;margin:6px 0 14px">' +
    '  <div class="switch-row"><input type="checkbox" id="acSyncEnabled"' + (account.sync_enabled ? ' checked' : '') + '>' +
    '    <label for="acSyncEnabled">自动收取新邮件</label></div>' +
    '  <div class="field"><label>自动收信间隔（秒，最小 60）</label><input id="acInterval" type="number" value="' + esc(account.sync_interval || 300) + '"></div>' +
    '  <div class="field"><label>邮件签名</label><textarea id="acSignature" rows="3">' + esc(account.signature || '') + '</textarea></div>' +
    '</div>' +
    '<div class="modal-foot">' +
    '  <button class="btn primary" data-ac="save">保存</button>' +
    '  <button class="btn" data-ac="test-in">测试收信</button>' +
    '  <button class="btn" data-ac="test-out">测试发信</button>' +
    '  <div class="spacer"></div>' +
    '  <span class="hint" id="acStatus"></span>' +
    '  <button class="btn ghost" data-act="close-modal">取消</button>' +
    '</div>', {
    wide: true,
    onMount: function (wrapper) {
      var providerSelect = $('#acProvider', wrapper);
      if (account._provider) providerSelect.value = account._provider;

      function refreshProtocolFields() {
        var protocol = $('#acProtocol').value;
        $('#acKeep').disabled = protocol !== 'pop3';
        $('#acSyncAll').disabled = protocol !== 'imap';
        $('#acSaveSent').disabled = protocol !== 'imap';
        if ($('#acKeep').disabled) $('#acKeep').closest('.switch-row').style.opacity = '.45';
        else $('#acKeep').closest('.switch-row').style.opacity = '';
        if ($('#acSyncAll').disabled) $('#acSyncAll').closest('.switch-row').style.opacity = '.45';
        else $('#acSyncAll').closest('.switch-row').style.opacity = '';
      }
      refreshProtocolFields();
      $('#acProtocol', wrapper).addEventListener('change', function () {
        refreshProtocolFields();
        var protocol = this.value;
        var guess = providerFor($('#acEmail').value.trim());
        if (guess) applyProvider(guess, protocol, true);
        if (protocol === 'imap' && !$('#acInPort').value) $('#acInPort').value = 993;
        if (protocol === 'pop3' && !$('#acInPort').value) $('#acInPort').value = 995;
      });

      function providerFor(email) {
        if (!email || email.indexOf('@') < 0) return null;
        var domain = email.split('@').pop().toLowerCase();
        return (state.boot.providers || []).filter(function (p) {
          return (p.domains || []).some(function (d) { return d === domain || domain.endsWith('.' + d); });
        })[0] || null;
      }

      function applyProvider(provider, protocol, force) {
        if (!provider) return;
        var incoming = provider[protocol] || provider.pop3;
        if (incoming && (force || !$('#acInHost').value)) {
          $('#acInHost').value = incoming.host;
          $('#acInPort').value = incoming.port;
          $('#acInSecurity').value = incoming.security;
        }
        if (provider.smtp && (force || !$('#acOutHost').value)) {
          $('#acOutHost').value = provider.smtp.host;
          $('#acOutPort').value = provider.smtp.port;
          $('#acOutSecurity').value = provider.smtp.security;
        }
        providerSelect.value = provider.id;
      }

      providerSelect.addEventListener('change', function () {
        var provider = (state.boot.providers || []).filter(function (p) { return p.id === providerSelect.value; })[0];
        if (provider) applyProvider(provider, $('#acProtocol').value, true);
      });
      $('#acEmail', wrapper).addEventListener('blur', function () {
        var guess = providerFor(this.value.trim());
        if (guess) applyProvider(guess, $('#acProtocol').value, true);
        if (!$('#acName').value) $('#acName').value = this.value.split('@')[0];
      });

      wrapper.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-ac]');
        if (!btn) return;
        var payload = collectAccountForm(account.id);
        var status = $('#acStatus');
        if (btn.dataset.ac === 'test-in') {
          status.textContent = '正在测试收信…';
          api('/api/accounts/test-incoming', { method: 'POST', body: payload })
            .then(function (data) { status.textContent = ''; showTestResult('收信测试', [['结果', data.message]]); })
            .catch(function (err) { status.textContent = ''; showTestResult('收信测试失败', [['错误', err.message]], true); });
          return;
        }
        if (btn.dataset.ac === 'test-out') {
          status.textContent = '正在测试发信…';
          api('/api/accounts/test-outgoing', { method: 'POST', body: payload })
            .then(function (data) { status.textContent = ''; showTestResult('发信测试', [['结果', data.message]]); })
            .catch(function (err) { status.textContent = ''; showTestResult('发信测试失败', [['错误', err.message]], true); });
          return;
        }
        if (btn.dataset.ac === 'save') {
          if (!payload.email) { toast('请填写邮箱地址', 'err'); return; }
          status.textContent = '正在保存…';
          var promise = account.id
            ? api('/api/accounts/' + account.id, { method: 'PUT', body: payload })
            : api('/api/accounts', { method: 'POST', body: payload });
          promise.then(function () {
            closeModal();
            toast('账号已保存', 'ok');
            reload().then(function () {
              if (!account.id) {
                var created = state.boot.accounts[state.boot.accounts.length - 1];
                state.target = { accountId: created.id, folderId: null, kind: 'inbox' };
              }
              if (state.view === 'accounts') renderAccounts();
            });
          }).catch(function (err) { status.textContent = ''; toast(err.message, 'err'); });
        }
      });
    }
  });
}

function showTestResult(title, rows, isError) {
  openModal(modalHeader(title) + '<div class="modal-body">' +
    rows.map(function (row) {
      return '<div class="field"><label>' + esc(row[0]) + '</label><div' +
        (isError ? ' style="color:#e5484d"' : '') + '>' + esc(row[1]) + '</div></div>';
    }).join('') + '</div>');
}

function collectAccountForm(id) {
  var payload = {
    name: $('#acName').value.trim(),
    email: $('#acEmail').value.trim(),
    display_name: $('#acDisplayName').value.trim(),
    protocol: $('#acProtocol').value,
    in_host: $('#acInHost').value.trim(),
    in_port: Number($('#acInPort').value || 0),
    in_security: $('#acInSecurity').value,
    in_user: $('#acInUser').value.trim(),
    in_allow_insecure: $('#acInsecure').checked,
    pop3_keep_server: $('#acKeep').checked,
    imap_sync_all: $('#acSyncAll').checked,
    out_host: $('#acOutHost').value.trim(),
    out_port: Number($('#acOutPort').value || 0),
    out_security: $('#acOutSecurity').value,
    out_user: $('#acOutUser').value.trim(),
    out_use_in_auth: $('#acUseIn').checked,
    save_sent_to_server: $('#acSaveSent').checked,
    sync_enabled: $('#acSyncEnabled').checked,
    sync_interval: Number($('#acInterval').value || 300),
    signature: $('#acSignature').value
  };
  if (id) payload.id = id;
  var inPassword = $('#acInPassword').value;
  var outPassword = $('#acOutPassword').value;
  if (inPassword) payload.in_password = inPassword;
  if (outPassword) payload.out_password = outPassword;
  return payload;
}

/* ===================================================================== 日志 */

function renderLogs() {
  var pane = $('#listPane');
  pane.innerHTML = '<div class="panel"><div class="panel-head"><h2>运行日志</h2>' +
    '<div class="spacer"></div><button class="btn small" data-act="log-refresh">刷新</button></div>' +
    '<div id="logBody" class="card" style="padding:0;overflow:auto;max-height:calc(100vh - 150px)">正在加载…</div></div>';
  loadLogs();
}

function loadLogs() {
  var body = $('#logBody');
  if (!body) return;
  api('/api/logs', { params: { limit: 300 } }).then(function (data) {
    if (!data.logs.length) { body.innerHTML = '<div class="empty">暂无日志</div>'; return; }
    body.innerHTML = '<table class="simple"><thead><tr><th class="nowrap">时间</th><th>级别</th><th>来源</th><th>内容</th></tr></thead><tbody>' +
      data.logs.map(function (log) {
        return '<tr><td class="nowrap">' + esc(fmtFull(log.ts)) + '</td>' +
          '<td><span class="log-level ' + esc(log.level) + '">' + esc(log.level) + '</span></td>' +
          '<td class="nowrap">' + esc(log.source) + '</td>' +
          '<td>' + esc(log.message) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }).catch(function (err) { body.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>'; });
}

/* ===================================================================== 工具 */

function renderTools() {
  var pane = $('#listPane');
  pane.innerHTML = '<div class="panel"><div class="panel-head"><h2>工具</h2></div>' +
    '<div class="grid-2">' +
    '  <div class="card">' +
    '    <div class="card-title">端口冲突检测</div>' +
    '    <div class="hint">在修改应用端口前先检测是否被占用，可避免部署后服务无法启动。</div>' +
    '    <div class="field-row" style="margin-top:10px">' +
    '      <input id="portInput" type="number" value="' + esc(state.boot.app.port) + '" placeholder="端口号">' +
    '      <button class="btn" data-act="port-check" style="flex:0 0 auto">检测</button>' +
    '      <button class="btn ghost" data-act="port-scan" style="flex:0 0 auto">常用端口扫描</button>' +
    '    </div>' +
    '    <div id="portResult" class="hint" style="margin-top:8px">当前服务端口：' + esc(state.boot.app.port) + '</div>' +
    '  </div>' +
    '  <div class="card">' +
    '    <div class="card-title">修改访问口令</div>' +
    '    <div class="field"><label>原口令</label><input id="pwOld" type="password"></div>' +
    '    <div class="field"><label>新口令（至少 6 位）</label><input id="pwNew" type="password"></div>' +
    '    <div class="field"><label>确认新口令</label><input id="pwConfirm" type="password"></div>' +
    '    <button class="btn primary" data-act="change-password">修改口令</button>' +
    '    <div class="hint" style="margin-top:6px">修改后所有已登录的会话会立即失效，需要重新登录。</div>' +
    '  </div>' +
    '  <div class="card">' +
    '    <div class="card-title">运行环境</div>' +
    '    <div id="envBox" class="hint">正在读取…</div>' +
    '  </div>' +
    '  <div class="card">' +
    '    <div class="card-title">访问方式</div>' +
    '    <div class="hint">本服务同时提供两种访问方式，二者数据完全一致：</div>' +
    '    <div class="field" style="margin-top:8px"><label>飞牛桌面窗口</label><div>在飞牛 OS 桌面双击「肥牛邮箱」图标</div></div>' +
    '    <div class="field"><label>浏览器直连</label><div>http://&lt;NAS 的 IP&gt;:' + esc(state.boot.app.port) + '</div></div>' +
    '    <div class="hint">端口可在「应用中心 → 已安装 → 肥牛邮箱 → 设置」中修改，保存后服务会自动重启。</div>' +
    '  </div>' +
    '</div></div>';
  api('/api/env').then(function (data) {
    var box = $('#envBox');
    if (!box) return;
    box.innerHTML = '<table class="simple">' + [
      ['版本', data.app.name + ' ' + data.app.version],
      ['Python', data.python],
      ['服务端口', data.app.port],
      ['数据目录', data.data_dir],
      ['邮件归档目录', data.mailbox_dir],
      ['索引数据库', data.db_path],
      ['前端目录', data.www_dir],
      ['启动时间', fmtFull(data.started)]
    ].map(function (row) {
      return '<tr><th style="width:110px;position:static">' + esc(row[0]) + '</th><td>' + esc(row[1]) + '</td></tr>';
    }).join('') + '</table>';
  }).catch(function () { });
}

function onToolsClick(event) {
  var target = event.target;
  if (target.closest('[data-act="port-check"]')) { runPortCheck(Number($('#portInput').value)); return; }
  if (target.closest('[data-act="port-scan"]')) {
    var ports = [7300, 7301, 7302, 8080, 8081, 8888, 9090, 3000, 5000, 8000];
    Promise.all(ports.map(function (p) { return api('/api/port-check', { params: { port: p } }); }))
      .then(function (results) {
        $('#portResult').innerHTML = results.map(function (r) {
          return '<div><span class="tag ' + (r.free ? 'ok' : (r.is_current ? '' : 'danger')) + '">' +
            (r.free ? '可用' : (r.is_current ? '本应用占用' : '已占用')) + '</span> ' + esc(r.message) + '</div>';
        }).join('');
      }).catch(function (err) { toast(err.message, 'err'); });
    return;
  }
  if (target.closest('[data-act="change-password"]')) {
    var oldPw = $('#pwOld').value, newPw = $('#pwNew').value, confirmPw = $('#pwConfirm').value;
    if (newPw.length < 6) { toast('新口令至少 6 位', 'err'); return; }
    if (newPw !== confirmPw) { toast('两次输入的新口令不一致', 'err'); return; }
    api('/api/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } }).then(function (data) {
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      toast('口令已修改', 'ok');
      $('#pwOld').value = $('#pwNew').value = $('#pwConfirm').value = '';
    }).catch(function (err) { toast(err.message, 'err'); });
  }
}

function runPortCheck(port) {
  if (!port) { toast('请输入端口号', 'err'); return; }
  api('/api/port-check', { params: { port: port } }).then(function (data) {
    $('#portResult').innerHTML = '<span class="tag ' + (data.free ? 'ok' : (data.is_current ? '' : 'danger')) + '">' +
      (data.free ? '可用' : (data.is_current ? '本应用占用' : '已被占用')) + '</span> ' + esc(data.message);
  }).catch(function (err) { toast(err.message, 'err'); });
}

/* ===================================================================== 通用弹窗 */

function confirmBox(title, message, onOk) {
  openModal(modalHeader(title) + '<div class="modal-body">' + esc(message) + '</div>' +
    '<div class="modal-foot"><button class="btn danger" data-confirm="ok">确定</button>' +
    '<div class="spacer"></div><button class="btn ghost" data-act="close-modal">取消</button></div>', {
    onMount: function (wrapper) {
      wrapper.addEventListener('click', function (event) {
        if (event.target.closest('[data-confirm="ok"]')) { closeModal(); onOk(); }
      });
    }
  });
}

function promptNewFolder() {
  if (state.target.accountId === null) { toast('请先选择一个账号', 'err'); return; }
  openModal(modalHeader('新建文件夹') + '<div class="modal-body">' +
    '<div class="field"><label>文件夹名称</label><input id="nfName" type="text" placeholder="例如：项目邮件"></div>' +
    '</div><div class="modal-foot"><button class="btn primary" data-nf="ok">创建</button>' +
    '<div class="spacer"></div><button class="btn ghost" data-act="close-modal">取消</button></div>', {
    onMount: function (wrapper) {
      wrapper.addEventListener('click', function (event) {
        if (!event.target.closest('[data-nf="ok"]')) return;
        var name = $('#nfName').value.trim();
        if (!name) { toast('请输入文件夹名称', 'err'); return; }
        api('/api/folders', { method: 'POST', body: { account_id: state.target.accountId, name: name } })
          .then(function () { closeModal(); toast('已创建', 'ok'); reload().catch(function () { }); })
          .catch(function (err) { toast(err.message, 'err'); });
      });
    }
  });
}

/* ===================================================================== 全局绑定 */

function bindEvents() {
  $('#splashForm').addEventListener('submit', submitSplash);
  $('#sidebar').addEventListener('click', onSidebarClick);
  $('#listPane').addEventListener('click', function (event) {
    if (state.view === 'mail') onListPaneClick(event);
    else if (state.view === 'contacts') onContactsClick(event);
    else if (state.view === 'accounts') onAccountsClick(event);
    else if (state.view === 'logs') {
      if (event.target.closest('[data-act="log-refresh"]')) loadLogs();
    } else if (state.view === 'tools') onToolsClick(event);
  });
  $('#listPane').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.id === 'searchInput') { event.preventDefault(); doSearch(); }
    if (event.key === 'Enter' && event.target.id === 'contactSearch') { event.preventDefault(); state.contactQuery = event.target.value.trim(); loadContacts(); }
  });
  $('#listPane').addEventListener('change', function (event) {
    if (event.target.id === 'contactGroup') loadContacts();
    if (event.target.id === 'contactFile') importContactsFile(event.target.files[0]);
  });
  $('#readPane').addEventListener('click', onReaderClick);
  $$('.view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setView(btn.dataset.view); });
  });
  $('#btnCompose').addEventListener('click', function () { openCompose({}); });
  $('#btnOpenExternal').addEventListener('click', openExternal);
  $('#btnLogout').addEventListener('click', doLogout);
  $('#btnSyncAll').addEventListener('click', function () {
    syncCurrent();
    if (state.view === 'accounts') setTimeout(function () { reload().then(renderAccounts); }, 1200);
  });
  $('#modalRoot').addEventListener('click', function (event) {
    if (event.target.closest('[data-act="close-modal"]')) closeModal();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !$('#modalRoot').classList.contains('hidden')) closeModal();
  });
}

/* ===================================================================== 启动 */

function boot() {
  bindEvents();
  api('/api/session').then(function (session) {
    $('#splashVersion').textContent = session.app.name + ' ' + session.app.version;
    if (session.authenticated) {
      enterApp().catch(function (err) {
        showSplash('login', err.message);
      });
      return;
    }
    if (session.setup_required) showSplash('setup', '');
    else showSplash('login', '');
  }).catch(function (err) {
    showSplash('login', '无法连接到 FeiniuMail 服务：' + err.message);
  });
}

document.addEventListener('DOMContentLoaded', boot);
