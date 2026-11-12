/* 肥牛邮箱（FeiniuMail）· 在线预览打包入口
 *
 * 把 Flyfish File Viewer（@file-viewer/* 3.3.3）的 core、web 组件与八个渲染器
 * 打成一个 IIFE，挂到 window.FnmailFileViewer 上，供 /preview.js 调用。
 *
 * 八个渲染器通过 import 自注册到全局 registry，所以只需要 import 一次即可；
 * 运行时资源（pdf worker / cmaps / 字体、xlsx、docx、pptx 的 worker）由
 * www/file-viewer/vendor/** 提供，基址在下面统一指定。
 */
import { defineFileViewerElement, mountViewer } from '@file-viewer/web';
import { setDefaultFileViewerAssetBaseUrl } from '@file-viewer/core/assets';
import '@file-viewer/renderer-pdf';
import '@file-viewer/renderer-word';
import '@file-viewer/renderer-spreadsheet';
import '@file-viewer/renderer-pptx';
import '@file-viewer/renderer-ppt';
import '@file-viewer/renderer-image';
import '@file-viewer/renderer-text';
import '@file-viewer/renderer-media';

const BASE = '/file-viewer/';
setDefaultFileViewerAssetBaseUrl(BASE);
const A = (p) => BASE + p;
/* docx 渲染器会给 worker / jszip 的 URL 打上运行时版本号，显式传入时需自己带上。 */
const docxVer = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + 'file-viewer-docx=0.3.39';
const assetOptions = {
  pdf: {
    workerUrl: A('vendor/pdf/pdf.worker.mjs'),
    cMapUrl: A('vendor/pdf/cmaps/'),
    wasmUrl: A('vendor/pdf/wasm/'),
    standardFontDataUrl: A('vendor/pdf/standard_fonts/'),
    cjkFontFallbackPath: A('vendor/pdf/fonts/')
  },
  docx: {
    workerUrl: docxVer(A('vendor/docx/docx.worker.js')),
    workerJsZipUrl: docxVer(A('vendor/docx/jszip.min.js'))
  },
  spreadsheet: { workerUrl: A('vendor/xlsx/sheet.worker.js') },
  presentation: {
    workerUrl: A('vendor/pptx/pptx.worker.js'),
    /* 老 .ppt 的解析 Worker 走独立文件：IIFE 下 import.meta.url 不可用，
       必须显式给 URL，否则 PptWorkerClient 无法定位 pptjs.worker.js。 */
    pptWorkerUrl: A('vendor/ppt/pptjs.worker.js')
  }
};
defineFileViewerElement();
window.FnmailFileViewer = { mountViewer, defineFileViewerElement, setDefaultFileViewerAssetBaseUrl, assetOptions };
