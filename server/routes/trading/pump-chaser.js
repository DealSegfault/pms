/**
 * SURF Engine — perpetual momentum rider with auto-deleverage.
 *
 * Builds position up to `maxNotional`, then auto-deleverages with a reverse
 * chase order at 40 bps offset. Freed capital recycles into new entries.
 *
 * SHORT side: sells into pumps (HWM tracking, floor gate, sell fills, buy-back scalps)
 * LONG side: buys into dips (LWM tracking, ceiling gate, buy fills, sell-back scalps)
 *
 * Combines trail ratcheting, chase-limit repricing, and Bézier sizing
 * with a scalp/core bucket split. State persisted to Redis.
 */
import { Router } from 'express';
import prisma from '../../db/prisma.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getRedis } from '../../redis.js';
import { startChaseInternal, cancelChaseInternal } from './chase-limit.js';

const router = Router();

// ── Redis persistence helpers ─────────────────────

const PC_REDIS_PREFIX = 'pms:pumpc:';
const PC_TTL_SEC = 172800; // 48 hours max (long-running)

async function saveToRedis(pc) {
    try {
        const r = getRedis();
        if (!r) return;
        const { _unsubPrice, _repriceTimeout, _processing, _lastTickTs, _lastSaveTs, _lastStateLogTs, _activeChaseIds, _priceHistory, ...data } = pc;
        await r.set(PC_REDIS_PREFIX + pc.id, JSON.stringify(data), 'EX', PC_TTL_SEC);
    } catch (err) {
        console.warn('[PumpChaser-Redis] Save failed:', err.message);
    }
}

async function deleteFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(PC_REDIS_PREFIX + id);
    } catch { /* ignore */ }
}

// ── Pump Chaser Engine ────────────────────────────

const activePumpChasers = new Map(); // id → PumpChaserState
const MAX_ACTIVE_PUMP_CHASERS = 50;

