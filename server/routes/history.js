/**
 * Segregated History Routes.
 * Provides per-sub-account order/trade history with cursor-based pagination,
 * matching the v7 BinanceHistorySyncService backfill pattern.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { flexAuthMiddleware } from '../auth.js';
import { validate } from '../middleware/validate.js';
import { HistoryQuery, AllHistoryQuery, BackfillBody, SubAccountIdParam } from '../contracts/history.contracts.js';

const router = Router();

let exchange = null;
export function initHistory(exchangeModule) {
    exchange = exchangeModule;
}

// Auth for all routes
router.use(flexAuthMiddleware());

// ── GET /api/history/orders/:subAccountId ──

router.get('/orders/:subAccountId', validate(SubAccountIdParam, 'params'), validate(HistoryQuery, 'query'), async (req, res) => {
    try {
        const { subAccountId } = req.params;
        const { symbol, limit, startTime, endTime, offset, cursor } = req.query;

        // Verify ownership (admin can see all)
        if (req.user.role !== 'ADMIN') {
            const sa = await prisma.subAccount.findFirst({
                where: { id: subAccountId, userId: req.user.id },
            });
            if (!sa) return res.status(403).json({ error: 'Not authorized' });
        }

        const where = { subAccountId };
        if (symbol) where.symbol = symbol;
        if (startTime || endTime) {
            where.timestamp = {};
            if (startTime) where.timestamp.gte = new Date(startTime);
            if (endTime) where.timestamp.lte = new Date(endTime);
        }
        // Cursor-based pagination: fetch records older than the cursor ID
        if (cursor) {
            where.id = { lt: cursor };
        }

        const take = Math.min(limit, 1000);
        const trades = await prisma.tradeExecution.findMany({
            where,
            ...(cursor ? {} : { skip: offset || 0 }),
            take,
            orderBy: { timestamp: 'desc' },
        });

        const nextCursor = trades.length === take && trades.length > 0
            ? trades[trades.length - 1].id
            : null;

        res.json({
            orders: trades,
            count: trades.length,
            hasMore: trades.length === take,
            nextCursor,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/history/trades/:subAccountId ──

router.get('/trades/:subAccountId', validate(SubAccountIdParam, 'params'), validate(HistoryQuery, 'query'), async (req, res) => {
    try {
        const { subAccountId } = req.params;
        const { symbol, limit, startTime, endTime, cursor } = req.query;

        if (req.user.role !== 'ADMIN') {
            const sa = await prisma.subAccount.findFirst({
                where: { id: subAccountId, userId: req.user.id },
            });
            if (!sa) return res.status(403).json({ error: 'Not authorized' });
        }

        const where = {
            subAccountId,
            status: 'FILLED',
        };
        if (symbol) where.symbol = symbol;
        if (startTime || endTime) {
            where.timestamp = {};
            if (startTime) where.timestamp.gte = new Date(startTime);
            if (endTime) where.timestamp.lte = new Date(endTime);
        }
        // Cursor-based pagination
        if (cursor) {
            where.id = { lt: cursor };
        }

        const take = Math.min(limit, 1000);
        const trades = await prisma.tradeExecution.findMany({
            where,
            take,
            orderBy: { timestamp: 'desc' },
            include: {
                position: { select: { id: true, symbol: true, side: true, entryPrice: true } },
            },
        });

        const nextCursor = trades.length === take && trades.length > 0
            ? trades[trades.length - 1].id
            : null;

        res.json({
            trades,
            count: trades.length,
            hasMore: trades.length === take,
            nextCursor,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/history/backfill/:subAccountId ──
// Fetches historical orders from Binance and tags them with the sub-account.
// Uses cursor-based pagination matching v7's BinanceHistorySyncService.

router.post('/backfill/:subAccountId', validate(SubAccountIdParam, 'params'), validate(BackfillBody), async (req, res) => {
    try {
        const { subAccountId } = req.params;
        const { symbols, days } = req.body;

        // Admin only
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const sa = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!sa) return res.status(404).json({ error: 'Sub-account not found' });

        const prefix = subAccountId.substring(0, 8);
        const startMs = Date.now() - days * 86400 * 1000;
        const endMs = Date.now();

        let totalImported = 0;
        const symbolList = symbols || ['BTC/USDT:USDT'];

        for (const symbol of symbolList) {
            // ── Phase 1: Backfill from fetchOrders (order-level data) ──
            let cursor = startMs;
            let pageGuard = 0;

            while (pageGuard++ < 500) {
                try {
                    const orders = await exchange.fetchOrders(symbol, cursor, 500);
                    if (!orders || orders.length === 0) break;

                    // Filter only PMS-tagged orders for this sub-account
                    const filtered = orders.filter(o => {
                        const ts = o.timestamp || 0;
                        const clientId = o.clientOrderId || '';
                        return ts >= startMs && ts <= endMs && clientId.startsWith(`PMS${prefix}`);
                    });

                    const orderIds = filtered.map((o) => String(o.id));
                    if (orderIds.length > 0) {
                        const existingRows = await prisma.tradeExecution.findMany({
                            where: { exchangeOrderId: { in: orderIds } },
                            select: { exchangeOrderId: true },
                        });
                        const existingIds = new Set(existingRows.map((r) => r.exchangeOrderId));

                        const rows = [];
                        for (const order of filtered) {
                            const orderId = String(order.id);
                            if (existingIds.has(orderId) || !(order.filled > 0)) continue;

                            // Infer action from side rather than just reduceOnly
                            const side = order.side?.toUpperCase() || 'BUY';
                            let action = 'OPEN';
                            if (order.reduceOnly) {
                                action = 'CLOSE';
                            } else if (side === 'SELL') {
                                action = 'CLOSE'; // Sells are typically closes for longs
                            }

                            rows.push({
                                subAccountId,
                                exchangeOrderId: orderId,
                                clientOrderId: order.clientOrderId,
                                symbol,
                                side,
                                type: order.type?.toUpperCase() || 'MARKET',
                                price: order.average || order.price || 0,
                                quantity: order.filled,
                                notional: (order.average || order.price || 0) * order.filled,
                                fee: order.fee?.cost || 0,
                                action,
                                originType: 'BOT',
                                status: 'FILLED',
                                signature: `backfill_${order.id}_${subAccountId}`.substring(0, 32),
                                timestamp: new Date(order.timestamp),
                            });
                            existingIds.add(orderId);
                        }

                        if (rows.length > 0) {
                            await prisma.tradeExecution.createMany({ data: rows });
                            totalImported += rows.length;
                        }
                    }

                    // Advance cursor
                    const maxTs = Math.max(...orders.map(o => o.timestamp || 0));
                    if (maxTs <= cursor) break;
                    cursor = maxTs + 1;
                    if (cursor > endMs) break;
                    if (orders.length < 500) break;

                } catch (err) {
                    console.error(`[History] Backfill fetchOrders error for ${symbol}:`, err.message);
                    break;
                }
            }

            // ── Phase 2: Backfill from fetchMyTrades (trade-level data — catches fills missed by fetchOrders) ──
            let tradeCursor = startMs;
            let tradePageGuard = 0;

            while (tradePageGuard++ < 500) {
                try {
                    const trades = await exchange.fetchMyTrades(symbol, tradeCursor, 500);
                    if (!trades || trades.length === 0) break;

                    const filtered = trades.filter(t => {
                        const ts = t.timestamp || 0;
                        return ts >= startMs && ts <= endMs;
                    });

                    // Deduplicate against existing records by exchangeOrderId
                    const tradeOrderIds = filtered.map(t => String(t.order || t.id));
                    if (tradeOrderIds.length > 0) {
                        const existingRows = await prisma.tradeExecution.findMany({
                            where: { exchangeOrderId: { in: tradeOrderIds } },
                            select: { exchangeOrderId: true },
                        });
                        const existingIds = new Set(existingRows.map(r => r.exchangeOrderId));

                        const rows = [];
                        for (const trade of filtered) {
                            const orderId = String(trade.order || trade.id);
                            if (existingIds.has(orderId)) continue;
                            if (!(trade.amount > 0)) continue;

                            const side = trade.side?.toUpperCase() || 'BUY';
                            const action = side === 'SELL' ? 'CLOSE' : 'OPEN';

                            rows.push({
                                subAccountId,
                                exchangeOrderId: orderId,
                                symbol,
                                side,
                                type: trade.type?.toUpperCase() || 'MARKET',
                                price: trade.price || 0,
                                quantity: trade.amount,
                                notional: (trade.price || 0) * trade.amount,
                                fee: trade.fee?.cost || 0,
                                action,
                                originType: 'BOT',
                                status: 'FILLED',
                                signature: `backfill_trade_${trade.id}_${subAccountId}`.substring(0, 32),
                                timestamp: new Date(trade.timestamp),
                            });
                            existingIds.add(orderId);
                        }

                        if (rows.length > 0) {
                            await prisma.tradeExecution.createMany({ data: rows });
                            totalImported += rows.length;
                        }
                    }

                    // Advance cursor
                    const maxTs = Math.max(...trades.map(t => t.timestamp || 0));
                    if (maxTs <= tradeCursor) break;
                    tradeCursor = maxTs + 1;
                    if (tradeCursor > endMs) break;
                    if (trades.length < 500) break;

                } catch (err) {
                    console.error(`[History] Backfill fetchMyTrades error for ${symbol}:`, err.message);
                    break;
                }
            }
        }

        res.json({
            subAccountId,
            imported: totalImported,
            days,
            symbols: symbolList,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/history/all — Admin: all orders across all sub-accounts ──

router.get('/all', validate(AllHistoryQuery, 'query'), async (req, res) => {
    try {
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { limit, offset } = req.query;

        const trades = await prisma.tradeExecution.findMany({
            skip: offset,
            take: Math.min(limit, 1000),
            orderBy: { timestamp: 'desc' },
            include: {
                subAccount: { select: { id: true, name: true, type: true } },
            },
        });

        res.json({
            orders: trades,
            count: trades.length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/history/exposure — Admin: overall exposure by user/bot ──

router.get('/exposure', async (req, res) => {
    try {
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin only' });
        }

        // Server-side aggregation — single SQL query instead of N+1 JS loops
        const rows = await prisma.$queryRaw`
            SELECT
                sa.id              AS "subAccountId",
                sa.name,
                sa.type,
                sa.user_id         AS "userId",
                u.username,
                sa.current_balance AS "balance",
                COALESCE(SUM(vp.notional), 0)::float AS "totalExposure",
                COALESCE(SUM(vp.margin), 0)::float   AS "totalMargin",
                COUNT(vp.id)::int                     AS "positionCount"
            FROM sub_accounts sa
            LEFT JOIN users u ON u.id = sa.user_id
            LEFT JOIN virtual_positions vp ON vp.sub_account_id = sa.id AND vp.status = 'OPEN'
            GROUP BY sa.id, sa.name, sa.type, sa.user_id, u.username, sa.current_balance
        `;

        // Fetch per-account open positions for the detail payload
        const openPositions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN' },
            select: { subAccountId: true, symbol: true, side: true, notional: true, margin: true, leverage: true },
        });
        const posByAccount = new Map();
        for (const p of openPositions) {
            if (!posByAccount.has(p.subAccountId)) posByAccount.set(p.subAccountId, []);
            posByAccount.get(p.subAccountId).push(p);
        }

        const exposure = rows.map(a => ({
            ...a,
            positions: posByAccount.get(a.subAccountId) || [],
        }));

        const globalExposure = rows.reduce((s, a) => s + a.totalExposure, 0);
        const globalMargin = rows.reduce((s, a) => s + a.totalMargin, 0);

        res.json({
            globalExposure,
            globalMargin,
            accounts: exposure,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
