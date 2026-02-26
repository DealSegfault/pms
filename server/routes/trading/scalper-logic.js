/**
 * Scalper Logic — Pure Functions (extracted for testability)
 *
 * All functions here are pure or near-pure (no I/O, no state mutation).
 * They are imported by both:
 *   - server/routes/trading/scalper.js  (runtime)
 *   - tests/scalper-logic.test.js       (unit tests)
 *
 * Run tests:  node --test tests/scalper-logic.test.js
 */

// ── Layer Geometry ─────────────────────────────────────────────

/**
 * Generate exponentially-spread offset percentages centered on baseOffset.
 * With childCount=1 returns [baseOffset].
 * With childCount=3, maxSpread=2: [base/√2, base, base×√2] approximately.
 *
 * @param {number} baseOffset - base stalk offset %
 * @param {number} count      - number of layers (1–10)
 * @param {number} maxSpread  - ratio between highest and lowest offset (default 2)
 * @returns {number[]}
 */
export function generateLayerOffsets(baseOffset, count, maxSpread = 2.0) {
    if (count <= 1) return [baseOffset];
    const step = Math.log(maxSpread) / (count - 1);
    return Array.from({ length: count }, (_, i) => {
        return baseOffset * Math.exp(-Math.log(maxSpread) / 2 + step * i);
    });
}

/**
 * Compute skew-weighted allocations for N layers.
 * Positive skew → larger size on further-out layers (more stealth).
 * Negative skew → larger size on closest layers.
 *
 * @param {number} count
 * @param {number} skew  — -100 to +100
 * @returns {number[]} weights that sum to 1
 */
export function generateSkewWeights(count, skew) {
    if (count <= 1) return [1];
    const weights = [];
    const s = skew / 100; // -1 to +1
    for (let i = 0; i < count; i++) {
        const t = i / (count - 1); // 0 (closest) → 1 (furthest)
        const w = Math.pow(8, s * (2 * t - 1));
        weights.push(w);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / total);
}

// ── Anti-Overtrading Guards ──────────────────────────────────

/**
 * Compute fill-spread cooldown delay.
 * effectiveSpread decays exponentially toward 0 as time passes.
 * Returns how many ms to wait before the spread will be wide enough.
 *
 * @param {Object} sp - scalper state (minFillSpreadPct, fillDecayHalfLifeMs, _lastFillPrice, _lastFillTime)
 * @param {'LONG'|'SHORT'} legSide
 * @param {number} currentPrice
 * @param {number} [now] - current timestamp (ms), defaults to Date.now()
 * @returns {number} ms to wait (0 = ok to proceed)
 */
export function fillSpreadCooldownMs(sp, legSide, currentPrice, now = Date.now()) {
    const lastPrice = sp._lastFillPrice?.[legSide];
    const lastTime = sp._lastFillTime?.[legSide] || 0;
    if (!lastPrice || !currentPrice || sp.minFillSpreadPct <= 0) return 0;
    const elapsed = now - lastTime;
    const halfLife = sp.fillDecayHalfLifeMs || 30000;
    const decayFactor = Math.pow(0.5, elapsed / halfLife);
    const effectiveSpread = sp.minFillSpreadPct * decayFactor;
    const actualSpread = Math.abs(currentPrice - lastPrice) / lastPrice * 100;
    if (actualSpread >= effectiveSpread) return 0;
    const remaining = halfLife * Math.log2(sp.minFillSpreadPct / Math.max(actualSpread, 0.0001)) - elapsed;
    return Math.max(0, Math.ceil(remaining));
}

/**
 * Compute fill-refill delay (exponential backoff per slot per side).
 * Exponent is capped at 4 (max 16× base delay) to prevent permanent side-silencing.
 *
 * @param {Object} sp - scalper state (minRefillDelayMs, _fillRefillCount)
 * @param {'LONG'|'SHORT'} legSide
 * @param {number} [backoffMaxMs] - cap for backoff
 * @returns {number} ms to wait (0 = ok to proceed)
 */
const BACKOFF_MAX_MS = 300000; // 5min cap

export function fillRefillDelayMs(sp, legSide, backoffMaxMs = BACKOFF_MAX_MS) {
    if (!sp.minRefillDelayMs || sp.minRefillDelayMs <= 0) return 0;
    const count = Math.min(sp._fillRefillCount?.[legSide] || 0, 4); // cap at 2^4 = 16×
    return Math.min(sp.minRefillDelayMs * Math.pow(2, count), backoffMaxMs);
}

/**
 * Check if the burst fill rate on this side exceeds maxFillsPerMinute.
 * Uses a sliding 60-second window of recent fill timestamps.
 *
 * @param {Object} sp - scalper state (maxFillsPerMinute, _recentFillTimes)
 * @param {'LONG'|'SHORT'} legSide
 * @param {number} [now] - current timestamp (ms)
 * @returns {number} 0 if ok, or ms to wait until window clears
 */