function generateId() {
    return `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Throttle constants ──
const PRICE_TICK_THROTTLE_MS = 500;
const REDIS_SAVE_THROTTLE_MS = 2000;

// ── Bézier sizing ──

function bezierCubic(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function getBezierMultiplier(amplitude, maxPump, maxMult) {
    const t = Math.min(Math.max(amplitude / maxPump, 0), 1);
    // Slow start, aggressive ramp
    const mult = bezierCubic(t, 1.0, 1.05, 0.9 * maxMult, maxMult);
    return Math.max(1, Math.min(maxMult, mult));
}

// ── Price helpers (reuse chase-limit patterns) ──

function roundToTickSize(symbol, price) {
    try {
        const market = exchange.markets?.[symbol];
        if (market?.precision?.price != null) {
            const tickSize = market.precision.price;
            if (tickSize >= 1) {
                return parseFloat(price.toFixed(tickSize));
            }
            const decimalPlaces = Math.max(0, Math.round(-Math.log10(tickSize)));
            return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(decimalPlaces));
        }
    } catch { /* ignore */ }
    return parseFloat(price.toFixed(8));
}

function getTickSize(symbol) {
    try {
        const market = exchange.markets?.[symbol];
        if (market?.precision?.price != null) {
            const tickSize = market.precision.price;
            if (tickSize < 1) return tickSize;
        }
    } catch { /* ignore */ }
    return 0.00001; // default
}

function clampToMarketLimits(symbol, price) {
    try {
        const market = exchange.markets?.[symbol];
        if (!market) return price;
        const min = market.limits?.price?.min;
        const max = market.limits?.price?.max;
        if (min != null && price < min) price = min;
        if (max != null && price > max) price = max;
        const filters = market.info?.filters;
        if (filters) {
            const pctFilter = filters.find(f => f.filterType === 'PERCENT_PRICE');
            if (pctFilter) {
                const markPrice = exchange.getLatestPrice(symbol);
                if (markPrice && markPrice > 0) {
                    const down = parseFloat(pctFilter.multiplierDown);
                    const up = parseFloat(pctFilter.multiplierUp);
                    if (Number.isFinite(down)) {
                        const pctMin = roundToTickSize(symbol, markPrice * down);
                        if (price < pctMin) price = pctMin;
                    }
                    if (Number.isFinite(up)) {
                        const pctMax = roundToTickSize(symbol, markPrice * up);
                        if (price > pctMax) price = pctMax;
                    }
                }
            }
        }
    } catch { /* ignore */ }
    return price;
}

function getMinQty(symbol) {
    try {
        const market = exchange.markets?.[symbol];
        if (market?.limits?.amount?.min) return market.limits.amount.min;
    } catch { /* ignore */ }
    return 1;
}

function roundQty(symbol, qty) {
    try {
        const market = exchange.markets?.[symbol];
        if (market?.precision?.amount != null) {
            const stepSize = market.precision.amount;
            if (stepSize >= 1) {
                return parseFloat(qty.toFixed(stepSize));
            }
            const decimalPlaces = Math.max(0, Math.round(-Math.log10(stepSize)));
            return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(decimalPlaces));
        }
    } catch { /* ignore */ }
    return Math.floor(qty);
}

// ── State machine constants ──
const States = {
    IDLE: 'IDLE',                 // Waiting for min activation amplitude
    ARMED: 'ARMED',               // Chase limit active, ready to fill
    STEP_WAIT: 'STEP_WAIT',       // After fill, waiting for step-up
    GATED: 'GATED',               // Price below trail floor
    DELEVERAGING: 'DELEVERAGING', // Position at max, unwinding via reverse chase
    PAUSED: 'PAUSED',             // Circuit breaker / manual pause
    STOPPED: 'STOPPED',           // Finished
};

const DELEVERAGE_OFFSET_BPS = 40; // 40 bps = 0.4%
const DELEVERAGE_REENTRY_RATIO = 0.90; // Re-enter trading when position drops below 90% of max
const DELEVERAGE_REPRICE_THROTTLE_MS = 2000; // Don't reprice faster than every 2s

// ── Core price tick handler ──

async function handlePriceTick(pc, price) {
    if (!activePumpChasers.has(pc.id)) return;
    if (pc.state === States.STOPPED || pc.state === States.PAUSED) return;
    if (pc._processing) return;
    if (!price || !Number.isFinite(price) || price <= 0) return;

    const now = Date.now();
    if (now - (pc._lastTickTs || 0) < PRICE_TICK_THROTTLE_MS) return;
    pc._lastTickTs = now;

    const tickSize = getTickSize(pc.symbol);
    const isShort = pc.side === 'SHORT';

    // ── Update extreme price (HWM for SHORT, LWM for LONG) with jump filter ──
    if (isShort ? (price > pc.extreme) : (price < pc.extreme)) {
        const jumpPct = Math.abs((price - pc.extreme) / pc.extreme) * 100;
        if (jumpPct <= pc.config.hwmJumpMax) {
            pc.extreme = price;
            // SHORT: floor = extreme * (1 - trail%), LONG: ceiling = extreme * (1 + trail%)
            pc.gate = isShort
                ? pc.extreme * (1 - pc.config.trailPct / 100)
                : pc.extreme * (1 + pc.config.trailPct / 100);
        } else {
            pc.stats.hwmJumpsFiltered = (pc.stats.hwmJumpsFiltered || 0) + 1;
        }
    }

    // ── Amplitude (always positive — measures move magnitude) ──
    const amplitude = Math.abs((pc.extreme - pc.startPrice) / pc.startPrice) * 100;
    pc.amplitude = amplitude;

    // ── Periodic live state log (every 10s) — runs in ALL states ──
    if (now - (pc._lastStateLogTs || 0) > 10000) {
        pc._lastStateLogTs = now;
        const dynamicOff = computeDynamicOffset(pc);
        const offset = Math.max(pc.extreme * dynamicOff / 100, tickSize);
        const liveChasePrice = isShort ? (pc.extreme - offset) : (pc.extreme + offset);
        const gap = isShort ? ((price - liveChasePrice) / liveChasePrice * 100) : ((liveChasePrice - price) / price * 100);
        const stateInfo = pc.state === States.IDLE ? ` | need ${pc.config.minActivationAmp}% amp` : pc.state === States.GATED ? ' | gated' : pc.state === States.STEP_WAIT ? ' | step-wait' : '';
        logPC(pc, `📊 ${pc.state}${stateInfo} | $${price.toFixed(5)} | ${isShort ? 'HWM' : 'LWM'}=$${pc.extreme.toFixed(5)} | gate=$${pc.gate.toFixed(5)} | chase=$${liveChasePrice.toFixed(5)} (${gap.toFixed(2)}% away) | amp=${amplitude.toFixed(2)}% | pos=$${(pc.core.qty * price).toFixed(0)}/$${pc.config.maxNotional}`);
    }

    // ── Track price for dynamic offset ──
    recordPriceForDynamicOffset(pc, price);

    // ── Live position notional ──
    const positionNotional = pc.core.qty * price;

    // ── DELEVERAGING state: manage reverse chase unwind ──
    if (pc.state === States.DELEVERAGING) {
        // Check if position has dropped enough to re-enter trading
        if (positionNotional < pc.config.maxNotional * DELEVERAGE_REENTRY_RATIO) {
            await cancelDeleverageChase(pc);
            pc.state = States.STEP_WAIT;
            logPC(pc, `DELEVERAGE → TRADING — position $${positionNotional.toFixed(0)} < ${(DELEVERAGE_REENTRY_RATIO * 100).toFixed(0)}% of max $${pc.config.maxNotional}`);
            broadcastProgress(pc);
        } else if (!pc._deleverageChaseId) {
            // No active deleverage chase — start one
            await startDeleverageChase(pc, price, now);
        }

        // Throttled save + broadcast
        if (now - (pc._lastSaveTs || 0) > REDIS_SAVE_THROTTLE_MS) {
            pc._lastSaveTs = now;
            saveToRedis(pc);
            broadcastProgress(pc);
        }
        return;
    }

    // ── State machine transitions ──
    if (pc.state === States.IDLE) {
        if (amplitude >= pc.config.minActivationAmp) {
            pc.state = States.ARMED;
            pc.activatedAt = now;
            logPC(pc, `ACTIVATED — amplitude ${amplitude.toFixed(2)}% ≥ ${pc.config.minActivationAmp}%`);
            broadcastProgress(pc);
        }
        return;
    }

    // Gate check: SHORT gates when price drops below floor, LONG gates when price rises above ceiling
    const gated = isShort ? (price < pc.gate) : (price > pc.gate);
    if (pc.state === States.ARMED && gated) {
        pc.state = States.GATED;
        pc.stats.gateActivations = (pc.stats.gateActivations || 0) + 1;
        logPC(pc, `GATED — price ${price.toFixed(5)} ${isShort ? '<' : '>'} gate ${pc.gate.toFixed(5)}`);
        broadcastProgress(pc);
        return;
    }

    if (pc.state === States.GATED) {
        const ungated = isShort ? (price >= pc.gate) : (price <= pc.gate);
        if (ungated) {
            pc.state = States.STEP_WAIT;
        } else {
            return;
        }
    }

    if (pc.state === States.STEP_WAIT) {
        let stepTarget;
        if (pc.lastFillPrice) {
            stepTarget = isShort
                ? pc.lastFillPrice * (1 + pc.config.stepPct / 100)
                : pc.lastFillPrice * (1 - pc.config.stepPct / 100);
        } else {
            stepTarget = isShort
                ? pc.startPrice * (1 + pc.config.minActivationAmp / 100)
                : pc.startPrice * (1 - pc.config.minActivationAmp / 100);
        }
        const stepped = isShort ? (price >= stepTarget) : (price <= stepTarget);
        if (stepped) {
            pc.state = States.ARMED;
        } else {
            return;
        }
    }

    if (pc.state !== States.ARMED) return;

    // ── Max position check → enter deleveraging ──
    if (positionNotional >= pc.config.maxNotional) {
        pc.state = States.DELEVERAGING;
        logPC(pc, `MAX POSITION REACHED — $${positionNotional.toFixed(0)} ≥ max $${pc.config.maxNotional} — entering DELEVERAGING`);
        await startDeleverageChase(pc, price, now);
        broadcastProgress(pc);
        return;
    }

    // ── Fill rate limiter ──
    const recentFills = pc.fills.filter(f => now - f.timestamp < 3600000);
    if (recentFills.length >= (pc.config.maxFillsPerHour || 10)) return;

    // ── Chase limit check (dynamic offset) ──
    const dynamicOff = computeDynamicOffset(pc);
    const offset = Math.max(pc.extreme * dynamicOff / 100, tickSize);
    // SHORT: chase below extreme, LONG: chase above extreme
    const rawChasePrice = isShort ? (pc.extreme - offset) : (pc.extreme + offset);
    const chasePrice = clampToMarketLimits(pc.symbol, roundToTickSize(pc.symbol, rawChasePrice));

    // Fill trigger: SHORT fills when price drops to/below chase, LONG fills when price rises to/above chase
    const shouldFill = isShort ? (price <= chasePrice) : (price >= chasePrice);
    if (shouldFill) {
        await executeFill(pc, chasePrice, amplitude, now);
    }

    // ── Throttled Redis save + broadcast ──
    if (now - (pc._lastSaveTs || 0) > REDIS_SAVE_THROTTLE_MS) {
        pc._lastSaveTs = now;
        saveToRedis(pc);
        broadcastProgress(pc);
    }
}

// ── Execute a fill via Chase child order ──

async function executeFill(pc, chasePrice, amplitude, now) {
    if (pc._processing) return;
    pc._processing = true;
    const isShort = pc.side === 'SHORT';
    const currentPrice = exchange.getLatestPrice(pc.symbol) || chasePrice;

    try {
        const mult = getBezierMultiplier(amplitude, pc.config.bezierMaxPump, pc.config.maxMultiplier);
        let qty = roundQty(pc.symbol, pc.config.baseQty * mult);

        // Cap to remaining room under maxNotional
        const positionNotional = pc.core.qty * currentPrice;
        const remaining = Math.max(0, pc.config.maxNotional - positionNotional);
        const maxQty = Math.floor(remaining / chasePrice);
        qty = Math.min(qty, maxQty);
        qty = roundQty(pc.symbol, qty);

        // Min notional check ($5)
        if (qty * chasePrice < 5) {
            pc.state = States.DELEVERAGING;
            await startDeleverageChase(pc, currentPrice, now);
            broadcastProgress(pc);
            return;
        }

        // Min qty check
        const minQty = getMinQty(pc.symbol);
        if (qty < minQty) qty = minQty;

        // Dynamic offset for chase child
        const dynamicOffset = computeDynamicOffset(pc);

        // Split into scalp and core
        const scalpQty = roundQty(pc.symbol, qty * pc.config.scalpRatio);
        const coreQ = qty - scalpQty;

        logPC(pc, `🔫 FILL via Chase — qty=${qty} (core:${coreQ} scalp:${scalpQty}) offset=${dynamicOffset.toFixed(3)}% amp=${amplitude.toFixed(1)}%`);

        // Spawn chase child for the fill
        const { chaseId } = await startChaseInternal({
            subAccountId: pc.subAccountId,
            symbol: pc.symbol,
            side: pc.side,
            quantity: qty,
            leverage: pc.config?.leverage || pc.leverage || 1,
            stalkOffsetPct: dynamicOffset,
            stalkMode: 'trail',
            orderType: 'SURF_LIMIT',
            onFill: async (fillPrice, fillQty, cId) => {
                handleSurfCoreFill(pc, fillPrice, fillQty, coreQ, scalpQty, amplitude, mult, now);
                pc._activeChaseIds.delete(cId);
            },
            onCancel: (reason, cId) => {
                logPC(pc, `Chase child ${cId} cancelled: ${reason}`);
                pc._activeChaseIds.delete(cId);
                pc._processing = false;
            },
        });

        pc._activeChaseIds.add(chaseId);
        pc.lastFillPrice = chasePrice;
        pc.state = States.STEP_WAIT;
    } catch (err) {
        logPC(pc, `Fill via Chase failed: ${err.message}`);
        if (err.message?.includes('insufficient') || err.message?.includes('Margin is insufficient')) {
            pc.state = States.PAUSED;
            logPC(pc, 'Insufficient margin — pausing');
        }
    } finally {
        pc._processing = false;
    }
}

// ── Handle core fill callback from Chase child ──

function handleSurfCoreFill(pc, fillPrice, fillQty, coreQ, scalpQty, amplitude, mult, triggerTime) {
    const isShort = pc.side === 'SHORT';
    const fillNotional = fillPrice * fillQty;
    const now = Date.now();
    let actualScalpQty = scalpQty;

    // Core bucket
    if (coreQ > 0) {
        const prevNotional = pc.core.vwap * pc.core.qty;
        pc.core.qty += coreQ;
        pc.core.notional = prevNotional + (fillPrice * coreQ);
        pc.core.vwap = pc.core.notional / pc.core.qty;
    }

    // Scalp bucket — spawn chase child for round-trip close
    if (actualScalpQty > 0) {
        const scalpPrice = isShort
            ? roundToTickSize(pc.symbol, fillPrice * (1 - pc.config.spreadOffsetPct / 100))
            : roundToTickSize(pc.symbol, fillPrice * (1 + pc.config.spreadOffsetPct / 100));
        const clampedScalpPrice = clampToMarketLimits(pc.symbol, scalpPrice);
        const scalpNotional = actualScalpQty * clampedScalpPrice;

        if (scalpNotional < 5.5) {
            // Too small for scalp — route to core
            pc.core.qty += actualScalpQty;
            pc.core.notional += (fillPrice * actualScalpQty);
            pc.core.vwap = pc.core.notional / pc.core.qty;
            actualScalpQty = 0;
        } else {
            // Spawn chase child for scalp close (reduceOnly)
            const scalpSide = isShort ? 'LONG' : 'SHORT';
            startChaseInternal({
                subAccountId: pc.subAccountId,
                symbol: pc.symbol,
                side: scalpSide,
                quantity: actualScalpQty,
                leverage: pc.config?.leverage || pc.leverage || 1,
                stalkOffsetPct: 0,
                stalkMode: 'none',
                orderType: 'SURF_SCALP',
                reduceOnly: true,
                onFill: (scalpFillPrice, scalpFillQty, cId) => {
                    handleSurfScalpFill(pc, fillPrice, scalpFillPrice, scalpFillQty);
                    pc._activeChaseIds.delete(cId);
                },
                onCancel: (reason, cId) => {
                    // Expired scalp becomes core
                    pc.core.qty += actualScalpQty;
                    pc.core.notional += fillPrice * actualScalpQty;
                    pc.core.vwap = pc.core.qty > 0 ? pc.core.notional / pc.core.qty : 0;
                    pc.stats.scalpExpired = (pc.stats.scalpExpired || 0) + 1;
                    logPC(pc, `Scalp chase cancelled (${reason}) — ${actualScalpQty} → core`);
                    pc._activeChaseIds.delete(cId);
                },
            }).then(({ chaseId }) => {
                pc._activeChaseIds.add(chaseId);
                pc.pendingScalps.push({ chaseId, scalpPrice: clampedScalpPrice, fillPrice, qty: actualScalpQty, placedAt: now });
            }).catch(err => {
                const errorMsg = err.message || '';
                logPC(pc, `Scalp chase spawn failed: ${errorMsg}`);

                const isGhostError = errorMsg.includes('Invalid quantity') ||
                    errorMsg.includes('Position') ||
                    errorMsg.includes('-2022') ||
                    errorMsg.includes('Unknown') ||
                    errorMsg.includes('insufficient') ||
                    errorMsg.includes('reduceOnly');

                if (isGhostError) {
                    logPC(pc, `🚨 Ghost position detected on scalp! Binance rejected reduceOnly. Auto-correcting SURF state to 0.`);
                    pc.core.qty = 0;
                    pc.core.notional = 0;
                    pc.core.vwap = 0;
                    pc.state = States.STEP_WAIT;
                    broadcastProgress(pc);
                    saveToRedis(pc);
                } else {
                    pc.core.qty += actualScalpQty;
                    pc.core.notional += (fillPrice * actualScalpQty);
                    pc.core.vwap = pc.core.notional / pc.core.qty;
                }
            });
        }
    }

    // Record fill
    const actualCoreQty = fillQty - actualScalpQty;
    const fillRecord = {
        fillNum: pc.fills.length + 1, timestamp: now, price: fillPrice,
        side: isShort ? 'sell' : 'buy', qty: fillQty,
        scalpQty: actualScalpQty, coreQty: actualCoreQty,
        notional: fillNotional, amplitude, mult,
        extreme: pc.extreme, gate: pc.gate,
    };
    pc.fills.push(fillRecord);
    pc.lastFillPrice = fillPrice;

    logPC(pc, `FILL #${fillRecord.fillNum} @ $${fillPrice.toFixed(5)} — qty:${fillQty} (scalp:${actualScalpQty} core:${actualCoreQty}) — $${fillNotional.toFixed(2)} — pos:$${(pc.core.qty * fillPrice).toFixed(0)}/$${pc.config.maxNotional}`);

    broadcastProgress(pc);
    broadcast('pump_chaser_fill', {
        pumpChaserId: pc.id, subAccountId: pc.subAccountId,
        symbol: pc.symbol, side: pc.side,
        fill: fillRecord, core: { ...pc.core }, scalpProfit: pc.scalpProfit,
    });
    saveToRedis(pc);
}

