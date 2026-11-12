/* 肥牛邮箱（FeiniuMail）· 附件在线预览
 *
 * 渲染统一交给 Flyfish File Viewer（@file-viewer/* 3.3.3，打包产物在
 * /file-viewer/flyfish-viewer.iife.js）：它按扩展名分派到 PDF / 图片 / 文本 /
 * Word / Excel / PowerPoint 各自的渲染器，全部在浏览器本地完成，不经过 NAS 上的
 * Office / PDF 应用，也不做服务端转换。
 * 本文件只负责判断格式能否预览、开预览弹层、把舞台交给 viewer，并在关闭时
 * 释放它占用的 Worker 与 Blob。
 */
(function () {
  'use strict';

  /* 能被 viewer 接管的扩展名，与 file-viewer 的渲染器定义保持一致。
     未命中的格式不提供「在线预览」，仍可「下载」或「用 NAS 默认应用打开」。 */
  var GROUPS = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'svg', 'ico'],
    pdf: ['pdf'],
    text: ['txt', 'log', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'ini',
      'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
      'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'sql', 'sh', 'bash', 'vue', 'ts',
      'tsx', 'jsx', 'diff', 'patch', 'tex', 'toml'],
    doc: ['doc', 'dot'],
    docx: ['docx', 'docm', 'dotx', 'dotm'],
    sheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xlt', 'xltm', 'ods', 'fods', 'csv', 'tsv'],
    ppt: ['ppt', 'pot'],
    pptx: ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm']
  };

  var KIND_BY_EXT = (function () {
    var map = {};
    Object.keys(GROUPS).forEach(function (kind) {
      GROUPS[kind].forEach(function (ext) { map[ext] = kind; });
    });
    return map;
  })();

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

  /* viewer 自带悬浮工具栏（缩放 / 查找 / 打印 / 主题）。关掉「下载」是因为
     弹层底部已有下载按钮（走原始附件地址，文件名更可靠），关掉「导出 HTML」
     是因为它面向开发者，关掉「主题」是因为本应用只有浅色一套配色。 */
  var TOOLBAR = {
    download: false,
    exportHtml: false,
    theme: false,
    print: true,
    zoom: true,
    search: true
  };

  function openPreview(info) {
    var name = info.name || '附件';
    if (!canPreview(name)) {
      toast('这种格式暂时没法在线预览，请下载或用 NAS 默认应用打开');
      return;
    }

    var api = window.FnmailFileViewer;
    var viewer = null;
    var wrapper = openModal(
      modalHeader('预览：' + name) +
      '<div class="preview-stage"></div>' +
      '<div class="modal-foot"><div class="spacer"></div>' +
      '<a class="btn ghost" href="' + esc(info.downloadUrl) + '">下载</a>' +
      '<button class="btn ghost" data-act="close-modal">关闭</button></div>',
      {
        wide: true,
        cls: 'preview',
        onClose: function () {
          if (!viewer) return;
          try { viewer.destroy(); } catch (e) { /* 忽略 */ }
          viewer = null;
        }
      }
    );

    var stage = wrapper.querySelector('.preview-stage');
    if (!api || typeof api.mountViewer !== 'function') {
      stage.appendChild(el('div', 'preview-status err',
        '预览组件没有加载成功，请刷新页面后重试，或下载后用本地软件查看。'));
      return;
    }

    try {
      viewer = api.mountViewer(stage, {
        url: info.url,
        filename: name,
        options: Object.assign({
          theme: 'light',
          toolbar: TOOLBAR
        }, api.assetOptions)
      });
    } catch (err) {
      stage.appendChild(el('div', 'preview-status err',
        '预览失败：' + ((err && err.message) || err) +
        '。可以改用「用 NAS 默认应用打开」或下载后用本地软件查看。'));
    }
  }

  window.FnmailPreview = {
    canPreview: canPreview,
    kindOf: kindOf,
    open: openPreview
  };
})();
