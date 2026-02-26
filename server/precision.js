/**
 * precision.js — Pure precision-math utilities for Binance symbol formatting.
 *
 * Extracted from exchange.js (QW2) so that:
 *   1. AI agents can reason about precision logic without the 1300-line exchange file.
 *   2. These functions can be shared with tests, workers, and other modules.
 *   3. No side effects — every function is pure (no network, no state mutation).
 *
 * ── Coupling Map ────────────────────────────────────────────────────────
 * READS:  nothing external (pure functions only)
 * WRITES: nothing external (pure functions only)
 * USED BY:
 *   exchange.js  — ExchangeConnector.amountToPrecision, priceToPrecision
 *   (future)     — order routes, precision tests
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Count the number of decimal places implied by a step size.
 * e.g. 0.001 → 3, 1 → 0, 1e-8 → 8
 * @param {number} step
 * @returns {number}
 */
export function decimalsFromStep(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    if (step >= 1) return 0;
    const text = String(step).toLowerCase();
    if (text.includes('e-')) {
        const exp = Number.parseInt(text.split('e-')[1], 10);
        return Number.isFinite(exp) ? Math.max(0, exp) : 0;
    }
    const dot = text.indexOf('.');
    if (dot < 0) return 0;
    return Math.max(0, text.length - dot - 1);
}

/**
 * Round a number to the nearest multiple of `step`.
 * @param {number} value  — the value to round
 * @param {number} step   — the step size (e.g. 0.001)
 * @param {'nearest'|'down'|'up'} mode — rounding direction
 * @returns {number}
 */
export function roundToStep(value, step, mode = 'nearest') {
    const n = Number(value);
    if (!Number.isFinite(n)) return n;
    if (!Number.isFinite(step) || step <= 0) return n;
    const scaled = n / step;
    let units;
    if (mode === 'down') units = Math.floor(scaled + 1e-12);
    else if (mode === 'up') units = Math.ceil(scaled - 1e-12);
    else units = Math.round(scaled);
    const rounded = units * step;
    const decimals = Math.min(12, decimalsFromStep(step));
    return Number(rounded.toFixed(decimals));
}

/**
 * Derive the step size for quantity from a market info object.
 * Looks at stepSize → LOT_SIZE filter → precision.amount fallback.
 * @param {object|null} market — market info object from exchangeInfo
 * @returns {number|null}
 */
export function stepFromAmountMarket(market) {
    if (market?.stepSize && market.stepSize > 0) return market.stepSize;
    const lotFilter = (market?.info?.filters || market?.filters || []).find(f => f?.filterType === 'LOT_SIZE');
    const lotStep = Number.parseFloat(lotFilter?.stepSize);
    if (Number.isFinite(lotStep) && lotStep > 0) return lotStep;
    const amountPrecision = market?.precision?.amount;
    if (Number.isFinite(amountPrecision) && Number.isInteger(amountPrecision) && amountPrecision >= 0) {
        return Math.pow(10, -amountPrecision);
    }
    return null;
}

/**
 * Derive the step size for price from a market info object.
 * Looks at tickSize → PRICE_FILTER filter → precision.price fallback.
 * @param {object|null} market — market info object from exchangeInfo
 * @returns {number|null}
 */
export function stepFromPriceMarket(market) {
    if (market?.tickSize && market.tickSize > 0) return market.tickSize;
    const priceFilter = (market?.info?.filters || market?.filters || []).find(f => f?.filterType === 'PRICE_FILTER');
    const tickSize = Number.parseFloat(priceFilter?.tickSize);
    if (Number.isFinite(tickSize) && tickSize > 0) return tickSize;
    const pricePrecision = market?.precision?.price;
    if (Number.isFinite(pricePrecision) && Number.isInteger(pricePrecision) && pricePrecision >= 0) {
        return Math.pow(10, -pricePrecision);
    }
    return null;
}

/**
 * Format a quantity to the correct precision for a given market.
 * @param {number} qty      — raw quantity
 * @param {object|null} market — market info
 * @param {'nearest'|'down'|'up'} mode — rounding direction
 * @returns {string}
 */
export function formatAmount(qty, market, mode = 'nearest') {
    const n = Number(qty);
    if (!Number.isFinite(n)) return String(qty);
    const step = stepFromAmountMarket(market);
    const rounded = roundToStep(n, step, mode);
    const decimals = Math.min(12, decimalsFromStep(step || 0.00000001));
    return rounded.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Format a price to the correct precision for a given market.
 * @param {number} price    — raw price
 * @param {object|null} market — market info
 * @param {'nearest'|'down'|'up'} mode — rounding direction
 * @returns {string}
 */
export function formatPrice(price, market, mode = 'nearest') {
    const n = Number(price);
    if (!Number.isFinite(n)) return String(price);
    const tick = stepFromPriceMarket(market);
    const rounded = roundToStep(n, tick, mode);
    const decimals = Math.min(12, decimalsFromStep(tick || 0.00000001));
    return rounded.toFixed(decimals).replace(/\.?0+$/, '');
}