// ── Handle scalp fill callback ──

function handleSurfScalpFill(pc, originalFillPrice, scalpFillPrice, scalpFillQty) {
    const isShort = pc.side === 'SHORT';
    const profit = isShort
        ? (originalFillPrice - scalpFillPrice) * scalpFillQty
        : (scalpFillPrice - originalFillPrice) * scalpFillQty;
    pc.scalpProfit += profit;
    pc.scalpRoundTrips.push({
        fillPrice: originalFillPrice, scalpPrice: scalpFillPrice,
        qty: scalpFillQty, profit, completedAt: Date.now(),
    });
    // Remove from pendingScalps
    const idx = pc.pendingScalps.findIndex(s => Math.abs(s.fillPrice - originalFillPrice) < 0.0001 && Math.abs(s.qty - scalpFillQty) < 0.0001);
    if (idx >= 0) pc.pendingScalps.splice(idx, 1);

    logPC(pc, `💰 SCALP — ${isShort ? 'sold' : 'bought'} $${originalFillPrice.toFixed(5)} → ${isShort ? 'bought' : 'sold'} $${scalpFillPrice.toFixed(5)} — +$${profit.toFixed(3)}`);
    broadcast('pump_chaser_scalp', {
        pumpChaserId: pc.id, subAccountId: pc.subAccountId,
        symbol: pc.symbol, side: pc.side,
        roundTrip: pc.scalpRoundTrips[pc.scalpRoundTrips.length - 1],
        totalScalpProfit: pc.scalpProfit,
    });
    broadcastProgress(pc);
    saveToRedis(pc);
}

