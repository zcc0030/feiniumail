/* 肥牛邮箱（FeiniuMail）· 在线预览打包入口
 *
 * 把 Flyfish File Viewer（@file-viewer/* 3.3.3）的 core、web 组件与八个渲染器
 * 打成一个 IIFE，挂到 window.FnmailFileViewer 上，供 /preview.js 调用。
 *
 * 各 renderer 包只导出 renderer 对象、不会自注册（只有 preset-* 包才会），因此这里
 * 取出需要的八个渲染器，用一个自建的自动预设注册进全局 registry，viewer 挂载时会
 * 自动装配；运行时资源（pdf worker / cmaps / 字体、xlsx、docx、pptx 的 worker）由
 * www/file-viewer/vendor/** 提供，基址在下面统一指定。
 */
import { defineFileViewerElement, mountViewer } from '@file-viewer/web';
import { registerFileViewerAutoRendererPreset } from '@file-viewer/core';
import { setDefaultFileViewerAssetBaseUrl } from '@file-viewer/core/assets';
import { pdfRenderer } from '@file-viewer/renderer-pdf';
import { wordRenderer } from '@file-viewer/renderer-word';
import { spreadsheetRenderer } from '@file-viewer/renderer-spreadsheet';
import { pptxRenderer } from '@file-viewer/renderer-pptx';
import { pptRenderer } from '@file-viewer/renderer-ppt';
import { imageRenderer } from '@file-viewer/renderer-image';
import { textRenderer } from '@file-viewer/renderer-text';
import { mediaRenderer } from '@file-viewer/renderer-media';

/* 按格式挑出的八个渲染器：PDF、Word（doc/docx/rtf/odt）、表格
   （xls/xlsx/ods/csv）、新版 pptx、老 .ppt、图片、文本与代码、音视频。
   注册为自动预设后，preview.js 调用 mountViewer 时无需再传 renderers。 */
const renderers = [
  pdfRenderer,
  wordRenderer,
  spreadsheetRenderer,
  pptxRenderer,
  pptRenderer,
  imageRenderer,
  textRenderer,
  mediaRenderer
];
registerFileViewerAutoRendererPreset(
  { id: 'fnmail-preview', label: '肥牛邮箱内嵌预览渲染器', renderers },
  { id: 'fnmail-preview', packageName: 'fnmail-viewer' }
);

/* 引擎本体与它依赖的运行时资源都只在版本发布时变化，文件名却固定不变，必须靠版本号
   换 URL 才能让升级后的浏览器取到新文件（否则会一直用旧缓存）。版本号从引入本脚本的
   <script src="…/flyfish-viewer.iife.js?v=1.0.31"> 上读，无需在打包时注入。 */
const BASE = '/file-viewer/';
setDefaultFileViewerAssetBaseUrl(BASE);
const VERSION = (() => {
  const src = document.currentScript && document.currentScript.src;
  if (!src) return '';
  try {
    return new URL(src, location.href).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
})();
const A = (p) => BASE + p;
/* 版本号只加在「具体文件」地址上。cmaps、标准字体这类是目录地址，引擎会在其后自行拼接
   文件名，加查询串会把拼出来的 URL 弄坏；它们本身也几乎不变，按路径缓存即可。 */
const AF = (p) => (VERSION ? A(p) + (p.indexOf('?') >= 0 ? '&' : '?') + 'v=' + VERSION : A(p));
/* docx 渲染器会给 worker / jszip 的 URL 打上运行时版本号，显式传入时需自己带上。 */
const docxVer = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + 'file-viewer-docx=0.3.39';
const assetOptions = {
  pdf: {
    workerUrl: AF('vendor/pdf/pdf.worker.mjs'),
    cMapUrl: A('vendor/pdf/cmaps/'),
    wasmUrl: A('vendor/pdf/wasm/'),
    standardFontDataUrl: A('vendor/pdf/standard_fonts/'),
    cjkFontFallbackPath: A('vendor/pdf/fonts/')
  },
  docx: {
    workerUrl: docxVer(AF('vendor/docx/docx.worker.js')),
    workerJsZipUrl: docxVer(AF('vendor/docx/jszip.min.js'))
  },
  spreadsheet: { workerUrl: AF('vendor/xlsx/sheet.worker.js') },
  presentation: {
    workerUrl: AF('vendor/pptx/pptx.worker.js'),
    /* 老 .ppt 的解析 Worker 走独立文件：IIFE 下 import.meta.url 不可用，
       必须显式给 URL，否则 PptWorkerClient 无法定位 pptjs.worker.js。 */
    pptWorkerUrl: AF('vendor/ppt/pptjs.worker.js')
  }
};
defineFileViewerElement();
window.FnmailFileViewer = { mountViewer, defineFileViewerElement, setDefaultFileViewerAssetBaseUrl, assetOptions };
