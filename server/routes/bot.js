/**
 * Bot API Routes — CRUD + toggle for micro trading bot config.
 *
 * Endpoints:
 *   GET    /api/bot/config/:subAccountId  — Get/create bot config
 *   PUT    /api/bot/config/:subAccountId  — Update bot config
 *   POST   /api/bot/toggle/:subAccountId  — Toggle bot on/off
 *   GET    /api/bot/status/:subAccountId  — Live bot status
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import botManager from '../bot/manager.js';
import { requireOwnership } from '../ownership.js';
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

export default router;