export function burstCooldownMs(sp, legSide, now = Date.now()) {
    if (!sp.maxFillsPerMinute || sp.maxFillsPerMinute <= 0) return 0;
    const WINDOW_MS = 60000;
    if (!sp._recentFillTimes) sp._recentFillTimes = {};
    if (!sp._recentFillTimes[legSide]) sp._recentFillTimes[legSide] = [];
    // Prune timestamps older than 60s (mutates — caller should pass a copy for purity)
    sp._recentFillTimes[legSide] = sp._recentFillTimes[legSide].filter(t => now - t < WINDOW_MS);
    const count = sp._recentFillTimes[legSide].length;
    if (count < sp.maxFillsPerMinute) return 0;
    const oldest = sp._recentFillTimes[legSide][0];
    return Math.max(0, oldest + WINDOW_MS - now);
}

// ── Risk Guards ──────────────────────────────────────────────

/**
 * Check if a reduce-only slot should be held because the current position
 * loss exceeds maxLossPerCloseBps.
 *
 * @param {Object} sp - scalper state (maxLossPerCloseBps, startSide)
 * @param {'LONG'|'SHORT'} legSide - the closing leg
 * @param {number} currentPrice - latest market price
 * @param {number|null} entryPrice - position entry price for the opening side
 * @returns {boolean} true if the slot should be paused (loss too large)
 */
export function isMaxLossExceeded(sp, legSide, currentPrice, entryPrice) {
    if (!sp.maxLossPerCloseBps || sp.maxLossPerCloseBps <= 0) return false;
    if (!currentPrice || !entryPrice || entryPrice <= 0) return false;
    const openingSide = sp.startSide;
    if (legSide === openingSide) return false; // only guard the closing leg
    let lossBps = 0;
    if (openingSide === 'LONG') {
        lossBps = (entryPrice - currentPrice) / entryPrice * 10000;
    } else {
        lossBps = (currentPrice - entryPrice) / entryPrice * 10000;
    }
    return lossBps > sp.maxLossPerCloseBps;
}

/**
 * Check if the current price is within the allowed range for a leg.
 * When allowLoss=false, pins the effective boundary to the position entry.
 *
 * @param {Object} sp - scalper state (longMaxPrice, shortMinPrice, allowLoss, pinLongToEntry, pinShortToEntry)
 * @param {'LONG'|'SHORT'} legSide
 * @param {number} currentPrice
 * @param {number|null} longEntry - current long position entry
 * @param {number|null} shortEntry - current short position entry
 * @returns {boolean} true if the slot can be placed
 */
export function isPriceAllowed(sp, legSide, currentPrice, longEntry, shortEntry) {
    if (!currentPrice) return true;

    let effectiveLongMax = sp.longMaxPrice || null;
    let effectiveShortMin = sp.shortMinPrice || null;

    // Pin LONG bounds
    if (sp.pinLongToEntry) {
        if (shortEntry && shortEntry > 0) {
            effectiveLongMax = effectiveLongMax ? Math.min(effectiveLongMax, shortEntry) : shortEntry;
        }
        if (longEntry && longEntry > 0) {
            effectiveLongMax = effectiveLongMax ? Math.min(effectiveLongMax, longEntry) : longEntry;
        }
    }

    // Pin SHORT bounds
    if (sp.pinShortToEntry) {
        if (longEntry && longEntry > 0) {
            effectiveShortMin = effectiveShortMin ? Math.max(effectiveShortMin, longEntry) : longEntry;
        }
        if (shortEntry && shortEntry > 0) {
            effectiveShortMin = effectiveShortMin ? Math.max(effectiveShortMin, shortEntry) : shortEntry;
        }
    }

    // Legacy fallback (allowLoss=false)
    if (!sp.allowLoss) {
        if (legSide === 'LONG' && shortEntry && shortEntry > 0) {
            effectiveLongMax = effectiveLongMax ? Math.min(effectiveLongMax, shortEntry) : shortEntry;
        }
        if (legSide === 'SHORT' && longEntry && longEntry > 0) {
            effectiveShortMin = effectiveShortMin ? Math.max(effectiveShortMin, longEntry) : longEntry;
        }
    }

    if (legSide === 'LONG' && effectiveLongMax && currentPrice > effectiveLongMax) return false;
    if (legSide === 'SHORT' && effectiveShortMin && currentPrice < effectiveShortMin) return false;
    return true;
}

// ── PnL Feedback ─────────────────────────────────────────────

const MIN_FEEDBACK_FILLS = 3;
const TARGET_SPREAD_BPS = 30;
const MAX_WIDEN_FACTOR = 2.5;