// ── Deleverage via Chase child ──

async function startDeleverageChase(pc, price, now) {
    const isShort = pc.side === 'SHORT';
    const deleverageSide = isShort ? 'LONG' : 'SHORT'; // Opposite side to close

    // Unwind qty = 30% of core position
    let qty = roundQty(pc.symbol, pc.core.qty * 0.3);
    const minQty = getMinQty(pc.symbol);
    if (qty < minQty) qty = minQty;
    if (qty > pc.core.qty) qty = pc.core.qty;

    if (qty * price < 5) {
        logPC(pc, `Deleverage qty too small ($${(qty * price).toFixed(2)}) — waiting`);
        return;
    }

    try {
        const { chaseId } = await startChaseInternal({
            subAccountId: pc.subAccountId,
            symbol: pc.symbol,
            side: deleverageSide,
            quantity: qty,
            leverage: pc.config?.leverage || pc.leverage || 1,
            stalkOffsetPct: DELEVERAGE_OFFSET_BPS / 100, // Convert bps to %
            stalkMode: 'trail',
            orderType: 'SURF_DELEVERAGE',
            reduceOnly: true,
            onFill: (fillPrice, fillQty, cId) => {
                handleSurfDeleverageFill(pc, fillPrice, fillQty);
                pc._activeChaseIds.delete(cId);
                pc._deleverageChaseId = null;
            },
            onCancel: (reason, cId) => {
                logPC(pc, `Deleverage chase cancelled: ${reason}`);
                pc._activeChaseIds.delete(cId);
                pc._deleverageChaseId = null;
            },
        });

        pc._activeChaseIds.add(chaseId);
        pc._deleverageChaseId = chaseId;
        logPC(pc, `DELEVERAGE chase started: ${deleverageSide} ${qty} @ ~$${price.toFixed(5)} (${DELEVERAGE_OFFSET_BPS}bps offset)`);
    } catch (err) {
        const errorMsg = err.message || '';
        logPC(pc, `Deleverage chase failed: ${errorMsg}`);
        pc._deleverageChaseId = null;

        // If Binance rejects the reduceOnly deleverage order because the position doesn't exist
        // (e.g. user manually closed it, hit ADL, or liquidation), auto-correct SURF's hallucinated state!
        const isGhostError = errorMsg.includes('Invalid quantity') ||
            errorMsg.includes('Position') ||
            errorMsg.includes('-2022') ||
            errorMsg.includes('Unknown') ||
            errorMsg.includes('insufficient') ||
            errorMsg.includes('reduceOnly');

        if (isGhostError) {
            logPC(pc, `🚨 Ghost position detected! Binance rejected deleverage. Auto-correcting SURF state to 0.`);
            pc.core.qty = 0;
            pc.core.notional = 0;
            pc.core.vwap = 0;
            pc.state = States.STEP_WAIT;
            broadcastProgress(pc);
            saveToRedis(pc);
        }
    }
}

