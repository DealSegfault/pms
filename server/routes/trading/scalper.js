/**
 * Scalper Engine — dual-leg chase for market-making / scalping.
 *
 * Spawns two groups of chase orders simultaneously on the same symbol:
 *   • Long leg  — N child chases at exponentially-spread offsets below bid
 *   • Short leg — N child chases at exponentially-spread offsets above ask
 *
 * Side rules (reduce-only enforcement):
 *   startSide=LONG  → long chases are normal, short chases are reduceOnly
 *   startSide=SHORT → short chases are normal, long chases are reduceOnly
 *
 * When a child fills → that slot immediately spawns a brand-new chase at the
 * same offset, keeping the layer count constant.
 *
 * Layer offsets:
 *   Exponentially distributed around the base offset with a fixed spread
 *   factor (2×), so layers fan out naturally even with childCount=1.
 *   Skew weights adjust the USD size allocation across layers.
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import riskEngine from '../../risk/index.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getRedis } from '../../redis.js';
import { startChaseInternal, cancelChaseInternal, startChaseBatch } from './chase-limit.js';

const router = Router();

// ── Redis ─────────────────────────────────────────────────────
const SC_PREFIX = 'pms:scalper:';
const SC_TTL = 172800; // 48 h

async function saveToRedis(sp) {
    try {
        const r = getRedis();
        if (!r) return;
        // Omit non-serialisable runtime fields
        const { _longChases, _shortChases, ...data } = sp;
        // Persist just the chaseId per slot
        data._longSlots = (sp._longChases || []).map(s => ({ layerIdx: s.layerIdx, chaseId: s.chaseId, qty: s.qty, offsetPct: s.offsetPct }));
        data._shortSlots = (sp._shortChases || []).map(s => ({ layerIdx: s.layerIdx, chaseId: s.chaseId, qty: s.qty, offsetPct: s.offsetPct }));
        await r.set(SC_PREFIX + sp.id, JSON.stringify(data), 'EX', SC_TTL);
    } catch (err) {
        console.warn('[Scalper-Redis] Save failed:', err.message);
    }
}

async function deleteFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(SC_PREFIX + id);
    } catch { /* ignore */ }
}

// ── State ─────────────────────────────────────────────────────
const activeScalpers = new Map(); // id → ScalperState
const MAX_ACTIVE_SCALPERS = 50;

// Track pending slot retry timers so finishScalper can clear them.
// Key: `${scalperId}:${legSide}:${layerIdx}` → timerId
const _slotTimers = new Map();

