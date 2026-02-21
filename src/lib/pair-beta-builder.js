function asFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function sortByTime(series = []) {
    return [...series].sort((a, b) => a.time - b.time);
}

function normalizeSeries(series = []) {
    return sortByTime(series.map((row) => {
        const time = asFiniteNumber(row?.time);
        const close = asFiniteNumber(row?.close);
        if (time == null || close == null) return null;
        return { time, close };
    }).filter(Boolean));
}

export function sampleVariance(values = []) {
    if (!Array.isArray(values) || values.length < 2) return 0;
    const mean = values.reduce((acc, x) => acc + x, 0) / values.length;
    const sq = values.reduce((acc, x) => {
        const d = x - mean;
        return acc + (d * d);
    }, 0);
    return sq / (values.length - 1);
}

export function sampleCovariance(left = [], right = []) {
    const n = Math.min(left.length, right.length);
    if (n < 2) return 0;

    const leftSlice = left.slice(0, n);
    const rightSlice = right.slice(0, n);

    const leftMean = leftSlice.reduce((acc, x) => acc + x, 0) / n;
    const rightMean = rightSlice.reduce((acc, x) => acc + x, 0) / n;

    let sum = 0;
    for (let i = 0; i < n; i += 1) {
        sum += (leftSlice[i] - leftMean) * (rightSlice[i] - rightMean);
    }
    return sum / (n - 1);
}

export function sampleCorrelation(left = [], right = []) {
    const n = Math.min(left.length, right.length);
    if (n < 2) return 0;

    const leftSlice = left.slice(0, n);
    const rightSlice = right.slice(0, n);

    const leftVar = sampleVariance(leftSlice);
    const rightVar = sampleVariance(rightSlice);
    if (leftVar <= 0 || rightVar <= 0) return 0;

    const cov = sampleCovariance(leftSlice, rightSlice);
    const corr = cov / Math.sqrt(leftVar * rightVar);
    if (!Number.isFinite(corr)) return 0;
    return Math.max(-1, Math.min(1, corr));
}

export function alignCloseSeries(leftSeries = [], rightSeries = []) {
    const left = normalizeSeries(leftSeries);
    const right = normalizeSeries(rightSeries);
    if (left.length === 0 || right.length === 0) return { leftClose: [], rightClose: [], times: [] };

    const rightMap = new Map(right.map((row) => [row.time, row.close]));
    const leftClose = [];
    const rightClose = [];
    const times = [];

    for (const row of left) {
        const rightCloseVal = rightMap.get(row.time);
        if (rightCloseVal == null) continue;
        leftClose.push(row.close);
        rightClose.push(rightCloseVal);
        times.push(row.time);
    }

    return { leftClose, rightClose, times };
}

export function computePairStatsFromSeries(pair, leftSeries = [], rightSeries = []) {
    const { leftClose, rightClose } = alignCloseSeries(leftSeries, rightSeries);
    if (leftClose.length < 3 || rightClose.length < 3) return null;

    const cov = sampleCovariance(leftClose, rightClose);
    const rightVar = sampleVariance(rightClose);
    const beta = rightVar > 0 ? cov / rightVar : 0;
    const corr = sampleCorrelation(leftClose, rightClose);

    const firstLeft = leftClose[0];
    const lastLeft = leftClose[leftClose.length - 1];
    const firstRight = rightClose[0];
    const lastRight = rightClose[rightClose.length - 1];

    if (firstLeft === 0 || firstRight === 0) return null;

    const retLeft = (lastLeft / firstLeft) - 1;
    const retRight = (lastRight / firstRight) - 1;
    const ret = retLeft - retRight;

    if (![beta, corr, ret].every(Number.isFinite)) return null;
    return { pair, beta, corr, ret };
}

function parsePairName(pair = '') {
    const [left, right] = String(pair).split('/');
    const l = String(left || '').trim().toUpperCase();
    const r = String(right || '').trim().toUpperCase();
    if (!l || !r) return null;
    return { left: l, right: r };
}

