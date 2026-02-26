/**
 * TCA API Routes — Transaction Cost Analysis dashboard data.
 *
 * Serves execution quality, latency, reconciliation, and cost metrics
 * aggregated by the tca-collector. All query methods are async
 * (memory for ≤1h windows, DB for historical data).
 */

import { Router } from 'express';
import tca from '../tca-collector.js';

const router = Router();

// ── GET /api/tca/summary ──────────────────────────────────────
router.get('/summary', async (req, res) => {
    try {
        const windowMs = parseInt(req.query.window) || 3600_000;
        const summary = await tca.getSummary(windowMs);
        res.json(summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/tca/latency ──────────────────────────────────────
router.get('/latency', async (req, res) => {
    try {
        const windowMs = parseInt(req.query.window) || 3600_000;
        const breakdown = await tca.getLatencyBreakdown(windowMs);
        res.json(breakdown);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/tca/ws-latency ───────────────────────────────────
router.get('/ws-latency', async (req, res) => {
    try {
        const windowMs = parseInt(req.query.window) || 3600_000;
        const breakdown = await tca.getWsLatency(windowMs);
        res.json(breakdown);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/tca/fills ────────────────────────────────────────
router.get('/fills', async (req, res) => {
    try {
        const { symbol, window: windowStr, limit: limitStr } = req.query;
        const windowMs = parseInt(windowStr) || 3600_000;
        const limit = parseInt(limitStr) || 200;
        const fills = await tca.getFillDetail({ symbol, windowMs, limit });
        res.json(fills);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/tca/reconciliation ───────────────────────────────
router.get('/reconciliation', async (req, res) => {
    try {
        const windowMs = parseInt(req.query.window) || 3600_000;
        const limit = parseInt(req.query.limit) || 100;
        const log = await tca.getReconciliationLog(windowMs, limit);
        res.json(log);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/tca/scalper-sessions ─────────────────────────────
router.get('/scalper-sessions', async (req, res) => {
    try {
        const windowMs = parseInt(req.query.window) || 86400_000;
        const limit = parseInt(req.query.limit) || 50;
        const sessions = await tca.getScalperSessions(windowMs, limit);
        res.json({ sessions, count: sessions.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
