/**
 * Proxied User Data WebSocket Stream.
 *
 * PMS maintains ONE connection to the real Binance user data stream.
 * Bot clients connect to ws://pms/ws/user-stream?key=<apiKey>
 * Events are routed to the correct sub-account by checking clientOrderId prefix.
 */

import WebSocket, { WebSocketServer } from 'ws';
import prisma from './db/prisma.js';
import crypto from 'crypto';
import { getOrderMapping, acquireReconcileLock, releaseReconcileLock } from './redis.js';
import { markReconciled } from './position-sync.js';
import riskEngine from './risk/index.js';
import { handleExchangeOrderUpdate } from './order-sync.js';
import { isRecentlyClosed } from './recent-close.js';



let binanceWs = null;
let binanceListenKey = null;
let keepaliveInterval = null;
const clientConnections = new Map(); // connId → { ws, userId, subAccountId, subAccountPrefix }
const prefixIndex = new Map();       // subAccountPrefix → Set<connId> — O(1) routing
const recentFills = new Map(); // symbol → { price, timestamp } — for reconciliation
const MAX_RECENT_FILLS = 500;

let exchangeRef = null;

export function initProxyStream(httpServer, exchange) {
    exchangeRef = exchange;
    const wss = new WebSocketServer({ noServer: true });

    // Handle upgrade for /ws/user-stream
    httpServer.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== '/ws/user-stream') return;

        const apiKey = url.searchParams.get('key');
        if (!apiKey) {
            socket.destroy();
            return;
        }

        // Validate API key
        const user = await prisma.user.findUnique({ where: { apiKey } });
        if (!user || user.status !== 'APPROVED') {
            socket.destroy();
            return;
        }

        // Find user's active sub-account
        const subAccountId = url.searchParams.get('subaccount');
        let sa;
        if (subAccountId) {
            sa = await prisma.subAccount.findFirst({
                where: { id: subAccountId, userId: user.id, status: 'ACTIVE' },
            });
        } else {
            sa = await prisma.subAccount.findFirst({
                where: { userId: user.id, status: 'ACTIVE' },
                orderBy: { createdAt: 'asc' },
            });
        }

        if (!sa) {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            const connId = crypto.randomBytes(8).toString('hex');
            const subAccountPrefix = sa.id.substring(0, 8);

            clientConnections.set(connId, {
                ws,
                userId: user.id,
                subAccountId: sa.id,
                subAccountPrefix,
                username: user.username,
            });

            // Maintain prefix → connId index for O(1) routing
            if (!prefixIndex.has(subAccountPrefix)) prefixIndex.set(subAccountPrefix, new Set());
            prefixIndex.get(subAccountPrefix).add(connId);

            console.log(`[ProxyStream] Client connected: ${user.username} → ${sa.name} (${connId})`);

            ws.on('close', () => {
                // Clean up prefix index
                const entry = clientConnections.get(connId);
                if (entry) {
                    const set = prefixIndex.get(entry.subAccountPrefix);
                    if (set) {
                        set.delete(connId);
                        if (set.size === 0) prefixIndex.delete(entry.subAccountPrefix);
                    }
                }
                clientConnections.delete(connId);
                console.log(`[ProxyStream] Client disconnected: ${connId}`);
            });

            ws.on('message', (msg) => {
                // Handle pings from client
                try {
                    const data = JSON.parse(msg);
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                    }
                } catch { }
            });

            // Ensure Binance stream is running
            ensureBinanceStream(exchange);
        });
    });

    // Auto-start Binance user stream on server boot
    ensureBinanceStream(exchange);

    return wss;
}

async function ensureBinanceStream(exchange) {
    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) return;

    try {
        // Create listen key via exchange
        const fapi = exchange._fapi_base || 'https://fapi.binance.com';
        const apiKey = exchange.exchange.apiKey;

        const response = await fetch(`${fapi}/fapi/v1/listenKey`, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': apiKey },
        });
        const data = await response.json();
        binanceListenKey = data.listenKey;

        if (!binanceListenKey) {
            console.error('[ProxyStream] Failed to get listen key');
            return;
        }

        const wsUrl = `wss://fstream.binance.com/ws/${binanceListenKey}`;
        binanceWs = new WebSocket(wsUrl);

        binanceWs.on('open', () => {
            console.log('[ProxyStream] ✓ Connected to Binance user stream');
        });

        binanceWs.on('message', async (rawMsg) => {
            try {
                const event = JSON.parse(rawMsg.toString());
                await routeEvent(event);
            } catch (err) {
                console.error('[ProxyStream] Parse error:', err.message);
            }
        });

        binanceWs.on('close', () => {
            console.log('[ProxyStream] Binance stream disconnected, reconnecting...');
            binanceWs = null;
            setTimeout(() => ensureBinanceStream(exchange), 3000);
        });

        binanceWs.on('error', (err) => {
            console.error('[ProxyStream] WS error:', err.message);
        });

        // Keepalive every 30min
        if (keepaliveInterval) clearInterval(keepaliveInterval);
        keepaliveInterval = setInterval(async () => {
            try {
                await fetch(`${fapi}/fapi/v1/listenKey`, {
                    method: 'PUT',
                    headers: { 'X-MBX-APIKEY': apiKey },
                });
            } catch { }
        }, 30 * 60 * 1000);

    } catch (err) {
        console.error('[ProxyStream] Failed to start Binance stream:', err.message);
    }
}

/**
 * Route a Binance user stream event to the correct sub-account client.
 * Uses clientOrderId prefix matching.
 * Also handles position sync when exchange positions are closed externally.
 */
