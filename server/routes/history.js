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
        const { symbol, limit, startTime, endTime, offset } = req.query;

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

        const trades = await prisma.tradeExecution.findMany({
            where,
            skip: offset,
            take: Math.min(limit, 1000),
            orderBy: { timestamp: 'desc' },
        });

        res.json({
            orders: trades,
            count: trades.length,
            hasMore: trades.length === limit,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/history/trades/:subAccountId ──

router.get('/trades/:subAccountId', validate(SubAccountIdParam, 'params'), validate(HistoryQuery, 'query'), async (req, res) => {
    try {
        const { subAccountId } = req.params;
        const { symbol, limit, startTime, endTime } = req.query;

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

        const trades = await prisma.tradeExecution.findMany({
            where,
            take: Math.min(limit, 1000),
            orderBy: { timestamp: 'desc' },
            include: {
                position: { select: { id: true, symbol: true, side: true, entryPrice: true } },
            },
        });

        res.json({
            trades,
            count: trades.length,
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

        let totalOrders = 0;
        const symbolList = symbols || ['BTC/USDT:USDT'];

        for (const symbol of symbolList) {
            let cursor = startMs;
            let pageGuard = 0;

            while (pageGuard++ < 500) {
                try {
                    const orders = await exchange.exchange.fetchOrders(symbol, cursor, 500);
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

                            rows.push({
                                subAccountId,
                                exchangeOrderId: orderId,
                                clientOrderId: order.clientOrderId,
                                symbol,
                                side: order.side?.toUpperCase() || 'BUY',
                                type: order.type?.toUpperCase() || 'MARKET',
                                price: order.average || order.price || 0,
                                quantity: order.filled,
                                notional: (order.average || order.price || 0) * order.filled,
                                fee: order.fee?.cost || 0,
                                action: order.reduceOnly ? 'CLOSE' : 'OPEN',
                                originType: 'BOT',
                                status: 'FILLED',
                                signature: `backfill_${order.id}_${subAccountId}`.substring(0, 32),
                                timestamp: new Date(order.timestamp),
                            });
                            existingIds.add(orderId);
                        }

                        if (rows.length > 0) {
                            await prisma.tradeExecution.createMany({ data: rows });
                            totalOrders += rows.length;
                        }
                    }

                    // Advance cursor
                    const maxTs = Math.max(...orders.map(o => o.timestamp || 0));
                    if (maxTs <= cursor) break;
                    cursor = maxTs + 1;
                    if (cursor > endMs) break;
                    if (orders.length < 500) break;

                } catch (err) {
                    console.error(`[History] Backfill error for ${symbol}:`, err.message);
                    break;
                }
            }
        }

        res.json({
            subAccountId,
            imported: totalOrders,
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

        const accounts = await prisma.subAccount.findMany({
            include: {
                user: { select: { id: true, username: true } },
                positions: {
                    where: { status: 'OPEN' },
                    select: { symbol: true, side: true, notional: true, margin: true, leverage: true },
                },
            },
        });

        const exposure = accounts.map(a => ({
            subAccountId: a.id,
            name: a.name,
            type: a.type,
            userId: a.userId,
            username: a.user?.username || null,
            balance: a.currentBalance,
            positions: a.positions,
            totalExposure: a.positions.reduce((s, p) => s + p.notional, 0),
            totalMargin: a.positions.reduce((s, p) => s + p.margin, 0),
            positionCount: a.positions.length,
        }));

        const globalExposure = exposure.reduce((s, a) => s + a.totalExposure, 0);
        const globalMargin = exposure.reduce((s, a) => s + a.totalMargin, 0);

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
