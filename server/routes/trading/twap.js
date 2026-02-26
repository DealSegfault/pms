/**
 * TWAP Engine + TWAP Basket Engine — routes and scheduling.
 */
import { Router } from 'express';
import riskEngine, { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getRedis } from '../../redis.js';

const router = Router();

// ── Redis persistence helpers ─────────────────────

const TWAP_REDIS_PREFIX = 'pms:twap:';
const TWAP_BASKET_REDIS_PREFIX = 'pms:twapb:';
const TWAP_TTL_SEC = 43200; // 12 hours max

/** Serialize single-symbol TWAP state to Redis (exclude timerId). */
async function saveTwapToRedis(twap) {
    try {
        const r = getRedis();
        if (!r) return;
        const { timerId, ...data } = twap;
        await r.set(TWAP_REDIS_PREFIX + twap.id, JSON.stringify(data), 'EX', TWAP_TTL_SEC);
    } catch (err) {
        console.warn('[TWAP-Redis] Save failed:', err.message);
    }
}

async function deleteTwapFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(TWAP_REDIS_PREFIX + id);
    } catch { /* ignore */ }
}

/** Serialize basket TWAP state to Redis (exclude timerId). */
async function saveTwapBasketToRedis(basket) {
    try {
        const r = getRedis();
        if (!r) return;
        const { timerId, ...data } = basket;
        await r.set(TWAP_BASKET_REDIS_PREFIX + basket.id, JSON.stringify(data), 'EX', TWAP_TTL_SEC);
    } catch (err) {
        console.warn('[TWAP-Redis] Basket save failed:', err.message);
    }
}

async function deleteTwapBasketFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(TWAP_BASKET_REDIS_PREFIX + id);
    } catch { /* ignore */ }
}

// ── TWAP Engine ───────────────────────────────────

const activeTwaps = new Map(); // twapId → TwapState
const MAX_ACTIVE_TWAPS = 500;

