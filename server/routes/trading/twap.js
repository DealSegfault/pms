/**
 * TWAP + Basket TWAP — thin C++ proxy.
 *
 * All scheduling, lot sizing, limit→market fallback, and basket fan-out
 * run in C++ TwapActor and BasketActor.  JS only validates and delegates.
 *
 * Removed JS fallback (1,155→180 lines).
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { checkCppWriteReady } from './cpp-write-ready.js';
import { ensureCppAccountSynced } from './cpp-order-utils.js';
import { toCppSymbol } from './cpp-symbol.js';

const router = Router();

// ── POST /api/trade/twap — Start a single-symbol TWAP ──────────────

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
        const parsedPriceLimit = priceLimit ? parseFloat(priceLimit) : null;

        if (!Number.isFinite(parsedSize) || parsedSize <= 0) return res.status(400).json({ error: 'totalSize must be positive' });
        if (!Number.isInteger(parsedLots) || parsedLots < 2 || parsedLots > 100) return res.status(400).json({ error: 'lots must be 2-100' });
        if (!Number.isFinite(parsedDuration) || parsedDuration < 1 || parsedDuration > 720) return res.status(400).json({ error: 'durationMinutes must be 1-720' });
        if (!Number.isFinite(parsedLeverage) || parsedLeverage <= 0 || parsedLeverage > 125) return res.status(400).json({ error: 'leverage must be 1-125' });
        if (parsedPriceLimit !== null && (!Number.isFinite(parsedPriceLimit) || parsedPriceLimit <= 0)) return res.status(400).json({ error: 'priceLimit must be positive' });

        const minLotSize = parsedSize / parsedLots;
        if (minLotSize < 6) {
            const maxLots = Math.floor(parsedSize / 6);
            return res.status(400).json({ error: `Each lot $${minLotSize.toFixed(2)} < $6 min. Reduce lots to ${maxLots}.` });
        }

        // Delegate to C++ TwapActor
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) return res.status(503).json({ error: 'C++ engine not ready', details: readiness });

        await ensureCppAccountSynced(bridge, subAccountId);
        const requestId = await bridge.sendCommand('twap_start', {
            sub_account_id: subAccountId,
            symbol: toCppSymbol(symbol),
            side: normSide === 'LONG' ? 'BUY' : 'SELL',
            total_size: parsedSize,
            lots: parsedLots,
            duration_minutes: parsedDuration,
            leverage: parsedLeverage,
            jitter: !!jitter,
            irregular: !!irregular,
            price_limit: parsedPriceLimit || 0,
        });

        res.set('X-Source', 'cpp-engine');
        return res.status(202).json({
            success: true, source: 'cpp-engine', requestId,
            symbol, side: normSide, totalSize: parsedSize, lots: parsedLots, durationMinutes: parsedDuration,
        });
    } catch (err) {
        console.error('[TWAP] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/trade/twap/active/:subAccountId ────────────────────────

router.get('/twap/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        if (bridge?.isHealthy()) {
            bridge.sendCommand('twap_status', { sub_account_id: req.params.subAccountId }).catch(() => { });
        }
        res.json([]); // Real-time status via WS
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/trade/twap/:twapId ──────────────────────────────────

router.delete('/twap/:twapId', async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) return res.status(503).json({ error: 'C++ engine not ready' });

        await bridge.sendCommand('twap_stop', { twap_id: req.params.twapId });
        res.json({ success: true, twapId: req.params.twapId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/trade/twap-basket — Start a basket (index) TWAP ──────

router.post('/twap-basket', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, legs, basketName, lots, durationMinutes, jitter, irregular } = req.body;
        if (!subAccountId || !Array.isArray(legs) || legs.length === 0 || !lots || !durationMinutes) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, legs[], lots, durationMinutes' });
        }

        const parsedLots = parseInt(lots, 10);
        const parsedDuration = parseFloat(durationMinutes);
        if (!Number.isInteger(parsedLots) || parsedLots < 2 || parsedLots > 100) return res.status(400).json({ error: 'lots must be 2-100' });
        if (!Number.isFinite(parsedDuration) || parsedDuration < 1 || parsedDuration > 720) return res.status(400).json({ error: 'durationMinutes must be 1-720' });

        // Validate & normalize legs
        const normalizedLegs = [];
        for (const leg of legs) {
            if (!leg?.symbol || !leg?.side || !leg?.sizeUsdt || !leg?.leverage) {
                return res.status(400).json({ error: `Invalid leg: needs symbol, side, sizeUsdt, leverage` });
            }
            const side = String(leg.side).toUpperCase();
            const sizeUsdt = parseFloat(leg.sizeUsdt);
            const leverage = parseFloat(leg.leverage);
            if (side !== 'LONG' && side !== 'SHORT') return res.status(400).json({ error: `Invalid side for ${leg.symbol}` });
            if (!Number.isFinite(sizeUsdt) || sizeUsdt <= 0) return res.status(400).json({ error: `Invalid sizeUsdt for ${leg.symbol}` });
            if (!Number.isFinite(leverage) || leverage <= 0 || leverage > 125) return res.status(400).json({ error: `Invalid leverage for ${leg.symbol}` });

            if (sizeUsdt / parsedLots < 6) {
                return res.status(400).json({ error: `${leg.symbol}: per-lot $${(sizeUsdt / parsedLots).toFixed(2)} < $6 min` });
            }

            normalizedLegs.push({ symbol: String(leg.symbol), side, sizeUsdt, leverage });
        }

        // Delegate to C++ BasketActor
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) return res.status(503).json({ error: 'C++ engine not ready', details: readiness });

        await ensureCppAccountSynced(bridge, subAccountId);
        const requestId = await bridge.sendCommand('basket_start', {
            sub_account_id: subAccountId,
            basket_name: basketName || 'Unnamed Index',
            legs: normalizedLegs.map(l => ({
                symbol: toCppSymbol(l.symbol),
                side: l.side === 'LONG' ? 'BUY' : 'SELL',
                sizeUsdt: l.sizeUsdt,
                leverage: l.leverage,
            })),
            lots: parsedLots,
            duration_minutes: parsedDuration,
            jitter: !!jitter,
            irregular: !!irregular,
        });

        res.set('X-Source', 'cpp-engine');
        return res.status(202).json({
            success: true, source: 'cpp-engine', requestId,
            basketName: basketName || 'Unnamed Index', legs: normalizedLegs.length, lots: parsedLots, durationMinutes: parsedDuration,
        });
    } catch (err) {
        console.error('[TWAP-Basket] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/trade/twap-basket/active/:subAccountId ─────────────────

router.get('/twap-basket/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        if (bridge?.isHealthy()) {
            bridge.sendCommand('basket_status', { sub_account_id: req.params.subAccountId }).catch(() => { });
        }
        res.json([]); // Real-time status via WS
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/trade/twap-basket/:twapBasketId ─────────────────────

router.delete('/twap-basket/:twapBasketId', async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) return res.status(503).json({ error: 'C++ engine not ready' });

        const basketId = parseInt(req.params.twapBasketId, 10) || 0;
        await bridge.sendCommand('basket_stop', { basket_id: basketId });
        res.json({ success: true, twapBasketId: req.params.twapBasketId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// No-op stubs for backward compat (previously exported for server startup)
export function resumeActiveTwaps() { /* C++ handles persistence */ }

export default router;
