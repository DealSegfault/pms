import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import exchange from './exchange.js';
import riskEngine from './risk/index.js';
import { initWebSocket } from './ws.js';
import { initRedis, closeRedis } from './redis.js';
// V2: proxy-stream, position-sync, order-sync are replaced by C++ engine + handlers/
// Keeping files on disk as safety net but not importing
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
import babysitterActionConsumer from './bot/babysitter-action-consumer.js';
import babysitterProcess from './bot/babysitter-process.js';
import { resumeActiveTwaps } from './routes/trading/twap.js';
import { resumeActiveTrailStops, initTrailStopCleanup } from './routes/trading/trail-stop.js';
import { resumeActiveChaseOrders, initChaseCleanup } from './routes/trading/chase-limit.js';
import {
    getPendingOrderPersistenceRecoveryStats,
    startPendingOrderPersistenceRecovery,
    stopPendingOrderPersistenceRecovery,
} from './routes/trading/order-persistence-recovery.js';
import tcaRouter from './routes/tca.js';
// V2: UDS bridge is the only transport — no Redis pub/sub bridge
import { initSimplxBridge, getSimplxBridge, shutdownSimplxBridge } from './simplx-uds-bridge.js';
import { initHandlers, shutdownHandlers, getHandlerStatus } from './handlers/index.js';
import { initEventRelay, shutdownEventRelay, getRelayStatus } from './engine-event-relay.js';
import { startProcessManager, stopProcessManager } from './simplx-process-manager.js';

import { stopAllAgents } from './agents/manager.js';

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3900;
const SHOULD_LOG_API_REQUESTS = process.env.API_REQUEST_LOGS === '1';

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (opt-in; disabled by default for hot paths)
if (SHOULD_LOG_API_REQUESTS) {
    app.use((req, _res, next) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/fapi')) {
            console.log(`[API] ${req.method} ${req.url}`);
        }
        next();
    });
}

// ── Rate Limiting ────────────────────────────────
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const apiLimiter = rateLimit({
    windowMs: 60_000,   // 1 minute
    max: 300,           // 300 requests per minute per user (or per IP if unauthenticated)
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),  // Fix 9: per-user rate limiting
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

// Higher limit for trading-related routes (positions, margins, history polls)
const tradingLimiter = rateLimit({
    windowMs: 60_000,
    max: 600,           // 600 requests per minute per user — UI polls these frequently during HFT
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many trading requests, please try again later' },
});

const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,            // 10 auth attempts per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later' },
});

app.use('/api', apiLimiter);
app.use('/api/trade', tradingLimiter);
app.use('/api/history', tradingLimiter);

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

    const cppBridge = getSimplxBridge();
    const status = (exchange.ready && dbOk) ? 'ok' : 'degraded';
    res.json({
        status,
        exchange: exchange.ready,
        redis: redisOk,
        database: dbOk,
        positionBookAccounts: riskEngine.book.size,
        cppEngine: cppBridge ? cppBridge.getStatus() : { enabled: false },
        timestamp: Date.now(),
    });
});

// AI-debuggable diagnostics endpoint (public — no auth needed for debugging)
import { getRecentErrors } from './structured-logger.js';

app.get('/api/debug/diagnostics', async (_req, res) => {
    const cppBridge = getSimplxBridge();

    // Collect subsystem statuses
    let dbOk = false;
    try { await prisma.$queryRawUnsafe('SELECT 1'); dbOk = true; } catch { }
    const persistenceRecovery = await getPendingOrderPersistenceRecoveryStats();

    const diag = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),

        // Core services
        exchange: { ready: exchange.ready },
        database: { ok: dbOk },
        positionBook: { accounts: riskEngine.book.size },

        // C++ engine
        cppEngine: cppBridge ? cppBridge.getStatus() : { enabled: false },

        // Event subsystems
        eventPersister: getHandlerStatus(),
        eventRelay: getRelayStatus(),
        persistenceRecovery,

        // Recent errors from the structured logger (last 20)
        recentErrors: getRecentErrors(20),
    };

    res.json(diag);
});

