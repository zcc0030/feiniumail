import { applyPptxChartFont } from "./chart-text.js";
export const createPptxChartLegend = (surface, chart, legend, font) => {
    var _a, _b;
    const document = surface.ownerDocument;
    const view = document === null || document === void 0 ? void 0 : document.defaultView;
    if (!view || (legend === null || legend === void 0 ? void 0 : legend.show) === false || !((legend === null || legend === void 0 ? void 0 : legend.overlay) || ['t', 'tr', 'l'].includes((legend === null || legend === void 0 ? void 0 : legend.position) || '')))
        return;
    const left = (legend === null || legend === void 0 ? void 0 : legend.position) === 'l' || (legend === null || legend === void 0 ? void 0 : legend.position) === 'r';
    const layout = document.createElement('div');
    layout.className = 'pptx-chart-layout';
    layout.style.cssText = `display:flex;flex-direction:${left ? 'row' : 'column'};width:100%;height:100%;min-width:0;min-height:0;position:relative`;
    surface.replaceWith(layout);
    const list = document.createElement('div');
    list.className = 'pptx-chart-legend';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Chart legend');
    list.style.cssText = `display:flex;flex:${left ? '0 1 auto' : '0 0 auto'};flex-direction:${left ? 'column' : 'row'};flex-wrap:${left ? 'nowrap' : 'wrap'};gap:4px 12px;align-items:${left ? 'stretch' : 'center'};justify-content:${(legend === null || legend === void 0 ? void 0 : legend.position) === 'tr' ? 'flex-end' : 'center'};box-sizing:border-box;padding:4px;overflow:auto;${left ? 'max-width:50%' : 'max-height:50%'};font:12px sans-serif`;
    applyPptxChartFont(list.style, font);
    if (legend === null || legend === void 0 ? void 0 : legend.overlay) {
        list.style.position = 'absolute';
        list.style.zIndex = '1';
        list.style[legend.position === 'b' ? 'bottom' : 'top'] = '0';
        list.style[legend.position === 'tr' || legend.position === 'r' ? 'right' : 'left'] = '0';
        if (left)
            list.style.height = '100%';
        else
            list.style.width = '100%';
    }
    surface.style.width = left ? '0' : '100%';
    surface.style.height = left ? '100%' : '0';
    surface.style.alignSelf = 'stretch';
    if (legend === null || legend === void 0 ? void 0 : legend.overlay)
        surface.style.width = surface.style.height = '100%';
    layout.append(list, surface);
    const xs = new Set(Object.values(((_a = chart.data) === null || _a === void 0 ? void 0 : _a.xs) || {}).map(String));
    const entries = (((_b = chart.data) === null || _b === void 0 ? void 0 : _b.columns) || []).filter((column) => !xs.has(String(column[0])))
        .map((column) => {
        var _a, _b, _c;
        const id = String(column[0]);
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', 'true');
        button.style.cssText = 'display:inline-flex;flex:0 0 auto;align-items:center;gap:4px;min-width:0;max-width:100%;border:0;padding:2px;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer';
        const swatch = document.createElement('span');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.cssText = 'display:inline-block;flex:0 0 10px;width:10px;height:10px';
        const text = document.createElement('span');
        text.className = 'pptx-chart-legend-label';
        text.style.cssText = 'min-width:0;overflow-wrap:anywhere';
        text.textContent = String((_c = (_b = (_a = chart.data) === null || _a === void 0 ? void 0 : _a.names) === null || _b === void 0 ? void 0 : _b[id]) !== null && _c !== void 0 ? _c : id) || '\u200b';
        button.append(swatch, text);
        list.append(button);
        return { id, button, swatch };
    });
    chart.legend = { ...chart.legend, show: false };
    let observer;
    let instance;
    let width = 0, height = 0;
    return {
        size() {
            return { width: surface.clientWidth, height: surface.clientHeight };
        },
        bind(api) {
            var _a;
            instance = api;
            for (const { id, button, swatch } of entries) {
                swatch.style.backgroundColor = ((_a = api.color) === null || _a === void 0 ? void 0 : _a.call(api, id)) || 'currentColor';
                button.onclick = () => {
                    var _a;
                    (_a = api.toggle) === null || _a === void 0 ? void 0 : _a.call(api, id);
                    const visible = button.getAttribute('aria-pressed') !== 'true';
                    button.setAttribute('aria-pressed', String(visible));
                    button.style.opacity = visible ? '1' : '.45';
                };
                button.onmouseenter = () => { var _a; return (_a = api.focus) === null || _a === void 0 ? void 0 : _a.call(api, id); };
                button.onmouseleave = () => { var _a; return (_a = api.revert) === null || _a === void 0 ? void 0 : _a.call(api); };
            }
            if (view.ResizeObserver) {
                observer = new view.ResizeObserver(([entry]) => {
                    var _a;
                    const { width: nextWidth, height: nextHeight } = entry.contentRect;
                    if (nextWidth > 0 && nextHeight > 0 && (Math.abs(nextWidth - width) > .5 || Math.abs(nextHeight - height) > .5)) {
                        width = nextWidth;
                        height = nextHeight;
                        (_a = instance === null || instance === void 0 ? void 0 : instance.resize) === null || _a === void 0 ? void 0 : _a.call(instance, { width, height });
                    }
                });
                observer.observe(surface);
            }
        },
        destroy() {
            observer === null || observer === void 0 ? void 0 : observer.disconnect();
            instance = undefined;
            for (const { button } of entries)
                button.onclick = button.onmouseenter = button.onmouseleave = null;
            layout.remove();
        },
    };
};
