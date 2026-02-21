/**
 * Bot API Routes — CRUD + toggle for micro trading bot config.
 *
 * Endpoints:
 *   GET    /api/bot/config/:subAccountId  — Get/create bot config
 *   PUT    /api/bot/config/:subAccountId  — Update bot config
 *   POST   /api/bot/toggle/:subAccountId  — Toggle bot on/off
 *   GET    /api/bot/status/:subAccountId  — Live bot status
 *
 * Babysitter (v7):
 *   POST   /api/bot/babysitter/enable     — Enable babysitter for sub-account
 *   POST   /api/bot/babysitter/disable    — Disable babysitter
 *   POST   /api/bot/babysitter/position/:posId/exclude  — Exclude position
 *   POST   /api/bot/babysitter/position/:posId/include  — Include position
 *   GET    /api/bot/babysitter/status      — Babysitter status
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import botManager from '../bot/manager.js';
import babysitterManager from '../bot/babysitter-manager.js';
import { requireOwnership, requirePositionOwnership } from '../ownership.js';
import riskEngine from '../risk/index.js';
const router = Router();

// ─────────────────────────────────────
// UPDATABLE BOT CONFIG FIELDS
// ─────────────────────────────────────

const ALLOWED_FIELDS = {
    maxNotional: { type: 'number', min: 6, max: 500 },
    maxLayers: { type: 'number', min: 1, max: 32, int: true },
    maxExposure: { type: 'number', min: 50, max: 5000 },
    volFilterEnabled: { type: 'boolean' },
    minSpreadBps: { type: 'number', min: 1, max: 100 },
    maxSpreadBps: { type: 'number', min: 5, max: 200 },
    minHoldSec: { type: 'number', min: 0, max: 60 },
    minProfitBps: { type: 'number', min: 1, max: 500 },
    tpDecayEnabled: { type: 'boolean' },
    tpDecayHalfLife: { type: 'number', min: 1, max: 120 },
    trailingStopEnabled: { type: 'boolean' },
    trailingStopBps: { type: 'number', min: 3, max: 200 },
    inverseTPEnabled: { type: 'boolean' },
    inverseTPMinLayers: { type: 'number', min: 2, max: 10, int: true },
    scaledExitEnabled: { type: 'boolean' },
    maxLossBps: { type: 'number', min: 50, max: 2000 },
    lossCooldownSec: { type: 'number', min: 1, max: 300 },
    symbols: { type: 'string' },
    blacklist: { type: 'string' },
    tpMode: { type: 'string', enum: ['auto', 'fast', 'vol', 'long_short'] },
};

function validateConfig(body) {
    const errors = [];
    const cleaned = {};

    for (const [key, val] of Object.entries(body)) {
        const spec = ALLOWED_FIELDS[key];
        if (!spec) continue; // skip unknown fields

        if (spec.type === 'boolean') {
            cleaned[key] = Boolean(val);
        } else if (spec.type === 'number') {
            const n = Number(val);
            if (isNaN(n)) { errors.push(`${key} must be a number`); continue; }
            if (spec.min !== undefined && n < spec.min) { errors.push(`${key} min is ${spec.min}`); continue; }
            if (spec.max !== undefined && n > spec.max) { errors.push(`${key} max is ${spec.max}`); continue; }
            cleaned[key] = spec.int ? Math.round(n) : n;
        } else if (spec.type === 'string') {
            const s = String(val).slice(0, 1000);
            if (spec.enum && !spec.enum.includes(s)) {
                errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
                continue;
            }
            cleaned[key] = s;
        }
    }

    return { errors, cleaned };
}

// ─────────────────────────────────────
// GET /config/:subAccountId
// ─────────────────────────────────────

router.get('/config/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        // Verify account exists and belongs to user
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
        });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        // Get or create config
        let config = await prisma.botConfig.findUnique({
            where: { subAccountId },
        });

        if (!config) {
            config = await prisma.botConfig.create({
                data: { subAccountId },
            });
        }

        res.json(config);
    } catch (err) {
        console.error('[BotAPI] GET config error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────
// PUT /config/:subAccountId
// ─────────────────────────────────────

router.put('/config/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        // Validate
        const { errors, cleaned } = validateConfig(req.body);
        if (errors.length > 0) {
            return res.status(400).json({ errors });
        }
        if (Object.keys(cleaned).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        // Upsert config
        const config = await prisma.botConfig.upsert({
            where: { subAccountId },
            update: cleaned,
            create: { subAccountId, ...cleaned },
        });

        // Hot-reload if bot is running
        if (botManager.getActiveBots().includes(subAccountId)) {
            await botManager.reconfigure(subAccountId);
        }

        // If tpMode changed, refresh babysitter so Python picks it up
        if (cleaned.tpMode) {
            await babysitterManager.refreshForSubAccount(subAccountId, 'tpMode_change');
        }

        res.json(config);
    } catch (err) {
        console.error('[BotAPI] PUT config error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────
// POST /toggle/:subAccountId
// ─────────────────────────────────────

router.post('/toggle/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        // Verify account
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
        });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (account.status !== 'ACTIVE') {
            return res.status(400).json({ error: 'Account is not active' });
        }

        // Get current config
        let config = await prisma.botConfig.findUnique({
            where: { subAccountId },
        });

        const wasEnabled = config?.enabled || false;
        const nowEnabled = !wasEnabled;

        if (!config) {
            config = await prisma.botConfig.create({
                data: { subAccountId, enabled: nowEnabled },
            });
        } else {
            config = await prisma.botConfig.update({
                where: { subAccountId },
                data: { enabled: nowEnabled },
            });
        }

        // Start or stop the bot
        if (nowEnabled) {
            await botManager.startBot(subAccountId);
        } else {
            await botManager.stopBot(subAccountId, false);
        }

        res.json({
            enabled: nowEnabled,
            message: nowEnabled ? 'Bot activated' : 'Bot deactivated',
            config,
        });
    } catch (err) {
        console.error('[BotAPI] Toggle error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────
// GET /status/:subAccountId
// ─────────────────────────────────────

router.get('/status/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId } = req.params;
        const status = botManager.getStatus(subAccountId);

        // Also include config
        const config = await prisma.botConfig.findUnique({
            where: { subAccountId },
        });

        res.json({
            ...status,
            config: config || null,
        });
    } catch (err) {
        console.error('[BotAPI] Status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// BABYSITTER (V7) ROUTES
// ═══════════════════════════════════════════════════

// POST /babysitter/enable — Enable babysitter for a sub-account
// Body: { subAccountId }
router.post('/babysitter/enable', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId } = req.body;
        if (!subAccountId) {
            return res.status(400).json({ error: 'subAccountId is required' });
        }

        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
        });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        await babysitterManager.enableUser(subAccountId);

        res.json({
            enabled: true,
            message: 'Babysitter enabled — v7 grid strategy is now managing this account',
        });
    } catch (err) {
        console.error('[BotAPI] Babysitter enable error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /babysitter/disable — Disable babysitter for a sub-account
// Body: { subAccountId }
router.post('/babysitter/disable', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId } = req.body;
        if (!subAccountId) {
            return res.status(400).json({ error: 'subAccountId is required' });
        }

        await babysitterManager.disableUser(subAccountId);

        res.json({
            enabled: false,
            message: 'Babysitter disabled',
        });
    } catch (err) {
        console.error('[BotAPI] Babysitter disable error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /babysitter/position/:posId/exclude — Exclude position from babysitter
router.post('/babysitter/position/:posId/exclude', requirePositionOwnership('posId'), async (req, res) => {
    try {
        const { posId } = req.params;
        const pos = await prisma.virtualPosition.findUnique({
            where: { id: posId },
        });
        if (!pos) return res.status(404).json({ error: 'Position not found' });

        await babysitterManager.excludePosition(pos.subAccountId, posId);

        res.json({ excluded: true, positionId: posId });
    } catch (err) {
        console.error('[BotAPI] Position exclude error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /babysitter/position/:posId/include — Re-include position in babysitter
router.post('/babysitter/position/:posId/include', requirePositionOwnership('posId'), async (req, res) => {
    try {
        const { posId } = req.params;
        const pos = await prisma.virtualPosition.findUnique({
            where: { id: posId },
        });
        if (!pos) return res.status(404).json({ error: 'Position not found' });

        await babysitterManager.includePosition(pos.subAccountId, posId);

        res.json({ excluded: false, positionId: posId });
    } catch (err) {
        console.error('[BotAPI] Position include error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /babysitter/close-position — Python babysitter callback to close a position (exchange-first)
router.post('/babysitter/close-position', async (req, res) => {
    try {
        const { positionId, closePrice, reason } = req.body;
        if (!positionId || !closePrice) {
            return res.status(400).json({ error: 'positionId and closePrice are required' });
        }
        const result = await riskEngine.closeVirtualPositionByPrice(
            positionId, parseFloat(closePrice), reason || 'BABYSITTER_TP'
        );
        console.log(`[BotAPI] Babysitter close-position: ${positionId} @ ${closePrice} → ${result.success ? 'OK' : result.error}`);
        res.json(result);
    } catch (err) {
        console.error('[BotAPI] Babysitter close-position error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /babysitter/status — Get babysitter process + per-user status
router.get('/babysitter/status', async (req, res) => {
    try {
        const connected = await babysitterManager.isConnected();
        res.json({
            running: babysitterManager.isRunning(),
            connected,
            status: babysitterManager.getStatus() || {},
        });
    } catch (err) {
        console.error('[BotAPI] Babysitter status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
