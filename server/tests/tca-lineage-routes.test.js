import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import prisma from '../db/prisma.js';
import tcaRouter from '../routes/trading/tca.js';

function matchFrontierEdges(whereOr, edges) {
    const parentFrontier = new Set(
        whereOr
            .filter((entry) => entry.parentNodeType && entry.parentNodeId)
            .map((entry) => `${entry.parentNodeType}:${entry.parentNodeId}`),
    );
    const childFrontier = new Set(
        whereOr
            .filter((entry) => entry.childNodeType && entry.childNodeId)
            .map((entry) => `${entry.childNodeType}:${entry.childNodeId}`),
    );
    return edges.filter((edge) =>
        parentFrontier.has(`${edge.parentNodeType}:${edge.parentNodeId}`)
        || childFrontier.has(`${edge.childNodeType}:${edge.childNodeId}`));
}

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

test('GET /trade/tca/lineage returns recursive graph scoped to requested sub-account', { concurrency: false }, async () => {
    const originalQueryRaw = prisma.$queryRaw;
    const edges = [
        {
            subAccountId: 'sub-1',
            parentNodeType: 'STRATEGY_SESSION',
            parentNodeId: 'scalper-1',
            childNodeType: 'STRATEGY_SESSION',
            childNodeId: 'chase-1',
            relationType: 'SPAWNS_SESSION',
            sourceEventId: 'e-1',
            sourceTs: new Date('2026-03-05T10:00:00.000Z'),
            ingestedTs: new Date('2026-03-05T10:00:00.010Z'),
            createdAt: new Date('2026-03-05T10:00:00.010Z'),
        },
        {
            subAccountId: 'sub-1',
            parentNodeType: 'STRATEGY_SESSION',
            parentNodeId: 'chase-1',
            childNodeType: 'ORDER_LIFECYCLE',
            childNodeId: 'lc-1',
            relationType: 'SUBMITS_ORDER',
            sourceEventId: 'e-2',
            sourceTs: new Date('2026-03-05T10:00:01.000Z'),
            ingestedTs: new Date('2026-03-05T10:00:01.010Z'),
            createdAt: new Date('2026-03-05T10:00:01.010Z'),
        },
        {
            subAccountId: 'sub-2',
            parentNodeType: 'STRATEGY_SESSION',
            parentNodeId: 'foreign-scalper',
            childNodeType: 'ORDER_LIFECYCLE',
            childNodeId: 'foreign-lc',
            relationType: 'SUBMITS_ORDER',
            sourceEventId: 'e-x',
            sourceTs: new Date('2026-03-05T10:00:02.000Z'),
            ingestedTs: new Date('2026-03-05T10:00:02.010Z'),
            createdAt: new Date('2026-03-05T10:00:02.010Z'),
        },
    ];
    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        assert.ok(sql.includes('WITH RECURSIVE'));
        assert.equal(query.values.includes('sub-1'), true);
        return edges
            .filter((edge) => edge.subAccountId === 'sub-1')
            .map(({ subAccountId, ...row }) => row);
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/lineage/sub-1/STRATEGY_SESSION/scalper-1`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.truncated, false);
            assert.equal(payload.stats.rootNodeType, 'STRATEGY_SESSION');
            assert.equal(payload.stats.rootNodeId, 'scalper-1');
            assert.equal(payload.edges.length, 2);
            const nodeIds = new Set(payload.nodes.map((node) => node.nodeId));
            assert.ok(nodeIds.has('scalper-1'));
            assert.ok(nodeIds.has('chase-1'));
            assert.ok(nodeIds.has('lc-1'));
            assert.ok(!nodeIds.has('foreign-lc'));
        });
    } finally {
        prisma.$queryRaw = originalQueryRaw;
    }
});

test('GET /trade/tca/lifecycle includes lineageGraph for lifecycle detail', { concurrency: false }, async () => {
    const originalQueryRaw = prisma.$queryRaw;
    const originalFindFirst = prisma.orderLifecycle.findFirst;

    const edges = [
        {
            subAccountId: 'sub-1',
            parentNodeType: 'ORDER_LIFECYCLE',
            parentNodeId: 'lc-1',
            childNodeType: 'FILL_FACT',
            childNodeId: 'fill-1',
            relationType: 'GENERATES_FILL',
            sourceEventId: 'e-fill',
            sourceTs: new Date('2026-03-05T10:00:03.000Z'),
            ingestedTs: new Date('2026-03-05T10:00:03.010Z'),
            createdAt: new Date('2026-03-05T10:00:03.010Z'),
        },
    ];

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        assert.ok(sql.includes('WITH RECURSIVE'));
        assert.equal(query.values.includes('sub-1'), true);
        return edges.map(({ subAccountId, ...row }) => row);
    };
    prisma.orderLifecycle.findFirst = async ({ where }) => {
        assert.equal(where.id, 'lc-1');
        assert.equal(where.subAccountId, 'sub-1');
        return {
            id: 'lc-1',
            subAccountId: 'sub-1',
            executionScope: 'SUB_ACCOUNT',
            ownershipConfidence: 'HARD',
            originPath: 'PYTHON_CMD',
            strategyType: 'CHASE',
            strategySessionId: 'chase-1',
            parentId: 'chase-1',
            clientOrderId: 'coid-1',
            exchangeOrderId: 'oid-1',
            symbol: 'BTCUSDT',
            side: 'SELL',
            orderType: 'LIMIT',
            orderRole: 'UNWIND',
            reduceOnly: true,
            requestedQty: 1,
            limitPrice: 100,
            decisionBid: 99.9,
            decisionAsk: 100.1,
            decisionMid: 100,
            decisionSpreadBps: 20,
            intentTs: new Date('2026-03-05T10:00:00.000Z'),
            ackTs: new Date('2026-03-05T10:00:00.100Z'),
            firstFillTs: null,
            doneTs: null,
            finalStatus: null,
            filledQty: 0,
            avgFillPrice: null,
            repriceCount: 0,
            reconciliationStatus: 'PENDING',
            reconciliationReason: null,
            updatedAt: new Date('2026-03-05T10:00:00.200Z'),
            strategySession: null,
            events: [],
            fillFacts: [],
        };
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/lifecycle/sub-1/lc-1`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.ok(payload.lineageGraph);
            assert.equal(payload.lineageGraph.truncated, false);
            assert.equal(payload.lineageGraph.edges.length, 1);
            assert.equal(payload.lineageGraph.edges[0].relationType, 'GENERATES_FILL');
            assert.equal(payload.orderRole, 'UNWIND');
        });
    } finally {
        prisma.$queryRaw = originalQueryRaw;
        prisma.orderLifecycle.findFirst = originalFindFirst;
    }
});
