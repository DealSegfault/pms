import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import prisma from '../db/prisma.js';
import tcaRouter from '../routes/trading/tca.js';
import {
    __resetRuntimeMemorySnapshotProviderForTests,
    __setRuntimeMemorySnapshotProviderForTests,
} from '../runtime-metrics.js';

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

test('GET /trade/tca/strategy-sessions-page returns root-session cards with runtime/economic fields', { concurrency: false }, async () => {
    const originalQueryRaw = prisma.$queryRaw;

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        if (sql.includes('SELECT COUNT(*) AS "total"')) {
            return [{ total: 1 }];
        }
        if (sql.includes('LEFT JOIN LATERAL (') && sql.includes('strategy_session_param_samples p')) {
            return [{
                strategySessionId: 'scalper-1',
                subAccountId: 'sub-1',
                strategyType: 'CHASE',
                sessionRole: 'ROOT',
                symbol: 'BTCUSDT',
                side: 'LONG',
                startedAt: new Date('2026-03-05T10:00:00.000Z'),
                sessionUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                rollupStrategySessionId: 'scalper-1',
                rollupSubAccountId: 'sub-1',
                rollupStrategyType: 'CHASE',
                rollupLevel: 'ROOT',
                rollupExecutionScope: 'SUB_ACCOUNT',
                rollupOwnershipConfidence: 'HARD',
                qualityByRoleJson: '{}',
                rollupFillCount: 3,
                rollupCloseCount: 1,
                rollupRealizedPnl: 12,
                rollupUnrealizedPnl: 3,
                rollupNetPnl: 15,
                rollupFeesTotal: 1,
                rollupOpenQty: 0.5,
                rollupOpenNotional: 50,
                rollupWinCount: 1,
                rollupLossCount: 0,
                rollupWinRate: 1,
                rollupAvgArrivalSlippageBps: 1,
                rollupAvgMarkout1sBps: 2,
                rollupAvgMarkout5sBps: 1,
                rollupAvgMarkout30sBps: 0.5,
                rollupTotalRepriceCount: 0,
                rollupUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                runtimeStrategySessionId: 'scalper-1',
                runtimeSubAccountId: 'sub-1',
                runtimeStrategyType: 'CHASE',
                runtimeStatus: 'ACTIVE',
                runtimeResumePolicy: 'RECREATE_CHILD_ORDERS',
                runtimeUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                latestPnlSampledAt: new Date('2026-03-05T10:05:00.000Z'),
                latestPnlRealizedPnl: 12,
                latestPnlUnrealizedPnl: 3,
                latestPnlNetPnl: 15,
                latestPnlFeesTotal: 1,
                latestPnlOpenQty: 0.5,
                latestPnlOpenNotional: 50,
                latestPnlFillCount: 3,
                latestPnlCloseCount: 1,
                latestPnlWinCount: 1,
                latestPnlLossCount: 0,
                latestParamSampledAt: new Date('2026-03-05T10:05:00.000Z'),
                latestParamPauseReasonsJson: '{"price_filter":1}',
                sortUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                sortStartedAt: new Date('2026-03-05T10:00:00.000Z'),
                sortNetPnl: 15,
                sortRealizedPnl: 12,
                sortFillCount: 3,
                sortToxicityScore: 0.9,
            }];
        }
        if (sql.includes('WHERE ranked.rn <= 20')) {
            return [
                { strategySessionId: 'scalper-1', sampledAt: new Date('2026-03-05T10:04:55.000Z'), netPnl: 14 },
                { strategySessionId: 'scalper-1', sampledAt: new Date('2026-03-05T10:05:00.000Z'), netPnl: 15 },
            ];
        }
        if (sql.includes('WITH unknown_roles AS')) {
            return [{
                strategySessionId: 'scalper-1',
                unknownRoleCount: 1,
                unknownLineageCount: 1,
                sessionPnlAnomalyCount: 1,
            }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-sessions-page/sub-1?page=1&pageSize=25`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.items.length, 1);
            assert.equal(payload.items[0].strategySessionId, 'scalper-1');
            assert.equal(payload.items[0].runtimeStatus, 'ACTIVE');
            assert.equal(payload.items[0].strategyType, 'SCALPER');
            assert.equal(payload.items[0].netPnl, 15);
            assert.equal(payload.items[0].hasAnomaly, true);
            assert.equal(payload.items[0].sparkline.length, 2);
        });
    } finally {
        prisma.$queryRaw = originalQueryRaw;
    }
});

test('GET /trade/tca/strategy-sessions-page falls back when quality_by_role_json is not yet migrated', { concurrency: false }, async () => {
    const originalQueryRaw = prisma.$queryRaw;

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        if (sql.includes('SELECT COUNT(*) AS "total"')) {
            return [{ total: 1 }];
        }
        if (sql.includes('LEFT JOIN LATERAL (') && sql.includes('quality_by_role_json')) {
            throw new Error('column r.quality_by_role_json does not exist');
        }
        if (sql.includes('LEFT JOIN LATERAL (') && sql.includes('NULL AS "qualityByRoleJson"')) {
            return [{
                strategySessionId: 'scalper-legacy',
                subAccountId: 'sub-1',
                strategyType: 'SCALPER',
                sessionRole: 'ROOT',
                symbol: 'BTCUSDT',
                side: 'LONG',
                startedAt: new Date('2026-03-05T10:00:00.000Z'),
                sessionUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                rollupStrategySessionId: 'scalper-legacy',
                rollupSubAccountId: 'sub-1',
                rollupStrategyType: 'SCALPER',
                rollupLevel: 'ROOT',
                rollupExecutionScope: 'SUB_ACCOUNT',
                rollupOwnershipConfidence: 'HARD',
                qualityByRoleJson: null,
                rollupFillCount: 4,
                rollupCloseCount: 2,
                rollupRealizedPnl: 10,
                rollupUnrealizedPnl: 1,
                rollupNetPnl: 11,
                rollupFeesTotal: 0.5,
                rollupOpenQty: 0,
                rollupOpenNotional: 0,
                rollupWinCount: 2,
                rollupLossCount: 0,
                rollupWinRate: 1,
                rollupAvgArrivalSlippageBps: 0.5,
                rollupAvgMarkout1sBps: 1.2,
                rollupAvgMarkout5sBps: 0.8,
                rollupAvgMarkout30sBps: 0.4,
                rollupTotalRepriceCount: 0,
                rollupUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                runtimeStrategySessionId: 'scalper-legacy',
                runtimeSubAccountId: 'sub-1',
                runtimeStrategyType: 'SCALPER',
                runtimeStatus: 'ACTIVE',
                runtimeResumePolicy: 'RECREATE_CHILD_ORDERS',
                runtimeUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                latestPnlSampledAt: new Date('2026-03-05T10:05:00.000Z'),
                latestPnlRealizedPnl: 10,
                latestPnlUnrealizedPnl: 1,
                latestPnlNetPnl: 11,
                latestPnlFeesTotal: 0.5,
                latestPnlOpenQty: 0,
                latestPnlOpenNotional: 0,
                latestPnlFillCount: 4,
                latestPnlCloseCount: 2,
                latestPnlWinCount: 2,
                latestPnlLossCount: 0,
                latestParamSampledAt: new Date('2026-03-05T10:05:00.000Z'),
                latestParamPauseReasonsJson: '{}',
                sortUpdatedAt: new Date('2026-03-05T10:05:00.000Z'),
                sortStartedAt: new Date('2026-03-05T10:00:00.000Z'),
                sortNetPnl: 11,
                sortRealizedPnl: 10,
                sortFillCount: 4,
                sortToxicityScore: 0.4,
            }];
        }
        if (sql.includes('WHERE ranked.rn <= 20')) {
            return [
                { strategySessionId: 'scalper-legacy', sampledAt: new Date('2026-03-05T10:04:55.000Z'), netPnl: 10 },
                { strategySessionId: 'scalper-legacy', sampledAt: new Date('2026-03-05T10:05:00.000Z'), netPnl: 11 },
            ];
        }
        if (sql.includes('WITH unknown_roles AS')) {
            return [{
                strategySessionId: 'scalper-legacy',
                unknownRoleCount: 0,
                unknownLineageCount: 0,
                sessionPnlAnomalyCount: 0,
            }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-sessions-page/sub-1?page=1&pageSize=25`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.items.length, 1);
            assert.equal(payload.items[0].strategySessionId, 'scalper-legacy');
            assert.equal(payload.items[0].netPnl, 11);
            assert.equal(payload.items[0].sparkline.length, 2);
        });
    } finally {
        prisma.$queryRaw = originalQueryRaw;
    }
});

