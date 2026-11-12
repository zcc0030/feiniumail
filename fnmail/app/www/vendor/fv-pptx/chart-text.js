import { resolvePptxChartAxes } from "./chart-config.js";
export const mergePptxChartFonts = (...fonts) => Object.assign({}, ...fonts.map(font => Object.fromEntries(Object.entries(font || {}).filter(([, value]) => value !== undefined))));
export const applyPptxChartFont = (style, font) => {
    if (!font)
        return;
    const families = [...new Set([font.family, font.eastAsianFamily, font.complexScriptFamily]
            .filter((value) => typeof value === 'string' && !!value.trim())
            .filter(value => !/^\+(?:mj|mn)-(?:lt|ea|cs)$/.test(value))
            .map(value => /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i.test(value.trim())
            ? value.trim().toLowerCase() : JSON.stringify(value.slice(0, 512))))];
    if (families.length)
        style.fontFamily = [...families, 'sans-serif'].join(',');
    if (typeof font.sizePt === 'number' && Number.isFinite(font.sizePt) && font.sizePt > 0 && font.sizePt <= 4000) {
        style.fontSize = `${font.sizePt * 96 / 72}px`;
    }
    if (font.bold !== undefined)
        style.fontWeight = font.bold ? 'bold' : 'normal';
    if (font.italic !== undefined)
        style.fontStyle = font.italic ? 'italic' : 'normal';
    if (typeof font.color === 'string' && /^(?:#[\da-f]{6}(?:[\da-f]{2})?|transparent)$/i.test(font.color)) {
        style.color = font.color;
        style.fill = font.color;
    }
};
export const stylePptxChartText = (surface, model, chart, legendFont) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const view = (_a = surface.ownerDocument) === null || _a === void 0 ? void 0 : _a.defaultView;
    if (!view || typeof surface.appendChild !== 'function')
        return;
    const scope = `chart-${Math.random().toString(36).slice(2)}`;
    surface.dataset.pptxChartText = scope;
    surface.classList.add('pptx-chart-typed');
    const selector = `.pptx-chart-surface.pptx-chart-typed[data-pptx-chart-text="${scope}"]`;
    const element = surface.ownerDocument.createElement('style');
    element.dataset.pptxChartFonts = '';
    (_b = surface.parentNode) === null || _b === void 0 ? void 0 : _b.appendChild(element);
    const sheet = element.sheet;
    if (!sheet)
        return element;
    const rule = (suffix, font) => {
        if (!font || !Object.values(font).some(value => value !== undefined))
            return;
        const index = sheet.insertRule(suffix.split(',').map(value => `${selector} ${value.trim()}`).join(',') + '{}', sheet.cssRules.length);
        applyPptxChartFont(sheet.cssRules[index].style, font);
    };
    rule('svg', model === null || model === void 0 ? void 0 : model.font);
    rule('.bb-legend-item,.bb-legend-item text', mergePptxChartFonts(model === null || model === void 0 ? void 0 : model.font, legendFont));
    if (!model)
        return element;
    const { category, primary, secondary } = resolvePptxChartAxes(model);
    for (const [axis, font] of [['x', category === null || category === void 0 ? void 0 : category.font], ['y', primary === null || primary === void 0 ? void 0 : primary.font], ['y2', secondary === null || secondary === void 0 ? void 0 : secondary.font]]) {
        rule(`.bb-axis-${axis},.bb-axis-${axis} text`, mergePptxChartFonts(model.font, font));
    }
    let column = 0;
    const escape = (_c = view.CSS) === null || _c === void 0 ? void 0 : _c.escape;
    if (!escape)
        return element;
    for (const group of model.groups)
        for (let index = 0; index < group.series.length; index++, column++) {
            const id = String((_g = (_f = (_e = (_d = chart === null || chart === void 0 ? void 0 : chart.data) === null || _d === void 0 ? void 0 : _d.columns) === null || _e === void 0 ? void 0 : _e[column]) === null || _f === void 0 ? void 0 : _f[0]) !== null && _g !== void 0 ? _g : '');
            if (!id)
                continue;
            const labels = (_j = (_h = group.options.series) === null || _h === void 0 ? void 0 : _h[index]) === null || _j === void 0 ? void 0 : _j.labels;
            const font = mergePptxChartFonts(model.font, (_k = group.options.labels) === null || _k === void 0 ? void 0 : _k.font, labels === null || labels === void 0 ? void 0 : labels.font);
            const texts = `.bb-texts-${escape(id)}`;
            rule(`${texts},${texts} text`, font);
            const points = { ...(_l = group.options.labels) === null || _l === void 0 ? void 0 : _l.points, ...labels === null || labels === void 0 ? void 0 : labels.points };
            for (const [position, point] of Object.entries(points)) {
                if (!/^\d+$/.test(position) || !point.font)
                    continue;
                rule(`${texts} .bb-text-${escape(position)}`, mergePptxChartFonts(font, point.font));
            }
        }
    return element;
};
export const createPptxChartTextPlugin = (surface) => {
    const document = surface.ownerDocument;
    const view = document === null || document === void 0 ? void 0 : document.defaultView;
    if (!view || typeof surface.appendChild !== 'function')
        return undefined;
    let original;
    let wrapped;
    let stopped = false;
    let context;
    const plugin = {
        $$: undefined,
        $beforeInit() {
            const internal = this.$$;
            if (typeof (internal === null || internal === void 0 ? void 0 : internal.getTextRect) !== 'function')
                return;
            original = internal.getTextRect;
            wrapped = (source, className) => {
                var _a, _b, _c, _d, _e;
                const svg = ((_c = (_b = (_a = internal.$el) === null || _a === void 0 ? void 0 : _a.svg) === null || _b === void 0 ? void 0 : _b.node) === null || _c === void 0 ? void 0 : _c.call(_b)) || surface.querySelector('svg');
                if (!svg)
                    return original.call(internal, source, className);
                let base = ((_d = source === null || source === void 0 ? void 0 : source.node) === null || _d === void 0 ? void 0 : _d.call(source)) || source;
                if (!Array.isArray(source) && !/text/i.test((base === null || base === void 0 ? void 0 : base.tagName) || ''))
                    base = (_e = base === null || base === void 0 ? void 0 : base.querySelector) === null || _e === void 0 ? void 0 : _e.call(base, 'text');
                if (!Array.isArray(source) && !base)
                    return original.call(internal, source, className);
                const values = Array.isArray(source) ? source : [base.textContent || ''];
                const rectangles = values.map((value) => {
                    var _a;
                    const text = String(value !== null && value !== void 0 ? value : '');
                    const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    if (className)
                        node.setAttribute('class', className);
                    node.style.visibility = 'hidden';
                    if (base && !Array.isArray(source))
                        node.style.font = view.getComputedStyle(base).font;
                    node.textContent = text;
                    svg.appendChild(node);
                    try {
                        const box = node.getBBox();
                        if (box.height > 0 && (box.width > 0 || !text)) {
                            return { x: box.x, y: box.y, left: box.x, top: box.y, right: box.x + box.width,
                                bottom: box.y + box.height, width: box.width, height: box.height };
                        }
                        const style = view.getComputedStyle(node);
                        context !== null && context !== void 0 ? context : (context = document.createElement('canvas').getContext('2d'));
                        const size = Number.parseFloat(style.fontSize) || 10;
                        if (context)
                            context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                        const metrics = context === null || context === void 0 ? void 0 : context.measureText(text);
                        const width = (_a = metrics === null || metrics === void 0 ? void 0 : metrics.width) !== null && _a !== void 0 ? _a : 0;
                        const height = ((metrics === null || metrics === void 0 ? void 0 : metrics.fontBoundingBoxAscent) || 0) + ((metrics === null || metrics === void 0 ? void 0 : metrics.fontBoundingBoxDescent) || 0) || size * 1.2;
                        return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
                    }
                    finally {
                        node.remove();
                    }
                });
                return rectangles.length > 1 ? rectangles : rectangles[0];
            };
            internal.getTextRect = wrapped;
        },
        $init() { },
        $afterInit() { var _a; (_a = document.fonts) === null || _a === void 0 ? void 0 : _a.addEventListener('loadingdone', refresh); },
        $redraw() { },
        $willDestroy() {
            var _a, _b;
            stopped = true;
            (_a = document.fonts) === null || _a === void 0 ? void 0 : _a.removeEventListener('loadingdone', refresh);
            if (((_b = this.$$) === null || _b === void 0 ? void 0 : _b.getTextRect) === wrapped)
                this.$$.getTextRect = original;
            original = wrapped = context = undefined;
            this.$$ = undefined;
        },
    };
    const refresh = () => { var _a, _b, _c; if (!stopped)
        (_c = (_b = (_a = plugin.$$) === null || _a === void 0 ? void 0 : _a.api) === null || _b === void 0 ? void 0 : _b.flush) === null || _c === void 0 ? void 0 : _c.call(_b); };
    return plugin;
};