function handleSurfDeleverageFill(pc, filledPrice, filledQty) {
    const now = Date.now();

    // Reduce core position
    pc.core.qty = Math.max(0, pc.core.qty - filledQty);
    if (pc.core.qty > 0) {
        pc.core.notional = pc.core.vwap * pc.core.qty;
    } else {
        pc.core.notional = 0;
        pc.core.vwap = 0;
    }

    const deleverageRecord = {
        timestamp: now, price: filledPrice, qty: filledQty,
        freedNotional: filledQty * filledPrice,
        side: pc.side === 'SHORT' ? 'buy' : 'sell',
    };
    if (!pc.deleverageFills) pc.deleverageFills = [];
    pc.deleverageFills.push(deleverageRecord);
    pc.stats.deleverageCount = (pc.stats.deleverageCount || 0) + 1;

    logPC(pc, `📉 DELEVERAGE FILL — ${filledQty} @ $${filledPrice.toFixed(5)} — freed $${(filledQty * filledPrice).toFixed(2)} — core now: ${pc.core.qty}`);

    broadcast('pump_chaser_deleverage', {
        pumpChaserId: pc.id, subAccountId: pc.subAccountId,
        symbol: pc.symbol, side: pc.side,
        deleverage: deleverageRecord, core: { ...pc.core },
    });

    // Check if we should re-enter trading
    const currentPrice = exchange.getLatestPrice(pc.symbol) || filledPrice;
    const positionNotional = pc.core.qty * currentPrice;
    if (positionNotional < pc.config.maxNotional * DELEVERAGE_REENTRY_RATIO) {
        pc.state = States.STEP_WAIT;
        logPC(pc, `Deleverage complete — position $${positionNotional.toFixed(0)} < ${(DELEVERAGE_REENTRY_RATIO * 100).toFixed(0)}% of max — resuming`);
    }

    broadcastProgress(pc);
    saveToRedis(pc);
}

async function cancelDeleverageChase(pc) {
    if (pc._deleverageChaseId) {
        await cancelChaseInternal(pc._deleverageChaseId);
        pc._deleverageChaseId = null;
        logPC(pc, 'Deleverage chase cancelled');
    }
}

// ── Dynamic offset computation ──

function computeDynamicOffset(pc) {
    const baseOffset = pc.config.volOffsetBps / 100; // bps → %

    // Scale by recent volatility: EMA of price range ratio
    if (pc._priceHistory.length > 1) {
        const prices = pc._priceHistory;
        const high = Math.max(...prices);
        const low = Math.min(...prices);
        const rangeRatio = (high - low) / ((high + low) / 2) * 100;
        const volMultiplier = Math.max(0.5, Math.min(3.0, rangeRatio / (baseOffset || 0.3)));

        // Scale by fill count: tighter early, wider as position grows
        const fillScale = pc.fills.length < 3 ? 0.7 : pc.fills.length > 10 ? 1.5 : 1.0;

        return baseOffset * volMultiplier * fillScale;
    }

    return baseOffset;
}

// ── Track price history for dynamic offsets ──

function recordPriceForDynamicOffset(pc, price) {
    pc._priceHistory.push(price);
    // Keep last 60 ticks (~30s at 500ms throttle)
    if (pc._priceHistory.length > 60) pc._priceHistory.shift();
}

// ── Broadcast progress to frontend ──

function broadcastProgress(pc) {
    const currentPrice = exchange.getLatestPrice(pc.symbol) || 0;
    const isShort = pc.side === 'SHORT';
    // SHORT: profit when price drops below vwap, LONG: profit when price rises above vwap
    const coreUnrealized = pc.core.qty > 0
        ? (isShort ? (pc.core.vwap - currentPrice) : (currentPrice - pc.core.vwap)) * pc.core.qty
        : 0;
    const netPnl = pc.scalpProfit + coreUnrealized;
    const positionNotional = pc.core.qty * currentPrice;

    broadcast('pump_chaser_progress', {
        pumpChaserId: pc.id,
        subAccountId: pc.subAccountId,
        symbol: pc.symbol,
        side: pc.side,
        state: pc.state,
        startPrice: pc.startPrice,
        currentPrice,
        extreme: pc.extreme,
        gate: pc.gate,
        amplitude: pc.amplitude,
        positionNotional,
        maxNotional: pc.config.maxNotional,
        chasePrice: (() => {
            const tickSize = getTickSize(pc.symbol);
            const dynamicOff = computeDynamicOffset(pc);
            const offset = Math.max(pc.extreme * dynamicOff / 100, tickSize);
            return pc.side === 'SHORT' ? (pc.extreme - offset) : (pc.extreme + offset);
        })(),
        fillCount: pc.fills.length,
        core: {
            qty: pc.core.qty,
            vwap: pc.core.vwap,
            unrealized: coreUnrealized,
        },
        scalp: {
            pending: pc.pendingScalps.map(s => ({ price: s.scalpPrice, qty: s.qty })),
            roundTrips: pc.scalpRoundTrips.length,
            totalProfit: pc.scalpProfit,
        },
        deleverage: pc._deleverageOrder ? {
            price: pc._deleverageOrder.price,
            qty: pc._deleverageOrder.qty,
            side: pc._deleverageOrder.side,
        } : null,
        deleverageCount: pc.stats.deleverageCount || 0,
        netPnl,
        startedAt: pc.startedAt,
        lastFillPrice: pc.lastFillPrice,
    });
}

// ── Finish / stop ──

async function finishPumpChaser(pc, reason) {
    pc.state = States.STOPPED;
    pc.stoppedAt = Date.now();
    pc.stopReason = reason;

    if (pc._unsubPrice) {
        pc._unsubPrice();
        pc._unsubPrice = null;
    }

    // Cancel all active chase children (fills, scalps, deleverage)
    if (pc._activeChaseIds) {
        for (const cId of pc._activeChaseIds) {
            try { await cancelChaseInternal(cId); } catch { /* ignore */ }
        }
        pc._activeChaseIds.clear();
    }
    pc._deleverageChaseId = null;

    const currentPrice = exchange.getLatestPrice(pc.symbol) || 0;
    const isShort = pc.side === 'SHORT';
    const coreUnrealized = pc.core.qty > 0
        ? (isShort ? (pc.core.vwap - currentPrice) : (currentPrice - pc.core.vwap)) * pc.core.qty
        : 0;

    logPC(pc, `STOPPED (${reason}) — ${pc.side} — fills:${pc.fills.length} scalp:+$${pc.scalpProfit.toFixed(3)} core:${pc.core.qty}@${pc.core.vwap.toFixed(5)} unrealized:$${coreUnrealized.toFixed(2)} net:$${(pc.scalpProfit + coreUnrealized).toFixed(2)}`);

    activePumpChasers.delete(pc.id);
    deleteFromRedis(pc.id);

    broadcast('pump_chaser_stopped', {
        pumpChaserId: pc.id,
        subAccountId: pc.subAccountId,
        symbol: pc.symbol,
        side: pc.side,
        reason,
        fills: pc.fills.length,
        scalpProfit: pc.scalpProfit,
        core: { ...pc.core },
        netPnl: pc.scalpProfit + coreUnrealized,
    });
}

