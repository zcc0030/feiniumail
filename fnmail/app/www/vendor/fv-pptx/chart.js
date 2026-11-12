import { createPptxCartesianChart } from "./chart-config.js";
import { createPptxChartTextPlugin, mergePptxChartFonts, stylePptxChartText } from "./chart-text.js";
import { createPptxChartLegend } from "./chart-legend.js";
let chartLibraryLoader = null;
let chartRenderer = null;
export const registerPptxChartRenderer = (renderer) => {
    chartRenderer = renderer;
};
export const registerPptxChartLibraryLoader = (loader) => {
    chartLibraryLoader = loader;
};
const asChartQueue = (charts) => {
    return Array.isArray(charts === null || charts === void 0 ? void 0 : charts.MsgQueue) ? charts.MsgQueue : [];
};
export const findPptxChartTarget = (root, chartID) => {
    const rootElement = root;
    if (rootElement.id === chartID) {
        return rootElement;
    }
    return Array.from(root.querySelectorAll('[id]'))
        .find(element => element.id === chartID) || null;
};
const formatEastAsianNumber = (index) => {
    const digits = '零一二三四五六七八九';
    const units = [[1000, '千'], [100, '百'], [10, '十'], [1, '']];
    const group = (value, omitLeadingOne = true) => {
        let label = '';
        let gap = false;
        for (const [place, unit] of units) {
            const digit = Math.floor(value / place);
            value %= place;
            if (digit) {
                if (gap)
                    label += digits[0];
                label += (place === 10 && digit === 1 && !label && omitLeadingOne ? '' : digits[digit]) + unit;
                gap = false;
            }
            else if (label && value)
                gap = true;
        }
        return label;
    };
    if (index < 10000)
        return group(index);
    const remainder = index % 10000;
    return digits[Math.floor(index / 10000)] + '万' +
        (remainder ? (remainder < 1000 ? digits[0] : '') + group(remainder, false) : '');
};
export const getNumericBulletText = (type, index) => {
    if (!Number.isInteger(index) || index < 1 || index > 32767) {
        return String(index);
    }
    if (type === 'ea1JpnChsDbPeriod') {
        return `${formatEastAsianNumber(index)}． `;
    }
    const match = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain)$/.exec(type);
    if (!match) {
        return String(index);
    }
    let label = String(index);
    if (match[1].startsWith('alpha')) {
        label = '';
        for (let remaining = index; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
            label = String.fromCharCode(65 + (remaining - 1) % 26) + label;
        }
    }
    else if (match[1].startsWith('roman')) {
        label = '';
        let remaining = index;
        const digits = [
            [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
            [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
        ];
        for (const [value, symbol] of digits) {
            label += symbol.repeat(Math.floor(remaining / value));
            remaining %= value;
        }
    }
    if (match[1].endsWith('Lc'))
        label = label.toLowerCase();
    switch (match[2]) {
        case 'Period': return `${label}. `;
        case 'ParenR': return `${label}) `;
        case 'ParenBoth': return `(${label}) `;
        default: return label;
    }
};
const restoreNumericBullets = (root) => {
    const scopes = [
        ...Array.from(root.querySelectorAll('.block')),
        ...Array.from(root.querySelectorAll('table td')),
    ];
    for (const scope of scopes) {
        const bullets = Array.from(scope.querySelectorAll('.numeric-bullet-style'));
        const counters = new Map();
        for (const bullet of bullets) {
            const type = String(bullet.dataset.bulltname || 'arabicPeriod');
            const level = String(bullet.dataset.bulltlvl || '0');
            const key = `${level}:${type}`;
            const startAt = Number(bullet.dataset.bulltstartat);
            const nextIndex = Number.isInteger(startAt) && startAt >= 1 && startAt <= 32767
                ? startAt
                : (counters.get(key) || 0) + 1;
            counters.set(key, nextIndex);
            bullet.textContent = getNumericBulletText(type, nextIndex);
        }
    }
};
const TEXT_FIT_MIN_SCALE = 0.7;
const TEXT_FIT_MAX_PASSES = 8;
const TEXT_FIT_TOLERANCE = 1;
const getFitDataKey = (property) => `pptxFit${property.charAt(0).toUpperCase()}${property.slice(1)}`;
const readOriginalPx = (element, property, computed = getComputedStyle(element)) => {
    const key = getFitDataKey(property);
    const existing = Number(element.dataset[key]);
    if (Number.isFinite(existing) && existing > 0) {
        return existing;
    }
    const value = parseFloat(computed[property]);
    if (!Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    element.dataset[key] = String(value);
    return value;
};
const setScaledPx = (element, property, scale, computed = getComputedStyle(element)) => {
    const original = readOriginalPx(element, property, computed);
    if (original === undefined) {
        return;
    }
    element.style[property] = `${original * scale}px`;
};
const collectTextFitElements = (block) => {
    const elements = new Set();
    block.querySelectorAll('.text-block, .numeric-bullet-style').forEach(element => {
        elements.add(element);
    });
    block.querySelectorAll('.slide-prgrph').forEach(paragraph => {
        Array.from(paragraph.children).forEach(child => {
            if (!(child instanceof HTMLElement) || child.querySelector('.text-block')) {
                return;
            }
            const computed = getComputedStyle(child);
            const fontSize = parseFloat(computed.fontSize);
            if (Number.isFinite(fontSize) && fontSize > 0) {
                elements.add(child);
            }
        });
    });
    return elements;
};
const applyTextFitScale = (block, scale) => {
    block.dataset.pptxTextFitScale = String(scale);
    for (const element of collectTextFitElements(block)) {
        const computed = getComputedStyle(element);
        setScaledPx(element, 'fontSize', scale, computed);
        setScaledPx(element, 'lineHeight', scale, computed);
        setScaledPx(element, 'paddingLeft', scale, computed);
        setScaledPx(element, 'paddingRight', scale, computed);
    }
    block.querySelectorAll('.slide-prgrph').forEach(paragraph => {
        const computed = getComputedStyle(paragraph);
        setScaledPx(paragraph, 'lineHeight', scale, computed);
        setScaledPx(paragraph, 'marginTop', scale, computed);
        setScaledPx(paragraph, 'marginBottom', scale, computed);
        setScaledPx(paragraph, 'paddingTop', scale, computed);
        setScaledPx(paragraph, 'paddingBottom', scale, computed);
    });
    block.querySelectorAll('.slide-prgrph > *').forEach(child => {
        const computed = getComputedStyle(child);
        setScaledPx(child, 'marginLeft', scale, computed);
        setScaledPx(child, 'marginRight', scale, computed);
        setScaledPx(child, 'paddingLeft', scale, computed);
        setScaledPx(child, 'paddingRight', scale, computed);
    });
};
const hasTextOverflow = (block, fitWidth = true) => block.scrollHeight > block.clientHeight + TEXT_FIT_TOLERANCE ||
    (fitWidth && block.scrollWidth > block.clientWidth + TEXT_FIT_TOLERANCE);
const fitOverflowingTextBlock = (block, fitWidth = true) => {
    const mode = block.dataset.pptxAutofit;
    if (mode && mode !== 'normal')
        return;
    if (block.dataset.pptxWrap === 'none')
        fitWidth = false;
    if (!block.querySelector('.text-block') || block.clientWidth <= 0 || block.clientHeight <= 0) {
        return;
    }
    let scale = Number(block.dataset.pptxTextFitScale) || 1;
    if (!hasTextOverflow(block, fitWidth)) {
        return;
    }
    for (let pass = 0; pass < TEXT_FIT_MAX_PASSES && hasTextOverflow(block, fitWidth); pass += 1) {
        const heightRatio = block.scrollHeight > 0
            ? Math.min(1, block.clientHeight / block.scrollHeight)
            : 1;
        const widthRatio = fitWidth && block.scrollWidth > 0
            ? Math.min(1, block.clientWidth / block.scrollWidth)
            : 1;
        const ratio = Math.min(heightRatio, widthRatio, 0.98);
        const nextScale = Math.max(TEXT_FIT_MIN_SCALE, scale * Math.max(ratio, 0.95));
        if (nextScale >= scale - 0.002) {
            scale = Math.max(TEXT_FIT_MIN_SCALE, scale * 0.97);
        }
        else {
            scale = nextScale;
        }
        applyTextFitScale(block, scale);
        if (scale <= TEXT_FIT_MIN_SCALE && hasTextOverflow(block, fitWidth)) {
            break;
        }
    }
};
const fitOverflowingTextBlocks = (root) => {
    root
        .querySelectorAll('.slide div.content, .slide div.content-rtl')
        .forEach(block => fitOverflowingTextBlock(block));
    root
        .querySelectorAll('.slide .pptx-table-cell-content')
        .forEach(block => fitOverflowingTextBlock(block, false));
};
const renderChart = async (message, root) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
    const payload = message.data;
    if (!(payload === null || payload === void 0 ? void 0 : payload.chartID) || !payload.chartType || !payload.chartData) {
        return;
    }
    const chartTarget = findPptxChartTarget(root, payload.chartID);
    if (!chartTarget) {
        return;
    }
    if (chartRenderer && payload.chartModel) {
        return await chartRenderer(payload.chartModel, chartTarget);
    }
    if (!chartLibraryLoader) {
        chartTarget.dataset.fileViewerMissingCapability = 'pptx-charts';
        chartTarget.setAttribute('title', 'PPTX chart rendering requires @file-viewer/capability-pptx-charts. Run `npx file-viewer-cli add pptx-charts --write`, then `npx file-viewer-cli install --yes`.');
        console.warn('[file-viewer] PPTX chart rendering requires @file-viewer/capability-pptx-charts. Run `npx file-viewer-cli add pptx-charts --write`, then `npx file-viewer-cli install --yes`.');
        return;
    }
    const { billboard, d3Format } = await chartLibraryLoader();
    const bb = billboard.default || billboard;
    const { area, bar, line, pie, donut, scatter } = billboard;
    if (typeof billboard.grid === 'function') {
        billboard.grid();
    }
    const chart = {
        bindto: chartTarget,
    };
    const chartData = payload.chartData;
    const axis = {
        x: {
            tick: {
                format(index) {
                    var _a, _b, _c;
                    return (_c = (_b = (_a = chartData[0]) === null || _a === void 0 ? void 0 : _a.xlabels) === null || _b === void 0 ? void 0 : _b[index]) !== null && _c !== void 0 ? _c : index;
                },
            },
        },
    };
    const cartesian = payload.chartModel ? createPptxCartesianChart(payload.chartModel, billboard) : null;
    if (cartesian)
        Object.assign(chart, cartesian);
    else
        switch (payload.chartType) {
            case 'doughnutChart': {
                const series = chartData[0];
                const columns = [];
                const names = {};
                const colors = {};
                for (const [index, point] of ((series === null || series === void 0 ? void 0 : series.values) || []).entries()) {
                    if (typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y === 0)
                        continue;
                    const id = `point-${index}`;
                    columns.push([id, Math.abs(point.y)]);
                    names[id] = String((_c = (_b = (_a = series.xlabels) === null || _a === void 0 ? void 0 : _a[index]) !== null && _b !== void 0 ? _b : point.x) !== null && _c !== void 0 ? _c : index);
                    const fill = (_h = (_g = (_f = (_e = (_d = payload.chartOptions) === null || _d === void 0 ? void 0 : _d.series) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.points) === null || _g === void 0 ? void 0 : _g[point.x]) !== null && _h !== void 0 ? _h : (_l = (_k = (_j = payload.chartOptions) === null || _j === void 0 ? void 0 : _j.series) === null || _k === void 0 ? void 0 : _k[0]) === null || _l === void 0 ? void 0 : _l.color;
                    if (fill && /^(?:#[\da-f]{6}(?:[\da-f]{2})?|transparent)$/i.test(fill))
                        colors[id] = fill;
                }
                const hole = (_m = payload.chartOptions) === null || _m === void 0 ? void 0 : _m.holeSize;
                const holeRatio = (typeof hole === 'number' && Number.isFinite(hole) && hole >= 10 && hole <= 90 ? hole : 50) / 100;
                const angle = (_o = payload.chartOptions) === null || _o === void 0 ? void 0 : _o.firstSliceAngle;
                let adjustingWidth = false;
                Object.assign(chart, {
                    data: { columns, names, colors, type: donut(), order: null },
                    donut: {
                        startingAngle: typeof angle === 'number' && Number.isFinite(angle) ? angle * Math.PI / 180 : 0,
                        expand: false,
                        label: { show: false },
                    },
                    transition: { duration: 0 },
                    onrendered() {
                        if (adjustingWidth || typeof this.config !== 'function')
                            return;
                        let radius = 0;
                        for (const arc of chartTarget.querySelectorAll('.bb-arc')) {
                            const match = /[Aa]([\d.+eE-]+)[ ,]+([\d.+eE-]+)/.exec(arc.getAttribute('d') || '');
                            if (match)
                                radius = Math.max(radius, Number(match[1]));
                        }
                        if (!(radius > 0) || !Number.isFinite(radius))
                            return;
                        const width = radius * (1 - holeRatio);
                        if (Math.abs(Number(this.config('donut.width')) - width) <= 0.01)
                            return;
                        adjustingWidth = true;
                        try {
                            this.config('donut.width', width, true);
                        }
                        finally {
                            adjustingWidth = false;
                        }
                    },
                });
                break;
            }
            case 'lineChart':
                Object.assign(chart, {
                    data: {
                        columns: chartData.map((item) => [item.key, ...item.values.map(({ y }) => y)]),
                        type: line(),
                    },
                    axis,
                    interaction: { enabled: true },
                });
                break;
            case 'barChart':
                Object.assign(chart, {
                    data: {
                        columns: chartData.map((item) => [item.key, ...item.values.map(({ y }) => y)]),
                        type: bar(),
                    },
                    axis: {
                        rotated: payload.barDirection === 'bar',
                        x: {
                            tick: {
                                multiline: true,
                                format(index) {
                                    var _a, _b, _c;
                                    return (_c = (_b = (_a = chartData[0]) === null || _a === void 0 ? void 0 : _a.xlabels) === null || _b === void 0 ? void 0 : _b[index]) !== null && _c !== void 0 ? _c : index;
                                },
                            },
                        },
                    },
                });
                break;
            case 'pieChart':
            case 'pie3DChart':
                Object.assign(chart, {
                    data: {
                        columns: Object.values(((_p = chartData[0]) === null || _p === void 0 ? void 0 : _p.xlabels) || {}).map((value, index) => {
                            var _a, _b, _c;
                            return [
                                value,
                                (_c = (_b = (_a = chartData[0]) === null || _a === void 0 ? void 0 : _a.values) === null || _b === void 0 ? void 0 : _b[index]) === null || _c === void 0 ? void 0 : _c.y,
                            ];
                        }),
                        type: pie(),
                    },
                });
                break;
            case 'areaChart':
                Object.assign(chart, {
                    data: {
                        columns: chartData.map((item) => [item.key, ...item.values.map(({ y }) => y)]),
                        type: area(),
                    },
                    axis,
                    interaction: { enabled: true },
                });
                break;
            case 'scatterChart':
                Object.assign(chart, {
                    data: {
                        xs: { y: 'x' },
                        columns: chartData.map((item, index) => [index ? 'y' : 'x', ...item]),
                        type: scatter(),
                    },
                    axis: {
                        x: {
                            label: 'X',
                            showDist: true,
                            tick: {
                                format: d3Format.format('.02f'),
                            },
                        },
                        y: {
                            label: 'Y',
                            showDist: true,
                            tick: {
                                format: d3Format.format('.02f'),
                            },
                        },
                    },
                });
                break;
            default:
                return;
        }
    if (chart.data) {
        const options = payload.chartOptions;
        if (options === null || options === void 0 ? void 0 : options.legend) {
            chart.legend = {
                show: options.legend.show !== false,
                position: options.legend.position === 'b' ? 'bottom' : 'right',
                format: (label) => label === '' ? '\u200b' : label,
            };
        }
        if (!cartesian && ['barChart', 'areaChart', 'lineChart'].includes(payload.chartType)) {
            const used = new Set();
            const reserved = new Set(chart.data.columns.map((column) => String(column[0])));
            const names = {};
            chart.data.columns.forEach((column, index) => {
                const label = String(column[0]);
                let id = label;
                if (used.has(id)) {
                    id = `pptx-series-${index}`;
                    while (reserved.has(id) || used.has(id))
                        id += '-';
                    column[0] = id;
                }
                used.add(id);
                Object.defineProperty(names, id, { value: label, enumerable: true });
            });
            chart.data.names = names;
            if ((options === null || options === void 0 ? void 0 : options.grouping) === 'stacked' || (options === null || options === void 0 ? void 0 : options.grouping) === 'percentStacked') {
                chart.data.groups = [chart.data.columns.map((column) => column[0])];
                if (options.grouping === 'percentStacked')
                    chart.data.stack = { normalize: true };
                chart.data.order = null;
            }
            const colors = {};
            chartData.forEach((item, index) => {
                var _a, _b;
                const fill = (_b = (_a = options === null || options === void 0 ? void 0 : options.series) === null || _a === void 0 ? void 0 : _a[index]) === null || _b === void 0 ? void 0 : _b.color;
                if (fill && /^(?:#[\da-f]{6}(?:[\da-f]{2})?|transparent)$/i.test(fill))
                    Object.defineProperty(colors, String(chart.data.columns[index][0]), { value: fill, enumerable: true });
            });
            if (Object.keys(colors).length)
                chart.data.colors = colors;
        }
        const surface = chartTarget.ownerDocument.createElement('div');
        surface.className = 'pptx-chart-surface';
        surface.style.cssText = 'width:100%;height:100%;min-width:0;min-height:0;flex:1 1 auto';
        chartTarget.replaceChildren(surface);
        chart.bindto = surface;
        const legend = createPptxChartLegend(surface, chart, options === null || options === void 0 ? void 0 : options.legend, mergePptxChartFonts((_q = payload.chartModel) === null || _q === void 0 ? void 0 : _q.font, (_r = options === null || options === void 0 ? void 0 : options.legend) === null || _r === void 0 ? void 0 : _r.font));
        const fontStyle = stylePptxChartText(surface, payload.chartModel, chart, (_t = (_s = payload.chartOptions) === null || _s === void 0 ? void 0 : _s.legend) === null || _t === void 0 ? void 0 : _t.font);
        const textPlugin = createPptxChartTextPlugin(surface);
        if (textPlugin)
            chart.plugins = [...(chart.plugins || []), textPlugin];
        const logicalSize = [((_u = chartTarget.style) === null || _u === void 0 ? void 0 : _u.width) || '', ((_v = chartTarget.style) === null || _v === void 0 ? void 0 : _v.height) || '']
            .map(value => /^\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : NaN);
        if (logicalSize.every(value => Number.isFinite(value) && value > 0)) {
            const plotSize = legend === null || legend === void 0 ? void 0 : legend.size();
            chart.size = plotSize && plotSize.width > 0 && plotSize.height > 0 ? plotSize : { width: logicalSize[0], height: logicalSize[1] };
            chart.resize = { auto: false };
        }
        try {
            const instance = bb.generate(chart);
            legend === null || legend === void 0 ? void 0 : legend.bind(instance);
            return {
                destroy() {
                    var _a;
                    try {
                        legend === null || legend === void 0 ? void 0 : legend.destroy();
                        (_a = instance.destroy) === null || _a === void 0 ? void 0 : _a.call(instance);
                    }
                    finally {
                        surface.remove();
                        fontStyle === null || fontStyle === void 0 ? void 0 : fontStyle.remove();
                    }
                },
            };
        }
        catch (error) {
            surface.remove();
            fontStyle === null || fontStyle === void 0 ? void 0 : fontStyle.remove();
            legend === null || legend === void 0 ? void 0 : legend.destroy();
            throw error;
        }
    }
};
export const renderPptxPostProcessing = async (charts, root) => {
    restoreNumericBullets(root);
    fitOverflowingTextBlocks(root);
    const queue = asChartQueue(charts);
    const chartInstances = [];
    if (queue.length) {
        const results = await Promise.allSettled(queue.map(message => renderChart(message, root)));
        for (const result of results) {
            if (result.status === 'fulfilled') {
                if (result.value) {
                    chartInstances.push(result.value);
                }
            }
            else {
                console.warn('PPTX chart rendering skipped:', result.reason);
            }
        }
    }
    let destroyed = false;
    return {
        destroy() {
            var _a;
            if (destroyed) {
                return;
            }
            destroyed = true;
            for (const chart of chartInstances) {
                try {
                    (_a = chart.destroy) === null || _a === void 0 ? void 0 : _a.call(chart);
                }
                catch {
                }
            }
            chartInstances.length = 0;
        },
    };
};
