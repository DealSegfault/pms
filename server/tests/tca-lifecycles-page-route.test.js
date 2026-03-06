import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import prisma from '../db/prisma.js';
import tcaRouter from '../routes/trading/tca.js';

async function withTestServer(run) {
    const app = express();
    app.use((req, _res, next) => {
        req.user = { id: 'admin-user', role: 'ADMIN' };
        next();
    });
    app.use('/trade', tcaRouter);

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await run(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('GET /trade/tca/lifecycles-page returns paginated lifecycle envelope with metadata', { concurrency: false }, async () => {
    const originalCount = prisma.orderLifecycle.count;
    const originalFindMany = prisma.orderLifecycle.findMany;

    prisma.orderLifecycle.count = async ({ where }) => {
        assert.equal(where.subAccountId, 'sub-1');
        assert.equal(where.executionScope, 'SUB_ACCOUNT');
        assert.equal(where.ownershipConfidence, 'HARD');
        assert.equal(where.symbol, 'BTCUSDT');
        assert.equal(where.finalStatus, 'FILLED');
        return 63;
    };

    prisma.orderLifecycle.findMany = async ({ skip, take, orderBy, where }) => {
        assert.equal(skip, 50);
        assert.equal(take, 25);
        assert.deepEqual(orderBy, { updatedAt: 'desc' });
        assert.equal(where.subAccountId, 'sub-1');
        return [
            {
                id: 'lc-1',
                subAccountId: 'sub-1',
                executionScope: 'SUB_ACCOUNT',
                ownershipConfidence: 'HARD',
                originPath: 'PYTHON_CMD',
                strategyType: 'SCALPER',
                strategySessionId: 'sess-1',
                parentId: 'sess-1',
                clientOrderId: 'coid-1',
                exchangeOrderId: 'oid-1',
                symbol: 'BTCUSDT',
                side: 'BUY',
                orderType: 'LIMIT',
                orderRole: 'ADD',
                reduceOnly: false,
                requestedQty: 1,
                limitPrice: 100,
                decisionBid: 99,
                decisionAsk: 101,
                decisionMid: 100,
                decisionSpreadBps: 200,
                intentTs: new Date('2026-03-05T10:00:00.000Z'),
                ackTs: new Date('2026-03-05T10:00:00.050Z'),
                firstFillTs: new Date('2026-03-05T10:00:00.060Z'),
                doneTs: new Date('2026-03-05T10:00:00.150Z'),
                finalStatus: 'FILLED',
                filledQty: 1,
                avgFillPrice: 101,
                repriceCount: 0,
                reconciliationStatus: 'LIVE',
                reconciliationReason: null,
                updatedAt: new Date('2026-03-05T10:00:00.200Z'),
                _count: { events: 4, fillFacts: 1 },
                fillFacts: [
                    {
                        markouts: [
                            { horizonMs: 1000, markoutBps: 2.1 },
                            { horizonMs: 5000, markoutBps: 1.4 },
                        ],
                    },
                ],
            },
        ];
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/lifecycles-page/sub-1?page=3&pageSize=25&executionScope=SUB_ACCOUNT&ownershipConfidence=HARD&symbol=btcusdt&finalStatus=filled`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.page, 3);
            assert.equal(payload.pageSize, 25);
            assert.equal(payload.total, 63);
            assert.equal(payload.totalPages, 3);
            assert.equal(payload.hasPrev, true);
            assert.equal(payload.hasNext, false);
            assert.equal(payload.items.length, 1);
            assert.equal(payload.items[0].lifecycleId, 'lc-1');
            assert.equal(payload.items[0].orderRole, 'ADD');
            assert.equal(payload.items[0].avgMarkout1sBps, 2.1);
            assert.equal(payload.items[0].avgMarkout5sBps, 1.4);
            assert.equal(payload.items[0].lineageStatus, 'COMPLETE');
        });
    } finally {
        prisma.orderLifecycle.count = originalCount;
        prisma.orderLifecycle.findMany = originalFindMany;
    }
});
