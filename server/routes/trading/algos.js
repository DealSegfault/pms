/**
 * Algo Routes — Thin Redis proxies for all algo commands.
 *
 * All algo logic lives in Python. JS just forwards commands via Redis.
 * Each route: LPUSH → pms:cmd:{algo} → Python processes → SET pms:result:{requestId} → JS reads
 *
 * State mappings use contracts/events.js for consistent shapes.
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';
import prisma from '../../db/prisma.js';

const router = Router();

function normalizeSymbolKey(raw) {
    const text = String(raw || '').trim().toUpperCase();
    if (!text) return '';
    const compact = text.replace('/', '').replace(':USDT', '');
    return compact.endsWith('USDT') ? compact : `${compact}USDT`;
}

function exchangeSidesForStart(startSide) {
    const normalized = String(startSide || 'LONG').toUpperCase();
    const opening = normalized === 'SHORT' ? 'SELL' : 'BUY';
    return {
        opening,
        closing: opening === 'BUY' ? 'SELL' : 'BUY',
        expectedPositionSide: normalized === 'SHORT' ? 'SHORT' : 'LONG',
    };
}

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function findVirtualPosition(positions, symbolKey, expectedSide) {
    if (!Array.isArray(positions) || !symbolKey) return null;

    let fallback = null;
    for (const position of positions) {
        const positionKey = normalizeSymbolKey(position?.symbol);
        if (positionKey !== symbolKey) continue;
        if (!fallback) fallback = position;
        if (String(position?.side || '').toUpperCase() === expectedSide) {
            return position;
        }
    }
    return fallback;
}

function evaluateClosingGate(scalper, virtualPosition, marketMid) {
    if (!virtualPosition || (toFiniteNumber(virtualPosition.quantity) || 0) <= 0) {
        return { allowed: false, reason: 'no_virtual_position' };
    }

    const allowLoss = Boolean(scalper.allowLoss);
    if (allowLoss) {
        return { allowed: true, reason: 'ok' };
    }

    const startSide = String(scalper.startSide || '').toUpperCase();
    const entryPrice = toFiniteNumber(virtualPosition.entryPrice);
    if (!entryPrice || !marketMid) {
        return { allowed: false, reason: 'unknown' };
    }

    if (startSide === 'LONG' && marketMid < entryPrice) {
        return { allowed: false, reason: 'allow_loss_disabled_price_gate' };
    }
    if (startSide === 'SHORT' && marketMid > entryPrice) {
        return { allowed: false, reason: 'allow_loss_disabled_price_gate' };
    }
    return { allowed: true, reason: 'ok' };
}

async function getMarketMid(getPriceCache, symbolKey) {
    if (!symbolKey) return null;
    const base = symbolKey.endsWith('USDT') ? symbolKey.slice(0, -4) : symbolKey;
    const candidates = [symbolKey, `${base}/USDT:USDT`, `${base}/USDT`];
    for (const candidate of candidates) {
        const cached = await getPriceCache(candidate);
        const mark = toFiniteNumber(cached?.mark);
        if (mark && mark > 0) return mark;
    }
    return null;
}

// ── Chase Limit ──

router.post('/chase-limit', requireOwnership('body'), proxyToRedis('pms:cmd:chase'));

router.delete('/chase-limit/:id', async (req, res) => {
    try {
        const chaseId = req.params.id;

        // Ownership check: look up chase state from Redis (#7)
        const { getRedis } = await import('../../redis.js');
        const r = getRedis();
        const stateJson = await r.get(`pms:chase:${chaseId}`);
        if (stateJson) {
            const state = JSON.parse(stateJson);
            if (state.subAccountId && req.user?.role !== 'ADMIN') {
                const account = await (await import('../../db/prisma.js')).default.subAccount.findUnique({
                    where: { id: state.subAccountId }, select: { userId: true },
                });
                if (account && account.userId !== req.user?.id) {
                    return res.status(403).json({ error: 'You do not own this chase order' });
                }
            }
        }

        const result = await pushAndWait('pms:cmd:chase_cancel', { chaseId });

        // Chase already gone from Python's active map — treat as success.
        if (!result.success) {
            try {
                const keys = [];
                for await (const key of r.scanIterator({ MATCH: 'pms:active_chase:*', COUNT: 100 })) {
                    keys.push(key);
                }
                for (const key of keys) {
                    await r.hdel(key, chaseId);
                }
                await r.del(`pms:chase:${chaseId}`);
            } catch (_) { /* non-fatal cleanup */ }

            return res.json({ success: true, alreadyCancelled: true });
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Scalper ──