function generateTwapId() {
    return `twap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildLotSizes(totalSize, lots, irregular) {
    if (!irregular) {
        const uniform = totalSize / lots;
        return Array.from({ length: lots }, () => uniform);
    }
    // Irregular: randomize each lot by ±30%, then rescale to preserve total
    const raw = Array.from({ length: lots }, () => 1 + (Math.random() - 0.5) * 0.6);
    const rawSum = raw.reduce((s, v) => s + v, 0);
    return raw.map(v => (v / rawSum) * totalSize);
}

function jitterInterval(baseMs) {
    // ±20% random displacement
    const factor = 1 + (Math.random() - 0.5) * 0.4;
    return Math.round(baseMs * factor);
}

function scheduleTwapTick(twap) {
    const delayMs = twap.jitter ? jitterInterval(twap.intervalMs) : twap.intervalMs;
    twap.nextOrderAt = Date.now() + delayMs;
    twap.timerId = setTimeout(() => executeTwapTick(twap), delayMs);
}

async function executeTwapTick(twap) {
    if (!activeTwaps.has(twap.id)) return; // cancelled
    const lotIndex = twap.filledLots;
    if (lotIndex >= twap.totalLots) {
        finishTwap(twap, 'completed');
        return;
    }

    const lotSizeUsdt = twap.lotSizes[lotIndex];
    const LIMIT_OFFSET_PCT = 0.0002; // 0.02% favorable offset
    const FILL_TIMEOUT_RATIO = 0.6;  // wait 60% of interval before fallback

    try {
        // Get current price for quantity calculation
        let price = exchange.getLatestPrice(twap.symbol);
        let bid = null, ask = null;
        if (!price || !Number.isFinite(price) || price <= 0) {
            const ticker = await exchange.fetchTicker(twap.symbol);
            price = Number(ticker?.mark || ticker?.last || ticker?.price);
            bid = Number(ticker?.bid);
            ask = Number(ticker?.ask);
        } else {
            // Use WS bid/ask (from bookTicker stream) — avoids REST call
            const wsBidAsk = exchange.getLatestBidAsk(twap.symbol);
            if (wsBidAsk) {
                bid = wsBidAsk.bid;
                ask = wsBidAsk.ask;
            }
            // Only fall back to REST if WS bid/ask unavailable
            if (!bid || !ask) {
                try {
                    const ticker = await exchange.fetchTicker(twap.symbol);
                    bid = Number(ticker?.bid);
                    ask = Number(ticker?.ask);
                } catch { /* fallback: compute from mark */ }
            }
        }
        if (!price || price <= 0) throw new Error('No price available');

        // ── Price sensitivity check ──────────────────────────
        // SHORT: skip if price is below the user-defined minimum sell price
        // LONG:  skip if price is above the user-defined maximum buy price
        if (twap.priceLimit && Number.isFinite(twap.priceLimit)) {
            const shouldSkip = (twap.side === 'SHORT' && price < twap.priceLimit)
                || (twap.side === 'LONG' && price > twap.priceLimit);
            if (shouldSkip) {
                twap.skippedTicks = (twap.skippedTicks || 0) + 1;
                console.log(`[TWAP ${twap.id}] Lot ${lotIndex + 1} SKIPPED — price $${price.toFixed(2)} ${twap.side === 'SHORT' ? 'below min' : 'above max'} $${twap.priceLimit} (skipped ${twap.skippedTicks}x)`);
                broadcast('twap_progress', {
                    twapId: twap.id,
                    subAccountId: twap.subAccountId,
                    symbol: twap.symbol,
                    side: twap.side,
                    filledLots: twap.filledLots,
                    totalLots: twap.totalLots,
                    filledSize: twap.filledSize,
                    totalSize: twap.totalSize,
                    skipped: true,
                    skippedTicks: twap.skippedTicks,
                    currentPrice: price,
                    priceLimit: twap.priceLimit,
                });
                // Re-schedule — don't count as filled, just wait for next tick
                if (activeTwaps.has(twap.id)) scheduleTwapTick(twap);
                return;
            }
        }

        const quantity = lotSizeUsdt / price;

        // --- STEP 1: Attempt limit order at favorable price ---
        const orderSide = twap.side === 'LONG' ? 'buy' : 'sell';
        // For LONG: buy at best ask minus offset (slightly below ask)
        // For SHORT: sell at best bid plus offset (slightly above bid)
        let limitPrice;
        if (twap.side === 'LONG') {
            const basePrice = (ask && Number.isFinite(ask) && ask > 0) ? ask : price;
            limitPrice = basePrice * (1 - LIMIT_OFFSET_PCT);
        } else {
            const basePrice = (bid && Number.isFinite(bid) && bid > 0) ? bid : price;
            limitPrice = basePrice * (1 + LIMIT_OFFSET_PCT);
        }

        // Round limit price to reasonable precision
        const pricePrecision = price > 100 ? 2 : price > 1 ? 4 : 6;
        limitPrice = parseFloat(limitPrice.toFixed(pricePrecision));

        let filled = false;
        let fillResult = null;
        let dbOrder = null;

        try {
            // Place limit order on exchange
            const exchangeResult = await exchange.createLimitOrder(twap.symbol, orderSide, quantity, limitPrice);

            // Store in pendingOrder DB so it shows on chart annotations
            dbOrder = await prisma.pendingOrder.create({
                data: {
                    subAccountId: twap.subAccountId,
                    symbol: twap.symbol,
                    side: twap.side,
                    type: 'LIMIT',
                    price: limitPrice,
                    quantity: quantity,
                    leverage: twap.leverage,
                    exchangeOrderId: exchangeResult.orderId,
                    status: 'PENDING',
                },
            });

            // Broadcast order_placed — shows toast + chart annotation on frontend
            broadcast('order_placed', {
                subAccountId: twap.subAccountId,
                symbol: twap.symbol,
                side: twap.side,
                price: limitPrice,
                quantity: quantity,
                notional: lotSizeUsdt,
                orderId: dbOrder.id,
                exchangeOrderId: exchangeResult.orderId,
                twapLot: lotIndex + 1,
                twapTotal: twap.totalLots,
                twapId: twap.id,
            });

            console.log(`[TWAP ${twap.id}] Lot ${lotIndex + 1}/${twap.totalLots} limit placed: ${quantity.toFixed(6)} @ $${limitPrice} ($${lotSizeUsdt.toFixed(2)})`);

            // --- STEP 2: Wait for fill or timeout ---
            const timeoutMs = Math.max(twap.intervalMs * FILL_TIMEOUT_RATIO, 3000);
            const pollIntervalMs = Math.min(3000, timeoutMs / 3);
            const startWait = Date.now();

            while (Date.now() - startWait < timeoutMs) {
                await new Promise(r => setTimeout(r, pollIntervalMs));
                if (!activeTwaps.has(twap.id)) return; // cancelled during wait

                try {
                    const orderStatus = await exchange.fetchOrder(twap.symbol, exchangeResult.orderId);
                    if (orderStatus.status === 'closed') {
                        // Filled!
                        filled = true;
                        fillResult = {
                            price: orderStatus.average || orderStatus.price || limitPrice,
                            quantity: orderStatus.filled || quantity,
                            fee: orderStatus.fee || 0,
                        };
                        break;
                    } else if (orderStatus.status === 'canceled' || orderStatus.status === 'cancelled' || orderStatus.status === 'expired') {
                        break; // someone else cancelled it
                    }
                    // Check if partially filled
                    if (orderStatus.filled && orderStatus.filled > 0 && orderStatus.filled >= quantity * 0.95) {
                        filled = true;
                        fillResult = {
                            price: orderStatus.average || orderStatus.price || limitPrice,
                            quantity: orderStatus.filled,
                            fee: orderStatus.fee || 0,
                        };
                        break;
                    }
                } catch { /* ignore fetch errors, keep waiting */ }
            }

            // --- STEP 3: If not filled, cancel and fall back to market ---
            if (!filled) {
                try {
                    await exchange.cancelOrder(twap.symbol, exchangeResult.orderId);
                    console.log(`[TWAP ${twap.id}] Lot ${lotIndex + 1} limit not filled — cancelled, falling back to market`);
                } catch (cancelErr) {
                    // Check if it got filled in the meantime
                    try {
                        const finalCheck = await exchange.fetchOrder(twap.symbol, exchangeResult.orderId);
                        if (finalCheck.status === 'closed') {
                            filled = true;
                            fillResult = {
                                price: finalCheck.average || finalCheck.price || limitPrice,
                                quantity: finalCheck.filled || quantity,
                                fee: finalCheck.fee || 0,
                            };
                        }
                    } catch { /* ignore */ }
                    if (!filled) {
                        console.warn(`[TWAP ${twap.id}] Cancel failed: ${cancelErr.message} — falling back to market`);
                    }
                }

                // Clean up DB order
                if (dbOrder) {
                    try {
                        await prisma.pendingOrder.update({
                            where: { id: dbOrder.id },
                            data: { status: filled ? 'FILLED' : 'CANCELLED' },
                        });
                    } catch { /* ignore */ }
                }

                // Broadcast cancellation so chart removes the line
                if (!filled) {
                    broadcast('order_cancelled', {
                        subAccountId: twap.subAccountId,
                        symbol: twap.symbol,
                        orderId: dbOrder?.id,
                    });
                }
            } else {
                // Limit filled — update DB
                if (dbOrder) {
                    try {
                        await prisma.pendingOrder.update({
                            where: { id: dbOrder.id },
                            data: { status: 'FILLED' },
                        });
                    } catch { /* ignore */ }
                }
            }
        } catch (limitErr) {
            console.warn(`[TWAP ${twap.id}] Limit order failed: ${limitErr.message} — falling back to market`);
        }

        // --- STEP 4: If limit didn't fill, execute as market ---
        if (!filled) {
            const result = await riskEngine.executeTrade(
                twap.subAccountId,
                twap.symbol,
                twap.side,
                quantity,
                twap.leverage,
                'MARKET',
                { silentFillBroadcast: true, origin: 'TWAP' },
            );

            twap.filledLots++;
            twap.filledSize += lotSizeUsdt;
            saveTwapToRedis(twap);

            if (result.success) {
                twap.results.push({ lot: lotIndex + 1, success: true, type: 'market', price, quantity, notional: lotSizeUsdt });
                console.log(`[TWAP ${twap.id}] Lot ${twap.filledLots}/${twap.totalLots} market filled: ${quantity.toFixed(6)} @ $${price.toFixed(2)} ($${lotSizeUsdt.toFixed(2)})`);
            } else {
                twap.errors.push({ lot: lotIndex + 1, error: result.errors?.map(e => e.message).join('; ') || 'Unknown' });
                twap.results.push({ lot: lotIndex + 1, success: false, error: result.errors });
                console.warn(`[TWAP ${twap.id}] Lot ${twap.filledLots}/${twap.totalLots} market failed:`, result.errors);
            }
        } else {
            // Limit order filled — now create the virtual position via riskEngine
            const result = await riskEngine.executeTrade(
                twap.subAccountId,
                twap.symbol,
                twap.side,
                fillResult.quantity,
                twap.leverage,
                'MARKET',     // type doesn't matter, the exchange order is already filled
                {
                    skipExchange: true,
                    fillPrice: fillResult.price,
                    fillFee: fillResult.fee,
                    silentFillBroadcast: true,
                    origin: 'TWAP',
                },
            );

            twap.filledLots++;
            twap.filledSize += lotSizeUsdt;
            saveTwapToRedis(twap);

            if (result.success) {
                twap.results.push({ lot: lotIndex + 1, success: true, type: 'limit', price: fillResult.price, quantity: fillResult.quantity, notional: lotSizeUsdt });
                console.log(`[TWAP ${twap.id}] Lot ${twap.filledLots}/${twap.totalLots} limit filled: ${fillResult.quantity.toFixed(6)} @ $${fillResult.price.toFixed(2)} ($${lotSizeUsdt.toFixed(2)})`);
            } else {
                // Exchange order filled but virtual position creation failed — still count as filled
                twap.results.push({ lot: lotIndex + 1, success: true, type: 'limit', price: fillResult.price, quantity: fillResult.quantity, notional: lotSizeUsdt, warning: 'virtual position sync issue' });
                console.warn(`[TWAP ${twap.id}] Lot ${twap.filledLots}/${twap.totalLots} limit filled on exchange but virtual position sync issue:`, result.errors);
            }
        }

        // Broadcast progress
        broadcast('twap_progress', {
            twapId: twap.id,
            subAccountId: twap.subAccountId,
            symbol: twap.symbol,
            side: twap.side,
            filledLots: twap.filledLots,
            totalLots: twap.totalLots,
            filledSize: twap.filledSize,
            totalSize: twap.totalSize,
            lastLotSuccess: twap.results[twap.results.length - 1]?.success || false,
            lastLotType: twap.results[twap.results.length - 1]?.type || 'unknown',
        });

    } catch (err) {
        twap.filledLots++;
        twap.filledSize += lotSizeUsdt;
        twap.errors.push({ lot: lotIndex + 1, error: err.message });
        saveTwapToRedis(twap);
        twap.results.push({ lot: lotIndex + 1, success: false, error: err.message });
        console.error(`[TWAP ${twap.id}] Lot ${lotIndex + 1} exception:`, err.message);
    }

    // Schedule next or finish
    if (twap.filledLots >= twap.totalLots) {
        finishTwap(twap, 'completed');
    } else if (activeTwaps.has(twap.id)) {
        scheduleTwapTick(twap);
    }
}

function finishTwap(twap, reason) {
    clearTimeout(twap.timerId);
    twap.timerId = null;
    twap.completedAt = Date.now();
    activeTwaps.delete(twap.id);
    deleteTwapFromRedis(twap.id);
    const successCount = twap.results.filter(r => r.success).length;
    console.log(`[TWAP ${twap.id}] ${reason}: ${successCount}/${twap.totalLots} lots filled, $${twap.filledSize.toFixed(2)}/$${twap.totalSize.toFixed(2)}`);
    broadcast(`twap_${reason}`, {
        twapId: twap.id,
        subAccountId: twap.subAccountId,
        symbol: twap.symbol,
        side: twap.side,
        filledLots: twap.filledLots,
        totalLots: twap.totalLots,
        filledSize: twap.filledSize,
        totalSize: twap.totalSize,
        errors: twap.errors,
    });
}

// POST /api/trade/twap - Start a TWAP order
router.post('/twap', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, symbol, side, totalSize, lots, durationMinutes, leverage, jitter, irregular, priceLimit } = req.body;
        if (!subAccountId || !symbol || !side || !totalSize || !lots || !durationMinutes || !leverage) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, totalSize, lots, durationMinutes, leverage' });
        }

        const normSide = String(side).toUpperCase();
        if (normSide !== 'LONG' && normSide !== 'SHORT') {
            return res.status(400).json({ error: `Invalid side '${side}'. Use LONG or SHORT.` });
        }

        const parsedSize = parseFloat(totalSize);
        const parsedLots = parseInt(lots, 10);
        const parsedDuration = parseFloat(durationMinutes);
        const parsedLeverage = parseFloat(leverage);

        if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
            return res.status(400).json({ error: 'totalSize must be a positive number' });
        }
        if (!Number.isInteger(parsedLots) || parsedLots < 2 || parsedLots > 100) {
            return res.status(400).json({ error: 'lots must be an integer between 2 and 100' });
        }
        if (!Number.isFinite(parsedDuration) || parsedDuration < 1 || parsedDuration > 720) {
            return res.status(400).json({ error: 'durationMinutes must be between 1 and 720 (12 hours)' });
        }
        if (!Number.isFinite(parsedLeverage) || parsedLeverage <= 0 || parsedLeverage > 125) {
            return res.status(400).json({ error: 'leverage must be between 1 and 125' });
        }

        // Min notional check: each lot must be >= $6
        const minLotSize = parsedSize / parsedLots;
        const MIN_NOTIONAL = 6;
        if (minLotSize < MIN_NOTIONAL) {
            // Suggest max lots that would keep each lot above min
            const maxLots = Math.floor(parsedSize / MIN_NOTIONAL);
            return res.status(400).json({
                error: `Each lot would be $${minLotSize.toFixed(2)}, below the $${MIN_NOTIONAL} minimum. Reduce lots to ${maxLots} or increase total size.`,
            });
        }


        const lotSizes = buildLotSizes(parsedSize, parsedLots, !!irregular);
        const intervalMs = (parsedDuration * 60 * 1000) / parsedLots;
        const twapId = generateTwapId();

        // Validate optional priceLimit
        const parsedPriceLimit = priceLimit ? parseFloat(priceLimit) : null;
        if (parsedPriceLimit !== null && (!Number.isFinite(parsedPriceLimit) || parsedPriceLimit <= 0)) {
            return res.status(400).json({ error: 'priceLimit must be a positive number or omitted' });
        }

        const twap = {
            id: twapId,
            subAccountId,
            symbol,
            side: normSide,
            leverage: parsedLeverage,
            totalSize: parsedSize,
            totalLots: parsedLots,
            filledLots: 0,
            filledSize: 0,
            lotSizes,
            intervalMs,
            jitter: !!jitter,
            irregular: !!irregular,
            durationMinutes: parsedDuration,
            startedAt: Date.now(),
            estimatedEnd: Date.now() + parsedDuration * 60 * 1000,
            nextOrderAt: Date.now(), // first lot executes immediately
            timerId: null,
            results: [],
            errors: [],
            priceLimit: parsedPriceLimit,
            skippedTicks: 0,
        };

        if (activeTwaps.size >= MAX_ACTIVE_TWAPS) {
            return res.status(429).json({ error: `Maximum concurrent TWAP orders (${MAX_ACTIVE_TWAPS}) reached` });
        }

        activeTwaps.set(twapId, twap);
        saveTwapToRedis(twap);

        // Set leverage once
        try {
            await exchange.setLeverage(symbol, parsedLeverage);
        } catch (err) {
            console.warn(`[TWAP] setLeverage warning:`, err.message);
        }

        // Execute first lot immediately, then schedule the rest
        executeTwapTick(twap);

        console.log(`[TWAP ${twapId}] Started: ${normSide} ${symbol}, $${parsedSize} in ${parsedLots} lots over ${parsedDuration}min (interval ~${(intervalMs / 1000).toFixed(1)}s, jitter=${!!jitter}, irregular=${!!irregular}${parsedPriceLimit ? `, priceLimit=$${parsedPriceLimit}` : ''})`);

        res.status(201).json({
            success: true,
            twapId,
            symbol,
            side: normSide,
            totalSize: parsedSize,
            totalLots: parsedLots,
            intervalSeconds: Math.round(intervalMs / 1000),
            durationMinutes: parsedDuration,
            estimatedEnd: new Date(twap.estimatedEnd).toISOString(),
            jitter: !!jitter,
            irregular: !!irregular,
        });
    } catch (err) {
        console.error('[TWAP] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/twap/active/:subAccountId - List active TWAPs
router.get('/twap/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const accountTwaps = [];
        for (const [, twap] of activeTwaps) {
            if (twap.subAccountId === req.params.subAccountId) {
                accountTwaps.push({
                    twapId: twap.id,
                    symbol: twap.symbol,
                    side: twap.side,
                    totalSize: twap.totalSize,
                    filledSize: twap.filledSize,
                    totalLots: twap.totalLots,
                    filledLots: twap.filledLots,
                    intervalSeconds: Math.round(twap.intervalMs / 1000),
                    durationMinutes: twap.durationMinutes,
                    jitter: twap.jitter,
                    irregular: twap.irregular,
                    startedAt: new Date(twap.startedAt).toISOString(),
                    estimatedEnd: new Date(twap.estimatedEnd).toISOString(),
                    nextOrderAt: new Date(twap.nextOrderAt).toISOString(),
                    errors: twap.errors,
                    priceLimit: twap.priceLimit || null,
                    skippedTicks: twap.skippedTicks || 0,
                });
            }
        }
        res.json(accountTwaps);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/twap/:twapId - Cancel a running TWAP
router.delete('/twap/:twapId', async (req, res) => {
    try {
        const twap = activeTwaps.get(req.params.twapId);
        if (!twap) return res.status(404).json({ error: 'TWAP not found or already completed' });

        // Ownership check: only the owner (or admin) can cancel
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({
                where: { id: twap.subAccountId },
                select: { userId: true },
            });
            if (account?.userId !== req.user?.id) {
                return res.status(403).json({ error: 'You do not own this TWAP order' });
            }
        }

        finishTwap(twap, 'cancelled');
        console.log(`[TWAP ${twap.id}] Cancelled by user after ${twap.filledLots}/${twap.totalLots} lots`);

        res.json({
            success: true,
            twapId: twap.id,
            filledLots: twap.filledLots,
            totalLots: twap.totalLots,
            filledSize: twap.filledSize,
            totalSize: twap.totalSize,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── TWAP Basket Engine (index TWAP) ────────────────

const activeTwapBaskets = new Map(); // twapBasketId → TwapBasketState
const MAX_ACTIVE_TWAP_BASKETS = 100;

function generateTwapBasketId() {
    return `twapb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Execute one tick for the entire basket — fires all legs in parallel.
 */
async function executeTwapBasketTick(basket) {
    if (!activeTwapBaskets.has(basket.id)) return;
    const lotIndex = basket.filledLots;
    if (lotIndex >= basket.totalLots) {
        finishTwapBasket(basket, 'completed');
        return;
    }

    const legResults = await Promise.allSettled(
        basket.legs.map(async (leg) => {
            const lotSizeUsdt = leg.lotSizes[lotIndex];
            const LIMIT_OFFSET_PCT = 0.0002;
            const FILL_TIMEOUT_RATIO = 0.6;

            let price = exchange.getLatestPrice(leg.symbol);
            let bid = null, ask = null;
            if (!price || !Number.isFinite(price) || price <= 0) {
                const ticker = await exchange.fetchTicker(leg.symbol);
                price = Number(ticker?.mark || ticker?.last || ticker?.price);
                bid = Number(ticker?.bid);
                ask = Number(ticker?.ask);
            } else {
                // Use WS bid/ask (from bookTicker stream) — avoids REST call
                const wsBidAsk = exchange.getLatestBidAsk(leg.symbol);
                if (wsBidAsk) {
                    bid = wsBidAsk.bid;
                    ask = wsBidAsk.ask;
                }
                // Only fall back to REST if WS bid/ask unavailable
                if (!bid || !ask) {
                    try {
                        const ticker = await exchange.fetchTicker(leg.symbol);
                        bid = Number(ticker?.bid);
                        ask = Number(ticker?.ask);
                    } catch { /* fallback */ }
                }
            }
            if (!price || price <= 0) throw new Error(`No price for ${leg.symbol}`);

            const quantity = lotSizeUsdt / price;
            const orderSide = leg.side === 'LONG' ? 'buy' : 'sell';

            let limitPrice;
            if (leg.side === 'LONG') {
                const base = (ask && Number.isFinite(ask) && ask > 0) ? ask : price;
                limitPrice = base * (1 - LIMIT_OFFSET_PCT);
            } else {
                const base = (bid && Number.isFinite(bid) && bid > 0) ? bid : price;
                limitPrice = base * (1 + LIMIT_OFFSET_PCT);
            }
            const pricePrecision = price > 100 ? 2 : price > 1 ? 4 : 6;
            limitPrice = parseFloat(limitPrice.toFixed(pricePrecision));

            let filled = false;
            let fillResult = null;
            let dbOrder = null;

            try {
                const exchangeResult = await exchange.createLimitOrder(leg.symbol, orderSide, quantity, limitPrice);
                dbOrder = await prisma.pendingOrder.create({
                    data: {
                        subAccountId: basket.subAccountId,
                        symbol: leg.symbol,
                        side: leg.side,
                        type: 'LIMIT',
                        price: limitPrice,
                        quantity,
                        leverage: leg.leverage,
                        exchangeOrderId: exchangeResult.orderId,
                        status: 'PENDING',
                    },
                });

                broadcast('order_placed', {
                    subAccountId: basket.subAccountId,
                    symbol: leg.symbol,
                    side: leg.side,
                    price: limitPrice,
                    quantity,
                    notional: lotSizeUsdt,
                    orderId: dbOrder.id,
                    exchangeOrderId: exchangeResult.orderId,
                    twapBasketId: basket.id,
                    twapLot: lotIndex + 1,
                    twapTotal: basket.totalLots,
                });

                const timeoutMs = Math.max(basket.intervalMs * FILL_TIMEOUT_RATIO, 3000);
                const pollIntervalMs = Math.min(3000, timeoutMs / 3);
                const startWait = Date.now();

                while (Date.now() - startWait < timeoutMs) {
                    await new Promise(r => setTimeout(r, pollIntervalMs));
                    if (!activeTwapBaskets.has(basket.id)) return { leg: leg.symbol, cancelled: true };
                    try {
                        const os = await exchange.fetchOrder(leg.symbol, exchangeResult.orderId);
                        if (os.status === 'closed') {
                            filled = true;
                            fillResult = { price: os.average || os.price || limitPrice, quantity: os.filled || quantity, fee: os.fee || 0 };
                            break;
                        } else if (['canceled', 'cancelled', 'expired'].includes(os.status)) break;
                        if (os.filled && os.filled > 0 && os.filled >= quantity * 0.95) {
                            filled = true;
                            fillResult = { price: os.average || os.price || limitPrice, quantity: os.filled, fee: os.fee || 0 };
                            break;
                        }
                    } catch { /* keep waiting */ }
                }

                if (!filled) {
                    try {
                        await exchange.cancelOrder(leg.symbol, exchangeResult.orderId);
                    } catch (cancelErr) {
                        try {
                            const fc = await exchange.fetchOrder(leg.symbol, exchangeResult.orderId);
                            if (fc.status === 'closed') {
                                filled = true;
                                fillResult = { price: fc.average || fc.price || limitPrice, quantity: fc.filled || quantity, fee: fc.fee || 0 };
                            }
                        } catch { /* ignore */ }
                    }
                    if (dbOrder) {
                        try { await prisma.pendingOrder.update({ where: { id: dbOrder.id }, data: { status: filled ? 'FILLED' : 'CANCELLED' } }); } catch { /* ignore */ }
                    }
                    if (!filled) {
                        broadcast('order_cancelled', { subAccountId: basket.subAccountId, symbol: leg.symbol, orderId: dbOrder?.id });
                    }
                } else if (dbOrder) {
                    try { await prisma.pendingOrder.update({ where: { id: dbOrder.id }, data: { status: 'FILLED' } }); } catch { /* ignore */ }
                }
            } catch (limitErr) {
                console.warn(`[TWAP-Basket ${basket.id}] ${leg.symbol} limit failed: ${limitErr.message}`);
            }

            // Market fallback or record limit fill
            let success = false;
            if (!filled) {
                const result = await riskEngine.executeTrade(basket.subAccountId, leg.symbol, leg.side, quantity, leg.leverage, 'MARKET', {});
                success = result.success;
                if (!success) console.warn(`[TWAP-Basket ${basket.id}] ${leg.symbol} market failed:`, result.errors);
            } else {
                const result = await riskEngine.executeTrade(
                    basket.subAccountId, leg.symbol, leg.side, fillResult.quantity, leg.leverage,
                    'MARKET', { skipExchange: true, fillPrice: fillResult.price, fillFee: fillResult.fee },
                );
                success = true; // exchange already filled
            }

            leg.filledSize += lotSizeUsdt;
            return { leg: leg.symbol, success, type: filled ? 'limit' : 'market', lotSizeUsdt };
        }),
    );

    basket.filledLots++;
    saveTwapBasketToRedis(basket);
    const lotSuccess = legResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    basket.results.push({ lot: lotIndex + 1, legResults: legResults.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }) });

    console.log(`[TWAP-Basket ${basket.id}] Lot ${basket.filledLots}/${basket.totalLots}: ${lotSuccess}/${basket.legs.length} legs OK`);

    broadcast('twap_basket_progress', {
        twapBasketId: basket.id,
        basketName: basket.basketName,
        subAccountId: basket.subAccountId,
        filledLots: basket.filledLots,
        totalLots: basket.totalLots,
        legs: basket.legs.map(l => ({ symbol: l.symbol, side: l.side, filledSize: l.filledSize, totalSize: l.totalSize })),
    });

    if (basket.filledLots >= basket.totalLots) {
        finishTwapBasket(basket, 'completed');
    } else if (activeTwapBaskets.has(basket.id)) {
        scheduleTwapBasketTick(basket);
    }
}