// ── Subscribe to price updates ──

function subscribeToPriceUpdates(pc) {
    exchange.subscribeToPrices([pc.symbol]);
    const handler = ({ symbol, mark }) => {
        if (symbol === pc.symbol) {
            handlePriceTick(pc, mark);
        }
    };
    exchange.on('price', handler);
    return () => exchange.off('price', handler);
}

// Fill checking now handled by Chase engine — no separate SURF fill checker needed.

// ── Logging helper ──

function logPC(pc, msg) {
    console.log(`[SURF ${pc.id}] ${msg}`);
}

// ── Presets ──

const PRESETS = {
    shitcoin: {
        trailPct: 0.8,
        stepPct: 0.3,
        minActivationAmp: 0.5,
        volOffsetBps: 0.3,
        scalpRatio: 0.6,
        spreadOffsetPct: 0.5,
        scalpTtlMinutes: 30,
        bezierMaxPump: 8,
        maxMultiplier: 5,
        hwmJumpMax: 5,
        maxFillsPerHour: 8,
    },
    midcap: {
        trailPct: 0.5,
        stepPct: 0.2,
        minActivationAmp: 0.3,
        volOffsetBps: 0.2,
        scalpRatio: 0.5,
        spreadOffsetPct: 0.3,
        scalpTtlMinutes: 30,
        bezierMaxPump: 5,
        maxMultiplier: 3,
        hwmJumpMax: 3,
        maxFillsPerHour: 6,
    },
    largecap: {
        trailPct: 0.3,
        stepPct: 0.1,
        minActivationAmp: 0.2,
        volOffsetBps: 0.1,
        scalpRatio: 0.4,
        spreadOffsetPct: 0.1,
        scalpTtlMinutes: 60,
        bezierMaxPump: 3,
        maxMultiplier: 3,
        hwmJumpMax: 2,
        maxFillsPerHour: 10,
    },
    scalp_heavy: {
        trailPct: 0.5,
        stepPct: 0.2,
        minActivationAmp: 0.3,
        volOffsetBps: 0.3,
        scalpRatio: 0.8,
        spreadOffsetPct: 0.5,
        scalpTtlMinutes: 20,
        bezierMaxPump: 8,
        maxMultiplier: 5,
        hwmJumpMax: 5,
        maxFillsPerHour: 10,
    },
    conviction: {
        trailPct: 1.5,
        stepPct: 0.5,
        minActivationAmp: 0.5,
        volOffsetBps: 0.3,
        scalpRatio: 0.2,
        spreadOffsetPct: 0.3,
        scalpTtlMinutes: 60,
        bezierMaxPump: 10,
        maxMultiplier: 5,
        hwmJumpMax: 5,
        maxFillsPerHour: 6,
    },
};

// ── Auto-detect profile from price ──
function autoDetectProfile(symbol, price) {
    // BTC, ETH → largecap
    const base = symbol.split('/')[0]?.toUpperCase() || '';
    if (['BTC', 'ETH'].includes(base)) return 'largecap';
    // Mid-caps: price > $1
    if (price >= 1) return 'midcap';
    // Everything else → shitcoin
    return 'shitcoin';
}

// ── Routes ────────────────────────────────────────