router.post('/scalper', requireOwnership('body'), proxyToRedis('pms:cmd:scalper'));

router.delete('/scalper/:id', async (req, res) => {
    try {
        const scalperId = req.params.id;

        // Ownership check (#7)
        const { getRedis } = await import('../../redis.js');
        const r = getRedis();
        const stateJson = await r.get(`pms:scalper:${scalperId}`);
        if (stateJson) {
            const state = JSON.parse(stateJson);
            if (state.subAccountId && req.user?.role !== 'ADMIN') {
                const account = await (await import('../../db/prisma.js')).default.subAccount.findUnique({
                    where: { id: state.subAccountId }, select: { userId: true },
                });
                if (account && account.userId !== req.user?.id) {
                    return res.status(403).json({ error: 'You do not own this scalper' });
                }
            }
        }

        // Forward close param from query string (#16)
        const closePositions = req.query.close === '1' || req.query.close === 'true';
        const result = await pushAndWait('pms:cmd:scalper_cancel', { scalperId, closePositions });

        // Scalper already gone — clean leftover Redis state and return success
        if (!result.success) {
            try {
                const keys = [];
                for await (const key of r.scanIterator({ MATCH: 'pms:active_scalper:*', COUNT: 100 })) {
                    keys.push(key);
                }
                for (const key of keys) {
                    await r.hdel(key, scalperId);
                }
                await r.del(`pms:scalper:${scalperId}`);
            } catch (_) { /* non-fatal */ }

            return res.json({ success: true, alreadyCancelled: true });
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/scalper/diagnostics/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const symbolFilter = normalizeSymbolKey(req.query.symbol);
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const { getRiskSnapshot, getPriceCache } = await import('../../redis.js');

        const [scalpers, chases, riskSnapshot, groupedActivity] = await Promise.all([
            getActiveFromRedis('pms:active_scalper', subAccountId),
            getActiveFromRedis('pms:active_chase', subAccountId),
            getRiskSnapshot(subAccountId),
            prisma.tradeExecution.groupBy({
                by: ['symbol', 'action'],
                where: {
                    subAccountId,
                    timestamp: { gte: sixHoursAgo },
                    action: { in: ['ADD', 'OPEN', 'CLOSE'] },
                },
                _count: { _all: true },
            }),
        ]);

        const activeScalpers = (scalpers || []).filter((item) => {
            if (!symbolFilter) return true;
            return normalizeSymbolKey(item?.symbol) === symbolFilter;
        });

        const activityBySymbol = new Map();
        for (const row of groupedActivity || []) {
            const key = normalizeSymbolKey(row.symbol);
            if (!key) continue;
            const slot = activityBySymbol.get(key) || { adds: 0, closes: 0 };
            const action = String(row.action || '').toUpperCase();
            const count = Number(row?._count?._all || 0);
            if (action === 'CLOSE') slot.closes += count;
            if (action === 'ADD' || action === 'OPEN') slot.adds += count;
            activityBySymbol.set(key, slot);
        }

        const chasesByScalper = new Map();
        for (const chase of chases || []) {
            const parentId = chase?.parentScalperId;
            if (!parentId) continue;
            const bucket = chasesByScalper.get(parentId) || [];
            bucket.push(chase);
            chasesByScalper.set(parentId, bucket);
        }

        const positions = Array.isArray(riskSnapshot?.positions) ? riskSnapshot.positions : [];
        const symbolKeys = [...new Set(activeScalpers.map((item) => normalizeSymbolKey(item.symbol)).filter(Boolean))];
        const marketMidBySymbol = new Map();
        await Promise.all(symbolKeys.map(async (symbolKey) => {
            const mark = await getMarketMid(getPriceCache, symbolKey);
            marketMidBySymbol.set(symbolKey, mark);
        }));

        const diagnostics = activeScalpers.map((scalper) => {
            const symbolKey = normalizeSymbolKey(scalper.symbol);
            const { opening, closing, expectedPositionSide } = exchangeSidesForStart(scalper.startSide);
            const childChases = chasesByScalper.get(scalper.scalperId) || [];
            let openingActiveChases = 0;
            let closingActiveChases = 0;

            for (const chase of childChases) {
                const chaseSide = String(chase?.side || '').toUpperCase();
                if (chase?.reduceOnly === true) {
                    closingActiveChases += 1;
                    continue;
                }
                if (chase?.reduceOnly === false) {
                    openingActiveChases += 1;
                    continue;
                }
                if (chaseSide === closing) {
                    closingActiveChases += 1;
                } else if (chaseSide === opening) {
                    openingActiveChases += 1;
                }
            }

            const virtualPosition = findVirtualPosition(positions, symbolKey, expectedPositionSide);
            const marketMid = marketMidBySymbol.get(symbolKey) ?? null;
            const closingGate = evaluateClosingGate(scalper, virtualPosition, marketMid);
            const activity = activityBySymbol.get(symbolKey) || { adds: 0, closes: 0 };
            const ratio = activity.closes > 0
                ? Number((activity.adds / activity.closes).toFixed(4))
                : null;

            return {
                scalperId: scalper.scalperId,
                symbol: scalper.symbol,
                startSide: scalper.startSide,
                neutralMode: Boolean(scalper.neutralMode),
                allowLoss: Boolean(scalper.allowLoss),
                reduceOnlyArmed: Boolean(scalper.reduceOnlyArmed),
                totalFillCount: Number(scalper.totalFillCount || 0),
                openingActiveChases,
                closingActiveChases,
                virtualPosition: virtualPosition
                    ? {
                        side: String(virtualPosition.side || '').toUpperCase() || null,
                        quantity: toFiniteNumber(virtualPosition.quantity),
                        entryPrice: toFiniteNumber(virtualPosition.entryPrice),
                        markPrice: toFiniteNumber(virtualPosition.markPrice),
                    }
                    : null,
                marketMid,
                closingGate,
                activity6h: {
                    adds: activity.adds,
                    closes: activity.closes,
                    addCloseRatio: ratio,
                },
            };
        });

        res.json({
            subAccountId,
            generatedAt: new Date().toISOString(),
            scalpers: diagnostics,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── TWAP ──

router.post('/twap', requireOwnership('body'), proxyToRedis('pms:cmd:twap'));
router.post('/twap-basket', requireOwnership('body'), proxyToRedis('pms:cmd:twap_basket'));

router.delete('/twap/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:twap_cancel', { twapId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/twap-basket/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_twap_basket', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/twap-basket/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:twap_basket_cancel', { twapBasketId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Trail Stop ──

router.post('/trail-stop', requireOwnership('body'), proxyToRedis('pms:cmd:trail_stop'));

router.delete('/trail-stop/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:trail_stop_cancel', { trailStopId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Active State GET Endpoints (read from Redis hashes) ──

async function getActiveFromRedis(prefix, subAccountId) {
    const { getRedis } = await import('../../redis.js');
    const redis = getRedis();
    const key = `${prefix}:${subAccountId}`;
    const raw = await redis.hgetall(key);
    const items = Object.values(raw || {}).map(v => {
        try { return JSON.parse(v); }
        catch { return null; }
    }).filter(Boolean);
    return items;
}

// Chase: Python to_dict() output passed through directly
router.get('/chase-limit/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_chase', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scalper: Python to_dict() output passed through directly
router.get('/scalper/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_scalper', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// TWAP: Python to_dict() output passed through directly
router.get('/twap/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_twap', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trail Stop: Python to_dict() output passed through directly
router.get('/trail-stop/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_trail_stop', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Validate (dry run) ──

router.post('/validate', requireOwnership('body'), proxyToRedis('pms:cmd:validate'));

export default router;
