/**
 * Trail Stop — thin C++ proxy.
 *
 * All trail-stop logic (HWM/LWM tracking, trigger detection, market close)
 * runs in the C++ TrailActor.  JS only validates, delegates via UDS bridge,
 * and returns the response.
 *
 * Removed JS fallback (500→90 lines).  Set CPP_ENGINE_WRITE=0 is no longer
 * supported for trail-stop — C++ is the only path.
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import { requireOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { checkCppWriteReady } from './cpp-write-ready.js';
import { ensureCppAccountSynced } from './cpp-order-utils.js';
import { toCppSymbol } from './cpp-symbol.js';

const router = Router();

// POST /api/trade/trail-stop — Start a trail stop for a position
router.post('/trail-stop', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, positionId, callbackPct, activationPrice } = req.body;
        if (!subAccountId || !positionId || !callbackPct) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, positionId, callbackPct' });
        }

        const parsedCallback = parseFloat(callbackPct);
        if (!Number.isFinite(parsedCallback) || parsedCallback <= 0 || parsedCallback > 50) {
            return res.status(400).json({ error: 'callbackPct must be between 0 and 50' });
        }

        const parsedActivation = activationPrice ? parseFloat(activationPrice) : null;

        // Verify position exists and belongs to this sub-account
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { id: true, subAccountId: true, symbol: true, side: true, quantity: true, entryPrice: true },
        });
        if (!position) {
            return res.status(404).json({ error: 'Position not found' });
        }
        if (position.subAccountId !== subAccountId) {
            return res.status(403).json({ error: 'Position does not belong to this sub-account' });
        }

        // Delegate to C++ TrailActor
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) {
            return res.status(503).json({ error: 'C++ engine not ready', details: readiness });
        }

        await ensureCppAccountSynced(bridge, subAccountId);
        const requestId = await bridge.sendCommand('trail_start', {
            sub_account_id: subAccountId,
            symbol: toCppSymbol(position.symbol),
            side: position.side === 'LONG' ? 'BUY' : 'SELL',
            quantity: position.quantity,
            callback_pct: parsedCallback,
            activation_price: parsedActivation || 0,
            position_id: positionId,
        });

        res.set('X-Source', 'cpp-engine');
        return res.status(202).json({
            success: true,
            source: 'cpp-engine',
            requestId,
            positionId,
            symbol: position.symbol,
            side: position.side,
            callbackPct: parsedCallback,
            activationPrice: parsedActivation,
        });
    } catch (err) {
        console.error('[TrailStop] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/trail-stop/:trailStopId — Cancel via C++
router.delete('/trail-stop/:trailStopId', async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        const readiness = checkCppWriteReady(bridge);
        if (!readiness.ok) {
            return res.status(503).json({ error: 'C++ engine not ready' });
        }

        const trailId = parseInt(req.params.trailStopId, 10) || 0;
        await bridge.sendCommand('trail_cancel', {
            trail_id: trailId,
        });

        res.json({ success: true, trailStopId: req.params.trailStopId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/trail-stop/active/:subAccountId — Query C++ for active trail stops
router.get('/trail-stop/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        if (!bridge?.isHealthy()) {
            return res.json([]); // No engine = no active trail stops
        }

        // Fire-and-forget status query; trail_status response arrives via WS
        bridge.sendCommand('trail_status', {
            sub_account_id: req.params.subAccountId,
        }).catch(() => { });

        // Return empty for now — real-time status comes via WS
        res.json([]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// No-op stubs for backward compat (previously exported for server startup)
export function resumeActiveTrailStops() { /* C++ handles persistence */ }
export function initTrailStopCleanup() { /* C++ handles cleanup */ }

export default router;
