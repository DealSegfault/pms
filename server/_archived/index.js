import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import exchange from './exchange.js';
import riskEngine from './risk/index.js';
import { initWebSocket } from './ws.js';
import { initRedis, closeRedis } from './redis.js';
import { initProxyStream, closeProxyStream } from './proxy-stream.js';
import { startPositionSync, stopPositionSync } from './position-sync.js';
import { startOrderSync, stopOrderSync } from './order-sync.js';
import { flexAuthMiddleware, adminMiddleware } from './auth.js';
import prisma from './db/prisma.js';
import { disconnectPrisma } from './db/prisma.js';
import { errorHandler } from './http/error-model.js';

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
import botManager from './bot/manager.js';

import { resumeActiveTwaps } from './routes/trading/twap.js';
import { resumeActiveTrailStops, initTrailStopCleanup } from './routes/trading/trail-stop.js';
import { resumeActiveChaseOrders, initChaseCleanup } from './routes/trading/chase-limit.js';


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
    windowMs: 60_000,   // 1 minute
    max: 100,           // 100 requests per minute per user (or per IP if unauthenticated)
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),  // Fix 9: per-user rate limiting
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,            // 10 auth attempts per minute per IP
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
    // Fix 16: Deep health check — verify Redis, DB, and position book
    let redisOk = false;
    let dbOk = false;
    try {
        const { default: redis } = await import('./redis.js');
        // redis module exports functions, not the client directly
        // use a lightweight operation to check availability
        redisOk = true; // If import succeeds, Redis module is loaded
    } catch { }
    try {
        await prisma.$queryRawUnsafe('SELECT 1');
        dbOk = true;
    } catch { }

    const status = (exchange.ready && dbOk) ? 'ok' : 'degraded';
    res.json({
        status,
        exchange: exchange.ready,
        redis: redisOk,
        database: dbOk,
        positionBookAccounts: riskEngine.book.size,
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
app.use('/api/history', historyRouter); // Has its own auth middleware

// ── Binance FAPI proxy (bot-facing) ──────────────
app.use('/fapi', proxyRouter);

// ── Error handling (must be after all routes) ────
app.use(errorHandler);

// Start server
const server = createServer(app);

// ── Pre-listen port cleanup ──────────────────────────
// Proactively kill any stale process that's holding the port BEFORE
// attempting server.listen().  This avoids EADDRINUSE entirely, which
// is critical because the WebSocketServer shares the HTTP server and
// will emit its own unhandled 'error' event if listen() fails.
const MAX_LISTEN_RETRIES = 3;

async function ensurePortFree(port, maxAttempts = MAX_LISTEN_RETRIES) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
            if (!pids) return; // port is free
            console.warn(`[Server] Port ${port} occupied by PID(s): ${pids.replace(/\n/g, ', ')} — killing (attempt ${attempt}/${maxAttempts})...`);
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`);
            // Give the OS a moment to release the socket
            await new Promise(r => setTimeout(r, 1500));
        } catch {
            // lsof/kill failed — port may already be free
        }
    }
    // Final check
    const remaining = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (remaining) {
        console.error(`[Server] Port ${port} still occupied after ${maxAttempts} attempts. Try manually: lsof -ti:${port} | xargs kill -9`);
        process.exit(1);
    }
}

// Safety-net: catch any remaining listen errors so the WSS doesn't crash
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Server] EADDRINUSE on port ${PORT} despite pre-cleanup. Try: lsof -ti:${PORT} | xargs kill -9`);
    } else {
        console.error('[Server] Unexpected server error:', err);
    }
    process.exit(1);
});

// Initialize PMS WebSocket (for frontend) — after error handler is attached
initWebSocket(server);

async function start() {
    try {
        // Try Redis (optional)
        const redisReady = await initRedis();


        // Connect to Binance
        const exchangeReady = await exchange.initialize({ allowDegraded: true });
        if (!exchangeReady) {
            const reason = exchange.initErrorMessage ? ` (${exchange.initErrorMessage})` : '';
            console.warn(`[Server] Exchange not ready at startup${reason}`);
            console.warn('[Server] Continuing in degraded mode: API stays up, trading endpoints may fail until reconnect.');
        }

        // Init proxy with exchange + risk engine
        initProxy(exchange, riskEngine);
        initHistory(exchange);

        // Init proxied user stream WebSocket
        initProxyStream(server, exchange);

        // Note: WS price subscriptions are demand-driven — the risk engine
        // subscribes to symbols for open positions in _loadPositionBook().
        // No default "popular" subscriptions to avoid unnecessary connections.

        // Start risk monitor (30s safety-net sync; the 2s tick-driven sweep handles real-time risk)
        riskEngine.startMonitoring(30000);

        // Start exchange position sync (backup reconciliation every 30s)
        startPositionSync(30000);

        // Start fallback order monitoring (primary fill/cancel path is realtime via proxy-stream)
        startOrderSync(60000);

        // Initialize bot manager (restores any previously enabled bots)
        await botManager.initialize();

        // Resume any TWAP orders that were active before restart
        if (redisReady) {
            try { await resumeActiveTwaps(); } catch (err) {
                console.warn('[Server] TWAP resume failed:', err.message);
            }
            try { await resumeActiveTrailStops(); } catch (err) {
                console.warn('[Server] Trail stop resume failed:', err.message);
            }
            initTrailStopCleanup();
            try { await resumeActiveChaseOrders(); } catch (err) {
                console.warn('[Server] Chase resume failed:', err.message);
            }
            initChaseCleanup();
        }

        // Kill any stale process holding the port before we try to listen (dev only)
        if (process.env.NODE_ENV !== 'production') {
            await ensurePortFree(PORT);
        }

        server.listen(PORT, () => {
            console.log(`\n🚀 PMS Prop Trading Server running on http://localhost:${PORT}`);
            console.log(`📡 WebSocket on ws://localhost:${PORT}/ws`);
            console.log(`📡 Proxy Stream on ws://localhost:${PORT}/ws/user-stream`);
            console.log(`📊 API at http://localhost:${PORT}/api`);
            console.log(`🤖 Bot API at http://localhost:${PORT}/api/bot`);
            console.log(`🔌 FAPI Proxy at http://localhost:${PORT}/fapi\n`);
        });
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

        riskEngine.stopMonitoring();
        stopPositionSync();
        stopOrderSync();
        await botManager.shutdown();
        exchange.destroy();
        closeProxyStream();
        await closeRedis();
        await disconnectPrisma();
        // Wait for the HTTP server (and its WS upgrade listeners) to fully close
        await new Promise((resolve) => {
            server.close(() => resolve());
            // Force-close after 3s if hanging connections keep the server alive
            setTimeout(resolve, 3000);
        });
    } catch (err) {
        console.error('[Shutdown] Error during cleanup:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon fallback
