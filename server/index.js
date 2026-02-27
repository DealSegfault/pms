/**
 * PMS Server — Thin Gateway Mode
 *
 * All trading logic runs in the Python engine.
 * JS handles: auth, API routing, WebSocket proxy, admin, read-only DB queries.
 *
 * Trading commands → Redis LPUSH → Python BLPOP → Redis SET result → JS reads
 * Live events → Python Redis PUB → JS Redis SUB → WebSocket broadcast
 *
 * Rollback: restore from server/_archived/index.js
 */
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { initWebSocket } from './ws.js';
import { initRedis, closeRedis } from './redis.js';
import { setRedisClient } from './redis-proxy.js';
import { flexAuthMiddleware, adminMiddleware } from './auth.js';
import prisma from './db/prisma.js';
import { disconnectPrisma } from './db/prisma.js';
import { errorHandler } from './http/error-model.js';
import { startPythonEngine, stopPythonEngine } from './python-engine.js';

// Routes
import authRouter from './routes/auth.js';
import subAccountsRouter from './routes/sub-accounts.js';
import riskRulesRouter from './routes/risk-rules.js';
import tradingRouter from './routes/trading.js';
import adminRouter from './routes/admin.js';
import proxyRouter, { initProxy } from './routes/proxy.js';
import historyRouter, { initHistory } from './routes/history.js';
import botRouter from './routes/bot.js';
import webauthnRouter from './routes/webauthn.js';


dotenv.config();

const app = express();

const PORT = process.env.PORT || 3900;

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/fapi')) {
        console.log(`[API] ${req.method} ${req.url}`);
    }
    next();
});

// ── Rate Limiting ────────────────────────────────
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 600,
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later' },
});

app.use('/api', apiLimiter);

// ── Public routes (no auth) ──────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/webauthn/login', authLimiter);
app.use('/api/auth', authRouter);
app.use('/api/auth/webauthn', webauthnRouter);

// Health check (public)
app.get('/api/health', async (req, res) => {
    let redisOk = false;
    let dbOk = false;
    let pythonOk = false;

    try {
        const { default: redis } = await import('./redis.js');
        redisOk = true;
    } catch { }
    try {
        await prisma.$queryRawUnsafe('SELECT 1');
        dbOk = true;
    } catch { }
    try {
        // Check if Python engine is alive by checking for recent risk snapshots
        const { getRedis } = await import('./redis.js');
        const r = getRedis();
        // Scan for any pms:risk:* keys — Python writes these on every price tick
        let found = false;
        for await (const key of r.scanIterator({ MATCH: 'pms:risk:*', COUNT: 10 })) {
            found = true;
            break;
        }
        pythonOk = found;
    } catch { }

    const status = dbOk ? 'ok' : 'degraded';
    res.json({
        status,
        mode: 'python-proxy',
        redis: redisOk,
        database: dbOk,
        pythonEngine: pythonOk,
        timestamp: Date.now(),
    });
});

// ── Protected routes (require auth) ──────────────
const auth = flexAuthMiddleware();
app.use('/api/sub-accounts', auth, subAccountsRouter);
app.use('/api/risk-rules', auth, riskRulesRouter);
app.use('/api/trade', auth, tradingRouter);
app.use('/api/admin', auth, adminMiddleware, adminRouter);
app.use('/api/bot', auth, botRouter);
app.use('/api/history', historyRouter);

// ── Binance FAPI proxy (bot-facing) ──────────────
app.use('/fapi', proxyRouter);

// ── Error handling (must be after all routes) ────
app.use(errorHandler);

// Start server
const server = createServer(app);

// ── Pre-listen port cleanup ──────────────────────────
const MAX_LISTEN_RETRIES = 3;

async function ensurePortFree(port, maxAttempts = MAX_LISTEN_RETRIES) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
            if (!pids) return;
            console.warn(`[Server] Port ${port} occupied by PID(s): ${pids.replace(/\n/g, ', ')} — killing (attempt ${attempt}/${maxAttempts})...`);
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`);
            await new Promise(r => setTimeout(r, 1500));
        } catch { }
    }
    const remaining = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (remaining) {
        console.error(`[Server] Port ${port} still occupied after ${maxAttempts} attempts.`);
        process.exit(1);
    }
}

// Safety-net: catch listen errors
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Server] EADDRINUSE on port ${PORT} despite pre-cleanup.`);
    } else {
        console.error('[Server] Unexpected server error:', err);
    }
    process.exit(1);
});

// NOTE: initWebSocket is called inside start() AFTER Redis is connected,
// so that subscribeToPmsEvents can create a PUB/SUB subscriber.

async function start() {
    try {
        // Connect Redis
        const redisReady = await initRedis();

        if (redisReady) {
            // Wire redis-proxy helper to use the Redis client
            const { getRedis } = await import('./redis.js');
            setRedisClient(getRedis());
            // Initialize WebSocket AFTER Redis is wired — PUB/SUB subscriber needs redis client
            initWebSocket(server);
            console.log('[Server] Redis proxy wired — trading commands will go to Python engine');
        } else {
            // Start WS without PUB/SUB — connections work but no real-time events
            initWebSocket(server);
            console.warn('[Server] Redis not available — trading commands will fail (Python engine unreachable)');
        }

        // Init FAPI proxy (still needs exchange for passthrough)
        // initProxy and initHistory may need exchange for non-trading endpoints
        // For now, skip exchange initialization — proxy routes handle degraded mode
        initHistory(null);

        // Kill any stale process holding the port (dev only)
        if (process.env.NODE_ENV !== 'production') {
            await ensurePortFree(PORT);
        }

        await new Promise((resolve) => {
            server.listen(PORT, () => {
                console.log(`\n🚀 PMS Server PROXY MODE on http://localhost:${PORT}`);
                console.log(`📡 WebSocket on ws://localhost:${PORT}/ws (Redis PUB/SUB)`);
                console.log(`📊 API at http://localhost:${PORT}/api`);
                console.log(`🐍 Trading → Python engine via Redis`);
                console.log(`📦 Auth, admin, history → JS (unchanged)\n`);
                resolve();
            });
        });

        // Start Python trading engine as child process (after server is listening)
        await startPythonEngine();
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();

// ── Graceful shutdown ────────────────────────────────
async function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);
    try {
        await stopPythonEngine();
        await closeRedis();
        await disconnectPrisma();
        await new Promise((resolve) => {
            server.close(() => resolve());
            setTimeout(resolve, 3000);
        });
    } catch (err) {
        console.error('[Shutdown] Error during cleanup:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2'));