test('GET /trade/tca/strategy-session returns root detail with lineage/runtime/anomaly blocks', { concurrency: false }, async () => {
    const originals = {
        queryRaw: prisma.$queryRaw,
        strategySessionFindFirst: prisma.strategySession.findFirst,
        strategyRollupFindFirst: prisma.strategyTcaRollup.findFirst,
        runtimeFindUnique: prisma.algoRuntimeSession.findUnique,
        pnlFindFirst: prisma.strategySessionPnlSample.findFirst,
        paramFindFirst: prisma.strategySessionParamSample.findFirst,
    };

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        if (sql.includes('WITH unknown_roles AS')) {
            return [{
                strategySessionId: 'scalper-1',
                unknownRoleCount: 1,
                unknownLineageCount: 2,
                sessionPnlAnomalyCount: 1,
            }];
        }
        if (sql.includes('WITH RECURSIVE')) {
            return [{
                parentNodeType: 'STRATEGY_SESSION',
                parentNodeId: 'scalper-1',
                childNodeType: 'ORDER_LIFECYCLE',
                childNodeId: 'lc-1',
                relationType: 'SUBMITS_ORDER',
                createdAt: new Date('2026-03-05T10:00:00.000Z'),
                sourceEventId: null,
                sourceTs: null,
                ingestedTs: null,
            }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    prisma.strategySession.findFirst = async () => ({
        id: 'scalper-1',
        subAccountId: 'sub-1',
        origin: 'SCALPER',
        strategyType: 'SCALPER',
        rootStrategySessionId: 'scalper-1',
        sessionRole: 'ROOT',
        symbol: 'BTCUSDT',
        side: 'LONG',
        startedAt: new Date('2026-03-05T10:00:00.000Z'),
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
        _count: { lifecycles: 3, rollups: 1 },
    });
    prisma.strategyTcaRollup.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        subAccountId: 'sub-1',
        strategyType: 'CHASE',
        rollupLevel: 'ROOT',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        fillCount: 3,
        realizedPnl: 12,
        unrealizedPnl: 3,
        netPnl: 15,
        avgArrivalSlippageBps: 1,
        avgMarkout1sBps: -1,
        avgMarkout5sBps: -2,
        avgMarkout30sBps: -3,
        qualityByRoleJson: '{"ADD":{"lifecycleCount":1,"fillCount":1,"avgArrivalSlippageBps":100,"avgMarkout1sBps":-1,"avgMarkout5sBps":-2,"avgMarkout30sBps":-3,"toxicityScore":1.7}}',
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
    });
    prisma.algoRuntimeSession.findUnique = async () => ({
        strategySessionId: 'scalper-1',
        subAccountId: 'sub-1',
        strategyType: 'CHASE',
        status: 'ACTIVE',
        resumePolicy: 'RECREATE_CHILD_ORDERS',
        latestCheckpointId: 'scalper-1:10',
        initialConfigJson: '{"childCount":2}',
        currentConfigJson: '{"childCount":2}',
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
    });
    prisma.strategySessionPnlSample.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        sampledAt: new Date('2026-03-05T10:05:00.000Z'),
        netPnl: 15,
        realizedPnl: 12,
        unrealizedPnl: 3,
    });
    prisma.strategySessionParamSample.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        sampledAt: new Date('2026-03-05T10:05:00.000Z'),
        sampleReason: 'HEARTBEAT',
        pauseReasonsJson: '{"price_filter":1}',
    });

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-session/sub-1/scalper-1`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.strategySession.strategySessionId, 'scalper-1');
            assert.equal(payload.strategySession.strategyType, 'SCALPER');
            assert.equal(payload.runtime.status, 'ACTIVE');
            assert.equal(payload.rollup.rollupLevel, 'ROOT');
            assert.equal(payload.rollup.strategyType, 'SCALPER');
            assert.equal(payload.anomalyCounts.unknownRoleCount, 1);
            assert.equal(payload.anomalyCounts.unknownLineageCount, 2);
            assert.ok(payload.qualityByRole.ADD);
            assert.equal(payload.lineageGraph.edges.length, 1);
        });
    } finally {
        prisma.$queryRaw = originals.queryRaw;
        prisma.strategySession.findFirst = originals.strategySessionFindFirst;
        prisma.strategyTcaRollup.findFirst = originals.strategyRollupFindFirst;
        prisma.algoRuntimeSession.findUnique = originals.runtimeFindUnique;
        prisma.strategySessionPnlSample.findFirst = originals.pnlFindFirst;
        prisma.strategySessionParamSample.findFirst = originals.paramFindFirst;
    }
});

test('GET /trade/tca/strategy-session-timeseries and lot-ledger expose chart/ledger payloads', { concurrency: false }, async () => {
    const originals = {
        databaseUrl: process.env.DATABASE_URL,
        pnlFindMany: prisma.strategySessionPnlSample.findMany,
        paramFindMany: prisma.strategySessionParamSample.findMany,
        checkpointCount: prisma.algoRuntimeCheckpoint.count,
        checkpointFindMany: prisma.algoRuntimeCheckpoint.findMany,
        fillFactFindMany: prisma.fillFact.findMany,
        positionLotFindMany: prisma.strategyPositionLot.findMany,
        lotRealizationFindMany: prisma.strategyLotRealization.findMany,
        tcaAnomaly: prisma.tcaAnomaly,
    };
    process.env.DATABASE_URL = 'file:test.db';

    prisma.strategySessionPnlSample.findMany = async () => ([
        { strategySessionId: 'scalper-1', sampledAt: new Date('2026-03-05T10:00:04.000Z'), netPnl: 2, realizedPnl: 1, unrealizedPnl: 1, openQty: 1, openNotional: 101, feesTotal: 0.2, fillCount: 2, closeCount: 1 },
        { strategySessionId: 'scalper-1', sampledAt: new Date('2026-03-05T10:00:01.000Z'), netPnl: 1, realizedPnl: 1, unrealizedPnl: 0, openQty: 1, openNotional: 100, feesTotal: 0.1, fillCount: 1, closeCount: 0 },
    ]);
    prisma.strategySessionParamSample.findMany = async () => ([
        { strategySessionId: 'scalper-1', sampledAt: new Date('2026-03-05T10:00:02.000Z'), longOffsetPct: 0.2, shortOffsetPct: 0.3, skew: 1, longActiveSlots: 1, shortActiveSlots: 0, longPausedSlots: 0, shortPausedSlots: 1, longRetryingSlots: 0, shortRetryingSlots: 1, minFillSpreadPct: 0.1, minRefillDelayMs: 1000, maxLossPerCloseBps: 50 },
    ]);
    prisma.algoRuntimeCheckpoint.count = async () => 1;
    prisma.algoRuntimeCheckpoint.findMany = async () => ([
        { checkpointTs: new Date('2026-03-05T10:00:03.000Z'), checkpointReason: 'PAUSE', status: 'ACTIVE', checkpointSeq: 7 },
    ]);
    prisma.fillFact.findMany = async () => ([
        {
            fillTs: new Date('2026-03-05T10:00:04.000Z'),
            markouts: [
                { horizonMs: 1000, markoutBps: 1 },
                { horizonMs: 5000, markoutBps: 2 },
                { horizonMs: 30000, markoutBps: 3 },
            ],
            lifecycle: {
                orderRole: 'UNWIND',
                side: 'SELL',
                decisionMid: 100,
                avgFillPrice: 99,
            },
        },
    ]);
    prisma.strategyPositionLot.findMany = async () => ([{
        id: 'lot-1',
        subAccountId: 'sub-1',
        rootStrategySessionId: 'scalper-1',
        sourceStrategySessionId: 'chase-1',
        symbol: 'BTCUSDT',
        positionSide: 'LONG',
        openedTs: new Date('2026-03-05T10:00:00.000Z'),
        openQty: 2,
        remainingQty: 1,
        openPrice: 100,
        openFee: 0.5,
        status: 'OPEN',
    }]);
    prisma.strategyLotRealization.findMany = async () => ([{
        id: 'real-1',
        lotId: 'lot-1',
        subAccountId: 'sub-1',
        rootStrategySessionId: 'scalper-1',
        sourceStrategySessionId: 'chase-1',
        closeFillFactId: 'fill-1',
        realizedTs: new Date('2026-03-05T10:00:04.000Z'),
        allocatedQty: 1,
        openPrice: 100,
        closePrice: 110,
        grossRealizedPnl: 10,
        openFeeAllocated: 0.25,
        closeFeeAllocated: 0.25,
        netRealizedPnl: 9.5,
    }]);
    prisma.tcaAnomaly = {
        ...(originals.tcaAnomaly || {}),
        findMany: async () => ([{
            id: 'anom-1',
            anomalyKey: 'UNMATCHED_CLOSE_QTY:fill-1',
            lifecycleId: 'lc-1',
            sourceTs: new Date('2026-03-05T10:00:05.000Z'),
            status: 'OPEN',
            severity: 'WARN',
            payloadJson: '{"reason":"UNMATCHED_CLOSE_QTY"}',
        }]),
    };

    try {
        await withTestServer(async (baseUrl) => {
            const [timeseriesRes, ledgerRes] = await Promise.all([
                fetch(`${baseUrl}/trade/tca/strategy-session-timeseries/sub-1/scalper-1?series=pnl,params,quality,exposure&includeEvents=1&from=2026-03-05T10:00:00.000Z&to=2026-03-05T10:00:10.000Z&bucketMs=5000`),
                fetch(`${baseUrl}/trade/tca/strategy-session-lot-ledger/sub-1/scalper-1`),
            ]);
            assert.equal(timeseriesRes.status, 200);
            assert.equal(ledgerRes.status, 200);
            const timeseries = await timeseriesRes.json();
            const ledger = await ledgerRes.json();
            assert.equal(timeseries.series.pnl.length, 1);
            assert.equal(timeseries.series.pnl[0].netPnl, 2);
            assert.equal(timeseries.series.params.length, 1);
            assert.equal(timeseries.series.quality.length, 1);
            assert.equal(timeseries.events.items.length, 1);
            assert.equal(timeseries.events.page, 1);
            assert.equal(timeseries.effectiveBucketMs, 5000);
            assert.equal(timeseries.pointCount, 1);
            assert.equal(timeseries.truncated, false);
            assert.equal(timeseries.range.defaultedWindow, false);
            assert.equal(ledger.openLots.length, 1);
            assert.equal(ledger.realizations.length, 1);
            assert.equal(ledger.anomalies.length, 1);
            assert.equal(ledger.anomalies[0].payload.reason, 'UNMATCHED_CLOSE_QTY');
        });
    } finally {
        process.env.DATABASE_URL = originals.databaseUrl;
        prisma.strategySessionPnlSample.findMany = originals.pnlFindMany;
        prisma.strategySessionParamSample.findMany = originals.paramFindMany;
        prisma.algoRuntimeCheckpoint.count = originals.checkpointCount;
        prisma.algoRuntimeCheckpoint.findMany = originals.checkpointFindMany;
        prisma.fillFact.findMany = originals.fillFactFindMany;
        prisma.strategyPositionLot.findMany = originals.positionLotFindMany;
        prisma.strategyLotRealization.findMany = originals.lotRealizationFindMany;
        if (originals.tcaAnomaly === undefined) {
            delete prisma.tcaAnomaly;
        } else {
            prisma.tcaAnomaly = originals.tcaAnomaly;
        }
    }
});

test('GET /trade/tca/embed-summary returns compact score-card, badge, and sparkline payloads', { concurrency: false }, async () => {
    const originals = {
        subRollupFindFirst: prisma.subAccountTcaRollup.findFirst,
        runtimeFindFirst: prisma.algoRuntimeSession.findFirst,
        strategySessionFindFirst: prisma.strategySession.findFirst,
        strategyRollupFindFirst: prisma.strategyTcaRollup.findFirst,
        pnlFindMany: prisma.strategySessionPnlSample.findMany,
    };

    prisma.subAccountTcaRollup.findFirst = async () => ({
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        fillCount: 9,
        realizedPnl: 20,
        unrealizedPnl: 5,
        netPnl: 25,
        feesTotal: 1.5,
        avgArrivalSlippageBps: 1,
        avgMarkout1sBps: -2,
        avgMarkout5sBps: -1,
        qualityByRoleJson: '{"ADD":{"lifecycleCount":3,"fillCount":3,"avgArrivalSlippageBps":1,"avgMarkout1sBps":-2,"avgMarkout5sBps":-1,"avgMarkout30sBps":0,"toxicityScore":1.7}}',
        updatedAt: new Date('2026-03-05T10:10:00.000Z'),
    });
    prisma.algoRuntimeSession.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        subAccountId: 'sub-1',
        strategyType: 'SCALPER',
        status: 'ACTIVE',
        resumePolicy: 'RECREATE_CHILD_ORDERS',
        updatedAt: new Date('2026-03-05T10:10:00.000Z'),
    });
    prisma.strategySession.findFirst = async () => ({
        id: 'scalper-1',
        subAccountId: 'sub-1',
        strategyType: 'SCALPER',
        symbol: 'BTCUSDT',
        side: 'LONG',
        updatedAt: new Date('2026-03-05T10:09:00.000Z'),
    });
    prisma.strategyTcaRollup.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        strategyType: 'SCALPER',
        netPnl: 15,
        updatedAt: new Date('2026-03-05T10:09:30.000Z'),
    });
    prisma.strategySessionPnlSample.findMany = async () => ([
        { sampledAt: new Date('2026-03-05T10:09:00.000Z'), netPnl: 14 },
        { sampledAt: new Date('2026-03-05T10:10:00.000Z'), netPnl: 15 },
    ]);

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/embed-summary/sub-1?symbol=BTCUSDT`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.scoreCard.netPnl, 25);
            assert.equal(payload.activeStrategy.strategySessionId, 'scalper-1');
            assert.equal(payload.activeStrategy.runtimeStatus, 'ACTIVE');
            assert.equal(payload.sparkline.length, 2);
        });
    } finally {
        prisma.subAccountTcaRollup.findFirst = originals.subRollupFindFirst;
        prisma.algoRuntimeSession.findFirst = originals.runtimeFindFirst;
        prisma.strategySession.findFirst = originals.strategySessionFindFirst;
        prisma.strategyTcaRollup.findFirst = originals.strategyRollupFindFirst;
        prisma.strategySessionPnlSample.findMany = originals.pnlFindMany;
    }
});

