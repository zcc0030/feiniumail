import createDOMPurify from 'dompurify';
import { parseMsDoc } from './msdoc/parser.js';
import { renderMsDoc } from './render/html.js';
const purifierByWindow = new WeakMap();
const trustedTypesPolicyByWindow = new WeakMap();
const getDocumentPurifier = (targetWindow) => {
    const cached = purifierByWindow.get(targetWindow);
    if (cached)
        return cached;
    const purifier = createDOMPurify(targetWindow);
    if (!purifier.isSupported)
        return null;
    purifierByWindow.set(targetWindow, purifier);
    return purifier;
};
const getDocumentTrustedTypesPolicy = (targetWindow) => {
    const cached = trustedTypesPolicyByWindow.get(targetWindow);
    if (cached)
        return cached;
    const trustedTypes = targetWindow.trustedTypes;
    if (!trustedTypes?.createPolicy)
        return null;
    try {
        const policy = trustedTypes.createPolicy('file-viewer-document-sanitizer', {
            createHTML: value => value,
            createScriptURL: value => value,
        });
        trustedTypesPolicyByWindow.set(targetWindow, policy);
        return policy;
    }
    catch {
        return null;
    }
};
export function sanitizeFileViewerDocumentMarkup(html, targetWindow, config) {
    const purifier = getDocumentPurifier(targetWindow);
    if (!purifier)
        return null;
    const policy = getDocumentTrustedTypesPolicy(targetWindow);
    try {
        return purifier.sanitize(html, {
            ...config,
            ...(policy ? { TRUSTED_TYPES_POLICY: policy } : {}),
        });
    }
    catch {
        return null;
    }
}
async function normalizeInput(input) {
    if (input instanceof ArrayBuffer)
        return input;
    if (ArrayBuffer.isView(input)) {
        const bytes = new Uint8Array(input.byteLength);
        bytes.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
        return bytes.buffer;
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        return await input.arrayBuffer();
    }
    if (typeof input === 'string') {
        const response = await fetch(input);
        if (!response.ok)
            throw new Error(`Failed to fetch document: ${response.status}`);
        return await response.arrayBuffer();
    }
    throw new TypeError('Unsupported input type');
}
export function sanitizeMsDocHtml(html, targetWindow) {
    const sanitized = sanitizeFileViewerDocumentMarkup(html, targetWindow, {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'object', 'script', 'style', 'template'],
        FORBID_ATTR: ['action', 'formaction', 'srcdoc'],
    });
    if (sanitized?.nodeType === 11)
        return sanitized;
    const fallback = targetWindow.document.createDocumentFragment();
    fallback.append(targetWindow.document.createTextNode(html));
    return fallback;
}
export function mountMsDoc(container, rendered) {
    if (!container)
        throw new Error('A container element is required');
    const targetWindow = container.ownerDocument.defaultView;
    if (!targetWindow)
        throw new Error('The container must belong to a browser document');
    const style = container.ownerDocument.createElement('style');
    style.dataset.msdoc = '';
    style.textContent = rendered.css;
    const root = container.ownerDocument.createElement('div');
    root.className = 'msdoc-root';
    root.append(sanitizeMsDocHtml(rendered.html, targetWindow));
    container.replaceChildren(style, root);
    return container;
}
export async function parseMsDocToHtml(input, options = {}) {
    const buffer = await normalizeInput(input);
    if (options.workerClient) {
        return options.workerClient.parseToHtml(buffer, {
            parseOptions: options.parseOptions || {},
            renderOptions: options.renderOptions || {},
        });
    }
    const parsed = parseMsDoc(buffer, options.parseOptions || {});
    return renderMsDoc(parsed, options.renderOptions || {});
}
export function createMsDocViewer(container, config = {}) {
    let current = null;
    return {
        async load(input, options = {}) {
            const rendered = await parseMsDocToHtml(input, {
                workerClient: options.workerClient || config.workerClient,
                parseOptions: { ...(config.parseOptions || {}), ...(options.parseOptions || {}) },
                renderOptions: { ...(config.renderOptions || {}), ...(options.renderOptions || {}) },
            });
            mountMsDoc(container, rendered);
            current = rendered;
            return rendered;
        },
        mount(rendered) {
            current = rendered;
            return mountMsDoc(container, rendered);
        },
        clear() {
            container.replaceChildren();
            current = null;
        },
        destroy() {
            this.clear();
        },
        get value() {
            return current;
        },
    };
}
