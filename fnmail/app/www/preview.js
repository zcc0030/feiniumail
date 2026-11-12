/* 肥牛邮箱（FeiniuMail）· 附件在线预览
 *
 * 渲染全部在浏览器里完成，不经过 NAS 上的 Office / PDF 应用，也不需要服务端转换：
 *   PDF         pdf.js
 *   图片 / 文本  浏览器原生
 *   doc / docx  @file-viewer/doc、@file-viewer/docx
 *   xls / xlsx  SheetJS
 *   ppt / pptx  @file-viewer/ppt、@file-viewer/pptx
 * 各引擎体积不小，第一次预览某类型时才按需下载对应文件。
 */
(function () {
  'use strict';

  var VENDOR = '/vendor/';

  var GROUPS = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'svg', 'ico'],
    pdf: ['pdf'],
    text: ['txt', 'log', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf',
      'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
      'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'sql', 'sh', 'bash', 'bat', 'ps1', 'vue', 'ts',
      'tsx', 'jsx', 'diff', 'patch', 'tex', 'toml', 'properties'],
    doc: ['doc', 'dot'],
    docx: ['docx', 'docm', 'dotx', 'dotm'],
    sheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xlt', 'xltm', 'ods', 'fods', 'csv', 'tsv'],
    ppt: ['ppt', 'pot'],
    pptx: ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'pps']
  };

  /* pdf.js 一次渲染全部页面会很慢，超过这个页数只渲染前面的部分。 */
  var PDF_MAX_PAGES = 60;
  /* 表格与文本的展示上限，避免超大附件把页面卡死。 */
  var SHEET_MAX_ROWS = 400;
  var SHEET_MAX_COLS = 40;
  var TEXT_MAX_BYTES = 512 * 1024;

  var KIND_BY_EXT = (function () {
    var map = {};
    Object.keys(GROUPS).forEach(function (kind) {
      GROUPS[kind].forEach(function (ext) { map[ext] = kind; });
    });
    return map;
  })();

  /* ================================================================= 通用工具 */

  function kindOf(name) {
    var text = String(name || '');
    var dot = text.lastIndexOf('.');
    return dot < 0 ? '' : (KIND_BY_EXT[text.slice(dot + 1).toLowerCase()] || '');
  }

  function canPreview(name) { return !!kindOf(name); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setContent(host, nodes) {
    while (host.firstChild) host.removeChild(host.firstChild);
    (nodes || []).forEach(function (node) { host.appendChild(node); });
  }

  var scriptCache = {};
  function loadScript(url) {
    if (!scriptCache[url]) {
      scriptCache[url] = new Promise(function (resolve, reject) {
        var node = document.createElement('script');
        node.src = url;
        node.onload = function () { resolve(); };
        node.onerror = function () {
          delete scriptCache[url];
          reject(new Error('加载预览组件失败：' + url));
        };
        document.head.appendChild(node);
      });
    }
    return scriptCache[url];
  }

  var moduleCache = {};
  function loadModule(url) {
    if (!moduleCache[url]) {
      moduleCache[url] = import(url).catch(function (err) {
        delete moduleCache[url];
        throw err;
      });
    }
    return moduleCache[url];
  }

  function fetchBuffer(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) throw new Error('读取附件失败（HTTP ' + resp.status + '）');
      return resp.arrayBuffer();
    });
  }

  /* ================================================================= 各类型渲染 */

  function renderImage(stage, url) {
    var img = el('img', 'preview-image');
    img.alt = '';
    img.src = url;
    setContent(stage, [img]);
  }

  function renderText(stage, url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) throw new Error('读取附件失败（HTTP ' + resp.status + '）');
      return resp.text();
    }).then(function (text) {
      var truncated = text.length > TEXT_MAX_BYTES;
      setContent(stage, [el('pre', 'preview-text',
        truncated ? (text.slice(0, TEXT_MAX_BYTES) + '\n\n…（内容过长，只显示前 512 KB，完整内容请下载）') : text)]);
    });
  }

  function renderPdf(stage, url, ctx) {
    return Promise.all([loadModule(VENDOR + 'pdf.min.mjs'), fetchBuffer(url)]).then(function (loaded) {
      var pdfjs = loaded[0];
      pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
      return pdfjs.getDocument({ data: new Uint8Array(loaded[1]) }).promise;
    }).then(function (doc) {
      ctx.cleanup(function () { try { doc.destroy(); } catch (e) { /* 忽略 */ } });
      var total = doc.numPages;
      var count = Math.min(total, PDF_MAX_PAGES);
      if (count < total) ctx.note('共 ' + total + ' 页，只预览前 ' + PDF_MAX_PAGES + ' 页。');
      var pages = el('div', 'preview-pdf');
      setContent(stage, [pages]);
      var width = stage.clientWidth || 900;
      var chain = Promise.resolve();
      for (var index = 1; index <= count; index += 1) {
        chain = chain.then(makePdfPage(doc, index, pages, width));
      }
      return chain;
    });
  }

  function makePdfPage(doc, number, host, hostWidth) {
    return function () {
      return doc.getPage(number).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        // 把页面缩放到预览区宽度，最多放大到 2 倍，避免小页被拉糊。
        var scale = Math.min(Math.max(hostWidth - 24, 320) / base.width, 2);
        var viewport = page.getViewport({ scale: scale });
        var canvas = el('canvas', 'preview-pdf-page');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        var holder = el('div', 'preview-pdf-holder');
        holder.appendChild(canvas);
        host.appendChild(holder);
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      });
    };
  }

  function renderDoc(stage, url) {
    return Promise.all([loadModule(VENDOR + 'fv-doc/index.js'), fetchBuffer(url)]).then(function (loaded) {
      var holder = el('div', 'preview-doc');
      setContent(stage, [holder]);
      // createMsDocViewer 内部用 DOMPurify 清洗生成的 HTML，再挂载到容器里。
      return loaded[0].createMsDocViewer(holder).load(loaded[1]);
    });
  }

  function renderDocx(stage, url) {
    return Promise.all([loadScript(VENDOR + 'jszip.min.js'), fetchBuffer(url)]).then(function (loaded) {
      return loadScript(VENDOR + 'docx-preview.min.js').then(function () { return loaded[1]; });
    }).then(function (buffer) {
      var lib = window.docx;
      if (!lib || typeof lib.renderAsync !== 'function') throw new Error('docx 预览组件不可用');
      var holder = el('div', 'preview-docx');
      setContent(stage, [holder]);
      return lib.renderAsync(new Blob([buffer]), holder, holder, {
        inWrapper: true,
        breakPages: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreLastRenderedPageBreak: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true
      });
    });
  }

  function renderSheet(stage, url, ctx) {
    return Promise.all([loadScript(VENDOR + 'xlsx.full.min.js'), fetchBuffer(url)]).then(function (loaded) {
      var XLSX = window.XLSX;
      if (!XLSX || typeof XLSX.read !== 'function') throw new Error('表格预览组件不可用');
      var book = XLSX.read(new Uint8Array(loaded[1]), { type: 'array' });
      var names = book.SheetNames || [];
      if (!names.length) throw new Error('这个表格里没有工作表');
      var tabs = el('div', 'preview-tabs');
      var pane = el('div', 'preview-sheet');
      setContent(stage, [tabs, pane]);
      var truncated = false;
      function show(index) {
        Array.prototype.forEach.call(tabs.children, function (node, position) {
          node.classList.toggle('is-active', position === index);
        });
        var rows = XLSX.utils.sheet_to_json(book.Sheets[names[index]], {
          header: 1, raw: false, defval: '', blankrows: false
        });
        if (rows.length > SHEET_MAX_ROWS) truncated = true;
        var width = 0;
        rows.slice(0, SHEET_MAX_ROWS).forEach(function (row) {
          if (row.length > width) width = row.length;
        });
        width = Math.min(width, SHEET_MAX_COLS);
        var table = el('table', 'preview-table');
        var body = el('tbody');
        rows.slice(0, SHEET_MAX_ROWS).forEach(function (row) {
          var tr = el('tr');
          for (var col = 0; col < width; col += 1) {
            var value = row[col];
            var cell = el(col === 0 ? 'th' : 'td', null,
              value === undefined || value === null ? '' : String(value));
            tr.appendChild(cell);
          }
          body.appendChild(tr);
        });
        table.appendChild(body);
        setContent(pane, [table]);
        if (truncated) ctx.note('表格较大，只显示前 ' + SHEET_MAX_ROWS + ' 行、' + SHEET_MAX_COLS + ' 列。');
      }
      // 所有工作表都做成标签页，默认展示第一张。
      names.forEach(function (sheetName, index) {
        var tab = el('button', 'preview-tab', sheetName);
        tab.type = 'button';
        tab.addEventListener('click', function () { show(index); });
        tabs.appendChild(tab);
      });
      show(0);
      if (names.length > 1) tabs.classList.add('is-multi');
    });
  }

  function renderPpt(stage, url, ctx) {
    return Promise.all([loadScript(VENDOR + 'pptjs.browser.js'), fetchBuffer(url)]).then(function (loaded) {
      var pptjs = window.PptJs;
      if (!pptjs || typeof pptjs.parsePpt !== 'function') throw new Error('PPT 预览组件不可用');
      var doc = pptjs.parsePpt(new Uint8Array(loaded[1]));
      var total = (doc && doc.slides && doc.slides.length) ||
        (doc && doc.metadata && doc.metadata.slideCount) || 0;
      if (!total) throw new Error('这个演示文稿里没有可预览的幻灯片');

      var assetUrls = [];
      var holder = el('div', 'preview-ppt');
      var styleHost = el('style');
      setContent(stage, [holder]);
      ctx.cleanup(function () {
        assetUrls.forEach(function (assetUrl) { URL.revokeObjectURL(assetUrl); });
      });

      var current = -1;
      function show(index) {
        current = Math.max(0, Math.min(index, total - 1));
        var result = pptjs.renderSlide(doc, current, {
          assetUrl: function (asset) {
            if (!asset || !asset.bytes) return undefined;
            var assetUrl = URL.createObjectURL(new Blob([asset.bytes], {
              type: asset.mimeType || 'application/octet-stream'
            }));
            assetUrls.push(assetUrl);
            return assetUrl;
          }
        });
        if (result && result.css) styleHost.textContent = result.css;
        var slide = el('div', 'preview-ppt-slide');
        slide.innerHTML = result && result.html ? result.html : '<p>这一页无法渲染</p>';
        setContent(holder, [styleHost, slide]);
        ctx.step.show(current + 1, total);
      }

      ctx.step = makeStepToolbar(ctx.tools, show);
      show(0);
    });
  }

  function renderPptx(stage, url, ctx) {
    return Promise.all([loadModule(VENDOR + 'fv-pptx/index.js'), fetchBuffer(url)]).then(function (loaded) {
      var lib = loaded[0];
      if (!lib || !lib.PptxViewer) throw new Error('PPTX 预览组件不可用');
      var holder = el('div', 'preview-pptx');
      setContent(stage, [holder]);
      var opened = lib.PptxViewer.open(loaded[1], holder, {
        fitMode: 'contain',
        workerUrl: VENDOR + 'fv-pptx/worker/pptx.worker.js'
      });
      ctx.cleanup(function () {
        opened.then(function (viewer) {
          try { viewer.destroy(); } catch (e) { /* 忽略 */ }
        }).catch(function () { /* 忽略 */ });
      });
      return opened;
    });
  }

  /* 翻页工具条：只有 PPT（.ppt）需要，pptx 引擎自带滚动与全屏演示。 */
  function makeStepToolbar(tools, show) {
    var bar = el('div', 'preview-steps');
    var prev = el('button', 'btn small', '上一页');
    var next = el('button', 'btn small', '下一页');
    var label = el('span', 'muted');
    prev.type = 'button';
    next.type = 'button';
    prev.addEventListener('click', function () { show(currentIndex() - 1); });
    next.addEventListener('click', function () { show(currentIndex() + 1); });
    var index = 0, count = 1;
    function currentIndex() { return index - 1; }
    bar.appendChild(prev);
    bar.appendChild(next);
    bar.appendChild(label);
    tools.appendChild(bar);
    return {
      show: function (position, total) {
        index = position;
        count = total;
        prev.disabled = index <= 1;
        next.disabled = index >= count;
        label.textContent = '第 ' + index + ' / ' + count + ' 页';
      }
    };
  }

  /* ================================================================= 预览弹层 */

  var RENDERERS = {
    image: renderImage,
    pdf: renderPdf,
    text: renderText,
    doc: renderDoc,
    docx: renderDocx,
    sheet: renderSheet,
    ppt: renderPpt,
    pptx: renderPptx
  };

  function openPreview(info) {
    var name = info.name || '附件';
    var kind = kindOf(name);
    if (!kind) { toast('这种格式暂时没法在线预览，请下载或用 NAS 默认应用打开'); return; }

    var cleanups = [];
    var wrapper = openModal(
      modalHeader('预览：' + name) +
      '<div class="preview-toolbar"></div>' +
      '<div class="preview-stage"><div class="preview-status">正在准备预览…</div></div>' +
      '<div class="modal-foot"><span class="preview-note muted"></span><div class="spacer"></div>' +
      '<a class="btn ghost" href="' + esc(info.downloadUrl) + '">下载</a>' +
      '<button class="btn ghost" data-act="close-modal">关闭</button></div>',
      {
        wide: true,
        cls: 'preview',
        onClose: function () {
          cleanups.splice(0).forEach(function (fn) {
            try { fn(); } catch (e) { /* 忽略 */ }
          });
        }
      }
    );

    var stage = wrapper.querySelector('.preview-stage');
    var ctx = {
      tools: wrapper.querySelector('.preview-toolbar'),
      note: function (text) { wrapper.querySelector('.preview-note').textContent = text; },
      cleanup: function (fn) { cleanups.push(fn); },
      step: null
    };

    Promise.resolve()
      .then(function () { return RENDERERS[kind](stage, info.url, ctx); })
      .then(function () {
        if (!stage.firstChild) setContent(stage, [el('div', 'preview-status', '没有可显示的内容。')]);
      })
      .catch(function (err) {
        var box = el('div', 'preview-status err');
        box.appendChild(el('p', null, '预览失败：' + ((err && err.message) || err)));
        box.appendChild(el('p', 'muted', '可以改用「用 NAS 默认应用打开」或直接下载后用本地软件查看。'));
        setContent(stage, [box]);
      });
  }

  window.FnmailPreview = {
    canPreview: canPreview,
    kindOf: kindOf,
    open: openPreview
  };
})();