test('GET /trade/tca/strategy-modal-payload returns combined detail+timeseries+ledger in one call', { concurrency: false }, async () => {
    const now = Date.now();
    const startedAt = new Date(now - (20 * 60 * 1000));
    const sampleOneTs = new Date(now - (10 * 60 * 1000));
    const sampleTwoTs = new Date(now - (5 * 60 * 1000));
    const checkpointTs = new Date(now - (4 * 60 * 1000));
    const originals = {
        databaseUrl: process.env.DATABASE_URL,
        queryRaw: prisma.$queryRaw,
        strategySessionFindFirst: prisma.strategySession.findFirst,
        strategyRollupFindFirst: prisma.strategyTcaRollup.findFirst,
        runtimeFindUnique: prisma.algoRuntimeSession.findUnique,
        pnlFindFirst: prisma.strategySessionPnlSample.findFirst,
        pnlFindMany: prisma.strategySessionPnlSample.findMany,
        paramFindFirst: prisma.strategySessionParamSample.findFirst,
        paramFindMany: prisma.strategySessionParamSample.findMany,
        checkpointCount: prisma.algoRuntimeCheckpoint.count,
        checkpointFindMany: prisma.algoRuntimeCheckpoint.findMany,
        fillFactFindMany: prisma.fillFact.findMany,
        positionLotFindMany: prisma.strategyPositionLot.findMany,
        lotRealizationFindMany: prisma.strategyLotRealization.findMany,
        tcaAnomaly: prisma.tcaAnomaly,
    };
    process.env.DATABASE_URL = 'file:test.db';

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        if (sql.includes('WITH unknown_roles AS')) {
            return [{ strategySessionId: 'scalper-1', unknownRoleCount: 0, unknownLineageCount: 0, sessionPnlAnomalyCount: 0 }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    prisma.strategySession.findFirst = async () => ({
        id: 'scalper-1', subAccountId: 'sub-1', origin: 'SCALPER', strategyType: 'SCALPER',
        rootStrategySessionId: 'scalper-1', sessionRole: 'ROOT', symbol: 'BTCUSDT', side: 'LONG',
        startedAt, updatedAt: sampleTwoTs,
        _count: { lifecycles: 2, rollups: 1 },
    });
    prisma.strategyTcaRollup.findFirst = async () => ({
        strategySessionId: 'scalper-1', strategyType: 'SCALPER', rollupLevel: 'ROOT',
        executionScope: 'SUB_ACCOUNT', ownershipConfidence: 'HARD',
        fillCount: 3, realizedPnl: 10, unrealizedPnl: 2, netPnl: 12,
        avgArrivalSlippageBps: 0.5, avgMarkout1sBps: -1, avgMarkout5sBps: -0.5,
        updatedAt: sampleTwoTs,
    });
    prisma.algoRuntimeSession.findUnique = async () => ({
        strategySessionId: 'scalper-1', status: 'ACTIVE', resumePolicy: 'RECREATE_CHILD_ORDERS',
        updatedAt: sampleTwoTs,
    });
    prisma.strategySessionPnlSample.findFirst = async () => ({
        strategySessionId: 'scalper-1', sampledAt: sampleTwoTs, netPnl: 12,
    });
    prisma.strategySessionParamSample.findFirst = async () => ({
        strategySessionId: 'scalper-1', sampledAt: sampleTwoTs,
    });
    prisma.strategySessionPnlSample.findMany = async () => ([
        { sampledAt: sampleOneTs, netPnl: 5, realizedPnl: 3, unrealizedPnl: 2, openQty: 1, openNotional: 100, feesTotal: 0.1, fillCount: 1, closeCount: 0 },
        { sampledAt: sampleTwoTs, netPnl: 12, realizedPnl: 10, unrealizedPnl: 2, openQty: 1, openNotional: 110, feesTotal: 0.2, fillCount: 3, closeCount: 1 },
    ]);
    prisma.strategySessionParamSample.findMany = async () => ([]);
    prisma.algoRuntimeCheckpoint.count = async () => 1;
    prisma.algoRuntimeCheckpoint.findMany = async () => ([
        { checkpointTs, checkpointReason: 'HEARTBEAT', status: 'ACTIVE', checkpointSeq: 5 },
    ]);
    prisma.fillFact.findMany = async () => ([]);
    prisma.strategyPositionLot.findMany = async () => ([]);
    prisma.strategyLotRealization.findMany = async () => ([]);
    prisma.tcaAnomaly = {
        ...(originals.tcaAnomaly || {}),
        findMany: async () => ([]),
    };

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-modal-payload/sub-1/scalper-1?sections=detail,timeseries,ledger&series=pnl,params,quality,exposure&includeEvents=1&maxPoints=180&eventsPageSize=8`);
            assert.equal(response.status, 200);
            const payload = await response.json();

            // Verify combined structure
            assert.ok(payload.detail, 'should have detail section');
            assert.ok(payload.timeseries, 'should have timeseries section');
            assert.ok(payload.ledger, 'should have ledger section');

            // Verify detail content
            assert.equal(payload.detail.strategySession.strategySessionId, 'scalper-1');
            assert.equal(payload.detail.strategySession.strategyType, 'SCALPER');
            assert.equal(payload.detail.runtime.status, 'ACTIVE');

            // Verify timeseries has series data
            assert.ok(Array.isArray(payload.timeseries.series.pnl), 'should have pnl series');
            assert.equal(payload.timeseries.series.pnl.length, 2);
            assert.equal(payload.timeseries.events.items.length, 1);
            assert.equal(payload.timeseries.range.defaultedWindow, true);

            // Verify ledger has arrays
            assert.ok(Array.isArray(payload.ledger.openLots), 'should have openLots');
            assert.ok(Array.isArray(payload.ledger.realizations), 'should have realizations');
        });
    } finally {
        process.env.DATABASE_URL = originals.databaseUrl;
        prisma.$queryRaw = originals.queryRaw;
        prisma.strategySession.findFirst = originals.strategySessionFindFirst;
        prisma.strategyTcaRollup.findFirst = originals.strategyRollupFindFirst;
        prisma.algoRuntimeSession.findUnique = originals.runtimeFindUnique;
        prisma.strategySessionPnlSample.findFirst = originals.pnlFindFirst;
        prisma.strategySessionPnlSample.findMany = originals.pnlFindMany;
        prisma.strategySessionParamSample.findFirst = originals.paramFindFirst;
        prisma.strategySessionParamSample.findMany = originals.paramFindMany;
        prisma.algoRuntimeCheckpoint.count = originals.checkpointCount;
        prisma.algoRuntimeCheckpoint.findMany = originals.checkpointFindMany;
        prisma.fillFact.findMany = originals.fillFactFindMany;
        prisma.strategyPositionLot.findMany = originals.positionLotFindMany;
        prisma.strategyLotRealization.findMany = originals.lotRealizationFindMany;
        if (originals.tcaAnomaly === undefined) {
            delete prisma.tcaAnomaly;
        } else {
            prisma.tcaAnomaly = originals.tcaAnomaly;
        }
    }
});

test('GET /trade/tca/strategy-modal-payload supports section-scoped detail-only responses', { concurrency: false }, async () => {
    const originals = {
        queryRaw: prisma.$queryRaw,
        strategySessionFindFirst: prisma.strategySession.findFirst,
        strategyRollupFindFirst: prisma.strategyTcaRollup.findFirst,
        runtimeFindUnique: prisma.algoRuntimeSession.findUnique,
        pnlFindFirst: prisma.strategySessionPnlSample.findFirst,
        paramFindFirst: prisma.strategySessionParamSample.findFirst,
    };

    prisma.$queryRaw = async (query) => {
        const sql = query.strings.join(' ');
        if (sql.includes('WITH unknown_roles AS')) {
            return [{ strategySessionId: 'scalper-1', unknownRoleCount: 0, unknownLineageCount: 0, sessionPnlAnomalyCount: 0 }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    prisma.strategySession.findFirst = async () => ({
        id: 'scalper-1',
        subAccountId: 'sub-1',
        origin: 'SCALPER',
        strategyType: 'SCALPER',
        rootStrategySessionId: 'scalper-1',
        sessionRole: 'ROOT',
        symbol: 'BTCUSDT',
        side: 'LONG',
        startedAt: new Date('2026-03-05T10:00:00.000Z'),
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
        _count: { lifecycles: 2, rollups: 1 },
    });
    prisma.strategyTcaRollup.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        strategyType: 'SCALPER',
        rollupLevel: 'ROOT',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        fillCount: 1,
        netPnl: 2,
        qualityByRoleJson: '{}',
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
    });
    prisma.algoRuntimeSession.findUnique = async () => ({
        strategySessionId: 'scalper-1',
        status: 'ACTIVE',
        resumePolicy: 'RECREATE_CHILD_ORDERS',
        updatedAt: new Date('2026-03-05T10:05:00.000Z'),
    });
    prisma.strategySessionPnlSample.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        sampledAt: new Date('2026-03-05T10:05:00.000Z'),
        netPnl: 2,
    });
    prisma.strategySessionParamSample.findFirst = async () => ({
        strategySessionId: 'scalper-1',
        sampledAt: new Date('2026-03-05T10:05:00.000Z'),
    });

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/trade/tca/strategy-modal-payload/sub-1/scalper-1?sections=detail`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.ok(payload.detail);
            assert.equal(payload.timeseries, undefined);
            assert.equal(payload.ledger, undefined);
        });
    } finally {
        prisma.$queryRaw = originals.queryRaw;
        prisma.strategySession.findFirst = originals.strategySessionFindFirst;
        prisma.strategyTcaRollup.findFirst = originals.strategyRollupFindFirst;
        prisma.algoRuntimeSession.findUnique = originals.runtimeFindUnique;
        prisma.strategySessionPnlSample.findFirst = originals.pnlFindFirst;
        prisma.strategySessionParamSample.findFirst = originals.paramFindFirst;
    }
});

test('GET /trade/tca/strategy-session-timeseries returns memory guard error for full-session windows under pressure', { concurrency: false }, async () => {
    __setRuntimeMemorySnapshotProviderForTests(() => ({
        budgetMb: { hostTotal: 1024, warn: 700, critical: 850, minAvailable: 128 },
        system: { availableMb: 96 },
        node: { rssMb: 200 },
        python: { rssMb: 200 },
        postgres: { localRssMb: 500 },
        combinedLocalRssMb: 900,
    }));

    try {
        await withTestServer(async (baseUrl) => {
            const response = await fetch(
                `${baseUrl}/trade/tca/strategy-session-timeseries/sub-1/scalper-1?from=2026-03-05T08:00:00.000Z&to=2026-03-05T12:00:00.000Z&series=pnl,quality`,
            );
            assert.equal(response.status, 503);
            const payload = await response.json();
            assert.equal(payload.errorCode, 'TCA_MEMORY_GUARD_ACTIVE');
            assert.equal(payload.details.suggestedWindow, '15m');
        });
    } finally {
        __resetRuntimeMemorySnapshotProviderForTests();
    }
});
