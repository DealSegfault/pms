import { WebSocketServer } from 'ws';
import prisma from './db/prisma.js';
import riskEngine from './risk/index.js';
import botManager from './bot/manager.js';
import { verifyToken } from './auth.js';


let wss = null;

// ── Indexed routing: O(1) lookup by subAccountId ──
const subAccountSockets = new Map(); // subAccountId → Set<WebSocket>

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
}

// ── Backpressure-safe send ──
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

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

    // Wire up the risk engine's WS emitter
    riskEngine.setWsEmitter(broadcast);

    // Wire up the bot manager's WS emitter for live scanner
    botManager.setWsEmitter(broadcast);

    wss.on('connection', (ws) => {
        console.log('[WS] Client connected');

        ws.isAlive = true;
        ws.userId = null;           // Set after auth
        ws.subscribedAccount = null; // Set after subscribe
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'subscribe') {
                    const subAccountId = msg.subAccountId || null;
                    const token = msg.token || null;

                    // Validate auth token
                    if (token) {
                        const payload = verifyToken(token);
                        if (payload) {
                            ws.userId = payload.id;
                            ws.userRole = payload.role;
                        }
                    }

                    // If we have a userId, validate ownership of the subAccount
                    if (subAccountId && ws.userId) {
                        // Remove from previous subscription index
                        unindexSocket(ws);

                        if (ws.userRole === 'ADMIN') {
                            // Admins can subscribe to any account
                            ws.subscribedAccount = subAccountId;
                            indexSocket(ws, subAccountId);
                        } else {
                            // Regular users: verify they own this sub-account
                            const account = await prisma.subAccount.findUnique({
                                where: { id: subAccountId },
                                select: { userId: true },
                            });
                            if (account && account.userId === ws.userId) {
                                ws.subscribedAccount = subAccountId;
                                indexSocket(ws, subAccountId);
                            } else {
                                console.warn(`[WS] User ${ws.userId} tried to subscribe to unowned account ${subAccountId}`);
                                ws.send(JSON.stringify({ type: 'error', message: 'Not authorized for this account' }));
                            }
                        }
                    } else if (subAccountId) {
                        // No auth token provided — reject subscription
                        ws.send(JSON.stringify({ type: 'error', message: 'Authentication token required' }));
                    }
                }
            } catch { }
        });

        ws.on('close', () => {
            unindexSocket(ws);
            console.log('[WS] Client disconnected');
        });

        // Send welcome
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

    console.log('[WS] WebSocket server started');
}

function broadcast(type, data) {
    if (!wss) return;
    const message = JSON.stringify({ type, data, timestamp: Date.now() });

    if (data.subAccountId) {
        // Targeted broadcast: O(1) lookup + O(subscribers)
        const sockets = subAccountSockets.get(data.subAccountId);
        if (sockets) {
            for (const ws of sockets) {
                safeSend(ws, message);
            }
        }
    } else {
        // Global broadcast (rare — no subAccountId)
        for (const ws of wss.clients) {
            safeSend(ws, message);
        }
    }
}

export { broadcast };