// ── Internal bot callbacks (localhost-only Python babysitter) ──
// Restricted to loopback addresses only
app.post('/api/bot/babysitter/close-position', async (req, res) => {
    // Enforce localhost-only access
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
        console.warn(`[BotAPI] Blocked babysitter call from non-local IP: ${ip}`);
        return res.status(403).json({ error: 'Forbidden — localhost only' });
    }
    try {
        const { positionId, reason } = req.body;
        if (!positionId) {
            return res.status(400).json({ error: 'positionId is required' });
        }
        // V2: close via C++ engine (reduce_only MARKET)
        const { closePositionViaCpp } = await import('./routes/trading/close-utils.js');
        const result = await closePositionViaCpp(positionId, reason || 'BABYSITTER_TP');
        console.log(`[BotAPI] Babysitter close-position: ${positionId} → ${result.success ? 'OK' : 'FAIL'}`);
        res.status(202).json(result);
    } catch (err) {
        console.error('[BotAPI] Babysitter close-position error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Protected routes (require auth) ──────────────
const auth = flexAuthMiddleware();
app.use('/api/sub-accounts', auth, subAccountsRouter);
app.use('/api/risk-rules', auth, riskRulesRouter);
app.use('/api/trade', auth, tradingRouter);
app.use('/api/admin', auth, adminMiddleware, adminRouter);
app.use('/api/bot', auth, botRouter);
app.use('/api/history', historyRouter); // Has its own auth middleware
app.use('/api/tca', auth, tcaRouter);

// ── Binance FAPI proxy (bot-facing) ──────────────
app.use('/fapi', proxyRouter);

// ── Error handling (must be after all routes) ────
app.use(errorHandler);

// Start server
const server = createServer(app);

// Track open sockets so we can force-destroy them on shutdown
const activeSockets = new Set();
server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
});

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
    const t0 = Date.now();
    const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

    try {
        // ── Phase 1: Parallel infrastructure init ─────────────
        // Redis, Exchange, port cleanup, and Prisma warmup have NO cross-dependencies.
        console.log('[Startup] Phase 1 — parallel infra init...');

        const portCleanupPromise = process.env.NODE_ENV !== 'production'
            ? ensurePortFree(PORT) : Promise.resolve();

        const [redisReady, exchangeReady] = await Promise.all([
            initRedis(),
            exchange.initialize({ allowDegraded: true }),
            portCleanupPromise,
            prisma.$queryRawUnsafe('SELECT 1').catch(() => { }), // warm Prisma connection pool
        ]);

        console.log(`[Startup] Phase 1 done (${elapsed()}) — Redis: ${redisReady ? '✓' : '✗'}, Exchange: ${exchangeReady ? '✓' : 'degraded'}`);

        if (!exchangeReady) {
            const reason = exchange.initErrorMessage ? ` (${exchange.initErrorMessage})` : '';
            console.warn(`[Server] Exchange not ready at startup${reason}`);
            console.warn('[Server] Continuing in degraded mode: API stays up, trading endpoints may fail until reconnect.');
        }

        // Start babysitter (disabled by default — set BABYSITTER_ENABLED=1 to activate)
        const babysitterEnabled = process.env.BABYSITTER_ENABLED === '1' || process.env.BABYSITTER_ENABLED === 'true';
        if (redisReady && babysitterEnabled) {
            babysitterActionConsumer.start().catch(err =>
                console.warn('[Server] Babysitter consumer start failed:', err.message));
            babysitterProcess.start();
        } else if (redisReady) {
            console.log('[Server] Babysitter disabled (set BABYSITTER_ENABLED=1 to enable)');
        }

        // Start recovery loop for post-ACK pendingOrder persistence failures
        startPendingOrderPersistenceRecovery();

        // ── Phase 2: Wire up subsystems (fast, sync-ish) ─────
        initProxy(exchange, riskEngine);
        initHistory(exchange);
        // V2: proxy-stream disabled — C++ engine handles user stream natively
        // initProxyStream(server, exchange);

        // V2: Binance user data stream started by C++ engine's WsClientActor
        // import('./proxy-stream.js').then(m => m.startGlobalBinanceStream(exchange));

        // C++ Simplx engine process manager — spawn + babysit the binary
        // Phase 4: skip when process is managed externally (systemd/launchctl)
        const cppExternalProcess = process.env.CPP_EXTERNAL_PROCESS === '1';
        if (cppExternalProcess) {
            console.log('[Startup] C++ process managed externally (CPP_EXTERNAL_PROCESS=1), skipping process manager');
        }
        const cppPM = cppExternalProcess ? null : await startProcessManager();
        if (cppPM?.getStatus().running) {
            // Give C++ engine ~2s to start and connect to Redis before bridge init
            await new Promise(r => setTimeout(r, 2000));
        }

        // C++ Simplx engine bridge (opt-in via CPP_ENGINE_ENABLED=1)
        const simplxBridge = await initSimplxBridge();
        if (simplxBridge) {
            // NOTE: price tick forwarding removed — C++ engine connects to
            // Binance WS directly via MarketDataActor and @bookTicker streams.

            // V2: Initialize clean event handlers (fill, position, rejection)
            initHandlers(simplxBridge, riskEngine);

            // Phase 4: Initialize event relay for live push (CPP_ENGINE_UDS=1)
            initEventRelay(simplxBridge);

            // V2: WAL removed — handlers/ persist events directly
        }

        // ── Phase 3: Parallel core engine startup ────────────
        // Risk engine + bot manager are independent — run concurrently.
        console.log(`[Startup] Phase 3 — parallel engine startup (${elapsed()})...`);

        const engineStartTasks = [
            riskEngine.startMonitoring(30000),
            botManager.initialize(),
        ];
        // If C++ bridge is connected, bootstrap accounts in parallel
        if (simplxBridge?.isHealthy()) {
            engineStartTasks.push(
                simplxBridge.bootstrapAccounts().catch(err =>
                    console.warn('[Server] C++ engine bootstrap failed:', err.message))
            );
        }
        await Promise.all(engineStartTasks);

        // V2: Reconciler and sync loops removed — C++ engine is single source of truth
        console.log('[Server] V2 mode — reconciler/sync loops disabled (C++ is SSOT)');

        console.log(`[Startup] Phase 3 done (${elapsed()})`);

        // ── Phase 4: Listen ASAP ─────────────────────────────
        // Get the server accepting connections before resuming background state.
        server.listen(PORT, () => {
            const listenTime = elapsed();
            console.log(`\n🚀 PMS Prop Trading Server running on http://localhost:${PORT} (startup: ${listenTime})`);
            console.log(`📡 WebSocket on ws://localhost:${PORT}/ws`);
            console.log(`📡 Proxy Stream on ws://localhost:${PORT}/ws/user-stream`);
            console.log(`📊 API at http://localhost:${PORT}/api`);
            console.log(`🤖 Bot API at http://localhost:${PORT}/api/bot`);
            console.log(`🔌 FAPI Proxy at http://localhost:${PORT}/fapi\n`);
        });

        // ── Phase 5: Background state restoration ────────────
        // Non-critical: resume active orders from Redis in parallel.
        // Server is already accepting connections at this point.
        if (redisReady) {
            console.log(`[Startup] Phase 5 — parallel state resume (${elapsed()})...`);

            // All 4 resume functions are independent — run concurrently
            const [twapResult, trailResult, chaseResult] = await Promise.allSettled([
                resumeActiveTwaps(),
                resumeActiveTrailStops(),
                resumeActiveChaseOrders(),
            ]);

            // Log any failures
            if (twapResult.status === 'rejected') console.warn('[Server] TWAP resume failed:', twapResult.reason?.message);
            if (trailResult.status === 'rejected') console.warn('[Server] Trail stop resume failed:', trailResult.reason?.message);
            if (chaseResult.status === 'rejected') console.warn('[Server] Chase resume failed:', chaseResult.reason?.message);

            // Start cleanup intervals (non-blocking)
            initTrailStopCleanup();
            initChaseCleanup();


            // ── Purge stale scalper state ──────────────────────
            // Scalpers are NOT auto-resumed — clean up orphaned Redis keys + DB orders concurrently.
            const { getRedis } = await import('./redis.js');
            const r = getRedis();

            await Promise.allSettled([
                // Purge stale Redis keys (SCAN-based, non-blocking)
                (async () => {
                    if (!r) return;
                    const scalperKeys = [];
                    await new Promise((resolve, reject) => {
                        const stream = r.scanStream({ match: 'pms:scalper:*', count: 100 });
                        stream.on('data', (batch) => scalperKeys.push(...batch));
                        stream.on('end', resolve);
                        stream.on('error', reject);
                    });
                    if (scalperKeys.length > 0) {
                        const pipe = r.pipeline();
                        scalperKeys.forEach(k => pipe.del(k));
                        await pipe.exec();
                        console.log(`[Server] Purged ${scalperKeys.length} stale scalper Redis key(s)`);
                    }
                })(),
                // Mark stale SCALPER_LIMIT pendingOrders as CANCELLED
                (async () => {
                    const { count } = await prisma.pendingOrder.updateMany({
                        where: { type: 'SCALPER_LIMIT', status: 'PENDING' },
                        data: { status: 'CANCELLED', cancelledAt: new Date() },
                    });
                    if (count > 0) {
                        console.log(`[Server] Marked ${count} stale SCALPER_LIMIT pendingOrder(s) as CANCELLED`);
                    }
                })(),
                // Mark stale CHASE_LIMIT pendingOrders as CANCELLED
                (async () => {
                    const { count } = await prisma.pendingOrder.updateMany({
                        where: { type: 'CHASE_LIMIT', status: 'PENDING' },
                        data: { status: 'CANCELLED', cancelledAt: new Date() },
                    });
                    if (count > 0) {
                        console.log(`[Server] Marked ${count} stale CHASE_LIMIT pendingOrder(s) as CANCELLED`);
                    }
                })(),
            ]).catch(() => { });

            console.log(`[Startup] Phase 5 done (${elapsed()})`);
        }

        console.log(`[Startup] ✅ Full startup complete in ${elapsed()}`);
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();

// ── Graceful shutdown ────────────────────────────────
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;          // prevent re-entrance from repeated SIGINTs
    shuttingDown = true;
    console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);
    try {
        // Stop babysitter first and WAIT for child process to die
        await babysitterProcess.stop();
        await babysitterActionConsumer.stop();
        stopPendingOrderPersistenceRecovery();
        await stopAllAgents();
        await shutdownSimplxBridge();
        shutdownHandlers();
        if (process.env.CPP_EXTERNAL_PROCESS !== '1') await stopProcessManager();
        riskEngine.stopMonitoring();
        await botManager.shutdown();
        exchange.destroy();
        await closeRedis();
        await disconnectPrisma();
        // Force-destroy all open sockets so server.close() resolves immediately
        for (const socket of activeSockets) {
            socket.destroy();
        }
        activeSockets.clear();
        // Wait for the HTTP server (and its WS upgrade listeners) to fully close
        await new Promise((resolve) => {
            server.close(() => resolve());
            // Safety net: force-exit after 1s if something still hangs
            setTimeout(resolve, 1000);
        });
    } catch (err) {
        console.error('[Shutdown] Error during cleanup:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon fallback
