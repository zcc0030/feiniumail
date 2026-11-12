import { isResolvedPptxWorkerLocation } from "./worker-location.js";
const viteOptimizedWorkerPathPattern = /\/\.?vite\/deps\/worker\/pptx\.worker\.js$/;
const viteSourceWorkerModulePattern = /\/src\/worker\.[cm]?[jt]s$/;
const angularCachePath = '/.angular/cache/';
const viteOptimizedPptxSourcePattern = /\/\/\s+(node_modules\/(?:\.pnpm\/[^\n]+?\/node_modules\/)?@file-viewer\/pptx\/dist\/worker\.js)\b/;
const resolveBundledPptxWorkerUrl = () => {
    const moduleUrl = new URL(import.meta.url);
    if (viteSourceWorkerModulePattern.test(moduleUrl.pathname)) {
        return new URL('../dist/worker/pptx.worker.js', moduleUrl);
    }
    return new URL('./worker/pptx.worker.js', import.meta.url);
};
const resolveAngularVitePptxWorkerUrl = (baseUrl, workerPath) => {
    const cacheIndex = baseUrl.pathname.indexOf(angularCachePath);
    if (cacheIndex < 0) {
        return null;
    }
    const workerUrl = new URL(baseUrl.href);
    workerUrl.pathname = `${workerUrl.pathname.slice(0, cacheIndex)}/${workerPath}`;
    workerUrl.search = '';
    workerUrl.hash = '';
    return workerUrl;
};
const resolveViteOptimizedPptxWorkerUrl = (defaultPptxWorkerUrl) => {
    if (typeof XMLHttpRequest === 'undefined') {
        return null;
    }
    try {
        const request = new XMLHttpRequest();
        request.open('GET', import.meta.url, false);
        request.send(null);
        if ((request.status > 0 && request.status < 200) || request.status >= 400) {
            return null;
        }
        const match = viteOptimizedPptxSourcePattern.exec(request.responseText || '');
        if (!match) {
            return null;
        }
        const workerPath = match[1].replace(/dist\/worker\.js$/, 'dist/worker/pptx.worker.js');
        const angularWorkerUrl = resolveAngularVitePptxWorkerUrl(defaultPptxWorkerUrl, workerPath);
        if (angularWorkerUrl) {
            return angularWorkerUrl;
        }
        const origin = typeof location !== 'undefined' && location.origin
            ? location.origin
            : defaultPptxWorkerUrl.origin;
        return `${origin}/${workerPath}`;
    }
    catch {
        return null;
    }
};
const resolvePptxWorkerUrl = (allowDependencyRelativeUrl) => {
    try {
        const moduleUrl = new URL(import.meta.url);
        const workerUrl = resolveBundledPptxWorkerUrl();
        if (isResolvedPptxWorkerLocation(moduleUrl, workerUrl))
            return workerUrl.href;
        if (viteOptimizedWorkerPathPattern.test(workerUrl.pathname)) {
            const optimizedUrl = resolveViteOptimizedPptxWorkerUrl(workerUrl);
            return optimizedUrl ? String(optimizedUrl) : undefined;
        }
        return allowDependencyRelativeUrl ? workerUrl.href : undefined;
    }
    catch {
    }
    return undefined;
};
export const resolvePptxPackageWorkerUrl = () => {
    return resolvePptxWorkerUrl(false);
};
export const createPptxWorker = (options = {}) => {
    var _a;
    if (options.workerFactory) {
        return options.workerFactory();
    }
    if (options.workerUrl) {
        return new Worker(options.workerUrl, {
            type: (_a = options.workerType) !== null && _a !== void 0 ? _a : 'module',
        });
    }
    const workerUrl = resolvePptxWorkerUrl(true);
    if (!workerUrl) {
        throw new Error('PPTX Worker URL is unavailable. Run file-viewer-copy-assets or provide workerUrl.');
    }
    return new Worker(workerUrl, { type: 'module' });
};
