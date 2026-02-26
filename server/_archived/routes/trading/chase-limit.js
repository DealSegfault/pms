/**
 * Chase Limit Engine — chases best bid/ask with optional stalk offset.
 *
 * Places a limit order at (or offset from) the best bid/ask and
 * continuously re-prices it as the market moves.
 *
 * Stalk modes:
 *   - none:     order sits at best bid/ask
 *   - maintain: order stays N% away from quote (both directions)
 *   - trail:    order only moves toward the market (one-way)
 *
 * State persisted to Redis so active chases survive restarts.
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getRedis } from '../../redis.js';
import { processChaseOrderFill } from '../../order-sync.js';

const router = Router();

// ── Redis persistence helpers ─────────────────────

const CHASE_REDIS_PREFIX = 'pms:chase:';
const CHASE_TTL_SEC = 86400; // 24 hours max

async function saveToRedis(ch) {
    try {
        const r = getRedis();
        if (!r) return;
        const { _unsubPrice, _repriceTimeout, _onFill, _onCancel, _repricing, ...data } = ch;
        await r.set(CHASE_REDIS_PREFIX + ch.id, JSON.stringify(data), 'EX', CHASE_TTL_SEC);
    } catch (err) {
        console.warn('[Chase-Redis] Save failed:', err.message);
    }
}

async function deleteFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(CHASE_REDIS_PREFIX + id);
    } catch { /* ignore */ }
}

// ── Chase Engine ──────────────────────────────────

const activeChaseOrders = new Map(); // id → ChaseState
const MAX_ACTIVE_CHASES = 500;