/**
 * Compute the realized PnL score for a slot in basis points per fill.
 * @returns {number|null} bps per fill, or null if not enough data
 */
export function slotPnlScoreBps(slot, price) {
    if (!slot.fills || slot.fills < MIN_FEEDBACK_FILLS) return null;
    if (!slot.pnlSum || !price || price <= 0) return null;
    const avgPnlUsd = slot.pnlSum / slot.fills;
    const notional = (slot.qty || 0) * price;
    if (notional <= 0) return null;
    return (avgPnlUsd / notional) * 10000;
}

/**
 * Compute an adaptive stalk offset based on this slot's PnL score.
 * Profitable → keep offset. Losing → widen by up to MAX_WIDEN_FACTOR.
 *
 * @param {string} feedbackMode - 'off' | 'soft' | 'full'
 * @param {Object} slot - { offsetPct, fills, pnlSum, qty }
 * @param {number} price
 * @returns {number} effective offset %
 */
export function adaptiveOffsetPct(feedbackMode, slot, price) {
    if (!feedbackMode || feedbackMode === 'off') return slot.offsetPct;
    const score = slotPnlScoreBps(slot, price);
    if (score === null) return slot.offsetPct;
    if (score >= 0) return slot.offsetPct;

    const deficit = Math.min(Math.abs(score), TARGET_SPREAD_BPS * (MAX_WIDEN_FACTOR - 1));
    const factor = 1 + deficit / TARGET_SPREAD_BPS;
    return slot.offsetPct * Math.min(factor, MAX_WIDEN_FACTOR);
}

/**
 * In 'full' feedback mode, scale down qty for underperforming slots.
 * Returns a scale factor 0.5–1.0.
 */
export function adaptiveQtyFactor(feedbackMode, slot, price) {
    if (feedbackMode !== 'full') return 1;
    const score = slotPnlScoreBps(slot, price);
    if (score === null || score >= 0) return 1;
    const deficit = Math.min(Math.abs(score), TARGET_SPREAD_BPS);
    return Math.max(0.5, 1 - (deficit / TARGET_SPREAD_BPS) * 0.5);
}

/**
 * Compute backoff delay: 2^retryCount × base, capped at max.
 */
const BACKOFF_BASE_MS = 2000;

export function backoffDelay(retryCount, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS) {
    return Math.min(baseMs * Math.pow(2, retryCount), maxMs);
}

// ── Distance-Based Refresh ──────────────────────────────────

const FAR_DISTANCE_BPS = 50;  // orders beyond this are "far"
const FAR_APPROACH_BPS = 30;  // price must approach by this much to trigger reprice

/**
 * Compute distance between an order price and a market price in basis points.
 * @param {number} orderPrice - the order's current limit price
 * @param {number} marketPrice - current mid price
 * @returns {number} distance in bps (always ≥ 0)
 */
export function computeDistanceBps(orderPrice, marketPrice) {
    if (!marketPrice || marketPrice <= 0 || !orderPrice || orderPrice <= 0) return 0;
    return Math.abs(orderPrice - marketPrice) / marketPrice * 10000;
}

/**
 * Determine whether a far order should skip repricing on this tick.
 *
 * Near orders (≤ farDistanceBps from mid) always reprice normally.
 * Far orders (> farDistanceBps) only reprice when price has moved
 * ≥ farApproachBps toward the order since the last reprice (reservationPrice).
 *
 * @param {'LONG'|'SHORT'} side - order side
 * @param {number} lastOrderPrice - current limit price of the order
 * @param {number} currentMid - current mid price
 * @param {number} reservationPrice - mid price at last reprice
 * @param {number} [farDistanceBps=50] - bps threshold for "far" classification
 * @param {number} [farApproachBps=30] - bps approach required to trigger reprice
 * @returns {boolean} true if this reprice should be skipped
 */
export function shouldSkipDistantReprice(side, lastOrderPrice, currentMid, reservationPrice, farDistanceBps = FAR_DISTANCE_BPS, farApproachBps = FAR_APPROACH_BPS) {
    if (!lastOrderPrice || lastOrderPrice <= 0) return false; // first placement
    if (!currentMid || currentMid <= 0) return false;

    const distBps = computeDistanceBps(lastOrderPrice, currentMid);
    if (distBps <= farDistanceBps) return false; // near order — always reprice

    // Far order — check if price approached since reservation
    const reservation = (reservationPrice && reservationPrice > 0) ? reservationPrice : currentMid;
    if (side === 'LONG') {
        // BUY order sits below mid. Price must drop toward it.
        const approachBps = (reservation - currentMid) / reservation * 10000;
        return approachBps < farApproachBps;
    } else {
        // SELL order sits above mid. Price must rise toward it.
        const approachBps = (currentMid - reservation) / reservation * 10000;
        return approachBps < farApproachBps;
    }
}