// POST /api/trade/pump-chaser — Start a SURF instance
router.post('/pump-chaser', requireOwnership('body'), async (req, res) => {
    try {
        const {
            subAccountId, symbol, leverage, side,
            maxNotional, totalBudget, profile,
            // Optional overrides
            trailPct, stepPct, minActivationAmp, volOffsetBps,
            scalpRatio, spreadOffsetPct, scalpTtlMinutes,
            bezierMaxPump, maxMultiplier, hwmJumpMax, maxFillsPerHour,
        } = req.body;

        // Accept both maxNotional (new) and totalBudget (legacy) field names
        const rawMaxNotional = maxNotional || totalBudget;
        if (!subAccountId || !symbol || !rawMaxNotional) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, maxNotional' });
        }

        // Parse + validate side (defaults to SHORT for backward compat)
        const parsedSide = (side || 'SHORT').toUpperCase();
        if (parsedSide !== 'LONG' && parsedSide !== 'SHORT') {
            return res.status(400).json({ error: 'side must be LONG or SHORT' });
        }

        const parsedMaxNotional = parseFloat(rawMaxNotional);
        if (!Number.isFinite(parsedMaxNotional) || parsedMaxNotional < 10) {
            return res.status(400).json({ error: 'maxNotional must be at least $10' });
        }

        const parsedLeverage = parseInt(leverage) || 20;
        if (parsedLeverage < 1 || parsedLeverage > 125) {
            return res.status(400).json({ error: 'leverage must be between 1 and 125' });
        }

        // Get current price early (needed for auto-detect)
        let currentPrice = exchange.getLatestPrice(symbol);
        if (!currentPrice) {
            try {
                const ticker = await exchange.fetchTicker(symbol);
                currentPrice = Number(ticker?.last || ticker?.close);
            } catch { /* ignore */ }
        }
        if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
            return res.status(500).json({ error: 'Cannot get current price for this symbol' });
        }

        // Auto-detect profile if not specified
        const detectedProfile = profile || autoDetectProfile(symbol, currentPrice);
        const preset = PRESETS[detectedProfile] || PRESETS.shitcoin;

        const config = {
            maxNotional: parsedMaxNotional,
            trailPct: parseFloat(trailPct) || preset.trailPct,
            stepPct: parseFloat(stepPct) || preset.stepPct,
            minActivationAmp: parseFloat(minActivationAmp) || preset.minActivationAmp,
            volOffsetBps: parseFloat(volOffsetBps) || preset.volOffsetBps,
            scalpRatio: parseFloat(scalpRatio) || preset.scalpRatio,
            spreadOffsetPct: parseFloat(spreadOffsetPct) || preset.spreadOffsetPct,
            scalpTtlMinutes: parseInt(scalpTtlMinutes) || preset.scalpTtlMinutes,
            bezierMaxPump: parseFloat(bezierMaxPump) || preset.bezierMaxPump,
            maxMultiplier: parseFloat(maxMultiplier) || preset.maxMultiplier,
            hwmJumpMax: parseFloat(hwmJumpMax) || preset.hwmJumpMax,
            maxFillsPerHour: parseInt(maxFillsPerHour) || preset.maxFillsPerHour,
        };

        // Clamp scalp ratio
        config.scalpRatio = Math.max(0, Math.min(1, config.scalpRatio));

        // Set leverage
        try {
            await exchange.setLeverage(symbol, parsedLeverage);
        } catch (err) {
            console.warn(`[SURF] setLeverage warning:`, err.message);
        }

        // Calculate base qty ($maxNotional / ~15 expected fills / currentPrice)
        const baseNotional = parsedMaxNotional / 15;
        const baseQty = roundQty(symbol, baseNotional / currentPrice);
        config.baseQty = Math.max(baseQty, getMinQty(symbol));

        // Check for duplicates on same symbol + same side
        for (const [, existing] of activePumpChasers) {
            if (existing.subAccountId === subAccountId && existing.symbol === symbol && existing.side === parsedSide && existing.state !== States.STOPPED) {
                return res.status(409).json({ error: `SURF ${parsedSide} already active on ${symbol}` });
            }
        }

        if (activePumpChasers.size >= MAX_ACTIVE_PUMP_CHASERS) {
            return res.status(429).json({ error: `Maximum concurrent SURFs (${MAX_ACTIVE_PUMP_CHASERS}) reached` });
        }

        const isShort = parsedSide === 'SHORT';
        const id = generateId();
        const pc = {
            id,
            subAccountId,
            symbol,
            side: parsedSide,
            leverage: parsedLeverage,
            config,
            profile: detectedProfile,
            state: States.IDLE,
            startPrice: currentPrice,
            // extreme = HWM for SHORT, LWM for LONG
            extreme: currentPrice,
            // gate = floor for SHORT, ceiling for LONG
            gate: isShort
                ? currentPrice * (1 - config.trailPct / 100)
                : currentPrice * (1 + config.trailPct / 100),
            amplitude: 0,
            lastFillPrice: null,
            startedAt: Date.now(),
            activatedAt: null,

            // Core bucket
            core: { qty: 0, vwap: 0, notional: 0 },

            // Scalp bucket
            pendingScalps: [],
            scalpRoundTrips: [],
            scalpProfit: 0,

            // Deleverage
            deleverageFills: [],
            _deleverageOrder: null,

            // All fills
            fills: [],

            // Stats
            stats: { gateActivations: 0, hwmJumpsFiltered: 0, scalpExpired: 0, deleverageCount: 0 },

            // Internal state
            _unsubPrice: null,
            _lastTickTs: 0,
            _lastSaveTs: 0,
            _processing: false,
            _activeChaseIds: new Set(),
            _priceHistory: [],
        };

        activePumpChasers.set(id, pc);
        pc._unsubPrice = subscribeToPriceUpdates(pc);
        saveToRedis(pc);

        logPC(pc, `Started: ${parsedSide} ${symbol} maxNotional=$${parsedMaxNotional} profile=${detectedProfile} trail=${config.trailPct}% step=${config.stepPct}% scalp=${(config.scalpRatio * 100).toFixed(0)}% baseQty=${config.baseQty} @ $${currentPrice.toFixed(5)}`);

        res.status(201).json({
            success: true,
            pumpChaserId: id,
            symbol,
            side: parsedSide,
            profile: detectedProfile,
            config,
            startPrice: currentPrice,
            state: pc.state,
        });
    } catch (err) {
        console.error('[SURF] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/pump-chaser/active/:subAccountId
router.get('/pump-chaser/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = [];
        const currentPrices = {};
        for (const [, pc] of activePumpChasers) {
            if (pc.subAccountId === req.params.subAccountId && pc.state !== States.STOPPED) {
                if (!currentPrices[pc.symbol]) {
                    currentPrices[pc.symbol] = exchange.getLatestPrice(pc.symbol) || 0;
                }
                const currentPrice = currentPrices[pc.symbol];
                const isShort = pc.side === 'SHORT';
                const coreUnrealized = pc.core.qty > 0
                    ? (isShort ? (pc.core.vwap - currentPrice) : (currentPrice - pc.core.vwap)) * pc.core.qty
                    : 0;

                results.push({
                    pumpChaserId: pc.id,
                    symbol: pc.symbol,
                    side: pc.side,
                    state: pc.state,
                    profile: pc.profile,
                    startPrice: pc.startPrice,
                    currentPrice,
                    extreme: pc.extreme,
                    gate: pc.gate,
                    amplitude: pc.amplitude,
                    fillCount: pc.fills.length,
                    positionNotional: pc.core.qty * currentPrice,
                    maxNotional: pc.config.maxNotional,
                    core: { ...pc.core, unrealized: coreUnrealized },
                    scalp: {
                        pending: (pc.pendingScalps || []).map(s => ({ price: s.scalpPrice, qty: s.qty })),
                        roundTrips: pc.scalpRoundTrips.length,
                        totalProfit: pc.scalpProfit,
                    },
                    deleverage: pc._deleverageOrder ? {
                        price: pc._deleverageOrder.price,
                        qty: pc._deleverageOrder.qty,
                    } : null,
                    netPnl: pc.scalpProfit + coreUnrealized,
                    startedAt: pc.startedAt,
                });
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/pump-chaser/:pumpChaserId — Full state
router.get('/pump-chaser/:pumpChaserId', async (req, res) => {
    try {
        const pc = activePumpChasers.get(req.params.pumpChaserId);
        if (!pc) return res.status(404).json({ error: 'SURF not found or already stopped' });

        const currentPrice = exchange.getLatestPrice(pc.symbol) || 0;
        const isShort = pc.side === 'SHORT';
        const coreUnrealized = pc.core.qty > 0
            ? (isShort ? (pc.core.vwap - currentPrice) : (currentPrice - pc.core.vwap)) * pc.core.qty
            : 0;

        res.json({
            pumpChaserId: pc.id,
            subAccountId: pc.subAccountId,
            symbol: pc.symbol,
            side: pc.side,
            state: pc.state,
            profile: pc.profile,
            config: pc.config,
            startPrice: pc.startPrice,
            currentPrice,
            extreme: pc.extreme,
            gate: pc.gate,
            amplitude: pc.amplitude,
            positionNotional: pc.core.qty * currentPrice,
            maxNotional: pc.config.maxNotional,
            core: { ...pc.core, unrealized: coreUnrealized },
            scalp: {
                pending: pc.pendingScalps || [],
                roundTrips: pc.scalpRoundTrips,
                totalProfit: pc.scalpProfit,
            },
            fills: pc.fills,
            stats: pc.stats,
            netPnl: pc.scalpProfit + coreUnrealized,
            startedAt: pc.startedAt,
            activatedAt: pc.activatedAt,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/pump-chaser/:pumpChaserId/adjust — Adjust parameters on-the-fly
router.post('/pump-chaser/:pumpChaserId/adjust', async (req, res) => {
    try {
        const pc = activePumpChasers.get(req.params.pumpChaserId);
        if (!pc) return res.status(404).json({ error: 'Pump chaser not found' });
        if (pc.state === States.STOPPED) return res.status(400).json({ error: 'Pump chaser already stopped' });

        const adjustable = ['trailPct', 'stepPct', 'scalpRatio', 'spreadOffsetPct', 'maxMultiplier', 'bezierMaxPump', 'maxFillsPerHour', 'maxNotional'];
        const changes = {};

        for (const key of adjustable) {
            if (req.body[key] !== undefined) {
                const val = parseFloat(req.body[key]);
                if (Number.isFinite(val)) {
                    changes[key] = val;
                    pc.config[key] = key === 'scalpRatio' ? Math.max(0, Math.min(1, val)) : val;
                }
            }
        }

        // Allow pausing/resuming
        if (req.body.pause === true) {
            pc.state = States.PAUSED;
            changes.state = 'PAUSED';
        }
        if (req.body.resume === true && pc.state === States.PAUSED) {
            pc.state = States.ARMED;
            changes.state = 'ARMED';
        }

        // Recalculate gate with new trail
        const isShort = pc.side === 'SHORT';
        pc.gate = isShort
            ? pc.extreme * (1 - pc.config.trailPct / 100)
            : pc.extreme * (1 + pc.config.trailPct / 100);

        saveToRedis(pc);
        logPC(pc, `Adjusted: ${JSON.stringify(changes)}`);

        res.json({ success: true, changes, config: pc.config, state: pc.state });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/pump-chaser/:pumpChaserId — Stop
router.delete('/pump-chaser/:pumpChaserId', async (req, res) => {
    try {
        const pc = activePumpChasers.get(req.params.pumpChaserId);
        if (!pc) return res.status(404).json({ error: 'Pump chaser not found or already stopped' });

        const currentPrice = exchange.getLatestPrice(pc.symbol) || 0;
        const isShort = pc.side === 'SHORT';
        const coreUnrealized = pc.core.qty > 0
            ? (isShort ? (pc.core.vwap - currentPrice) : (currentPrice - pc.core.vwap)) * pc.core.qty
            : 0;

        await finishPumpChaser(pc, 'cancelled');

        res.json({
            success: true,
            pumpChaserId: pc.id,
            symbol: pc.symbol,
            side: pc.side,
            fills: pc.fills.length,
            scalpProfit: pc.scalpProfit,
            core: { ...pc.core },
            netPnl: pc.scalpProfit + coreUnrealized,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/pump-chaser/presets — List available presets
router.get('/pump-chaser-presets', (req, res) => {
    res.json(PRESETS);
});

// ── Resume from Redis on restart ──

export async function resumeActivePumpChasers() {
    const r = getRedis();
    if (!r) return;

    let resumed = 0;
    try {
        const keys = await r.keys(PC_REDIS_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);

                if (activePumpChasers.has(data.id)) continue;
                if (data.state === States.STOPPED) {
                    await r.del(key);
                    continue;
                }

                // Restore internal state
                data._unsubPrice = null;
                data._lastTickTs = 0;
                data._lastSaveTs = 0;
                data._processing = false;

                // Backward-compat: old Redis entries may not have new field names
                if (!data.side) data.side = 'SHORT';
                if (data.extreme == null && data.hwm != null) data.extreme = data.hwm;
                if (data.gate == null && data.floor != null) data.gate = data.floor;
                if (!data.pendingScalps && data.pendingBuys) data.pendingScalps = data.pendingBuys;
                if (!data.pendingScalps) data.pendingScalps = [];
                if (!data.scalpRoundTrips) data.scalpRoundTrips = [];
                if (data.scalpProfit == null) data.scalpProfit = 0;
                if (!data.fills) data.fills = [];
                if (!data.stats) data.stats = { gateActivations: 0, hwmJumpsFiltered: 0, scalpExpired: 0, deleverageCount: 0 };
                if (data.core == null) data.core = { qty: 0, vwap: 0, notional: 0 };
                if (data.amplitude == null) data.amplitude = 0;
                if (data.activatedAt === undefined) data.activatedAt = null;
                if (!data.deleverageFills) data.deleverageFills = [];
                data._deleverageChaseId = null;
                data._activeChaseIds = new Set();
                data._priceHistory = [];
                // Migrate totalBudget → maxNotional
                if (data.config && !data.config.maxNotional && data.config.totalBudget) {
                    data.config.maxNotional = data.config.totalBudget;
                }


                activePumpChasers.set(data.id, data);
                exchange.subscribeToPrices([data.symbol]);
                data._unsubPrice = subscribeToPriceUpdates(data);

                resumed++;
                logPC(data, `Resumed: ${data.side} ${data.symbol} state=${data.state} fills=${data.fills?.length || 0} position=$${(data.core?.qty * (exchange.getLatestPrice(data.symbol) || 0)).toFixed(0)}/$${data.config?.maxNotional || '?'}`);
                saveToRedis(data);
            } catch (err) {
                console.warn(`[SURF-Resume] Failed to restore ${key}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('[SURF-Resume] Scan failed:', err.message);
    }

    if (resumed > 0) {
        console.log(`[SURF-Resume] ✓ Resumed ${resumed} active SURF(s) from Redis`);
    }
}

// ── Cleanup interval ──

export function initPumpChaserCleanup() {
    setInterval(async () => {
        const now = Date.now();
        for (const [, pc] of activePumpChasers) {
            if (pc.state === States.STOPPED) continue;

            // Staleness detection: auto-stop SURFs with no price ticks for 5+ minutes
            if (pc._lastTickTs && now - pc._lastTickTs > 300000) {
                logPC(pc, 'STALE — no price ticks for 5+ minutes — auto-stopping');
                await finishPumpChaser(pc, 'stale');
                continue;
            }
        }
    }, 60000); // every 60s
}

export default router;
