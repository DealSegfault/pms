/**
 * ws-proxy.js — WebSocket server with Redis PUB/SUB event forwarding.
 *
 * PROXY VERSION: Instead of wiring to riskEngine directly, subscribes to
 * Redis pms:events:* channels from Python engine and forwards to clients.
 *
 * Supports two subscription modes:
 *   1. PMS events (default) — normalized events scoped by subAccountId
 *   2. User stream — raw Binance user data events (for bot consumers)
 *
 * Auth: JWT token OR API key (X-PMS-Key style, passed in subscribe message)
 */
import { WebSocketServer } from 'ws';
import prisma from './db/prisma.js';
import { verifyToken, lookupApiKey } from './auth.js';
import { subscribeToPmsEvents } from './redis-proxy.js';

let wss = null;

// ── Indexed routing: O(1) lookup by subAccountId ──
const subAccountSockets = new Map();
// ── User stream subscribers (raw Binance events) ──
const userStreamSockets = new Set();

function indexSocket(ws, subAccountId) {
    if (!subAccountSockets.has(subAccountId)) {
        subAccountSockets.set(subAccountId, new Set());
    }
    subAccountSockets.get(subAccountId).add(ws);
}

function unindexSocket(ws) {
    if (ws.subscribedAccount) {
        const sockets = subAccountSockets.get(ws.subscribedAccount);
        if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) subAccountSockets.delete(ws.subscribedAccount);
        }
    }
    userStreamSockets.delete(ws);
}

// ── Backpressure-safe send ──
const MAX_BUFFER_BYTES = 1024 * 1024;

function safeSend(ws, message) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFER_BYTES) {
        console.warn('[WS] Client too slow, terminating');
        ws.terminate();
        return;
    }
    ws.send(message);
}

export function initWebSocket(server) {
    wss = new WebSocketServer({ server, path: '/ws' });

    // Wire up Redis PUB/SUB → broadcast (replaces riskEngine.setWsEmitter)
    subscribeToPmsEvents(broadcast).catch(err => {
        console.error('[WS] Redis event subscription failed:', err.message);
    });

    wss.on('connection', (ws) => {
        console.log('[WS] Client connected');

        ws.isAlive = true;
        ws.userId = null;
        ws.subscribedAccount = null;
        ws.subscribedUserStream = false;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'subscribe') {
                    const subAccountId = msg.subAccountId || null;
                    const token = msg.token || null;
                    const apiKey = msg.apiKey || null;
                    const streamType = msg.streamType || 'pms'; // 'pms' or 'user_stream'

                    // ── Auth: JWT token ──
                    if (token) {
                        const payload = verifyToken(token);
                        if (payload) {
                            ws.userId = payload.id;
                            ws.userRole = payload.role;
                        }
                    }

                    // ── Auth: API key (for bots) ──
                    if (!ws.userId && apiKey) {
                        try {
                            const user = await lookupApiKey(apiKey);
                            if (user && user.status === 'APPROVED') {
                                ws.userId = user.id;
                                ws.userRole = user.role;
                            } else {
                                ws.send(JSON.stringify({ type: 'error', message: 'Invalid or unapproved API key' }));
                            }
                        } catch (err) {
                            console.error('[WS] API key lookup error:', err.message);
                            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
                        }
                    }

                    // ── Subscribe to user stream (raw Binance events) ──
                    if (streamType === 'user_stream' && ws.userId) {
                        userStreamSockets.add(ws);
                        ws.subscribedUserStream = true;
                        ws.send(JSON.stringify({ type: 'subscribed', streamType: 'user_stream' }));
                        console.log(`[WS] Client subscribed to user_stream (userId: ${ws.userId})`);
                    }

                    // ── Subscribe to PMS events (scoped by subAccountId) ──
                    if (subAccountId && ws.userId) {
                        unindexSocket(ws);

                        if (ws.userRole === 'ADMIN') {
                            ws.subscribedAccount = subAccountId;
                            indexSocket(ws, subAccountId);
                        } else {
                            const account = await prisma.subAccount.findUnique({
                                where: { id: subAccountId },
                                select: { userId: true },
                            });
                            if (account && account.userId === ws.userId) {
                                ws.subscribedAccount = subAccountId;
                                indexSocket(ws, subAccountId);
                            } else {
                                ws.send(JSON.stringify({ type: 'error', message: 'Not authorized for this account' }));
                            }
                        }
                    } else if (subAccountId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Authentication token required' }));
                    }
                }
            } catch { }
        });

        ws.on('close', () => {
            unindexSocket(ws);
            console.log('[WS] Client disconnected');
        });

        ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    // Heartbeat
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => clearInterval(heartbeat));

    console.log('[WS] WebSocket server started (proxy mode)');
}

function broadcast(type, data) {
    if (!wss) return;

    // ── User stream events: forward raw to user_stream subscribers ──
    if (type === 'user_stream') {
        if (userStreamSockets.size === 0) return;
        const message = JSON.stringify({ type: 'user_stream_event', data, timestamp: Date.now() });
        console.log(`[WS] ▶ user_stream → ${userStreamSockets.size} bot clients`);
        for (const ws of userStreamSockets) {
            safeSend(ws, message);
        }
        return;
    }

    // ── PMS events: route by subAccountId ──
    const message = JSON.stringify({ type, data, timestamp: Date.now() });

    if (data.subAccountId) {
        const sockets = subAccountSockets.get(data.subAccountId);
        const count = sockets ? sockets.size : 0;
        console.log(`[WS] ▶ ${type} → account:${data.subAccountId.slice(0, 8)}… (${count} clients)`);
        if (sockets) {
            for (const ws of sockets) {
                safeSend(ws, message);
            }
        }
    } else {
        console.log(`[WS] ▶ ${type} → ALL (${wss.clients.size} clients)`);
        for (const ws of wss.clients) {
            safeSend(ws, message);
        }
    }
}

export { broadcast };

