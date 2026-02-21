const DEFAULT_FACTOR = 1;
const MIN_FACTOR = 0.01;

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function sanitizeFactor(value) {
    const parsed = toNumber(value);
    if (parsed === null || parsed === 0) return null;
    return parsed;
}

export function formulaToBuilderWeights(formula = []) {
    const merged = new Map();

    for (const leg of formula) {
        const symbol = normalizeSymbol(leg?.symbol);
        const factor = sanitizeFactor(leg?.factor);
        if (!symbol || factor === null) continue;
        merged.set(symbol, (merged.get(symbol) || 0) + factor);
    }

    return Array.from(merged.entries())
        .map(([symbol, factor]) => ({ symbol, factor }))
        .filter((x) => x.factor !== 0);
}

export function builderWeightsToFormula(weights = []) {
    return formulaToBuilderWeights(weights);
}

export function toggleBuilderSymbol(weights = [], symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return weights;

    const idx = weights.findIndex((x) => x.symbol === normalized);
    if (idx >= 0) {
        return weights.filter((_, i) => i !== idx);
    }

    return [...weights, { symbol: normalized, factor: DEFAULT_FACTOR }];
}

export function removeBuilderSymbol(weights = [], symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return weights;
    return weights.filter((x) => x.symbol !== normalized);
}

export function flipBuilderFactor(weights = [], symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return weights;

    return weights.map((x) => {
        if (x.symbol !== normalized) return x;
        const factor = sanitizeFactor(x.factor);
        if (factor === null) return { ...x, factor: -DEFAULT_FACTOR };
        return { ...x, factor: -factor };
    });
}

export function setBuilderFactor(weights = [], symbol, nextAbsFactor) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return weights;

    const rawAbs = toNumber(nextAbsFactor);
    const absFactor = rawAbs === null ? MIN_FACTOR : Math.max(MIN_FACTOR, Math.abs(rawAbs));

    return weights.map((x) => {
        if (x.symbol !== normalized) return x;
        const current = sanitizeFactor(x.factor);
        const sign = current === null ? 1 : (current >= 0 ? 1 : -1);
        return { ...x, factor: sign * absFactor };
    });
}

export function normalizeBuilderWeights(weights = []) {
    if (weights.length === 0) return weights;

    const sumAbs = weights.reduce((acc, x) => {
        const factor = sanitizeFactor(x.factor);
        return acc + (factor === null ? 0 : Math.abs(factor));
    }, 0);

    if (sumAbs <= 0) return equalizeBuilderWeights(weights);

    return weights.map((x) => {
        const factor = sanitizeFactor(x.factor);
        const sign = factor === null ? 1 : (factor >= 0 ? 1 : -1);
        const abs = factor === null ? 0 : Math.abs(factor);
        return { ...x, factor: sign * (abs / sumAbs) };
    });
}

export function equalizeBuilderWeights(weights = []) {
    if (weights.length === 0) return weights;

    const base = 1 / weights.length;
    return weights.map((x) => {
        const factor = sanitizeFactor(x.factor);
        const sign = factor === null ? 1 : (factor >= 0 ? 1 : -1);
        return { ...x, factor: sign * base };
    });
}

export function summarizeBuilderWeights(weights = []) {
    const sumWeights = weights.reduce((acc, x) => {
        const factor = sanitizeFactor(x.factor);
        return acc + (factor === null ? 0 : Math.abs(factor));
    }, 0);

    const longCount = weights.filter((x) => {
        const factor = sanitizeFactor(x.factor);
        return factor !== null && factor > 0;
    }).length;

    const shortCount = weights.filter((x) => {
        const factor = sanitizeFactor(x.factor);
        return factor !== null && factor < 0;
    }).length;

    return { sumWeights, longCount, shortCount };
}

export function validateIndexBuilderInput(name, weights, minSymbols = 2) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
        return { ok: false, error: 'Please enter an index name', formula: [] };
    }

    const formula = builderWeightsToFormula(weights);
    if (formula.length < minSymbols) {
        return { ok: false, error: `Select at least ${minSymbols} symbols`, formula };
    }

    const total = formula.reduce((acc, x) => acc + Math.abs(x.factor), 0);
    if (total <= 0) {
        return { ok: false, error: 'Index weights must sum to a positive value', formula: [] };
    }

    return { ok: true, formula, name: trimmedName };
}