function generateId() {
    return `scalper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Layer geometry ─────────────────────────────────────────────

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
function generateLayerOffsets(baseOffset, count, maxSpread = 2.0) {
    if (count <= 1) return [baseOffset];
    const step = Math.log(maxSpread) / (count - 1);
    return Array.from({ length: count }, (_, i) => {
        // Symmetric around baseOffset: layer 0 is baseOffset / sqrt(maxSpread),
        // middle is baseOffset, last is baseOffset * sqrt(maxSpread)
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
function generateSkewWeights(count, skew) {
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

// ── Leg management ─────────────────────────────────────────────

/**
 * Start all child chases for one leg.
 * @param {Object} sp        - ScalperState
 * @param {'LONG'|'SHORT'} legSide
 * @param {number[]} offsets - per-layer offset %
 * @param {number[]} qtys    - per-layer quantity (in coin)
 * @param {boolean} reduceOnly
 * @returns {Promise<Array<{layerIdx, chaseId, qty, offsetPct}>>}
 */
// Binance min notional per order (non-reduceOnly)
const MIN_NOTIONAL_USD = 5;

async function startLeg(sp, legSide, offsets, qtys, reduceOnly) {
    const slots = [];
    // Get current price for notional check
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 0;

    // ── Pre-filter: identify which layers are valid for batch submission ──
    const validLayers = [];  // { idx, offsetPct, qty } — layers to submit
    for (let i = 0; i < offsets.length; i++) {
        const offsetPct = offsets[i];
        const qty = qtys[i];
        // Skip layers below min notional (Binance -4164)
        if (!reduceOnly && price > 0 && (qty * price) + 0.001 < MIN_NOTIONAL_USD) {
            console.warn(`[Scalper ${sp.id}] ${legSide} layer ${i}: skipped (notional $${(qty * price).toFixed(2)} < $${MIN_NOTIONAL_USD})`);
            slots.push({ layerIdx: i, chaseId: null, qty, offsetPct, reduceOnly, skippedNotional: true });
            continue;
        }
        if (qty <= 0) {
            slots.push({ layerIdx: i, chaseId: null, qty, offsetPct, reduceOnly });
            continue;
        }
        validLayers.push({ idx: i, offsetPct, qty });
    }

    if (validLayers.length === 0) return slots;

    // ── Batch submission: up to 5 orders per Binance call ──
    const BATCH_SIZE = 5;
    for (let batchStart = 0; batchStart < validLayers.length; batchStart += BATCH_SIZE) {
        const chunk = validLayers.slice(batchStart, batchStart + BATCH_SIZE);

        // Build chase specs for this chunk
        const specs = chunk.map(layer => ({
            subAccountId: sp.subAccountId,
            symbol: sp.symbol,
            side: legSide,
            quantity: layer.qty,
            leverage: sp.leverage,
            stalkOffsetPct: layer.offsetPct,
            stalkMode: 'maintain',
            maxDistancePct: 0,
            orderType: 'SCALPER_LIMIT',
            reduceOnly,
            parentScalperId: sp.id,
            internal: false,
            onFill: (fillPrice, fillQty) => onChildFill(sp, legSide, layer.idx, fillPrice, fillQty),
            onCancel: (reason) => onChildCancel(sp, legSide, layer.idx, reason),
        }));

        try {
            const batchResults = await startChaseBatch(specs);

            // Map results back to slots
            for (let j = 0; j < chunk.length; j++) {
                const layer = chunk[j];
                const result = batchResults[j];
                if (result?.chaseId) {
                    slots.push({ layerIdx: layer.idx, chaseId: result.chaseId, qty: layer.qty, offsetPct: layer.offsetPct, reduceOnly });
                    console.log(`[Scalper ${sp.id}] ${legSide} layer ${layer.idx}: offset ${layer.offsetPct.toFixed(4)}%, qty ${layer.qty.toFixed(6)}, chaseId ${result.chaseId}${reduceOnly ? ' (reduceOnly)' : ''} [batch]`);
                } else {
                    console.error(`[Scalper ${sp.id}] Batch start ${legSide} layer ${layer.idx} failed: ${result?.error || 'unknown'}`);
                    slots.push({ layerIdx: layer.idx, chaseId: null, qty: layer.qty, offsetPct: layer.offsetPct, reduceOnly });
                }
            }
        } catch (err) {
            // Entire batch failed — fall back to sequential placement for this chunk
            console.warn(`[Scalper ${sp.id}] Batch failed, falling back to sequential:`, err.message);
            for (const layer of chunk) {
                try {
                    const { chaseId } = await startChaseInternal({
                        subAccountId: sp.subAccountId,
                        symbol: sp.symbol,
                        side: legSide,
                        quantity: layer.qty,
                        leverage: sp.leverage,
                        stalkOffsetPct: layer.offsetPct,
                        stalkMode: 'maintain',
                        maxDistancePct: 0,
                        orderType: 'SCALPER_LIMIT',
                        reduceOnly,
                        parentScalperId: sp.id,
                        internal: false,
                        onFill: (fillPrice, fillQty) => onChildFill(sp, legSide, layer.idx, fillPrice, fillQty),
                        onCancel: (reason) => onChildCancel(sp, legSide, layer.idx, reason),
                    });
                    slots.push({ layerIdx: layer.idx, chaseId, qty: layer.qty, offsetPct: layer.offsetPct, reduceOnly });
                    console.log(`[Scalper ${sp.id}] ${legSide} layer ${layer.idx}: offset ${layer.offsetPct.toFixed(4)}%, qty ${layer.qty.toFixed(6)}, chaseId ${chaseId}${reduceOnly ? ' (reduceOnly)' : ''} [fallback]`);
                } catch (seqErr) {
                    console.error(`[Scalper ${sp.id}] Sequential fallback ${legSide} layer ${layer.idx} failed:`, seqErr.message);
                    slots.push({ layerIdx: layer.idx, chaseId: null, qty: layer.qty, offsetPct: layer.offsetPct, reduceOnly });
                }
            }
        }
    }

    // Sort slots by layerIdx to maintain consistent ordering
    slots.sort((a, b) => a.layerIdx - b.layerIdx);
    return slots;
}

/**
 * Arm the reduce-only leg for the first time.
 * Called after the first fill on the opening leg (normal mode only).
 * In neutral mode this is never called — both legs start non-reduce-only at launch.
 */
async function armReduceOnlyLeg(sp) {
    if (sp.status !== 'active') return; // scalper already stopped — don't spawn new chases
    if (sp.neutralMode) return; // neutral mode: no reduce-only leg
    if (sp._reduceOnlyArmed) return; // already started
    sp._reduceOnlyArmed = true;
    const roSide = sp.startSide === 'LONG' ? 'SHORT' : 'LONG'; // the closing side
    const offsets = generateLayerOffsets(
        roSide === 'LONG' ? sp.longOffsetPct : sp.shortOffsetPct,
        sp.childCount
    );
    const sizeUsd = roSide === 'LONG' ? sp.longSizeUsd : sp.shortSizeUsd;
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 1;
    const weights = generateSkewWeights(sp.childCount, sp.skew);
    const qtys = weights.map(w => (sizeUsd * w) / price);

    console.log(`[Scalper ${sp.id}] Arming reduce-only ${roSide} leg (first fill on opening leg)`);
    const slots = await startLeg(sp, roSide, offsets, qtys, true);

    if (sp.status !== 'active') {
        // Scalper stopped during startLeg. Cancel newly spawned chases.
        slots.forEach(s => s.chaseId && cancelChaseInternal(s.chaseId).catch(() => { }));
        return;
    }

    if (roSide === 'LONG') sp._longChases = slots;
    else sp._shortChases = slots;

    // Retry any slots that failed to start during startLeg
    slots.filter(s => !s.chaseId && !s.skippedNotional).forEach(s => restartSlot(sp, roSide, s, true, false));

    saveToRedis(sp);
    broadcastProgress(sp);
}

// Backoff config
const BACKOFF_BASE_MS = 2000;   // 2s initial
const BACKOFF_MAX_MS = 300000; // 5min cap

/**
 * Compute backoff delay: 2^retryCount * base, capped at max.
 */
function backoffDelay(retryCount) {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, retryCount), BACKOFF_MAX_MS);
}

/**
 * Compute fill-spread cooldown delay.
 * effectiveSpread decays exponentially toward 0 as time passes.
 * Returns how many ms to wait before the spread will be wide enough.
 */
function fillSpreadCooldownMs(sp, legSide, currentPrice) {
    const lastPrice = sp._lastFillPrice?.[legSide];
    const lastTime = sp._lastFillTime?.[legSide] || 0;
    if (!lastPrice || !currentPrice || sp.minFillSpreadPct <= 0) return 0;
    const elapsed = Date.now() - lastTime;
    const halfLife = sp.fillDecayHalfLifeMs || 30000;
    const decayFactor = Math.pow(0.5, elapsed / halfLife);
    const effectiveSpread = sp.minFillSpreadPct * decayFactor;
    const actualSpread = Math.abs(currentPrice - lastPrice) / lastPrice * 100;
    if (actualSpread >= effectiveSpread) return 0; // already wide enough
    // Time needed for effective spread to decay to actualSpread:
    //   actualSpread = minFillSpreadPct * 0.5^(t/halfLife)
    //   t = halfLife * log2(minFillSpreadPct / actualSpread)
    const remaining = halfLife * Math.log2(sp.minFillSpreadPct / Math.max(actualSpread, 0.0001)) - elapsed;
    return Math.max(0, Math.ceil(remaining));
}

/**
 * Compute fill-refill delay (exponential backoff per slot per side).
 * Exponent is capped at 4 (max 16× base delay) to prevent permanent side-silencing.
 */
function fillRefillDelayMs(sp, legSide) {
    if (!sp.minRefillDelayMs || sp.minRefillDelayMs <= 0) return 0;
    const count = Math.min(sp._fillRefillCount?.[legSide] || 0, 4); // cap at 2^4 = 16×
    return Math.min(sp.minRefillDelayMs * Math.pow(2, count), BACKOFF_MAX_MS);
}

/**
 * Check if a reduce-only slot should be held because the current position
 * loss exceeds maxLossPerCloseBps.
 * We compare the closing side's position entry price against the current
 * market price — if the unrealised loss in bps exceeds the cap, we refuse
 * to restart the reduce-only slot (avoiding a lock-in of a big drawdown).
 * @returns {boolean} true if the slot should be paused (loss too large)
 */
function isMaxLossExceeded(sp, legSide) {
    if (!sp.maxLossPerCloseBps || sp.maxLossPerCloseBps <= 0) return false;
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice;
    if (!price) return false;
    // The reduce-only slot closes the OPPOSITE side from its own leg
    // e.g. a SHORT reduce-only slot closes a SHORT position — the opening side.
    const openingSide = sp.startSide; // original position side
    if (legSide === openingSide) return false; // only guard the closing leg
    const entry = getPositionEntry(sp, openingSide);
    if (!entry || entry <= 0) return false;
    let lossBps = 0;
    if (openingSide === 'LONG') {
        // Long position: loss when price < entry
        lossBps = (entry - price) / entry * 10000;
    } else {
        // Short position: loss when price > entry
        lossBps = (price - entry) / entry * 10000;
    }
    return lossBps > sp.maxLossPerCloseBps;
}

/**
 * Check if the burst fill rate on this side exceeds maxFillsPerMinute.
 * Uses a sliding 60-second window of recent fill timestamps.
 * @returns {number} 0 if ok, or ms to wait until window clears
 */
function burstCooldownMs(sp, legSide) {
    if (!sp.maxFillsPerMinute || sp.maxFillsPerMinute <= 0) return 0;
    const now = Date.now();
    const WINDOW_MS = 60000;
    if (!sp._recentFillTimes) sp._recentFillTimes = {};
    if (!sp._recentFillTimes[legSide]) sp._recentFillTimes[legSide] = [];
    // Prune timestamps older than 60s
    sp._recentFillTimes[legSide] = sp._recentFillTimes[legSide].filter(t => now - t < WINDOW_MS);
    const count = sp._recentFillTimes[legSide].length;
    if (count < sp.maxFillsPerMinute) return 0;
    // Must wait until the oldest fill in the window ages out
    const oldest = sp._recentFillTimes[legSide][0];
    return Math.max(0, oldest + WINDOW_MS - now);
}

/**
 * Compute the realized PnL score for a slot in basis points per fill.
 * Only meaningful after at least MIN_FEEDBACK_FILLS closing fills.
 * @returns {number|null} bps per fill, or null if not enough data
 */
const MIN_FEEDBACK_FILLS = 3;  // require N closing fills before adapting
const SCORE_DECAY = 0.85;       // EMA decay applied to older fills (lower = faster adaptation)

function slotPnlScoreBps(slot, price) {
    if (!slot.fills || slot.fills < MIN_FEEDBACK_FILLS) return null;
    if (!slot.pnlSum || !price || price <= 0) return null;
    // avg PnL per fill in USD, convert to bps relative to current price * qty
    const avgPnlUsd = slot.pnlSum / slot.fills;
    const notional = (slot.qty || 0) * price;
    if (notional <= 0) return null;
    return (avgPnlUsd / notional) * 10000; // bps
}

/**
 * Compute an adaptive stalk offset based on this slot's PnL score.
 *
 * Logic:
 *  - score == null (not enough fills) → use base offset as-is
 *  - score > 0 (profitable): offset stays near base (reward = no change)
 *  - score < 0 (losing): widen offset by up to MAX_WIDEN_FACTOR
 *    scaled by how negative the score is relative to a TARGET_SPREAD_BPS
 *
 * The widening is capped at MAX_WIDEN_FACTOR× and cannot go below baseOffset
 * (we never tighten — a slot earning alpha already has the right offset).
 *
 * @returns {number} effective offset percentage to pass to startChaseInternal
 */
const TARGET_SPREAD_BPS = 30;  // bps — a slot earning below this is "underperforming"
const MAX_WIDEN_FACTOR = 2.5;  // worst-case: offset widened to 2.5× base

function adaptiveOffsetPct(sp, slot) {
    if (!sp.pnlFeedbackMode || sp.pnlFeedbackMode === 'off') return slot.offsetPct;
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 0;
    const score = slotPnlScoreBps(slot, price);
    if (score === null) return slot.offsetPct; // not enough fills yet

    if (score >= 0) {
        // Profitable or break-even — don't touch the offset
        return slot.offsetPct;
    }

    // Negative score: widen proportionally
    // widen factor: 1 + (|score| / TARGET_SPREAD_BPS) capped at MAX_WIDEN_FACTOR
    const deficit = Math.min(Math.abs(score), TARGET_SPREAD_BPS * (MAX_WIDEN_FACTOR - 1));
    const factor = 1 + deficit / TARGET_SPREAD_BPS;
    const widened = slot.offsetPct * Math.min(factor, MAX_WIDEN_FACTOR);
    return widened;
}

/**
 * In 'full' feedback mode, also scale down qty for underperforming slots.
 * Returns a scale factor 0.5–1.0 applied to slot.qty.
 */
function adaptiveQtyFactor(sp, slot) {
    if (sp.pnlFeedbackMode !== 'full') return 1;
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 0;
    const score = slotPnlScoreBps(slot, price);
    if (score === null || score >= 0) return 1;
    // Scale down by up to 50% for the worst performers
    const deficit = Math.min(Math.abs(score), TARGET_SPREAD_BPS);
    return Math.max(0.5, 1 - (deficit / TARGET_SPREAD_BPS) * 0.5);
}

/**
 * Get the current position entry price for a leg side, used for allowLoss pinning.
 * Returns the entry price or null.
 */
function getPositionEntry(sp, legSide) {
    try {
        const bookEntry = riskEngine.book.getEntry(sp.subAccountId);
        if (!bookEntry) return null;
        for (const [, pos] of bookEntry.positions) {
            if (pos.symbol === sp.symbol && pos.side === legSide && pos.status === 'OPEN') {
                return pos.entryPrice || null;
            }
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Get the current position quantity for a leg side, used for neutral accumulation guard.
 */
function getPositionQty(sp, legSide) {
    try {
        const bookEntry = riskEngine.book.getEntry(sp.subAccountId);
        if (!bookEntry) return 0;
        for (const [, pos] of bookEntry.positions) {
            if (pos.symbol === sp.symbol && pos.side === legSide && pos.status === 'OPEN') {
                return pos.quantity || 0;
            }
        }
    } catch { /* ignore */ }
    return 0;
}

/**
 * Check if the current price is within the allowed range for a leg.
 * When allowLoss=false, pins the effective boundary to the position entry.
 * When pinLongToEntry=true, the LONG leg is pinned to the current long position entry, and the SHORT (unwind) leg is restricted from selling below the long entry.
 * When pinShortToEntry=true, the SHORT leg is pinned to the current short position entry, and the LONG (unwind) leg is restricted from buying above the short entry.
 * @returns {boolean} true if the slot can be placed
 */
function isPriceAllowed(sp, legSide) {
    const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice;
    if (!price) return true; // can't check → allow

    // Compute effective price bounds
    let effectiveLongMax = sp.longMaxPrice || null;
    let effectiveShortMin = sp.shortMinPrice || null;

    const longEntry = getPositionEntry(sp, 'LONG');
    const shortEntry = getPositionEntry(sp, 'SHORT');

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

    // Legacy fallback/addition (allowLoss=false)
    if (!sp.allowLoss) {
        if (legSide === 'LONG' && shortEntry && shortEntry > 0) {
            effectiveLongMax = effectiveLongMax ? Math.min(effectiveLongMax, shortEntry) : shortEntry;
        }
        if (legSide === 'SHORT' && longEntry && longEntry > 0) {
            effectiveShortMin = effectiveShortMin ? Math.max(effectiveShortMin, longEntry) : longEntry;
        }
    }

    if (legSide === 'LONG' && effectiveLongMax && price > effectiveLongMax) {
        console.log(`[Scalper ${sp.id}] LONG layer paused — price $${price} > max $${effectiveLongMax}${!sp.allowLoss || sp.pinLongToEntry || sp.pinShortToEntry ? ' (entry pin)' : ''}`);
        return false;
    }
    if (legSide === 'SHORT' && effectiveShortMin && price < effectiveShortMin) {
        console.log(`[Scalper ${sp.id}] SHORT layer paused — price $${price} < min $${effectiveShortMin}${!sp.allowLoss || sp.pinLongToEntry || sp.pinShortToEntry ? ' (entry pin)' : ''}`);
        return false;
    }
    return true;
}

/**
 * Restart a single child chase slot after it was filled or cancelled.
 * Implements exponential backoff on exchange errors and price-filter pause.
 * @param {boolean} isFillRestart - true when triggered by onChildFill (vs cancel/error retry)
 */
async function restartSlot(sp, legSide, slot, isRetry = false, isFillRestart = false) {
    if (sp.status !== 'active') return;

    // Per-slot lock: prevent concurrent restarts for the same slot (race guard)
    if (slot._restarting) return;
    slot._restarting = true;

    const timerKey = `${sp.id}:${legSide}:${slot.layerIdx}`;

    try {
        // ── Fill spread guard ─────────────────────────────────────
        // After a fill on this side, don't re-place at nearly the same price.
        // The cooldown decays exponentially, re-allowing trading gradually.
        if (isFillRestart && sp.minFillSpreadPct > 0) {
            const price = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 0;
            const waitMs = fillSpreadCooldownMs(sp, legSide, price);
            if (waitMs > 0) {
                slot.chaseId = null;
                slot.paused = true;
                slot.retryAt = Date.now() + waitMs;
                slot.pauseReason = 'fill_spread';
                console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} fill-spread cooldown — retry in ${(waitMs / 1000).toFixed(1)}s`);
                broadcastProgress(sp);
                const tid = setTimeout(() => {
                    _slotTimers.delete(timerKey);
                    slot.pauseReason = null;
                    if (sp.status === 'active') restartSlot(sp, legSide, slot, true, true);
                }, waitMs);
                _slotTimers.set(timerKey, tid);
                return;
            }
        }

        // ── Burst fill guard ──────────────────────────────────────
        // If this side has exceeded maxFillsPerMinute, pause until the oldest
        // fill in the rolling 60s window ages out.
        if (isFillRestart) {
            const waitMs = burstCooldownMs(sp, legSide);
            if (waitMs > 0) {
                slot.chaseId = null;
                slot.paused = true;
                slot.retryAt = Date.now() + waitMs;
                slot.pauseReason = 'burst_limit';
                console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} burst limit (${sp.maxFillsPerMinute}/min) — pause ${(waitMs / 1000).toFixed(1)}s`);
                broadcastProgress(sp);
                const tid = setTimeout(() => {
                    _slotTimers.delete(timerKey);
                    slot.pauseReason = null;
                    if (sp.status === 'active') restartSlot(sp, legSide, slot, true, false);
                }, waitMs);
                _slotTimers.set(timerKey, tid);
                return;
            }
        }

        // ── Fill refill delay (exponential backoff per side) ──────
        if (isFillRestart && sp.minRefillDelayMs > 0) {
            const delayMs = fillRefillDelayMs(sp, legSide);
            if (delayMs > 0) {
                slot.chaseId = null;
                slot.paused = true;
                slot.retryAt = Date.now() + delayMs;
                slot.pauseReason = 'refill_delay';
                console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} refill backoff — ${(delayMs / 1000).toFixed(1)}s (fill #${sp._fillRefillCount?.[legSide] || 0})`);
                broadcastProgress(sp);
                const tid = setTimeout(() => {
                    _slotTimers.delete(timerKey);
                    slot.pauseReason = null;
                    // Increment refill count for next backoff computation BEFORE restart
                    if (sp._fillRefillCount) sp._fillRefillCount[legSide] = (sp._fillRefillCount[legSide] || 0) + 1;
                    if (sp.status === 'active') restartSlot(sp, legSide, slot, true, false);
                }, delayMs);
                _slotTimers.set(timerKey, tid);
                return;
            }
        }

        // Use the reduceOnly flag stored on the slot at creation time.
        // NEVER re-derive it from legSide/startSide — that's what caused wrong-side fills.
        // slot.reduceOnly is set once in startLeg and is immutable.
        const reduceOnly = slot.reduceOnly ?? (legSide === 'LONG' ? sp.startSide === 'SHORT' : sp.startSide === 'LONG');

        // ── Neutral Mode Accumulation Guard ───────────────────────
        if (sp.neutralMode && !reduceOnly) {
            const configuredSizeUsd = legSide === 'LONG' ? sp.longSizeUsd : sp.shortSizeUsd;
            const maxSizeUsd = configuredSizeUsd * 2.0; // Cap accumulation at 2x base budget
            const currentQty = getPositionQty(sp, legSide);
            const currentPrice = exchange.getLatestPrice(sp.symbol) || sp._lastKnownPrice || 0;
            const currentNotional = currentQty * currentPrice;

            if (currentNotional > maxSizeUsd) {
                slot.chaseId = null;
                slot.paused = true;
                slot.retryAt = Date.now() + 10000;
                slot.pauseReason = 'neutral_inventory_full';
                console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} neutral-guard — pos $${currentNotional.toFixed(0)} > max $${maxSizeUsd.toFixed(0)} — holding 10s`);
                broadcastProgress(sp);
                const tid = setTimeout(() => {
                    _slotTimers.delete(timerKey);
                    slot.pauseReason = null;
                    if (sp.status === 'active') restartSlot(sp, legSide, slot, true);
                }, 10000);
                _slotTimers.set(timerKey, tid);
                return;
            }
        }

        // ── Price filter check ────────────────────────────────────
        // Pause this slot if market has moved outside allowed range
        if (!isPriceAllowed(sp, legSide)) {
            slot.chaseId = null;
            slot.paused = true;
            slot.retryAt = Date.now() + 30000; // re-check in 30s
            slot.pauseReason = 'price_filter';
            broadcastProgress(sp);
            const tid = setTimeout(() => {
                _slotTimers.delete(timerKey);
                slot.pauseReason = null;
                if (sp.status === 'active') restartSlot(sp, legSide, slot, true);
            }, 30000);
            _slotTimers.set(timerKey, tid);
            return;
        }

        slot.paused = false;

        // Explicit safety assertion: log loudly if a non-reduceOnly restart is about
        // to place an order on the wrong side (opening side should never be the other leg).
        if (!reduceOnly && legSide !== sp.startSide) {
            console.error(`[Scalper ${sp.id}] SAFETY BLOCK: refusing non-reduceOnly ${legSide} restart — startSide=${sp.startSide}. Slot marked paused.`);
            slot.paused = true;
            broadcastProgress(sp);
            return;
        }

        // ── Max loss per close guard ──────────────────────────────
        // If the position loss exceeds maxLossPerCloseBps, don't fire the
        // reduce-only closer right now — wait 30s and re-check.
        // This prevents locking in a large drawdown via hasty limit-close.
        if (reduceOnly && isMaxLossExceeded(sp, legSide)) {
            slot.chaseId = null;
            slot.paused = true;
            slot.retryAt = Date.now() + 30000;
            slot.pauseReason = 'max_loss_guard';
            const price = exchange.getLatestPrice(sp.symbol) || 0;
            console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} max-loss guard (>${sp.maxLossPerCloseBps}bps) @ $${price} — holding 30s`);
            broadcastProgress(sp);
            const tid = setTimeout(() => {
                _slotTimers.delete(timerKey);
                slot.pauseReason = null;
                if (sp.status === 'active') restartSlot(sp, legSide, slot, true);
            }, 30000);
            _slotTimers.set(timerKey, tid);
            return;
        }

        try {
            // ── PnL feedback: adapt offset (and optionally qty) based on this slot's history
            const effectiveOffset = adaptiveOffsetPct(sp, slot);
            const qtyFactor = adaptiveQtyFactor(sp, slot);
            let effectiveQty = slot.qty * qtyFactor;

            // ── Reduce-only Dust Close Exception ───────────────────────────────
            // Binance rejects < $5 orders UNLESS the quantity exactly matches the remaining position
            if (reduceOnly) {
                const price = exchange.getLatestPrice(sp.symbol) || 0;
                if (price > 0 && effectiveQty * price < MIN_NOTIONAL_USD) {
                    const posSide = legSide === 'LONG' ? 'SHORT' : 'LONG';
                    const currentQty = getPositionQty(sp, posSide);

                    if (currentQty === 0) {
                        console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} reduce-only skip — no position exists`);
                        slot.paused = true;
                        slot.retryAt = null;
                        slot.pauseReason = 'no_position';
                        broadcastProgress(sp);
                        return;
                    } else {
                        effectiveQty = currentQty;
                        console.log(`[Scalper ${sp.id}] ${legSide} layer ${slot.layerIdx} dust override — sizing exactly ${currentQty} to bypass MIN_NOTIONAL`);
                    }
                }
            }

            if (sp.pnlFeedbackMode && sp.pnlFeedbackMode !== 'off') {
                const price = exchange.getLatestPrice(sp.symbol) || 0;
                const score = slotPnlScoreBps(slot, price);
                if (score !== null && (effectiveOffset !== slot.offsetPct || qtyFactor !== 1)) {
                    console.log(`[Scalper ${sp.id}] ${legSide} L${slot.layerIdx} feedback [${sp.pnlFeedbackMode}] score=${score.toFixed(1)}bps offset ${slot.offsetPct.toFixed(3)}%→${effectiveOffset.toFixed(3)}% qty×${qtyFactor.toFixed(2)}`);
                }
            }

            // Final status check right before placing exchange order —
            // closes the window between the initial check (line 470) and this async call.
            if (sp.status !== 'active') return;

            const { chaseId } = await startChaseInternal({
                subAccountId: sp.subAccountId,
                symbol: sp.symbol,
                side: legSide,
                quantity: effectiveQty,
                leverage: sp.leverage,
                stalkOffsetPct: effectiveOffset,
                stalkMode: 'maintain',
                maxDistancePct: 0,
                orderType: 'SCALPER_LIMIT',
                reduceOnly,
                parentScalperId: sp.id,
                internal: false,
                onFill: (fillPrice, fillQty) => onChildFill(sp, legSide, slot.layerIdx, fillPrice, fillQty),
                onCancel: (reason) => onChildCancel(sp, legSide, slot.layerIdx, reason),
            });

            // Post-await status guard: finishScalper may have run while we were awaiting.
            // If so, immediately cancel the just-spawned chase and bail out.
            if (sp.status !== 'active') {
                cancelChaseInternal(chaseId).catch(() => { });
                return;
            }

            slot.chaseId = chaseId;
            slot.retryCount = 0; // reset backoff on success
            slot.retryAt = null;
            // Reset fill-refill backoff counter on successful restart so
            // the delay doesn't grow unboundedly and silence a side permanently.
            if (sp._fillRefillCount) sp._fillRefillCount[legSide] = 0;
            console.log(`[Scalper ${sp.id}] ${isRetry ? 'Re-' : ''}Started ${legSide} layer ${slot.layerIdx}: chaseId ${chaseId}`);
            saveToRedis(sp);
            broadcastProgress(sp);
        } catch (err) {
            slot.chaseId = null;
            slot.retryCount = (slot.retryCount || 0) + 1;
            const delay = backoffDelay(slot.retryCount - 1);
            slot.retryAt = Date.now() + delay;
            console.error(`[Scalper ${sp.id}] Restart ${legSide} layer ${slot.layerIdx} failed (attempt ${slot.retryCount}), retrying in ${(delay / 1000).toFixed(0)}s:`, err.message);
            broadcastProgress(sp);
            const tid = setTimeout(() => {
                _slotTimers.delete(timerKey);
                if (sp.status === 'active') restartSlot(sp, legSide, slot, true);
            }, delay);
            _slotTimers.set(timerKey, tid);
        }
    } finally {
        slot._restarting = false;
    }
}

/** Called when a child chase fills. */
async function onChildFill(sp, legSide, layerIdx, fillPrice, fillQty) {
    if (!activeScalpers.has(sp.id)) return;
    if (sp.status !== 'active') return; // scalper stopped mid-flight — don't restart or arm
    const slots = legSide === 'LONG' ? sp._longChases : sp._shortChases;
    const slot = slots?.find(s => s.layerIdx === layerIdx);
    if (!slot) return;
    slot.chaseId = null; // clear before restart

    const now = Date.now();

    // Track fill price/time/count per side for spread guard and refill backoff
    if (!sp._lastFillPrice) sp._lastFillPrice = {};
    if (!sp._lastFillTime) sp._lastFillTime = {};
    if (!sp._fillRefillCount) sp._fillRefillCount = {};
    if (!sp._recentFillTimes) sp._recentFillTimes = {};
    sp._lastFillPrice[legSide] = fillPrice;
    sp._lastFillTime[legSide] = now;
    // Record timestamp for burst guard (sliding window)
    if (!sp._recentFillTimes[legSide]) sp._recentFillTimes[legSide] = [];
    sp._recentFillTimes[legSide].push(now);
    // _fillRefillCount is incremented inside the refill-delay callback (after delay elapses)

    // ── Per-slot fill quality stats ───────────────────────────
    // Accumulate per-slot fill counts and (for closing fills) estimate PnL
    // from the open position entry price vs. fill price.
    const isOpeningLeg = legSide === sp.startSide;
    slot.fills = (slot.fills || 0) + 1;
    if (slot.lastFilledAt) {
        slot.holdMsSum = (slot.holdMsSum || 0) + (now - slot.lastFilledAt);
    }
    slot.lastFilledAt = now;
    if (!isOpeningLeg) {
        // Closing fill — estimate realised PnL from the opening side's position entry
        try {
            const entry = getPositionEntry(sp, sp.startSide);
            if (entry && entry > 0) {
                const pnlPerUnit = sp.startSide === 'LONG' ? (fillPrice - entry) : (entry - fillPrice);
                const fillPnl = pnlPerUnit * fillQty;
                // EMA update: blend new fill PnL with accumulated total
                // pnlSum keeps the running total; pnlScore is updated via EMA
                slot.pnlSum = (slot.pnlSum || 0) + fillPnl;
                // Update EMA-smoothed pnl score in bps for feedback loop
                const price = exchange.getLatestPrice(sp.symbol) || fillPrice;
                const notional = slot.qty * price;
                if (notional > 0) {
                    const fillBps = (fillPnl / notional) * 10000;
                    if (slot.pnlScoreEma == null) {
                        slot.pnlScoreEma = fillBps; // seed on first fill
                    } else {
                        slot.pnlScoreEma = SCORE_DECAY * slot.pnlScoreEma + (1 - SCORE_DECAY) * fillBps;
                    }
                }
            }
        } catch { /* never block fill flow */ }
    }

    console.log(`[Scalper ${sp.id}] ${legSide} layer ${layerIdx} filled @ $${fillPrice} qty ${fillQty}${isOpeningLeg ? ' (opening)' : ' (closing)'} [slot fills=${slot.fills}]`);
    broadcast('scalper_filled', {
        scalperId: sp.id,
        subAccountId: sp.subAccountId,
        symbol: sp.symbol,
        side: legSide,
        layerIdx,
        fillPrice,
        fillQty,
    });

    // Emit position_updated immediately from the in-memory book so the compact
    // positions panel reflects the new size/qty without waiting for a REST refresh.
    try {
        const bookEntry = riskEngine.book.getEntry(sp.subAccountId);
        if (bookEntry) {
            for (const [posId, pos] of bookEntry.positions) {
                if (pos.symbol === sp.symbol) {
                    broadcast('position_updated', {
                        subAccountId: sp.subAccountId,
                        positionId: posId,
                        symbol: pos.symbol,
                        side: pos.side,
                        entryPrice: pos.entryPrice,
                        quantity: pos.quantity,
                        notional: pos.notional,
                        leverage: pos.leverage,
                        margin: pos.margin,
                        liquidationPrice: pos.liquidationPrice || 0,
                    });
                }
            }
        }
    } catch { /* never block fill flow */ }

    sp.fillCount = (sp.fillCount || 0) + 1;

    // In neutral mode both legs are already running (non-reduceOnly).
    // In normal mode: first fill on opening leg → arm the reduce-only (closing) leg.
    if (!sp.neutralMode && isOpeningLeg && !sp._reduceOnlyArmed) {
        await armReduceOnlyLeg(sp);
    }

    // Auto-restart this slot — isFillRestart=true enables spread guard + refill backoff
    await restartSlot(sp, legSide, slot, false, true);
}

/** Called when a child chase is cancelled externally (distance breach etc). */
function onChildCancel(sp, legSide, layerIdx, reason) {
    if (!activeScalpers.has(sp.id)) return;
    const slots = legSide === 'LONG' ? sp._longChases : sp._shortChases;
    const slot = slots?.find(s => s.layerIdx === layerIdx);
    if (slot) {
        slot.chaseId = null;
        // Terminal reasons: exchange rejected the order for a structural reason —
        // don't loop forever (e.g. reduce-only rejected because position is gone).
        const TERMINAL_REASONS = [
            'reduce_only_reject', 'position_gone', 'insufficient_margin',
            'margin is insufficient', 'ReduceOnly Order is rejected',
            // Binance notional/qty errors — means position is dust, don't loop
            'notional must be no smaller', '-4164', 'Order does not meet minimum',
            'minimum quantity', 'minimum notional',
        ];
        const isTerminal = TERMINAL_REASONS.some(t => reason?.toLowerCase?.().includes(t.toLowerCase()));

        // If it wasn't cancelled by us (finishScalper), restart it
        // isTerminal errors get a slow 30s backoff rather than dying permanently.
        // isFillRestart=false: cancel restarts don't count as fills → no spread/backoff guard
        if (sp.status === 'active' && reason !== 'cancelled') {
            const delay = isTerminal ? 30000 : 2000;
            console.log(`[Scalper ${sp.id}] ${legSide} layer ${layerIdx} auto-cancelled (${reason}), restarting in ${delay / 1000}s...`);
            const timerKey = `${sp.id}:${legSide}:${layerIdx}`;
            // Dedup: clear any existing pending restart timer for this slot before
            // scheduling a new one. Without this, rapid cancel/reprice cycles stack
            // up multiple restartSlot calls → multiple leaked chases per slot.
            const existingTid = _slotTimers.get(timerKey);
            if (existingTid) clearTimeout(existingTid);
            const tid = setTimeout(() => {
                _slotTimers.delete(timerKey);
                restartSlot(sp, legSide, slot, false, false);
            }, delay);
            _slotTimers.set(timerKey, tid);
        }
    }
}

// ── Broadcast ─────────────────────────────────────────────────
// Broadcasts a lightweight scalper_progress event used by the
// open-orders panel to update the parent row's fill count and layer status.
function broadcastProgress(sp) {
    const mapSlot = s => ({
        layerIdx: s.layerIdx,
        offsetPct: s.offsetPct,
        qty: s.qty,
        active: !!s.chaseId,
        paused: !!s.paused,
        retryAt: s.retryAt || null,
        retryCount: s.retryCount || 0,
        pauseReason: s.pauseReason || null,
        // Fill quality stats
        fills: s.fills || 0,
        pnlSum: s.pnlSum != null ? +s.pnlSum.toFixed(6) : null,
        pnlScoreEma: s.pnlScoreEma != null ? +s.pnlScoreEma.toFixed(2) : null,
        avgHoldMs: s.fills && s.holdMsSum ? Math.round(s.holdMsSum / s.fills) : null,
    });
    broadcast('scalper_progress', {
        scalperId: sp.id,
        subAccountId: sp.subAccountId,
        symbol: sp.symbol,
        startSide: sp.startSide,
        status: sp.status,
        fillCount: sp.fillCount || 0,
        longMaxPrice: sp.longMaxPrice || null,
        shortMinPrice: sp.shortMinPrice || null,
        neutralMode: !!sp.neutralMode,
        minFillSpreadPct: sp.minFillSpreadPct || 0,
        fillDecayHalfLifeMs: sp.fillDecayHalfLifeMs || 30000,
        minRefillDelayMs: sp.minRefillDelayMs || 0,
        allowLoss: sp.allowLoss ?? true,
        maxLossPerCloseBps: sp.maxLossPerCloseBps || 0,
        maxFillsPerMinute: sp.maxFillsPerMinute || 0,
        pnlFeedbackMode: sp.pnlFeedbackMode || 'off',
        longSlots: (sp._longChases || []).map(mapSlot),
        shortSlots: (sp._shortChases || []).map(mapSlot),
        startedAt: sp.startedAt,
    });
}

// ── Finish ────────────────────────────────────────────────────

async function finishScalper(sp, reason, { closePositions = false } = {}) {
    if (sp.status === 'stopped') return; // already stopping
    sp.status = 'stopped';

    console.log(`[Scalper ${sp.id}] Stopping: ${reason}${closePositions ? ' (will close positions)' : ''}`);

    // Clear all pending slot retry timers so no delayed restarts fire after stop
    for (const [key, tid] of _slotTimers) {
        if (key.startsWith(sp.id + ':')) {
            clearTimeout(tid);
            _slotTimers.delete(key);
        }
    }

    // Cancel all active child chases
    const allSlots = [...(sp._longChases || []), ...(sp._shortChases || [])];
    await Promise.allSettled(
        allSlots
            .filter(s => s.chaseId)
            .map(s => cancelChaseInternal(s.chaseId).catch(err =>
                console.warn(`[Scalper ${sp.id}] Cancel child ${s.chaseId} error:`, err.message)
            ))
    );

    // Second sweep: catch chases spawned by in-flight restartSlots during the first cancel wave
    const lateSlots = [...(sp._longChases || []), ...(sp._shortChases || [])];
    await Promise.allSettled(
        lateSlots
            .filter(s => s.chaseId)
            .map(s => cancelChaseInternal(s.chaseId).catch(err =>
                console.warn(`[Scalper ${sp.id}] Late cancel child ${s.chaseId}:`, err.message)
            ))
    );

    // Optionally close any open positions on this symbol
    if (closePositions) {
        try {
            const openPositions = await prisma.virtualPosition.findMany({
                where: { subAccountId: sp.subAccountId, symbol: sp.symbol, status: 'OPEN' },
            });
            for (const pos of openPositions) {
                try {
                    await riskEngine.closePosition(pos.id, 'SCALPER_CLEANUP');
                    console.log(`[Scalper ${sp.id}] Closed position ${pos.id} (${pos.symbol} ${pos.side})`);
                } catch (err) {
                    console.warn(`[Scalper ${sp.id}] Failed to close position ${pos.id}:`, err.message);
                }
            }
        } catch (err) {
            console.warn(`[Scalper ${sp.id}] Error closing positions:`, err.message);
        }
    }

    activeScalpers.delete(sp.id);
    deleteFromRedis(sp.id);

    broadcast('scalper_cancelled', {
        scalperId: sp.id,
        subAccountId: sp.subAccountId,
        symbol: sp.symbol,
        reason,
    });
}

// ── Internal API ──────────────────────────────────────────────

/**
 * Start a scalper programmatically (used by other algos if needed).
 */
export async function startScalperInternal(opts) {
    return _startScalperCore(opts);
}

export async function cancelScalperInternal(scalperId) {
    const sp = activeScalpers.get(scalperId);
    if (!sp) return;
    await finishScalper(sp, 'cancelled', { closePositions: false });
}

// ── Core start logic ──────────────────────────────────────────

async function _startScalperCore(opts) {
    const {
        subAccountId, symbol, startSide, leverage,
        longOffsetPct, shortOffsetPct,
        childCount = 1, skew = 0,
        longSizeUsd, shortSizeUsd,
        longMaxPrice,              // LONG chase won't restart above this price
        shortMinPrice,             // SHORT chase won't restart below this price
        pinLongToEntry = false,
        pinShortToEntry = false,
        neutralMode = false,       // if true: both legs non-reduceOnly, no forced close
        minFillSpreadPct = 0,      // min % spread from last fill before re-placing same side
        fillDecayHalfLifeMs = 30000, // half-life for spread cooldown decay (ms)
        minRefillDelayMs = 0,      // base delay after a fill restart (ms)
        allowLoss = true,          // if false: pin short min/long max to position entry
        maxLossPerCloseBps = 0,    // pause reduce-only restarts when loss > N bps
        maxFillsPerMinute = 0,     // max fills per side per 60s window (0 = unlimited)
        pnlFeedbackMode = 'off',   // 'off' | 'soft' (offset only) | 'full' (offset + qty)
    } = opts;

    if (!subAccountId || !symbol || !startSide || !leverage) {
        throw new Error('Missing required fields: subAccountId, symbol, startSide, leverage');
    }

    const parsedLeverage = parseInt(leverage);
    const parsedLongOff = Math.max(0, Math.min(10, parseFloat(longOffsetPct) || 0));
    const parsedShortOff = Math.max(0, Math.min(10, parseFloat(shortOffsetPct) || 0));
    const parsedCount = Math.max(1, Math.min(10, parseInt(childCount) || 1));
    const parsedSkew = Math.max(-100, Math.min(100, parseInt(skew) || 0));
    const parsedLongSz = Math.max(0, parseFloat(longSizeUsd) || 0);
    const parsedShortSz = Math.max(0, parseFloat(shortSizeUsd) || 0);

    // Get current price for quantity computation
    let price = exchange.getLatestPrice(symbol);
    if (!price || price <= 0) {
        try {
            const ticker = await exchange.fetchTicker(symbol);
            price = Number(ticker?.last || ticker?.bid);
        } catch { /* ignore */ }
    }
    if (!price || price <= 0) throw new Error(`Cannot get price for ${symbol}`);

    // Set leverage once
    await exchange.setLeverage(symbol, parsedLeverage);

    // Compute layer offsets and size distribution
    const longOffsets = generateLayerOffsets(parsedLongOff, parsedCount);
    const shortOffsets = generateLayerOffsets(parsedShortOff, parsedCount);
    const weights = generateSkewWeights(parsedCount, parsedSkew);

    const longQtys = weights.map(w => (parsedLongSz * w) / price);
    const shortQtys = weights.map(w => (parsedShortSz * w) / price);

    // Hard block: validate every opening-leg layer meets Binance min notional ($5)
    // (reduce-only leg is deferred — validated when it arms after the first fill)
    const openingSideCheck = startSide.toUpperCase();
    const openingQtysCheck = openingSideCheck === 'LONG' ? longQtys : shortQtys;
    const minOpeningNotional = Math.min(...openingQtysCheck.map(q => q * price));
    if (minOpeningNotional < MIN_NOTIONAL_USD) {
        const worstLayer = openingQtysCheck.findIndex(q => q * price < MIN_NOTIONAL_USD);
        const worstNotional = (openingQtysCheck[worstLayer] * price).toFixed(2);
        throw new Error(
            `Layer ${worstLayer} notional is $${worstNotional} (< $${MIN_NOTIONAL_USD} minimum). ` +
            `Increase total size or reduce child count. ` +
            `Minimum opening-side size: $${(MIN_NOTIONAL_USD * parsedCount / weights[worstLayer]).toFixed(2)}`
        );
    }

    // Determine reduce-only per leg (unused at start, kept for reference)
    const longReduceOnly = startSide === 'SHORT';
    const shortReduceOnly = startSide === 'LONG';
    void longReduceOnly; void shortReduceOnly;

    if (activeScalpers.size >= MAX_ACTIVE_SCALPERS) {
        throw new Error(`Maximum concurrent scalpers (${MAX_ACTIVE_SCALPERS}) reached`);
    }

    // Optional price filter
    const parsedLongMax = longMaxPrice && Number.isFinite(+longMaxPrice) && +longMaxPrice > 0 ? +longMaxPrice : null;
    const parsedShortMin = shortMinPrice && Number.isFinite(+shortMinPrice) && +shortMinPrice > 0 ? +shortMinPrice : null;

    // Parse anti-overtrading settings
    const parsedNeutral = !!neutralMode;
    const parsedFillSpread = Math.max(0, Math.min(10, parseFloat(minFillSpreadPct) || 0));
    const parsedDecayHalfLife = Math.max(1000, Math.min(3600000, parseInt(fillDecayHalfLifeMs) || 30000));
    const parsedRefillDelay = Math.max(0, Math.min(300000, parseInt(minRefillDelayMs) || 0));
    const parsedAllowLoss = allowLoss !== false && allowLoss !== 'false';
    const parsedMaxLossBps = Math.max(0, Math.min(10000, parseInt(maxLossPerCloseBps) || 0));
    const parsedMaxFillsPm = Math.max(0, Math.min(100, parseInt(maxFillsPerMinute) || 0));
    const validFeedback = ['off', 'soft', 'full'];
    const parsedFeedback = validFeedback.includes(pnlFeedbackMode) ? pnlFeedbackMode : 'off';

    const id = generateId();
    const sp = {
        id,
        subAccountId,
        symbol,
        startSide: startSide.toUpperCase(),
        leverage: parsedLeverage,
        longOffsetPct: parsedLongOff,
        shortOffsetPct: parsedShortOff,
        childCount: parsedCount,
        skew: parsedSkew,
        longSizeUsd: parsedLongSz,
        shortSizeUsd: parsedShortSz,
        longMaxPrice: parsedLongMax,
        shortMinPrice: parsedShortMin,
        pinLongToEntry: !!pinLongToEntry,
        pinShortToEntry: !!pinShortToEntry,
        neutralMode: parsedNeutral,
        minFillSpreadPct: parsedFillSpread,
        fillDecayHalfLifeMs: parsedDecayHalfLife,
        minRefillDelayMs: parsedRefillDelay,
        allowLoss: parsedAllowLoss,
        maxLossPerCloseBps: parsedMaxLossBps,
        maxFillsPerMinute: parsedMaxFillsPm,
        pnlFeedbackMode: parsedFeedback,
        status: 'active',
        fillCount: 0,
        startedAt: Date.now(),
        _reduceOnlyArmed: parsedNeutral, // neutral mode: treat as already armed (both legs open)
        _lastKnownPrice: price,
        _longChases: [],
        _shortChases: [],
        _lastFillPrice: {},
        _lastFillTime: {},
        _fillRefillCount: {},
        _recentFillTimes: {},
    };

    activeScalpers.set(id, sp);

    console.log(`[Scalper ${id}] Starting: ${symbol} startSide=${startSide}, ${parsedCount} layers/leg, long offset ${parsedLongOff}%, short offset ${parsedShortOff}%${parsedNeutral ? ' [NEUTRAL]' : ''}`);

    const openingSide = startSide.toUpperCase();
    const openingOffsets = openingSide === 'LONG' ? longOffsets : shortOffsets;
    const openingQtys = openingSide === 'LONG' ? longQtys : shortQtys;

    const openingSlots = await startLeg(sp, openingSide, openingOffsets, openingQtys, false);

    if (sp.status !== 'active') {
        openingSlots.forEach(s => s.chaseId && cancelChaseInternal(s.chaseId).catch(() => { }));
        throw new Error('Scalper was cancelled during startup');
    }

    if (openingSide === 'LONG') {
        sp._longChases = openingSlots;
    } else {
        sp._shortChases = openingSlots;
    }

    // Retry any slots that failed to start
    openingSlots.filter(s => !s.chaseId && !s.skippedNotional).forEach(s => restartSlot(sp, openingSide, s, true, false));

    let otherSlots = [];
    if (parsedNeutral) {
        // Neutral mode: start BOTH legs immediately, both non-reduceOnly
        const otherSide = openingSide === 'LONG' ? 'SHORT' : 'LONG';
        const otherOffsets = otherSide === 'LONG' ? longOffsets : shortOffsets;
        const otherQtys = otherSide === 'LONG' ? longQtys : shortQtys;
        otherSlots = await startLeg(sp, otherSide, otherOffsets, otherQtys, false);

        if (sp.status !== 'active') {
            otherSlots.forEach(s => s.chaseId && cancelChaseInternal(s.chaseId).catch(() => { }));
            return sp; // or throw, but returning handles it since we already deleted it
        }

        if (otherSide === 'LONG') sp._longChases = otherSlots;
        else sp._shortChases = otherSlots;

        otherSlots.filter(s => !s.chaseId && !s.skippedNotional).forEach(s => restartSlot(sp, otherSide, s, true, false));
        console.log(`[Scalper ${id}] Neutral: both legs active (non-reduceOnly)`);
    } else {
        // Normal mode: reduce-only leg deferred until first fill
        if (openingSide === 'LONG') sp._shortChases = [];
        else sp._longChases = [];
    }

    saveToRedis(sp);
    broadcastProgress(sp);

    const totalOpening = openingSlots.filter(s => s.chaseId).length;
    const totalOther = otherSlots.filter(s => s.chaseId).length;
    if (parsedNeutral) {
        console.log(`[Scalper ${id}] Active: ${totalOpening} ${openingSide} + ${totalOther} ${openingSide === 'LONG' ? 'SHORT' : 'LONG'} layers`);
    } else {
        console.log(`[Scalper ${id}] Active: ${totalOpening} ${openingSide} layers (reduce-only leg deferred until first fill)`);
    }

    return {
        scalperId: id,
        symbol,
        startSide,
        childCount: parsedCount,
        neutralMode: parsedNeutral,
        longLayers: (openingSide === 'LONG' ? totalOpening : totalOther),
        shortLayers: (openingSide === 'SHORT' ? totalOpening : totalOther),
        longOffsetPct: parsedLongOff,
        shortOffsetPct: parsedShortOff,
        cancel: () => cancelScalperInternal(id),
    };
}

// ── Routes ────────────────────────────────────────────────────

// POST /api/trade/scalper — Start a scalper
router.post('/scalper', requireOwnership('body'), async (req, res) => {
    try {
        const {
            subAccountId, symbol, startSide, leverage,
            longOffsetPct, shortOffsetPct,
            childCount, skew,
            longSizeUsd, shortSizeUsd,
            longMaxPrice, shortMinPrice,
            // Anti-overtrading / neutral mode settings
            neutralMode,
            minFillSpreadPct,
            fillDecayHalfLifeMs,
            minRefillDelayMs,
            allowLoss,
            // Risk guards
            maxLossPerCloseBps,
            maxFillsPerMinute,
            // PnL feedback
            pnlFeedbackMode,
        } = req.body;

        // Validation
        if (!subAccountId || !symbol || !startSide || !leverage) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, startSide, leverage' });
        }
        const validSides = ['LONG', 'SHORT'];
        if (!validSides.includes(startSide?.toUpperCase())) {
            return res.status(400).json({ error: 'startSide must be LONG or SHORT' });
        }
        const parsedLev = parseInt(leverage);
        if (!Number.isFinite(parsedLev) || parsedLev < 1 || parsedLev > 125) {
            return res.status(400).json({ error: 'leverage must be between 1 and 125' });
        }
        const parsedLongOff = parseFloat(longOffsetPct) || 0;
        if (parsedLongOff < 0 || parsedLongOff > 10) {
            return res.status(400).json({ error: 'longOffsetPct must be 0–10' });
        }
        const parsedShortOff = parseFloat(shortOffsetPct) || 0;
        if (parsedShortOff < 0 || parsedShortOff > 10) {
            return res.status(400).json({ error: 'shortOffsetPct must be 0–10' });
        }
        const parsedCount = parseInt(childCount) || 1;
        if (parsedCount < 1 || parsedCount > 10) {
            return res.status(400).json({ error: 'childCount must be 1–10' });
        }
        const parsedLongSz = parseFloat(longSizeUsd) || 0;
        const parsedShortSz = parseFloat(shortSizeUsd) || 0;
        if (parsedLongSz <= 0 && parsedShortSz <= 0) {
            return res.status(400).json({ error: 'At least one of longSizeUsd or shortSizeUsd must be > 0' });
        }
        // Validate optional price filters
        if (longMaxPrice !== undefined && longMaxPrice !== null && longMaxPrice !== '') {
            const v = parseFloat(longMaxPrice);
            if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'longMaxPrice must be a positive number or omitted' });
        }
        if (shortMinPrice !== undefined && shortMinPrice !== null && shortMinPrice !== '') {
            const v = parseFloat(shortMinPrice);
            if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'shortMinPrice must be a positive number or omitted' });
        }

        // Validate anti-overtrading settings
        if (minFillSpreadPct !== undefined && minFillSpreadPct !== null && minFillSpreadPct !== '') {
            const v = parseFloat(minFillSpreadPct);
            if (!Number.isFinite(v) || v < 0 || v > 10) return res.status(400).json({ error: 'minFillSpreadPct must be 0–10' });
        }
        if (fillDecayHalfLifeMs !== undefined && fillDecayHalfLifeMs !== null && fillDecayHalfLifeMs !== '') {
            const v = parseInt(fillDecayHalfLifeMs);
            if (!Number.isFinite(v) || v < 1000) return res.status(400).json({ error: 'fillDecayHalfLifeMs must be ≥ 1000' });
        }
        if (minRefillDelayMs !== undefined && minRefillDelayMs !== null && minRefillDelayMs !== '') {
            const v = parseInt(minRefillDelayMs);
            if (!Number.isFinite(v) || v < 0 || v > 300000) return res.status(400).json({ error: 'minRefillDelayMs must be 0–300000' });
        }
        // Validate risk guards
        if (maxLossPerCloseBps !== undefined && maxLossPerCloseBps !== null && maxLossPerCloseBps !== '') {
            const v = parseInt(maxLossPerCloseBps);
            if (!Number.isFinite(v) || v < 0 || v > 10000) return res.status(400).json({ error: 'maxLossPerCloseBps must be 0–10000' });
        }
        if (maxFillsPerMinute !== undefined && maxFillsPerMinute !== null && maxFillsPerMinute !== '') {
            const v = parseInt(maxFillsPerMinute);
            if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: 'maxFillsPerMinute must be 0–100' });
        }
        // Validate pnl feedback mode
        if (pnlFeedbackMode !== undefined && pnlFeedbackMode !== null && pnlFeedbackMode !== '') {
            if (!['off', 'soft', 'full'].includes(pnlFeedbackMode)) {
                return res.status(400).json({ error: 'pnlFeedbackMode must be \'off\', \'soft\', or \'full\'' });
            }
        }

        const result = await _startScalperCore({
            subAccountId,
            symbol,
            startSide: startSide.toUpperCase(),
            leverage: parsedLev,
            longOffsetPct: parsedLongOff,
            shortOffsetPct: parsedShortOff,
            childCount: parsedCount,
            skew: parseInt(skew) || 0,
            longSizeUsd: parsedLongSz,
            shortSizeUsd: parsedShortSz,
            longMaxPrice: longMaxPrice || null,
            shortMinPrice: shortMinPrice || null,
            neutralMode: !!neutralMode,
            minFillSpreadPct: parseFloat(minFillSpreadPct) || 0,
            fillDecayHalfLifeMs: parseInt(fillDecayHalfLifeMs) || 30000,
            minRefillDelayMs: parseInt(minRefillDelayMs) || 0,
            allowLoss: allowLoss !== false && allowLoss !== 'false',
            maxLossPerCloseBps: parseInt(maxLossPerCloseBps) || 0,
            maxFillsPerMinute: parseInt(maxFillsPerMinute) || 0,
            pnlFeedbackMode: pnlFeedbackMode || 'off',
        });

        res.status(201).json({ success: true, ...result });
    } catch (err) {
        console.error('[Scalper] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/scalper/active/:subAccountId
router.get('/scalper/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = [];
        const mapSlot = s => ({
            layerIdx: s.layerIdx,
            offsetPct: s.offsetPct,
            qty: s.qty,
            active: !!s.chaseId,
            paused: !!s.paused,
            retryAt: s.retryAt || null,
            retryCount: s.retryCount || 0,
        });
        for (const [, sp] of activeScalpers) {
            if (sp.subAccountId !== req.params.subAccountId) continue;
            results.push({
                scalperId: sp.id,
                symbol: sp.symbol,
                startSide: sp.startSide,
                leverage: sp.leverage,
                longOffsetPct: sp.longOffsetPct,
                shortOffsetPct: sp.shortOffsetPct,
                childCount: sp.childCount,
                skew: sp.skew,
                status: sp.status,
                fillCount: sp.fillCount || 0,
                startedAt: new Date(sp.startedAt).toISOString(),
                longMaxPrice: sp.longMaxPrice || null,
                shortMinPrice: sp.shortMinPrice || null,
                longSlots: (sp._longChases || []).map(mapSlot),
                shortSlots: (sp._shortChases || []).map(mapSlot),
            });
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/scalper/:scalperId
// Query param ?close=1 to also market-close any open positions on the symbol.
router.delete('/scalper/:scalperId', async (req, res) => {
    try {
        const sp = activeScalpers.get(req.params.scalperId);
        if (!sp) return res.status(404).json({ error: 'Scalper not found or already stopped' });

        // Ownership check
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({
                where: { id: sp.subAccountId },
                select: { userId: true },
            });
            if (account?.userId !== req.user?.id) {
                return res.status(403).json({ error: 'You do not own this scalper' });
            }
        }

        const closePositions = req.query.close === '1' || req.query.close === 'true';
        await finishScalper(sp, 'cancelled', { closePositions });
        res.json({ success: true, scalperId: sp.id, symbol: sp.symbol, closedPositions: closePositions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Resume from Redis on restart ──────────────────────────────

export async function resumeActiveScalpers() {
    const r = getRedis();
    if (!r) return;
    let resumed = 0;
    try {
        const keys = await r.keys(SC_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);
                if (activeScalpers.has(data.id)) continue;
                if (data.status !== 'active') { await r.del(key); continue; }

                let price = exchange.getLatestPrice(data.symbol);
                if (!price) {
                    const t = await exchange.fetchTicker(data.symbol).catch(() => null);
                    price = Number(t?.last || 0);
                }
                if (!price) { console.warn(`[Scalper-Resume] No price for ${data.symbol}, skipping`); await r.del(key); continue; }

                console.log(`[Scalper-Resume] Resuming ${data.id} (${data.symbol} ${data.startSide}, armed=${data._reduceOnlyArmed})`);
                const sp = {
                    ...data,
                    _lastKnownPrice: price,
                    _longChases: [],
                    _shortChases: [],
                    status: 'active',
                    _reduceOnlyArmed: data._reduceOnlyArmed ?? false,
                    // Restore anti-overtrading state (fill tracking resets on resume — intentional)
                    _lastFillPrice: {},
                    _lastFillTime: {},
                    _fillRefillCount: {},
                };
                activeScalpers.set(sp.id, sp);

                const weights = generateSkewWeights(sp.childCount, sp.skew);

                // Always restart the opening leg
                const openingSide = sp.startSide; // 'LONG' or 'SHORT'
                const openingOff = generateLayerOffsets(
                    openingSide === 'LONG' ? sp.longOffsetPct : sp.shortOffsetPct,
                    sp.childCount
                );
                const openingSizeUsd = openingSide === 'LONG' ? sp.longSizeUsd : sp.shortSizeUsd;
                const openingQtys = weights.map(w => (openingSizeUsd * w) / price);
                const openingSlots = await startLeg(sp, openingSide, openingOff, openingQtys, false);
                if (openingSide === 'LONG') sp._longChases = openingSlots;
                else sp._shortChases = openingSlots;

                // Only restart the reduce-only leg if it was already armed
                if (sp._reduceOnlyArmed) {
                    const roSide = openingSide === 'LONG' ? 'SHORT' : 'LONG';
                    const roOff = generateLayerOffsets(
                        roSide === 'LONG' ? sp.longOffsetPct : sp.shortOffsetPct,
                        sp.childCount
                    );
                    const roSizeUsd = roSide === 'LONG' ? sp.longSizeUsd : sp.shortSizeUsd;
                    const roQtys = weights.map(w => (roSizeUsd * w) / price);
                    const roSlots = await startLeg(sp, roSide, roOff, roQtys, true);
                    if (roSide === 'LONG') sp._longChases = roSlots;
                    else sp._shortChases = roSlots;
                }

                saveToRedis(sp);
                resumed++;
            } catch (err) {
                console.warn('[Scalper-Resume] Failed for key', key, ':', err.message);
                await r.del(key);
            }
        }
        if (resumed > 0) console.log(`[Scalper-Resume] Resumed ${resumed} scalpers`);
    } catch (err) {
        console.warn('[Scalper-Resume] Error:', err.message);
    }
}

export default router;