async function routeEvent(event) {
    const eventType = event.e;

    if (eventType === 'ORDER_TRADE_UPDATE') {
        const o = event.o || {};
        const clientOrderId = o.c || '';
        const orderId = String(o.i || '');
        const orderStatus = String(o.X || o.x || '').toUpperCase();

        // Capture fill price for reconciliation
        if (o.X === 'FILLED' || o.x === 'TRADE') {
            const rawSymbol = o.s; // e.g. BTCUSDT
            const fillPrice = parseFloat(o.ap || o.L || o.p); // average price, last fill price, or order price
            if (rawSymbol && fillPrice) {
                // Convert to ccxt format: BTCUSDT → BTC/USDT:USDT
                const base = rawSymbol.replace('USDT', '');
                const ccxtSymbol = `${base}/USDT:USDT`;
                // Bound recentFills to prevent memory creep
                if (recentFills.size >= MAX_RECENT_FILLS) {
                    const oldest = recentFills.keys().next().value;
                    recentFills.delete(oldest);
                }
                recentFills.set(ccxtSymbol, { price: fillPrice, timestamp: Date.now(), side: o.S });
            }
        }

        // Try clientOrderId prefix match
        let targetPrefix = null;
        if (clientOrderId.startsWith('PMS')) {
            const parts = clientOrderId.split('_');
            targetPrefix = parts[0].substring(3); // 8-char prefix
        }

        // Also check Redis mapping
        if (!targetPrefix && orderId) {
            const mapping = await getOrderMapping(orderId);
            if (mapping) {
                targetPrefix = mapping.subAccountId.substring(0, 8);
            }
        }

        if (orderId && orderStatus) {
            handleExchangeOrderUpdate({
                orderId,
                status: orderStatus,
                avgPrice: parseFloat(o.ap || o.L || o.p),
                price: parseFloat(o.L || o.p),
                filledQty: parseFloat(o.z || o.l || o.q),
            }).catch((err) => {
                console.warn(`[ProxyStream] Fast order-sync failed for ${orderId}:`, err.message);
            });
        }

        // Route to matching client(s) via O(1) prefix index
        if (targetPrefix) {
            const connIds = prefixIndex.get(targetPrefix);
            if (connIds) {
                for (const cid of connIds) {
                    const conn = clientConnections.get(cid);
                    if (conn?.ws.readyState === WebSocket.OPEN) {
                        const enriched = {
                            ...event,
                            _pms: {
                                subAccountId: conn.subAccountId,
                                username: conn.username,
                                owned: true,
                            },
                        };
                        conn.ws.send(JSON.stringify(enriched));
                    }
                }
            }
        }
    } else if (eventType === 'ACCOUNT_UPDATE') {
        const accountData = event.a || {};
        const positionUpdates = accountData.P || [];

        // Check for positions closed on exchange (amount went to 0)
        for (const posUpdate of positionUpdates) {
            const posAmount = parseFloat(posUpdate.pa || '0');
            const rawSymbol = posUpdate.s; // e.g. BTCUSDT

            if (posAmount === 0 && rawSymbol) {
                // Position closed on exchange — reconcile virtual positions
                const base = rawSymbol.replace('USDT', '');
                const ccxtSymbol = `${base}/USDT:USDT`;

                // Get close price from recent fills or mark price
                let closePrice = recentFills.get(ccxtSymbol)?.price;
                if (!closePrice && exchangeRef) {
                    closePrice = exchangeRef.getLatestPrice(ccxtSymbol);
                }

                if (closePrice) {
                    // Skip if another path already closed this symbol
                    if (isRecentlyClosed(ccxtSymbol)) {
                        console.log(`[ProxyStream] Skipping reconcile for ${ccxtSymbol} — recently closed by another path`);
                        continue;
                    }
                    console.log(`[ProxyStream] Position ${ccxtSymbol} closed on exchange @ $${closePrice} — reconciling`);
                    try {
                        if (!await acquireReconcileLock(ccxtSymbol)) {
                            console.log(`[ProxyStream] Skipping reconcile for ${ccxtSymbol} — lock held by another path`);
                            continue;
                        }
                        try {
                            await riskEngine.reconcilePosition(ccxtSymbol, closePrice);
                            markReconciled(ccxtSymbol); // Prevent position-sync from re-reconciling
                        } finally {
                            await releaseReconcileLock(ccxtSymbol);
                        }
                    } catch (err) {
                        console.error(`[ProxyStream] Reconciliation failed for ${ccxtSymbol}:`, err.message);
                    }
                }
            }
        }

        // Broadcast to all connected clients
        for (const [, conn] of clientConnections) {
            if (conn.ws.readyState !== WebSocket.OPEN) continue;
            conn.ws.send(JSON.stringify({
                ...event,
                _pms: {
                    subAccountId: conn.subAccountId,
                    username: conn.username,
                },
            }));
        }
    } else if (eventType === 'TRADE_LITE') {
        const clientOrderId = event.c || '';
        let targetPrefix = null;
        if (clientOrderId.startsWith('PMS')) {
            const parts = clientOrderId.split('_');
            targetPrefix = parts[0].substring(3);
        }

        // O(1) prefix routing for TRADE_LITE
        if (targetPrefix) {
            const connIds = prefixIndex.get(targetPrefix);
            if (connIds) {
                for (const cid of connIds) {
                    const conn = clientConnections.get(cid);
                    if (conn?.ws.readyState === WebSocket.OPEN) {
                        conn.ws.send(JSON.stringify({
                            ...event,
                            _pms: { subAccountId: conn.subAccountId, owned: true },
                        }));
                    }
                }
            }
        }
    }
}

export function closeProxyStream() {
    if (binanceWs) {
        binanceWs.close();
        binanceWs = null;
    }
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
    for (const [, conn] of clientConnections) {
        conn.ws.close();
    }
    clientConnections.clear();
    prefixIndex.clear();
}
export { ensureBinanceStream };
