export const formatPptxChartNumber = (value, format = 'General') => {
    if (!Number.isFinite(value))
        return '';
    const match = /^([$€£]?)[#0,]+(?:\.([0#]+))?(%)?$/.exec(format);
    if (!match)
        return String(value);
    const decimal = (match[2] || '').slice(0, 20);
    return match[1] + new Intl.NumberFormat('en-US', {
        minimumFractionDigits: (decimal.match(/0/g) || []).length,
        maximumFractionDigits: decimal.length,
        useGrouping: format.includes(','),
        style: match[3] ? 'percent' : 'decimal',
    }).format(value);
};
const axisOptions = (axis) => {
    if (!axis)
        return {};
    const bounds = axis.min === undefined || axis.max === undefined || axis.min < axis.max
        ? { min: axis.min, max: axis.max } : {};
    return {
        ...bounds,
        ...(axis.min !== undefined || axis.max !== undefined ? { padding: { top: 0, bottom: 0 } } : {}),
        show: !axis.deleted,
        inverted: axis.reversed,
        ...(axis.logBase ? { type: 'log' } : {}),
        ...(axis.title ? { label: { text: axis.title, position: 'outer-middle' } } : {}),
        ...(axis.numberFormat ? { tick: { format: (value) => formatPptxChartNumber(value, axis.numberFormat.code) } } : {}),
    };
};
const defined = (labels) => Object.fromEntries(Object.entries(labels || {}).filter(([, value]) => value !== undefined));
export const resolvePptxChartAxes = (model) => {
    var _a, _b;
    const axesFor = (group) => model.axes.filter(axis => group === null || group === void 0 ? void 0 : group.axisIds.includes(axis.id));
    const primary = (_a = axesFor(model.groups[0]).find(axis => axis.kind === 'value')) !== null && _a !== void 0 ? _a : model.axes.find(axis => axis.kind === 'value');
    const secondary = model.groups.filter(group => group.series.length > 0).flatMap(axesFor).find(axis => axis.kind === 'value' && axis.id !== (primary === null || primary === void 0 ? void 0 : primary.id));
    const category = (_b = axesFor(model.groups[0]).find(axis => axis.kind === 'category' || axis.kind === 'date')) !== null && _b !== void 0 ? _b : model.axes.find(axis => axis.kind === 'category' || axis.kind === 'date');
    return { category, primary, secondary };
};
export const createPptxCartesianChart = (model, library) => {
    var _a, _b, _c, _d;
    if (!model.groups.length || model.groups.some(group => !['lineChart', 'barChart', 'areaChart'].includes(group.chartType)))
        return null;
    const rows = model.groups.flatMap((group, groupIndex) => group.series.map((series, index) => ({
        group, groupIndex, series, index, id: `pptx-series-${groupIndex}-${index}`,
    })));
    const coordinates = new Set();
    const labels = new Map();
    for (const { series } of rows)
        for (const [position, point] of series.values.entries()) {
            const coordinate = String(point.x);
            coordinates.add(coordinate);
            if (!labels.has(coordinate))
                labels.set(coordinate, String((_a = series.xlabels[position]) !== null && _a !== void 0 ? _a : coordinate));
        }
    const indices = [...coordinates].sort((a, b) => Number(a) - Number(b));
    const categories = indices.map(index => labels.get(index));
    const valueFor = (series) => {
        const points = new Map(series.values.map(point => [String(point.x), point.y]));
        return indices.map(index => { var _a; return (_a = points.get(index)) !== null && _a !== void 0 ? _a : null; });
    };
    const { primary, secondary, category } = resolvePptxChartAxes(model);
    const factory = { barChart: library.bar, lineChart: library.line, areaChart: library.area };
    if (rows.some(row => typeof factory[row.group.chartType] !== 'function'))
        return null;
    const originalValues = rows.map(row => valueFor(row.series));
    const columns = rows.map(({ id }, index) => [id, ...originalValues[index]]);
    const types = Object.fromEntries(rows.map(row => [row.id, factory[row.group.chartType]()]));
    const dataAxes = Object.fromEntries(rows.map(row => [row.id,
        secondary && row.group.axisIds.includes(secondary.id) ? 'y2' : 'y',
    ]));
    const groups = model.groups.flatMap((group, groupIndex) => group.options.grouping === 'stacked' || group.options.grouping === 'percentStacked'
        ? [rows.filter(row => row.groupIndex === groupIndex).map(row => row.id)] : []);
    const normalizeAll = model.groups.length === 1 && model.groups[0].options.grouping === 'percentStacked';
    const totals = new Map();
    rows.forEach((row, rowIndex) => {
        if (normalizeAll || row.group.options.grouping !== 'percentStacked')
            return;
        let total = totals.get(row.groupIndex);
        if (!total) {
            total = indices.map(() => 0);
            totals.set(row.groupIndex, total);
        }
        originalValues[rowIndex].forEach((value, index) => { total[index] += Math.abs(value || 0); });
    });
    rows.forEach((row, rowIndex) => {
        if (normalizeAll || row.group.options.grouping !== 'percentStacked')
            return;
        for (let i = 1; i < columns[rowIndex].length; i++) {
            const total = totals.get(row.groupIndex)[i - 1];
            if (typeof columns[rowIndex][i] === 'number' && total)
                columns[rowIndex][i] = Number(columns[rowIndex][i]) / total * 100;
        }
    });
    const colors = Object.fromEntries(rows.flatMap(row => {
        var _a, _b;
        const color = (_b = (_a = row.group.options.series) === null || _a === void 0 ? void 0 : _a[row.index]) === null || _b === void 0 ? void 0 : _b.color;
        return color && /^(?:#[\da-f]{6}(?:[\da-f]{2})?|transparent)$/i.test(color) ? [[row.id, color]] : [];
    }));
    const gap = (_b = model.groups.find(group => group.chartType === 'barChart')) === null || _b === void 0 ? void 0 : _b.options.gapWidth;
    const hasLabels = rows.some(row => { var _a, _b; return row.group.options.labels || ((_b = (_a = row.group.options.series) === null || _a === void 0 ? void 0 : _a[row.index]) === null || _b === void 0 ? void 0 : _b.labels); });
    const byId = new Map(rows.map(row => [row.id, row]));
    const labelFormat = (value, id, position) => {
        var _a, _b, _c;
        const row = byId.get(id);
        if (!row)
            return '';
        const properties = { ...defined(row.group.options.labels), ...defined((_b = (_a = row.group.options.series) === null || _a === void 0 ? void 0 : _a[row.index]) === null || _b === void 0 ? void 0 : _b.labels) };
        const originalIndex = indices[position];
        const point = (_c = properties.points) === null || _c === void 0 ? void 0 : _c[originalIndex];
        Object.assign(properties, defined(point));
        if (properties.deleted)
            return '';
        const result = [];
        if (properties.showSeries)
            result.push(String(row.series.key));
        if (properties.showCategory)
            result.push(categories[position] || '');
        if (properties.showValue)
            result.push(formatPptxChartNumber(value, properties.formatCode));
        return result.join(' ');
    };
    return {
        data: {
            columns, types, type: types[(_c = rows[0]) === null || _c === void 0 ? void 0 : _c.id], axes: dataAxes,
            names: Object.fromEntries(rows.map(row => [row.id, String(row.series.key)])),
            ...(Object.keys(colors).length ? { colors } : {}),
            ...(groups.length ? { groups, order: null } : {}),
            ...(normalizeAll ? { stack: { normalize: true } } : {}),
            ...(hasLabels ? { labels: { format: labelFormat } } : {}),
        },
        axis: {
            rotated: model.groups.some(group => group.barDirection === 'bar'),
            x: { ...axisOptions(category), type: 'category', categories, tick: model.groups.some(group => group.barDirection === 'bar')
                    ? { multiline: true }
                    : { multiline: false, culling: false, rotate: (_d = category === null || category === void 0 ? void 0 : category.labelRotation) !== null && _d !== void 0 ? _d : 60, autorotate: (category === null || category === void 0 ? void 0 : category.labelRotation) === undefined } },
            y: axisOptions(primary),
            ...(secondary ? { y2: axisOptions(secondary) } : {}),
        },
        grid: { x: { show: (category === null || category === void 0 ? void 0 : category.majorGridlines) === true }, y: { show: (primary === null || primary === void 0 ? void 0 : primary.majorGridlines) === true } },
        ...(gap !== undefined ? { bar: { width: { ratio: 100 / (100 + gap) } } } : {}),
        ...(model.title ? { title: { text: model.title } } : {}),
        interaction: { enabled: true },
    };
};