function generateId() {
    return `chase_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Throttle: don't reprice more than once per 500ms ──
const REPRICE_THROTTLE_MS = 500;
const REDIS_SAVE_THROTTLE_MS = 1000;

/**
 * Calculate the target order price based on side, quote, and stalk offset.
 * BUY:  best bid (- stalkOffset% if stalking)
 * SELL: best ask (+ stalkOffset% if stalking)
 */
function computeTargetPrice(side, bid, ask, stalkOffsetPct) {
    if (side === 'LONG') {
        const base = bid;
        return stalkOffsetPct > 0 ? base * (1 - stalkOffsetPct / 100) : base;
    }
    // SHORT
    const base = ask;
    return stalkOffsetPct > 0 ? base * (1 + stalkOffsetPct / 100) : base;
}

/**
 * Check whether the chase has exceeded the max distance cap.
 * Returns true if the chase should be auto-cancelled.
 */
function isDistanceBreached(ch, currentQuote) {
    if (!ch.maxDistancePct || ch.maxDistancePct <= 0) return false; // infinite
    const pctMove = Math.abs(currentQuote - ch.initialPrice) / ch.initialPrice * 100;
    return pctMove > ch.maxDistancePct;
}

/**
 * Decide whether the order should be re-priced under stalk mode rules.
 * - maintain: always reprice to keep offset distance
 * - trail: only move toward the market (LONG = up, SHORT = down)
 * - none: always reprice to best bid/ask
 */
function shouldReprice(ch, newTarget) {
    if (!ch.lastOrderPrice) return true; // first placement

    const diff = Math.abs(newTarget - ch.lastOrderPrice);
    // Don't reprice if change is < 0.001% (noise filter)
    if (diff / ch.lastOrderPrice < 0.00001) return false;

    if (ch.stalkMode === 'trail') {
        // Trail: only move toward market
        if (ch.side === 'LONG') {
            // BUY: only move price UP (toward ask)
            return newTarget > ch.lastOrderPrice;
        } else {
            // SELL: only move price DOWN (toward bid)
            return newTarget < ch.lastOrderPrice;
        }
    }

    // maintain or none: always reprice when target changes
    return true;
}

/**
 * Round a price to the symbol's tick size for exchange compatibility.
 * Note: ccxt for Binance futures stores precision.price as the TICK SIZE
 * (e.g., 0.00001), NOT the number of decimal places.
 */
function roundToTickSize(symbol, price) {
    try {
        const market = exchange.markets?.[symbol];
        if (market?.precision?.price != null) {
            const tickSize = market.precision.price;
            if (tickSize >= 1) {
                // tickSize is already decimal places count (some exchanges)
                return parseFloat(price.toFixed(tickSize));
            }
            // tickSize is the actual tick (e.g., 0.00001 → 5 decimal places)
            const decimalPlaces = Math.max(0, Math.round(-Math.log10(tickSize)));
            return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(decimalPlaces));
        }
    } catch { /* ignore */ }
    // Fallback: round to 8 decimal places
    return parseFloat(price.toFixed(8));
}

/**
 * Clamp a price to the exchange's PRICE_FILTER and PERCENT_PRICE limits.
 * Prevents Binance -4016 ("can't be higher") and -4024 ("can't be lower") errors.
 *
 * PRICE_FILTER: static min/max (wide range, rarely hit)
 * PERCENT_PRICE: dynamic min/max = mark × multiplierDown/Up (~85%-115%)
 */
function clampToMarketLimits(symbol, price) {
    try {
        const market = exchange.markets?.[symbol];
        if (!market) return price;

        // Static PRICE_FILTER limits
        const min = market.limits?.price?.min;
        const max = market.limits?.price?.max;
        if (min != null && price < min) price = min;
        if (max != null && price > max) price = max;

        // Dynamic PERCENT_PRICE limits (mark × multiplierDown/Up)
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

async function handlePriceTick(ch, price) {
    if (!activeChaseOrders.has(ch.id)) return;
    if (ch.status !== 'active') return;
    if (ch._dead) return;
    if (ch._repricing) return; // already mid-reprice
    if (!price || !Number.isFinite(price) || price <= 0) return;

    // Throttle reprices
    const now = Date.now();
    if (now - (ch._lastRepriceTs || 0) < REPRICE_THROTTLE_MS) return;

    // Get bid/ask
    const bidAsk = exchange.getLatestBidAsk(ch.symbol);
    if (!bidAsk || !bidAsk.bid || !bidAsk.ask) return;

    const { bid, ask } = bidAsk;
    const currentQuote = ch.side === 'LONG' ? bid : ask;

    // Check distance cap
    if (isDistanceBreached(ch, currentQuote)) {
        console.log(`[Chase ${ch.id}] Distance cap breached (${ch.maxDistancePct}%) — auto-cancelling`);
        await finishChase(ch, 'distance_breached');
        return;
    }

    // Compute target price
    const rawTarget = computeTargetPrice(ch.side, bid, ask, ch.stalkOffsetPct);
    const target = clampToMarketLimits(ch.symbol, roundToTickSize(ch.symbol, rawTarget));

    if (!shouldReprice(ch, target)) {
        // Still broadcast progress even if not re-pricing
        if (now - (ch._lastSaveTs || 0) > REDIS_SAVE_THROTTLE_MS) {
            ch._lastSaveTs = now;
            broadcastProgress(ch, bid, ask);
        }
        return;
    }

    ch._repricing = true;
    ch._lastRepriceTs = now;

    try {
        // Cancel previous order (if exists)
        if (ch.currentExchangeOrderId) {
            try {
                await exchange.cancelOrder(ch.symbol, ch.currentExchangeOrderId);
            } catch (err) {
                // Order might already be filled or cancelled
                if (err.message?.includes('Unknown order') || err.message?.includes('UNKNOWN_ORDER')) {
                    // Check if it was filled
                    try {
                        const orderStatus = await exchange.fetchOrder(ch.symbol, ch.currentExchangeOrderId);
                        if (orderStatus?.status === 'closed' || orderStatus?.status === 'filled') {
                            console.log(`[Chase ${ch.id}] Order was filled during reprice!`);
                            await handleChaseFilled(ch, orderStatus);
                            return;
                        }
                    } catch { /* ignore */ }
                } else {
                    console.warn(`[Chase ${ch.id}] Cancel failed:`, err.message);
                }
            }
        }

        // Place new order — must forward reduceOnly on every reprice, not just the first placement.
        // Omitting it here would turn a reduce-only close into a position-opening order.
        const orderSide = ch.side === 'LONG' ? 'buy' : 'sell';
        const orderOpts = ch._reduceOnly ? { reduceOnly: true } : {};
        const result = await exchange.createLimitOrder(ch.symbol, orderSide, ch.quantity, target, orderOpts);

        // Post-await guard: if chase was cancelled during the await, cancel the orphaned order
        if (ch.status !== 'active' || ch._dead || !activeChaseOrders.has(ch.id)) {
            console.warn(`[Chase ${ch.id}] Reprice completed after cancel — killing orphaned order ${result.orderId}`);
            try { await exchange.cancelOrder(ch.symbol, result.orderId); } catch { }
            return;
        }

        ch.currentExchangeOrderId = result.orderId;
        ch.lastOrderPrice = target;
        ch.repriceCount = (ch.repriceCount || 0) + 1;

        // Throttled Redis save + WS broadcast
        if (now - (ch._lastSaveTs || 0) > REDIS_SAVE_THROTTLE_MS) {
            ch._lastSaveTs = now;
            saveToRedis(ch);
        }

        broadcastProgress(ch, bid, ask);
    } catch (err) {
        console.error(`[Chase ${ch.id}] Reprice failed:`, err.message);
        // If exchange error is fatal (e.g. insufficient margin), cancel the chase
        if (err.message?.includes('insufficient') || err.message?.includes('Margin is insufficient')) {
            console.log(`[Chase ${ch.id}] Insufficient margin — auto-cancelling`);
            await finishChase(ch, 'error');
        } else if (err.message?.includes('-4016') || err.message?.includes('PRICE_FILTER') || err.message?.toLowerCase()?.includes("price can't be")) {
            // Price filter breach — skip this tick, will retry when price moves back in range
            console.warn(`[Chase ${ch.id}] Price filter breach — skipping reprice, will retry on next tick`);
        }
    } finally {
        ch._repricing = false;
    }
}

function broadcastProgress(ch, bid, ask) {
    // Internal chases (spawned by scalper etc.) don't broadcast their own progress
    if (ch._internal) return;
    broadcast('chase_progress', {
        chaseId: ch.id,
        subAccountId: ch.subAccountId,
        symbol: ch.symbol,
        side: ch.side,
        quantity: ch.quantity,
        stalkOffsetPct: ch.stalkOffsetPct,
        stalkMode: ch.stalkMode,
        maxDistancePct: ch.maxDistancePct,
        currentOrderPrice: ch.lastOrderPrice,
        initialPrice: ch.initialPrice,
        repriceCount: ch.repriceCount || 0,
        bid,
        ask,
    });
}

async function handleChaseFilled(ch, orderStatus) {
    ch.status = 'filled';
    ch.filledAt = Date.now();
    ch.fillPrice = orderStatus?.price || orderStatus?.average || ch.lastOrderPrice;

    // Unsubscribe from price updates
    if (ch._unsubPrice) {
        ch._unsubPrice();
        ch._unsubPrice = null;
    }

    // Internal-only chases (pure algorithmic, no position tracking needed e.g. scalper)
    if (ch._internal && !ch.parentScalperId && ch._onFill) {
        try {
            await ch._onFill(ch.fillPrice, ch.quantity, ch.id);
            console.log(`[Chase ${ch.id}] Internal fill callback completed at $${ch.fillPrice}`);
        } catch (err) {
            console.error(`[Chase ${ch.id}] Internal fill callback failed:`, err.message);
        }
        activeChaseOrders.delete(ch.id);
        deleteFromRedis(ch.id);
        return;
    }

    // Process the fill through order-sync to create/update the virtual position.
    // This handles: pendingOrder status update, virtual position creation,
    // risk engine sync, and WS broadcast of order_filled.
    try {
        await processChaseOrderFill({
            exchangeOrderId: String(ch.currentExchangeOrderId),
            subAccountId: ch.subAccountId,
            symbol: ch.symbol,
            fillPrice: ch.fillPrice,
            fillQty: ch.quantity,
        });
        console.log(`[Chase ${ch.id}] Filled at $${ch.fillPrice}`);
    } catch (err) {
        console.error(`[Chase ${ch.id}] Fill processing failed:`, err.message);
    }

    // Scalper child: notify parent orchestrator so it can restart this slot
    if (ch._onFill) {
        try {
            await ch._onFill(ch.fillPrice, ch.quantity, ch.id);
        } catch (err) {
            console.error(`[Chase ${ch.id}] Fill callback (restart) failed:`, err.message);
        }
    }

    // Cleanup
    activeChaseOrders.delete(ch.id);
    deleteFromRedis(ch.id);

    broadcast('chase_filled', {
        chaseId: ch.id,
        subAccountId: ch.subAccountId,
        symbol: ch.symbol,
        side: ch.side,
        fillPrice: ch.fillPrice,
        quantity: ch.quantity,
        repriceCount: ch.repriceCount || 0,
        parentScalperId: ch.parentScalperId || null,
    });
}

async function finishChase(ch, reason) {
    ch.status = reason; // 'cancelled', 'distance_breached', 'error'
    ch._dead = true;   // fast-path flag so in-flight reprices bail out immediately

    if (ch._unsubPrice) {
        ch._unsubPrice();
        ch._unsubPrice = null;
    }

    // Cancel any remaining exchange order
    if (ch.currentExchangeOrderId) {
        try {
            await exchange.cancelOrder(ch.symbol, ch.currentExchangeOrderId);
        } catch (err) {
            // Might already be filled
            if (!err.message?.includes('Unknown order') && !err.message?.includes('UNKNOWN_ORDER')) {
                console.warn(`[Chase ${ch.id}] Cancel on finish failed:`, err.message);
            }
        }
    }

    activeChaseOrders.delete(ch.id);
    deleteFromRedis(ch.id);

    // Always call onCancel if set (scalper uses this for slot restart logic)
    if (ch._onCancel) {
        try { ch._onCancel(reason, ch.id); } catch { /* ignore */ }
    }

    // Pure internal chases: suppress public broadcast
    if (ch._internal && !ch.parentScalperId) {
        console.log(`[Chase ${ch.id}] Internal ${reason}: ${ch.symbol} ${ch.side}`);
        return;
    }

    console.log(`[Chase ${ch.id}] ${reason}: ${ch.symbol} ${ch.side}`);

    broadcast(`chase_cancelled`, {
        chaseId: ch.id,
        subAccountId: ch.subAccountId,
        symbol: ch.symbol,
        side: ch.side,
        reason,
        parentScalperId: ch.parentScalperId || null,
    });
}

/**
 * Subscribe to price updates for a chase.
 * Returns an unsubscribe function.
 */
function subscribeToPriceUpdates(ch) {
    exchange.subscribeToPrices([ch.symbol]);
    const handler = ({ symbol, mark }) => {
        if (symbol === ch.symbol) {
            handlePriceTick(ch, mark);
        }
    };
    exchange.on('price', handler);
    return () => exchange.off('price', handler);
}

/**
 * Periodically check if chase orders were filled on exchange.
 * Supplements the real-time proxy-stream fill detection.
 */
function startFillChecker() {
    setInterval(async () => {
        for (const [, ch] of activeChaseOrders) {
            if (ch.status !== 'active' || !ch.currentExchangeOrderId) continue;
            try {
                const orderStatus = await exchange.fetchOrder(ch.symbol, ch.currentExchangeOrderId);
                if (orderStatus?.status === 'closed' || orderStatus?.status === 'filled') {
                    console.log(`[Chase ${ch.id}] Fill detected by checker`);
                    await handleChaseFilled(ch, orderStatus);
                }
            } catch { /* ignore — order might have been cancelled during reprice */ }
        }
    }, 5000); // every 5s
}

// Start the fill checker once at module load
startFillChecker();

// ── Internal API (for Scalper and other algos) ───────

/**
 * Start a chase order programmatically (no HTTP).
 * Used by Scalper engine to spawn child orders.
 *
 * @param {Object} opts
 * @param {string} opts.subAccountId
 * @param {string} opts.symbol
 * @param {string} opts.side — 'LONG' or 'SHORT'
 * @param {number} opts.quantity
 * @param {number} opts.leverage
 * @param {number} [opts.stalkOffsetPct=0]
 * @param {string} [opts.stalkMode='trail']
 * @param {number} [opts.maxDistancePct=0] — 0 = infinite
 * @param {string} [opts.orderType='CHASE_LIMIT'] — DB order type
 * @param {boolean} [opts.reduceOnly=false]
 * @param {Function} [opts.onFill] — (fillPrice, fillQty, chaseId) => void
 * @param {Function} [opts.onCancel] — (reason, chaseId) => void
 * @returns {Promise<{ chaseId: string, cancel: () => Promise<void> }>}
 */
export async function startChaseInternal(opts) {
    const {
        subAccountId, symbol, side, quantity, leverage,
        stalkOffsetPct = 0, stalkMode = 'trail', maxDistancePct = 0,
        orderType = 'CHASE_LIMIT', reduceOnly = false,
        onFill, onCancel,
        parentScalperId = null,  // non-null → child of a scalper, stays visible in active list
        internal = false,        // true → pure algorithmic, hidden from active list
    } = opts;

    if (!subAccountId || !symbol || !side || !quantity || !leverage) {
        throw new Error('Missing required fields for internal chase: subAccountId, symbol, side, quantity, leverage');
    }

    const parsedSide = side.toUpperCase();
    const parsedQty = parseFloat(quantity);
    const parsedLeverage = parseInt(leverage);
    const parsedOffset = Math.max(0, Math.min(10, parseFloat(stalkOffsetPct) || 0));
    const parsedDistance = Math.max(0, Math.min(50, parseFloat(maxDistancePct) || 0));
    const validModes = ['none', 'maintain', 'trail'];
    const mode = validModes.includes(stalkMode) ? stalkMode : 'trail';

    // Get bid/ask
    let bidAsk = exchange.getLatestBidAsk(symbol);
    if (!bidAsk?.bid || !bidAsk?.ask) {
        try {
            const ticker = await exchange.fetchTicker(symbol);
            bidAsk = { bid: Number(ticker?.bid || ticker?.last), ask: Number(ticker?.ask || ticker?.last) };
        } catch { /* ignore */ }
    }
    if (!bidAsk?.bid || !bidAsk?.ask) {
        throw new Error(`Cannot get bid/ask for ${symbol}`);
    }

    // Compute initial target
    const rawTarget = computeTargetPrice(parsedSide, bidAsk.bid, bidAsk.ask, parsedOffset);
    const target = clampToMarketLimits(symbol, roundToTickSize(symbol, rawTarget));

    // Place initial limit order
    const orderSide = parsedSide === 'LONG' ? 'buy' : 'sell';
    const orderOpts = reduceOnly ? { reduceOnly: true } : {};
    const exchangeResult = await exchange.createLimitOrder(symbol, orderSide, parsedQty, target, orderOpts);

    // Store in DB as pendingOrder
    await prisma.pendingOrder.create({
        data: {
            subAccountId,
            symbol,
            side: parsedSide,
            type: orderType,
            price: target,
            quantity: parsedQty,
            leverage: parsedLeverage,
            status: 'PENDING',
            exchangeOrderId: String(exchangeResult.orderId),
        },
    });

    const id = generateId();
    const currentQuote = parsedSide === 'LONG' ? bidAsk.bid : bidAsk.ask;

    const ch = {
        id,
        subAccountId,
        symbol,
        side: parsedSide,
        quantity: parsedQty,
        leverage: parsedLeverage,
        stalkOffsetPct: parsedOffset,
        stalkMode: mode,
        maxDistancePct: parsedDistance,
        currentExchangeOrderId: exchangeResult.orderId,
        initialPrice: currentQuote,
        lastOrderPrice: target,
        repriceCount: 0,
        startedAt: Date.now(),
        status: 'active',
        // Flags
        _internal: internal,          // pure algorithmic: hide from list, no broadcast
        parentScalperId,              // non-null: child of scalper, shown in drawer
        _orderType: orderType,
        _reduceOnly: reduceOnly,
        _onFill: onFill || null,
        _onCancel: onCancel || null,
        // Runtime
        _unsubPrice: null,
        _lastRepriceTs: 0,
        _lastSaveTs: 0,
        _repricing: false,
    };

    if (activeChaseOrders.size >= MAX_ACTIVE_CHASES) {
        throw new Error(`Maximum concurrent chase orders (${MAX_ACTIVE_CHASES}) reached`);
    }

    activeChaseOrders.set(id, ch);
    ch._unsubPrice = subscribeToPriceUpdates(ch);
    saveToRedis(ch);

    const scopeLabel = parentScalperId ? `Scalper[${parentScalperId.slice(-6)}]` : (internal ? 'Internal' : 'Direct');
    console.log(`[Chase ${id}] ${scopeLabel} started: ${symbol} ${parsedSide}, qty ${parsedQty}, offset ${parsedOffset}%, type ${orderType}${reduceOnly ? ' (reduceOnly)' : ''}`);

    return {
        chaseId: id,
        cancel: () => cancelChaseInternal(id),
    };
}

/**
 * Cancel a chase order programmatically (no HTTP).
 * @param {string} chaseId
 */
export async function cancelChaseInternal(chaseId) {
    const ch = activeChaseOrders.get(chaseId);
    if (!ch) return; // already finished
    await finishChase(ch, 'cancelled');
}

/**
 * Start multiple chase orders in a single Binance REST call (batch API).
 * Used by the scalper's startLeg to place all layer orders at once.
 *
 * Each spec in the array produces one chase state — same as startChaseInternal
 * but all limit orders are submitted as a single /fapi/v1/batchOrders call.
 *
 * Max 5 per call (Binance limit). For > 5, callers should chunk and call multiple times.
 *
 * @param {Array<Object>} specs — array of chase specifications:
 *   { subAccountId, symbol, side, quantity, leverage, stalkOffsetPct, stalkMode,
 *     maxDistancePct, orderType, reduceOnly, parentScalperId, internal, onFill, onCancel }
 * @returns {Promise<Array<{chaseId: string|null, cancel: Function|null, error: string|null}>>}
 */
export async function startChaseBatch(specs) {
    if (!specs || specs.length === 0) return [];
    if (specs.length > 5) throw new Error('startChaseBatch: max 5 orders per batch');

    // All specs must share the same symbol (Binance batch requirement for uniform routing)
    const symbol = specs[0].symbol;

    // Get bid/ask once for all orders
    let bidAsk = exchange.getLatestBidAsk(symbol);
    if (!bidAsk?.bid || !bidAsk?.ask) {
        try {
            const ticker = await exchange.fetchTicker(symbol);
            bidAsk = { bid: Number(ticker?.bid || ticker?.last), ask: Number(ticker?.ask || ticker?.last) };
        } catch { /* ignore */ }
    }
    if (!bidAsk?.bid || !bidAsk?.ask) {
        throw new Error(`Cannot get bid/ask for ${symbol}`);
    }

    // Pre-compute targets for all orders
    const prepared = specs.map(spec => {
        const parsedSide = spec.side.toUpperCase();
        const parsedQty = parseFloat(spec.quantity);
        const parsedOffset = Math.max(0, Math.min(10, parseFloat(spec.stalkOffsetPct) || 0));
        const rawTarget = computeTargetPrice(parsedSide, bidAsk.bid, bidAsk.ask, parsedOffset);
        const target = clampToMarketLimits(symbol, roundToTickSize(symbol, rawTarget));
        const orderSide = parsedSide === 'LONG' ? 'buy' : 'sell';
        return { ...spec, parsedSide, parsedQty, parsedOffset, target, orderSide };
    });

    // Build batch order array for exchange
    const batchInput = prepared.map(p => ({
        symbol,
        side: p.orderSide,
        quantity: p.parsedQty,
        price: p.target,
        params: p.reduceOnly ? { reduceOnly: true } : {},
    }));

    // Place all orders in a single REST call
    const batchResults = await exchange.createBatchLimitOrders(batchInput);

    // Now register chase states for each successful order
    const results = [];
    const dbWrites = [];

    for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const result = batchResults[i];

        if (!result || result.error) {
            // This individual order failed — return null chaseId so caller can retry
            console.error(`[Chase-Batch] Order ${i} failed: ${result?.error || 'no response'}`);
            results.push({ chaseId: null, cancel: null, error: result?.error || 'batch order failed' });
            continue;
        }

        const parsedLeverage = parseInt(p.leverage);
        const parsedDistance = Math.max(0, Math.min(50, parseFloat(p.maxDistancePct) || 0));
        const validModes = ['none', 'maintain', 'trail'];
        const mode = validModes.includes(p.stalkMode) ? p.stalkMode : 'trail';
        const currentQuote = p.parsedSide === 'LONG' ? bidAsk.bid : bidAsk.ask;

        // DB write (collect for parallel execution)
        dbWrites.push(prisma.pendingOrder.create({
            data: {
                subAccountId: p.subAccountId,
                symbol,
                side: p.parsedSide,
                type: p.orderType || 'CHASE_LIMIT',
                price: p.target,
                quantity: p.parsedQty,
                leverage: parsedLeverage,
                status: 'PENDING',
                exchangeOrderId: String(result.orderId),
            },
        }));

        const id = generateId();

        const ch = {
            id,
            subAccountId: p.subAccountId,
            symbol,
            side: p.parsedSide,
            quantity: p.parsedQty,
            leverage: parsedLeverage,
            stalkOffsetPct: p.parsedOffset,
            stalkMode: mode,
            maxDistancePct: parsedDistance,
            currentExchangeOrderId: result.orderId,
            initialPrice: currentQuote,
            lastOrderPrice: p.target,
            repriceCount: 0,
            startedAt: Date.now(),
            status: 'active',
            _internal: p.internal || false,
            parentScalperId: p.parentScalperId || null,
            _orderType: p.orderType || 'CHASE_LIMIT',
            _reduceOnly: p.reduceOnly || false,
            _onFill: p.onFill || null,
            _onCancel: p.onCancel || null,
            _unsubPrice: null,
            _lastRepriceTs: 0,
            _lastSaveTs: 0,
            _repricing: false,
        };

        if (activeChaseOrders.size < MAX_ACTIVE_CHASES) {
            activeChaseOrders.set(id, ch);
            ch._unsubPrice = subscribeToPriceUpdates(ch);
            saveToRedis(ch);

            const scopeLabel = p.parentScalperId ? `Scalper[${p.parentScalperId.slice(-6)}]` : (p.internal ? 'Internal' : 'Direct');
            console.log(`[Chase-Batch ${id}] ${scopeLabel}: ${symbol} ${p.parsedSide}, qty ${p.parsedQty}, offset ${p.parsedOffset}%${p.reduceOnly ? ' (reduceOnly)' : ''}`);

            results.push({
                chaseId: id,
                cancel: () => cancelChaseInternal(id),
                error: null,
            });
        } else {
            console.warn(`[Chase-Batch] Max chases reached — order ${result.orderId} placed but chase not tracked`);
            results.push({ chaseId: null, cancel: null, error: 'max chases reached' });
        }
    }

    // Execute all DB writes in parallel (non-blocking for chase registration)
    Promise.allSettled(dbWrites).then(settled => {
        const failed = settled.filter(s => s.status === 'rejected');
        if (failed.length > 0) {
            console.warn(`[Chase-Batch] ${failed.length}/${dbWrites.length} DB writes failed`);
        }
    });

    return results;
}

// ── Routes ────────────────────────────────────────

// POST /api/trade/chase-limit — Start a chase order
router.post('/chase-limit', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, symbol, side, quantity, leverage, stalkOffsetPct, stalkMode, maxDistancePct } = req.body;

        if (!subAccountId || !symbol || !side || !quantity || !leverage) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, quantity, leverage' });
        }

        const parsedQty = parseFloat(quantity);
        if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
            return res.status(400).json({ error: 'quantity must be a positive number' });
        }

        const parsedLeverage = parseInt(leverage);
        if (!Number.isFinite(parsedLeverage) || parsedLeverage < 1 || parsedLeverage > 125) {
            return res.status(400).json({ error: 'leverage must be between 1 and 125' });
        }

        const parsedOffset = parseFloat(stalkOffsetPct) || 0;
        if (parsedOffset < 0 || parsedOffset > 10) {
            return res.status(400).json({ error: 'stalkOffsetPct must be between 0 and 10' });
        }

        const validModes = ['none', 'maintain', 'trail'];
        const mode = validModes.includes(stalkMode) ? stalkMode : 'none';

        const parsedDistance = parseFloat(maxDistancePct) || 0;
        if (parsedDistance < 0 || parsedDistance > 50) {
            return res.status(400).json({ error: 'maxDistancePct must be between 0 and 50 (0 = infinite)' });
        }

        // Get current bid/ask for initial placement
        // Prefer client-sent orderbook bid/ask (what the user sees in preview)
        // to avoid stale/different WS bookTicker data on the server
        const clientBid = parseFloat(req.body.clientBid);
        const clientAsk = parseFloat(req.body.clientAsk);

        let bidAsk = null;
        const serverBidAsk = exchange.getLatestBidAsk(symbol);

        if (Number.isFinite(clientBid) && clientBid > 0 && Number.isFinite(clientAsk) && clientAsk > 0) {
            // Use client bid/ask — this is what the user saw in the preview
            bidAsk = { bid: clientBid, ask: clientAsk };
            if (serverBidAsk?.bid) {
                const drift = Math.abs(clientBid - serverBidAsk.bid) / serverBidAsk.bid;
                if (drift > 0.05) {
                    console.warn(`[Chase] Client bid/ask drifts >5% from server (client bid=${clientBid}, server bid=${serverBidAsk.bid}). Using client values.`);
                }
            }
        } else if (serverBidAsk?.bid && serverBidAsk?.ask) {
            bidAsk = serverBidAsk;
        } else {
            // Fallback to REST
            try {
                const ticker = await exchange.fetchTicker(symbol);
                bidAsk = {
                    bid: Number(ticker?.bid || ticker?.last),
                    ask: Number(ticker?.ask || ticker?.last),
                };
            } catch { /* ignore */ }
        }
        if (!bidAsk?.bid || !bidAsk?.ask) {
            return res.status(500).json({ error: 'Cannot get current bid/ask for this symbol' });
        }

        // Set leverage
        await exchange.setLeverage(symbol, parsedLeverage);

        // Compute initial target price
        const rawTarget = computeTargetPrice(side.toUpperCase(), bidAsk.bid, bidAsk.ask, parsedOffset);
        const target = clampToMarketLimits(symbol, roundToTickSize(symbol, rawTarget));

        console.log(`[Chase] Initial placement debug: symbol=${symbol}, side=${side}, bid=${bidAsk.bid}, ask=${bidAsk.ask}, offset=${parsedOffset}%, rawTarget=${rawTarget}, target=${target}, qty=${parsedQty}, serverBid=${serverBidAsk?.bid || 'N/A'}, serverAsk=${serverBidAsk?.ask || 'N/A'}`);

        // Place initial limit order
        const orderSide = side.toUpperCase() === 'LONG' ? 'buy' : 'sell';
        const exchangeResult = await exchange.createLimitOrder(symbol, orderSide, parsedQty, target);

        // Store in DB
        await prisma.pendingOrder.create({
            data: {
                subAccountId,
                symbol,
                side: side.toUpperCase(),
                type: 'CHASE_LIMIT',
                price: target,
                quantity: parsedQty,
                leverage: parsedLeverage,
                status: 'PENDING',
                exchangeOrderId: String(exchangeResult.orderId),
            },
        });

        const id = generateId();
        const currentQuote = side.toUpperCase() === 'LONG' ? bidAsk.bid : bidAsk.ask;

        const ch = {
            id,
            subAccountId,
            symbol,
            side: side.toUpperCase(),
            quantity: parsedQty,
            leverage: parsedLeverage,
            stalkOffsetPct: parsedOffset,
            stalkMode: mode,
            maxDistancePct: parsedDistance,
            currentExchangeOrderId: exchangeResult.orderId,
            initialPrice: currentQuote,
            lastOrderPrice: target,
            repriceCount: 0,
            startedAt: Date.now(),
            status: 'active',
            _unsubPrice: null,
            _lastRepriceTs: 0,
            _lastSaveTs: 0,
            _repricing: false,
        };

        if (activeChaseOrders.size >= MAX_ACTIVE_CHASES) {
            return res.status(429).json({ error: `Maximum concurrent chase orders (${MAX_ACTIVE_CHASES}) reached` });
        }

        activeChaseOrders.set(id, ch);
        ch._unsubPrice = subscribeToPriceUpdates(ch);
        saveToRedis(ch);

        console.log(`[Chase ${id}] Started: ${symbol} ${side.toUpperCase()}, qty ${parsedQty}, offset ${parsedOffset}%, mode ${mode}, dist ${parsedDistance}%, initial @ $${target}`);

        res.status(201).json({
            success: true,
            chaseId: id,
            symbol,
            side: side.toUpperCase(),
            quantity: parsedQty,
            stalkOffsetPct: parsedOffset,
            stalkMode: mode,
            maxDistancePct: parsedDistance,
            currentOrderPrice: target,
            initialPrice: currentQuote,
            bid: bidAsk.bid,
            ask: bidAsk.ask,
        });
    } catch (err) {
        console.error('[Chase] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/chase-limit/active/:subAccountId
router.get('/chase-limit/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = [];
        for (const [, ch] of activeChaseOrders) {
            if (ch.subAccountId === req.params.subAccountId && !ch._internal) {
                results.push({
                    chaseId: ch.id,
                    symbol: ch.symbol,
                    side: ch.side,
                    quantity: ch.quantity,
                    stalkOffsetPct: ch.stalkOffsetPct,
                    stalkMode: ch.stalkMode,
                    maxDistancePct: ch.maxDistancePct,
                    currentOrderPrice: ch.lastOrderPrice,
                    initialPrice: ch.initialPrice,
                    repriceCount: ch.repriceCount || 0,
                    startedAt: new Date(ch.startedAt).toISOString(),
                    status: ch.status,
                    parentScalperId: ch.parentScalperId || null,
                    reduceOnly: ch._reduceOnly || false,
                });
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/chase-limit/:chaseId
router.delete('/chase-limit/:chaseId', async (req, res) => {
    try {
        const ch = activeChaseOrders.get(req.params.chaseId);
        if (!ch) return res.status(404).json({ error: 'Chase order not found or already completed' });

        // Ownership check
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({
                where: { id: ch.subAccountId },
                select: { userId: true },
            });
            if (account?.userId !== req.user?.id) {
                return res.status(403).json({ error: 'You do not own this chase order' });
            }
        }

        await finishChase(ch, 'cancelled');
        console.log(`[Chase ${ch.id}] Cancelled by user`);

        res.json({
            success: true,
            chaseId: ch.id,
            symbol: ch.symbol,
            side: ch.side,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Resume active chase orders from Redis on server restart ──

export async function resumeActiveChaseOrders() {
    const r = getRedis();
    if (!r) return;

    let resumed = 0;

    try {
        const keys = await r.keys(CHASE_REDIS_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);

                if (activeChaseOrders.has(data.id)) continue; // already running

                // Verify the exchange order is still active
                try {
                    if (data.currentExchangeOrderId) {
                        const orderStatus = await exchange.fetchOrder(data.symbol, data.currentExchangeOrderId);
                        if (orderStatus?.status === 'closed' || orderStatus?.status === 'filled') {
                            console.log(`[Chase-Resume] ${data.id} — order already filled, cleaning up`);
                            await r.del(key);
                            continue;
                        }
                        if (orderStatus?.status === 'canceled' || orderStatus?.status === 'cancelled') {
                            console.log(`[Chase-Resume] ${data.id} — order cancelled on exchange, cleaning up`);
                            await r.del(key);
                            continue;
                        }
                    }
                } catch (err) {
                    console.warn(`[Chase-Resume] ${data.id} — failed to check order:`, err.message);
                }

                // Restore state
                data._unsubPrice = null;
                data._lastRepriceTs = 0;
                data._lastSaveTs = 0;
                data._repricing = false;

                activeChaseOrders.set(data.id, data);

                // Re-subscribe to price stream
                exchange.subscribeToPrices([data.symbol]);
                data._unsubPrice = subscribeToPriceUpdates(data);

                resumed++;
                console.log(`[Chase-Resume] Resumed ${data.id}: ${data.symbol} ${data.side}, offset ${data.stalkOffsetPct}%, last @ $${data.lastOrderPrice?.toFixed(2) || '—'}`);
                saveToRedis(data);
            } catch (err) {
                console.warn(`[Chase-Resume] Failed to restore ${key}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('[Chase-Resume] Scan failed:', err.message);
    }

    if (resumed > 0) {
        console.log(`[Chase-Resume] ✓ Resumed ${resumed} active chase order(s) from Redis`);
    }
}

// ── Auto-cleanup: cancel chases for closed/stale orders ──

export function initChaseCleanup() {
    setInterval(async () => {
        for (const [, ch] of activeChaseOrders) {
            if (ch.status !== 'active') continue;
            // Check if exchange order is still valid
            try {
                if (ch.currentExchangeOrderId) {
                    const orderStatus = await exchange.fetchOrder(ch.symbol, ch.currentExchangeOrderId);
                    if (orderStatus?.status === 'closed' || orderStatus?.status === 'filled') {
                        console.log(`[Chase-Cleanup] ${ch.id} — order filled, handling fill`);
                        await handleChaseFilled(ch, orderStatus);
                    }
                }
            } catch { /* ignore */ }
        }
    }, 30000); // every 30s
}

export default router;