function resolveBaseSymbol(base, resolvePairBaseSymbol) {
    if (typeof resolvePairBaseSymbol !== 'function') return base;
    const resolved = resolvePairBaseSymbol(base);
    return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : null;
}

function addWeight(weights, symbol, delta) {
    if (!symbol || !Number.isFinite(delta) || delta === 0) return;
    weights[symbol] = (weights[symbol] || 0) + delta;
}

export function computePairBasketWeights({
    basketLong = [],
    basketShort = [],
    indexLong = [],
    indexShort = [],
    tradeSize = 0,
    resolvePairBaseSymbol,
    resolveIndexFormula,
} = {}) {
    const totalWeight = basketLong.length + basketShort.length + indexLong.length + indexShort.length;
    if (totalWeight === 0 || !Number.isFinite(tradeSize) || tradeSize <= 0) return null;

    const eachQty = tradeSize / totalWeight;
    const pairQty = eachQty / 2;
    const weights = {};

    for (const pair of basketLong) {
        const parsed = parsePairName(pair);
        if (!parsed) continue;
        const left = resolveBaseSymbol(parsed.left, resolvePairBaseSymbol);
        const right = resolveBaseSymbol(parsed.right, resolvePairBaseSymbol);
        if (!left || !right) continue;
        addWeight(weights, left, pairQty);
        addWeight(weights, right, -pairQty);
    }

    for (const pair of basketShort) {
        const parsed = parsePairName(pair);
        if (!parsed) continue;
        const shortBase = resolveBaseSymbol(parsed.left, resolvePairBaseSymbol);
        const longBase = resolveBaseSymbol(parsed.right, resolvePairBaseSymbol);
        if (!shortBase || !longBase) continue;
        addWeight(weights, longBase, pairQty);
        addWeight(weights, shortBase, -pairQty);
    }

    if (typeof resolveIndexFormula === 'function') {
        for (const indexId of indexLong) {
            const formula = resolveIndexFormula(indexId);
            if (!Array.isArray(formula) || formula.length === 0) continue;
            const fw = eachQty / formula.length;
            for (const leg of formula) {
                const symbol = typeof leg?.symbol === 'string' ? leg.symbol : '';
                const factor = Number(leg?.factor) || 0;
                addWeight(weights, symbol, fw * factor);
            }
        }

        for (const indexId of indexShort) {
            const formula = resolveIndexFormula(indexId);
            if (!Array.isArray(formula) || formula.length === 0) continue;
            const fw = eachQty / formula.length;
            for (const leg of formula) {
                const symbol = typeof leg?.symbol === 'string' ? leg.symbol : '';
                const factor = Number(leg?.factor) || 0;
                addWeight(weights, symbol, -fw * factor);
            }
        }
    }

    const totalSize = Object.values(weights).reduce((acc, v) => acc + Math.abs(v), 0);
    if (totalSize > 0 && totalSize < tradeSize) {
        const m = tradeSize / totalSize;
        for (const symbol of Object.keys(weights)) {
            weights[symbol] *= m;
        }
    }

    return Object.keys(weights).length ? weights : null;
}

export function weightsToFormula(weights = {}, mode = 'kingfisher') {
    const entries = Object.entries(weights).filter(([, factor]) => Number.isFinite(factor) && factor !== 0);
    if (entries.length === 0) return [];

    const sumAbs = entries.reduce((acc, [, factor]) => acc + Math.abs(factor), 0);
    if (sumAbs <= 0) return [];

    let multiplier = 1 / sumAbs;
    if (mode === 'kingfisher') {
        multiplier = entries.length / sumAbs;
    }

    return entries.map(([symbol, factor]) => ({
        symbol,
        factor: factor * multiplier,
    }));
}

export function scorePairStats(stats) {
    const corr = Math.abs(Number(stats?.corr) || 0);
    const beta = Number(stats?.beta) || 0;
    const ret = Math.abs(Number(stats?.ret) || 0);

    const betaFit = 1 / (1 + Math.abs(beta - 1));
    const retScore = Math.min(1, ret);

    return (0.55 * corr) + (0.30 * betaFit) + (0.15 * retScore);
}
