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

test('GET /trade/tca/strategy-rollups batches lifecycle enrichment and tolerates missing strategySessionId rows', { concurrency: false }, async () => {
    const originalRollupFindMany = prisma.strategyTcaRollup.findMany;

    prisma.strategyTcaRollup.findMany = async ({ where }) => {
        assert.equal(where.subAccountId, 'sub-1');
        return [
            {
                id: 'r1',
                strategySessionId: 'sess-1',
                subAccountId: 'sub-1',
                strategyType: 'SCALPER',
                executionScope: 'SUB_ACCOUNT',
                ownershipConfidence: 'HARD',
                orderCount: 3,
                terminalOrderCount: 3,
                fillCount: 2,
                cancelCount: 1,
                rejectCount: 0,
                totalRequestedQty: 10,
                totalFilledQty: 6,
                totalFillNotional: 600,
                fillRatio: 0.6,
                cancelToFillRatio: 0.5,
                avgArrivalSlippageBps: 2,
                avgAckLatencyMs: 30,
                avgWorkingTimeMs: 120,
                avgMarkout1sBps: -1,
                avgMarkout5sBps: -2,
                avgMarkout30sBps: -3,
                qualityByRoleJson: '{"ADD":{"lifecycleCount":1,"fillCount":1,"avgArrivalSlippageBps":100,"avgMarkout1sBps":-1,"avgMarkout5sBps":-2,"avgMarkout30sBps":-3,"toxicityScore":1.7}}',
                totalRepriceCount: 0,
                createdAt: new Date('2026-03-05T10:00:00.000Z'),
                updatedAt: new Date('2026-03-05T10:00:00.000Z'),
            },
            {
                id: 'r2',
                strategySessionId: 'sess-2',
                subAccountId: 'sub-1',
                strategyType: 'CHASE',
                executionScope: 'SUB_ACCOUNT',
                ownershipConfidence: 'HARD',
                orderCount: 2,
                terminalOrderCount: 2,
                fillCount: 1,
                cancelCount: 0,
                rejectCount: 0,
                totalRequestedQty: 4,
                totalFilledQty: 4,
                totalFillNotional: 400,
                fillRatio: 1,
                cancelToFillRatio: 0,
                avgArrivalSlippageBps: -1,
                avgAckLatencyMs: 20,
                avgWorkingTimeMs: 80,
                avgMarkout1sBps: 1,
                avgMarkout5sBps: 2,
                avgMarkout30sBps: 3,
                qualityByRoleJson: '{"UNWIND":{"lifecycleCount":1,"fillCount":1,"avgArrivalSlippageBps":100,"avgMarkout1sBps":0.5,"avgMarkout5sBps":1.5,"avgMarkout30sBps":2.5,"toxicityScore":20.1}}',
                totalRepriceCount: 0,
                createdAt: new Date('2026-03-05T10:00:00.000Z'),
                updatedAt: new Date('2026-03-05T10:00:00.000Z'),
            },
            {
                id: 'r3',
                strategySessionId: '',
                subAccountId: 'sub-1',
                strategyType: 'TWAP',
                executionScope: 'SUB_ACCOUNT',
                ownershipConfidence: 'HARD',
                orderCount: 0,
                terminalOrderCount: 0,
                fillCount: 0,
                cancelCount: 0,
                rejectCount: 0,
                totalRequestedQty: 0,
                totalFilledQty: 0,
                totalFillNotional: 0,
                fillRatio: null,
                cancelToFillRatio: null,
                avgArrivalSlippageBps: null,
                avgAckLatencyMs: null,
                avgWorkingTimeMs: null,
                avgMarkout1sBps: null,
                avgMarkout5sBps: null,
                avgMarkout30sBps: null,
                qualityByRoleJson: null,
                totalRepriceCount: 0,
                createdAt: new Date('2026-03-05T10:00:00.000Z'),
                updatedAt: new Date('2026-03-05T10:00:00.000Z'),
            },
        ];
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-rollups/sub-1?executionScope=SUB_ACCOUNT&ownershipConfidence=HARD`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.length, 3);
            const sess1 = payload.find((row) => row.strategySessionId === 'sess-1');
            const sess2 = payload.find((row) => row.strategySessionId === 'sess-2');
            const empty = payload.find((row) => row.strategySessionId === '');
            assert.ok(sess1.avgMarkout1sBpsByRole.ADD !== undefined);
            assert.ok(sess2.avgMarkout1sBpsByRole.UNWIND !== undefined);
            assert.deepEqual(empty.avgMarkout1sBpsByRole, {});
        });
    } finally {
        prisma.strategyTcaRollup.findMany = originalRollupFindMany;
    }
});
