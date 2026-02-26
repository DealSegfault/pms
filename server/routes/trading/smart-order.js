import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { getRedis } from '../../redis.js';
import { toCppSymbol } from './cpp-symbol.js';
import { checkCppWriteReady } from './cpp-write-ready.js';

const router = Router();

const REDIS_KEY_PREFIX = 'pms:smartorder:active:';
let _bridgeListenersAttached = false;

function getRedisKey(subAccountId) {
    return `${REDIS_KEY_PREFIX}${subAccountId}`;
}

function generateLocalId() {
    return `smart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toFiniteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function mapProgressStatus(eventName = '') {
    const event = String(eventName || '').toLowerCase();
    if (!event) return 'RUNNING';
    if (event.startsWith('stopped_')) return 'STOPPED';
    if (event.startsWith('paused_')) return 'PAUSED';
    return 'RUNNING';
}

function buildProgressDetails(msg) {
    const event = String(msg?.event || '').trim();
    const fills = toFiniteNumber(msg?.total_fills, null);
    const pnl = toFiniteNumber(msg?.total_pnl_usd, null);
    let details = event || 'tick';
    if (fills != null) details += ` • fills ${fills}`;
    if (pnl != null) details += ` • pnl $${pnl.toFixed(2)}`;
    return details;
}

async function readActiveSmartOrders(subAccountId) {
    const r = getRedis();
    if (!r) return new Map();

    const raw = await r.hgetall(getRedisKey(subAccountId));
    const parsed = new Map();
    for (const [key, jsonStr] of Object.entries(raw || {})) {
        try {
            parsed.set(key, JSON.parse(jsonStr));
        } catch {
            // Ignore malformed entries.
        }
    }
    return parsed;
}

async function upsertSmartOrderRecord(subAccountId, redisKey, record) {
    const r = getRedis();
    if (!r) return;
    await r.hset(getRedisKey(subAccountId), redisKey, JSON.stringify(record));
}

async function removeSmartOrderRecord(subAccountId, redisKey) {
    const r = getRedis();
    if (!r) return;
    await r.hdel(getRedisKey(subAccountId), redisKey);
}

async function applySmartOrderProgress(msg) {
    const subAccountId = msg?.sub_account_id || msg?.subAccountId;
    if (!subAccountId) return;

    const records = await readActiveSmartOrders(subAccountId);
    const cppSmartOrderId = toFiniteNumber(msg?.smart_order_id, null);
    const requestId = toFiniteNumber(msg?.request_id, null);

    let targetKey = null;
    let target = null;

    for (const [key, rec] of records.entries()) {
        if (cppSmartOrderId != null && toFiniteNumber(rec?.cppSmartOrderId, null) === cppSmartOrderId) {
            targetKey = key;
            target = rec;
            break;
        }
        if (requestId != null && toFiniteNumber(rec?.requestId, null) === requestId) {
            targetKey = key;
            target = rec;
        }
    }

    if (!targetKey) {
        targetKey = cppSmartOrderId != null ? `smart_cpp_${cppSmartOrderId}` : generateLocalId();
        target = { id: targetKey, createdAt: Date.now() };
    }

    const status = mapProgressStatus(msg?.event);
    if (status === 'STOPPED') {
        await removeSmartOrderRecord(subAccountId, targetKey);
        return;
    }

    const updated = {
        ...target,
        id: target.id || targetKey,
        subAccountId,
        cppSmartOrderId: cppSmartOrderId ?? target.cppSmartOrderId ?? null,
        requestId: requestId ?? target.requestId ?? null,
        symbol: target.symbol || msg?.symbol,
        side: target.side || 'NEUTRAL',
        status,
        details: buildProgressDetails(msg),
        totalFills: toFiniteNumber(msg?.total_fills, target.totalFills || 0),
        totalPnlUsd: toFiniteNumber(msg?.total_pnl_usd, target.totalPnlUsd || 0),
        updatedAt: Date.now(),
        createdAt: target.createdAt || Date.now(),
    };

    await upsertSmartOrderRecord(subAccountId, targetKey, updated);
}

async function applySmartOrderStatus(msg) {
    const subAccountId = msg?.sub_account_id || msg?.subAccountId;
    const orders = Array.isArray(msg?.orders) ? msg.orders : [];
    if (!subAccountId || orders.length === 0) return;

    const records = await readActiveSmartOrders(subAccountId);

    for (const order of orders) {
        const cppSmartOrderId = toFiniteNumber(order?.smart_order_id, null);
        if (cppSmartOrderId == null) continue;

        let targetKey = null;
        let target = null;
        for (const [key, rec] of records.entries()) {
            if (toFiniteNumber(rec?.cppSmartOrderId, null) === cppSmartOrderId) {
                targetKey = key;
                target = rec;
                break;
            }
        }

        if (!targetKey) {
            targetKey = `smart_cpp_${cppSmartOrderId}`;
            target = { id: targetKey, createdAt: Date.now() };
        }

        const updated = {
            ...target,
            id: target.id || targetKey,
            subAccountId,
            cppSmartOrderId,
            symbol: target.symbol || order.symbol,
            side: target.side || 'NEUTRAL',
            status: order.paused ? 'PAUSED' : 'RUNNING',
            details: order.paused ? 'paused' : 'running',
            totalFills: toFiniteNumber(order.total_fills, target.totalFills || 0),
            totalPnlUsd: toFiniteNumber(order.total_pnl_usd, target.totalPnlUsd || 0),
            updatedAt: Date.now(),
            createdAt: target.createdAt || Date.now(),
        };

        await upsertSmartOrderRecord(subAccountId, targetKey, updated);
    }
}

function ensureSmartOrderBridgeListeners(bridge) {
    if (!bridge || _bridgeListenersAttached) return;

    bridge.on('event', (msg) => {
        if (!msg?.stream) return;

        if (msg.stream === 'smart_order_progress') {
            applySmartOrderProgress(msg).catch((err) => {
                console.warn(`[SmartOrder] progress sync failed: ${err.message}`);
            });
            return;
        }

        if (msg.stream === 'smart_order_status') {
            applySmartOrderStatus(msg).catch((err) => {
                console.warn(`[SmartOrder] status sync failed: ${err.message}`);
            });
        }
    });

    _bridgeListenersAttached = true;
    console.log('[SmartOrder] Bridge listeners attached');
}

// POST /api/trade/smart-order — Start a new SmartOrder via C++ engine
router.post('/smart-order', requireOwnership('body'), async (req, res) => {
    try {
        const payload = req.body || {};
        if (!payload.subAccountId || !payload.symbol || !payload.side) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side' });
        }

        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) {
            return res.status(503).json({ error: readiness.error });
        }

        ensureSmartOrderBridgeListeners(bridge);

        const localSmartOrderId = generateLocalId();
        const requestId = await bridge.sendCommand('smart_order', {
            sub_account_id: payload.subAccountId,
            symbol: toCppSymbol(payload.symbol),
            direction: payload.side,
            max_notional_usd: Number(payload.maxNotionalUsd || 0),
            leverage: Number(payload.leverage || 1),
            target_pnl_velocity: Number(payload.targetPnlVelocity || 0),
            max_adverse_selection_bps: Number(payload.maxAdverseSelectionBps || 0),
            max_drawdown_usd: Number(payload.maxDrawdownUsd || 0),
            child_count: payload.childCount != null ? Number(payload.childCount) : undefined,
            skew: payload.skew != null ? Number(payload.skew) : undefined,
            long_offset_pct: payload.longOffsetPct != null ? Number(payload.longOffsetPct) : undefined,
            short_offset_pct: payload.shortOffsetPct != null ? Number(payload.shortOffsetPct) : undefined,
        });

        const startState = {
            id: localSmartOrderId,
            subAccountId: payload.subAccountId,
            symbol: payload.symbol,
            side: payload.side,
            leverage: payload.leverage ? Number(payload.leverage) : 1,
            amountInvestedUsd: Number(payload.longSizeUsd || payload.shortSizeUsd || payload.maxNotionalUsd || 0),
            status: 'STARTING',
            details: 'queued to C++',
            cppSmartOrderId: null,
            requestId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        await upsertSmartOrderRecord(payload.subAccountId, localSmartOrderId, startState);

        console.log(`[SmartOrder] Queued ${localSmartOrderId} (${payload.symbol}) request_id=${requestId}`);

        return res.status(202).json({
            success: true,
            accepted: true,
            smartOrderId: localSmartOrderId,
            requestId,
            status: 'QUEUED',
        });
    } catch (err) {
        console.error('[SmartOrder] Start error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/smart-order/active/:subAccountId — List active SmartOrders
router.get('/smart-order/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        const bridge = getSimplxBridge();
        if (bridge?.isHealthy()) {
            ensureSmartOrderBridgeListeners(bridge);
            bridge.sendCommand('smart_order_status', { sub_account_id: subAccountId }).catch(() => { });
        }

        const records = await readActiveSmartOrders(subAccountId);
        const results = [];
        for (const record of records.values()) {
            if (String(record?.status || '').toUpperCase() === 'STOPPED') continue;
            results.push(record);
        }

        results.sort((a, b) => {
            const ta = Number(a?.updatedAt || a?.createdAt || 0);
            const tb = Number(b?.updatedAt || b?.createdAt || 0);
            return tb - ta;
        });

        return res.json(results);
    } catch (err) {
        console.error('[SmartOrder] List error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/smart-order/:smartOrderId — Stop a SmartOrder
router.delete('/smart-order/:smartOrderId', requireOwnership('query'), async (req, res) => {
    try {
        const routeSmartOrderId = String(req.params.smartOrderId || '').trim();
        const subAccountId = String(req.query.subAccountId || '').trim();

        if (!subAccountId) {
            return res.status(400).json({ error: 'subAccountId query parameter is required to stop a SmartOrder' });
        }

        const bridge = getSimplxBridge();
        if (!bridge || !bridge.isHealthy()) {
            return res.status(503).json({ error: 'C++ Engine is currently unavailable' });
        }

        ensureSmartOrderBridgeListeners(bridge);

        const records = await readActiveSmartOrders(subAccountId);
        let targetKey = null;
        let target = null;

        if (records.has(routeSmartOrderId)) {
            targetKey = routeSmartOrderId;
            target = records.get(routeSmartOrderId);
        } else {
            for (const [key, rec] of records.entries()) {
                const sameLocalId = String(rec?.id || '') === routeSmartOrderId;
                const sameCppId = String(rec?.cppSmartOrderId || '') === routeSmartOrderId;
                if (sameLocalId || sameCppId) {
                    targetKey = key;
                    target = rec;
                    break;
                }
            }
        }

        const cppSmartOrderId = toFiniteNumber(target?.cppSmartOrderId ?? routeSmartOrderId, null);
        if (cppSmartOrderId == null) {
            return res.status(404).json({
                error: 'SmartOrder is still starting and has no C++ id yet. Retry in a moment.',
            });
        }

        await bridge.sendCommand('smart_order_stop', { smart_order_id: cppSmartOrderId });

        if (targetKey) {
            await removeSmartOrderRecord(subAccountId, targetKey);
        }

        // Remove any alias records that resolve to the same C++ smart order id.
        const stale = [];
        for (const [key, rec] of records.entries()) {
            if (toFiniteNumber(rec?.cppSmartOrderId, null) === cppSmartOrderId) {
                stale.push(key);
            }
        }
        await Promise.allSettled(stale.map((key) => removeSmartOrderRecord(subAccountId, key)));

        return res.json({
            success: true,
            accepted: true,
            cppSmartOrderId,
            smartOrderId: target?.id || routeSmartOrderId,
            message: 'Stop command dispatched',
        });
    } catch (err) {
        console.error('[SmartOrder] Stop error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