function scheduleTwapBasketTick(basket) {
    const delayMs = basket.jitter ? jitterInterval(basket.intervalMs) : basket.intervalMs;
    basket.nextOrderAt = Date.now() + delayMs;
    basket.timerId = setTimeout(() => executeTwapBasketTick(basket), delayMs);
}

function finishTwapBasket(basket, reason) {
    clearTimeout(basket.timerId);
    basket.timerId = null;
    basket.completedAt = Date.now();
    activeTwapBaskets.delete(basket.id);
    deleteTwapBasketFromRedis(basket.id);
    console.log(`[TWAP-Basket ${basket.id}] ${reason}: ${basket.filledLots}/${basket.totalLots} lots`);
    broadcast(`twap_basket_${reason}`, {
        twapBasketId: basket.id,
        basketName: basket.basketName,
        subAccountId: basket.subAccountId,
        filledLots: basket.filledLots,
        totalLots: basket.totalLots,
        legs: basket.legs.map(l => ({ symbol: l.symbol, side: l.side, filledSize: l.filledSize, totalSize: l.totalSize })),
    });
}

// POST /api/trade/twap-basket - Start a TWAP basket (index TWAP)
router.post('/twap-basket', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, legs, basketName, lots, durationMinutes, jitter, irregular } = req.body;
        if (!subAccountId || !Array.isArray(legs) || legs.length === 0 || !lots || !durationMinutes) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, legs[], lots, durationMinutes' });
        }

        const parsedLots = parseInt(lots, 10);
        const parsedDuration = parseFloat(durationMinutes);
        if (!Number.isInteger(parsedLots) || parsedLots < 2 || parsedLots > 100) {
            return res.status(400).json({ error: 'lots must be 2–100' });
        }
        if (!Number.isFinite(parsedDuration) || parsedDuration < 1 || parsedDuration > 720) {
            return res.status(400).json({ error: 'durationMinutes must be 1–720' });
        }

        // Validate & normalize legs
        const normalizedLegs = [];
        for (const leg of legs) {
            if (!leg?.symbol || !leg?.side || !leg?.sizeUsdt || !leg?.leverage) {
                return res.status(400).json({ error: `Invalid leg: needs symbol, side, sizeUsdt, leverage. Got: ${JSON.stringify(leg)}` });
            }
            const symbol = String(leg.symbol);
            const side = String(leg.side).toUpperCase();
            const sizeUsdt = parseFloat(leg.sizeUsdt);
            const leverage = parseFloat(leg.leverage);
            if (side !== 'LONG' && side !== 'SHORT') return res.status(400).json({ error: `Invalid side for ${symbol}` });
            if (!Number.isFinite(sizeUsdt) || sizeUsdt <= 0) return res.status(400).json({ error: `Invalid sizeUsdt for ${symbol}` });
            if (!Number.isFinite(leverage) || leverage <= 0 || leverage > 125) return res.status(400).json({ error: `Invalid leverage for ${symbol}` });

            const perLot = sizeUsdt / parsedLots;
            if (perLot < 6) {
                return res.status(400).json({ error: `${symbol}: per-lot $${perLot.toFixed(2)} < $6 min. Reduce lots or increase size.` });
            }

            normalizedLegs.push({ symbol, side, sizeUsdt, leverage });
        }



        const intervalMs = (parsedDuration * 60 * 1000) / parsedLots;
        const twapBasketId = generateTwapBasketId();

        // Build per-leg state
        const legStates = normalizedLegs.map(leg => {
            const lotSizes = buildLotSizes(leg.sizeUsdt, parsedLots, !!irregular);
            return {
                symbol: leg.symbol,
                side: leg.side,
                leverage: leg.leverage,
                totalSize: leg.sizeUsdt,
                filledSize: 0,
                lotSizes,
            };
        });

        // Set leverage for all symbols
        const uniqueSymbols = [...new Set(normalizedLegs.map(l => l.symbol))];
        for (const sym of uniqueSymbols) {
            const leg = normalizedLegs.find(l => l.symbol === sym);
            try { await exchange.setLeverage(sym, leg.leverage); } catch (err) {
                console.warn(`[TWAP-Basket] setLeverage ${sym}:`, err.message);
            }
        }
        exchange.subscribeToPrices(uniqueSymbols);

        const basket = {
            id: twapBasketId,
            subAccountId,
            basketName: basketName || 'Unnamed Index',
            legs: legStates,
            totalLots: parsedLots,
            filledLots: 0,
            intervalMs,
            jitter: !!jitter,
            irregular: !!irregular,
            durationMinutes: parsedDuration,
            startedAt: Date.now(),
            estimatedEnd: Date.now() + parsedDuration * 60 * 1000,
            nextOrderAt: Date.now(),
            timerId: null,
            results: [],
        };

        if (activeTwapBaskets.size >= MAX_ACTIVE_TWAP_BASKETS) {
            return res.status(429).json({ error: `Maximum concurrent TWAP baskets (${MAX_ACTIVE_TWAP_BASKETS}) reached` });
        }

        activeTwapBaskets.set(twapBasketId, basket);
        saveTwapBasketToRedis(basket);

        // Execute first lot immediately
        executeTwapBasketTick(basket);

        const totalSize = legStates.reduce((s, l) => s + l.totalSize, 0);
        console.log(`[TWAP-Basket ${twapBasketId}] Started: ${legStates.length} legs, $${totalSize.toFixed(2)} in ${parsedLots} lots over ${parsedDuration}min`);

        res.status(201).json({
            success: true,
            twapBasketId,
            basketName: basket.basketName,
            totalLots: parsedLots,
            intervalSeconds: Math.round(intervalMs / 1000),
            durationMinutes: parsedDuration,
            estimatedEnd: new Date(basket.estimatedEnd).toISOString(),
            legs: legStates.map(l => ({ symbol: l.symbol, side: l.side, totalSize: l.totalSize })),
        });
    } catch (err) {
        console.error('[TWAP-Basket] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/twap-basket/active/:subAccountId
router.get('/twap-basket/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = [];
        for (const [, basket] of activeTwapBaskets) {
            if (basket.subAccountId === req.params.subAccountId) {
                results.push({
                    twapBasketId: basket.id,
                    basketName: basket.basketName,
                    totalLots: basket.totalLots,
                    filledLots: basket.filledLots,
                    intervalSeconds: Math.round(basket.intervalMs / 1000),
                    durationMinutes: basket.durationMinutes,
                    jitter: basket.jitter,
                    irregular: basket.irregular,
                    startedAt: new Date(basket.startedAt).toISOString(),
                    estimatedEnd: new Date(basket.estimatedEnd).toISOString(),
                    nextOrderAt: new Date(basket.nextOrderAt).toISOString(),
                    legs: basket.legs.map(l => ({ symbol: l.symbol, side: l.side, filledSize: l.filledSize, totalSize: l.totalSize })),
                });
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/twap-basket/:twapBasketId
router.delete('/twap-basket/:twapBasketId', async (req, res) => {
    try {
        const basket = activeTwapBaskets.get(req.params.twapBasketId);
        if (!basket) return res.status(404).json({ error: 'TWAP basket not found or already completed' });

        // Ownership check: only the owner (or admin) can cancel
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({
                where: { id: basket.subAccountId },
                select: { userId: true },
            });
            if (account?.userId !== req.user?.id) {
                return res.status(403).json({ error: 'You do not own this TWAP basket' });
            }
        }

        finishTwapBasket(basket, 'cancelled');
        console.log(`[TWAP-Basket ${basket.id}] Cancelled by user after ${basket.filledLots}/${basket.totalLots} lots`);

        res.json({
            success: true,
            twapBasketId: basket.id,
            filledLots: basket.filledLots,
            totalLots: basket.totalLots,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Resume active TWAPs from Redis on server restart ──

export async function resumeActiveTwaps() {
    const r = getRedis();
    if (!r) return;

    let resumed = 0;
    const now = Date.now();

    // Resume single-symbol TWAPs
    try {
        const keys = await r.keys(TWAP_REDIS_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);

                if (activeTwaps.has(data.id)) continue; // already running

                // Calculate how many lots should have fired while we were offline
                const elapsed = now - (data.startedAt || now);
                const expectedLots = Math.min(data.totalLots, Math.floor(elapsed / data.intervalMs));
                const adjustedFilled = Math.max(data.filledLots, expectedLots);

                if (adjustedFilled >= data.totalLots) {
                    console.log(`[TWAP-Resume] ${data.id} expired (all ${data.totalLots} lots should have completed) — cleaning up`);
                    await r.del(key);
                    continue;
                }

                // Restore state
                const skippedLots = adjustedFilled - data.filledLots;
                data.filledLots = adjustedFilled;
                data.timerId = null;
                data.results = data.results || [];
                data.errors = data.errors || [];

                activeTwaps.set(data.id, data);

                // Subscribe to prices and set leverage
                try { await exchange.setLeverage(data.symbol, data.leverage); } catch { /* ignore */ }
                exchange.subscribeToPrices([data.symbol]);

                // Schedule next tick
                scheduleTwapTick(data);
                resumed++;
                console.log(`[TWAP-Resume] Resumed ${data.id}: ${data.symbol} ${data.side}, ${data.filledLots}/${data.totalLots} lots (skipped ${skippedLots} missed lots)`);
                saveTwapToRedis(data);
            } catch (err) {
                console.warn(`[TWAP-Resume] Failed to restore ${key}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('[TWAP-Resume] Single TWAP scan failed:', err.message);
    }

    // Resume basket TWAPs
    try {
        const keys = await r.keys(TWAP_BASKET_REDIS_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);

                if (activeTwapBaskets.has(data.id)) continue; // already running

                const elapsed = now - (data.startedAt || now);
                const expectedLots = Math.min(data.totalLots, Math.floor(elapsed / data.intervalMs));
                const adjustedFilled = Math.max(data.filledLots, expectedLots);

                if (adjustedFilled >= data.totalLots) {
                    console.log(`[TWAP-Resume] Basket ${data.id} expired — cleaning up`);
                    await r.del(key);
                    continue;
                }

                data.filledLots = adjustedFilled;
                data.timerId = null;
                data.results = data.results || [];

                activeTwapBaskets.set(data.id, data);

                // Re-subscribe to price streams for all leg symbols
                const symbols = [...new Set(data.legs.map(l => l.symbol))];
                for (const sym of symbols) {
                    const leg = data.legs.find(l => l.symbol === sym);
                    try { await exchange.setLeverage(sym, leg?.leverage || 20); } catch { /* ignore */ }
                }
                exchange.subscribeToPrices(symbols);

                scheduleTwapBasketTick(data);
                resumed++;
                console.log(`[TWAP-Resume] Resumed basket ${data.id} (${data.basketName}): ${data.filledLots}/${data.totalLots} lots, ${data.legs.length} legs`);
                saveTwapBasketToRedis(data);
            } catch (err) {
                console.warn(`[TWAP-Resume] Failed to restore basket ${key}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('[TWAP-Resume] Basket scan failed:', err.message);
    }

    if (resumed > 0) {
        console.log(`[TWAP-Resume] ✓ Resumed ${resumed} active TWAP(s) from Redis`);
    }
}

export default router;
