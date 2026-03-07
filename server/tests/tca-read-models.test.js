import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildStrategySessionPageQuery,
    buildStrategyTimeseriesQuery,
    buildLifecyclePageQuery,
    buildRecursiveLineageGraph,
    buildLifecycleQuery,
    buildMarkoutQuery,
    buildRollupQuery,
    buildStrategyRollupQuery,
    buildStrategySessionQuery,
    bucketTimeSeries,
    computeRoleQualityFromLifecycles,
    serializeLifecycleDetail,
    serializeLifecycleSummary,
    serializeStrategyRollup,
    serializeSubAccountRollup,
} from '../tca-read-models.js';

test('buildLifecycleQuery keeps sub-account scoping and normalizes filters', () => {
    const query = buildLifecycleQuery('sub-1', {
        executionScope: 'sub_account',
        ownershipConfidence: 'hard',
        finalStatus: 'filled',
        symbol: 'btc/usdt:usdt',
        strategyType: 'twap',
        limit: '25',
    });

    assert.deepEqual(query.where, {
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        finalStatus: 'FILLED',
        symbol: 'BTCUSDT',
        strategyType: 'TWAP',
    });
    assert.equal(query.take, 25);
});

test('buildLifecycleQuery honors optional created-at range filters', () => {
    const query = buildLifecycleQuery('sub-1', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-02T00:00:00.000Z',
    });

    assert.equal(query.where.subAccountId, 'sub-1');
    assert.equal(query.where.createdAt.gte.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(query.where.createdAt.lte.toISOString(), '2026-03-02T00:00:00.000Z');
});

test('buildLifecyclePageQuery clamps pagination and normalizes sort controls', () => {
    const query = buildLifecyclePageQuery('sub-1', {
        page: '-4',
        pageSize: '999',
        sortBy: 'notAField',
        sortDir: 'upward',
        executionScope: 'sub_account',
        ownershipConfidence: 'hard',
    });

    assert.equal(query.page, 1);
    assert.equal(query.pageSize, 100);
    assert.equal(query.skip, 0);
    assert.equal(query.take, 100);
    assert.deepEqual(query.orderBy, { updatedAt: 'desc' });
    assert.equal(query.sortBy, 'updatedAt');
    assert.equal(query.sortDir, 'desc');
    assert.equal(query.where.subAccountId, 'sub-1');
});

test('buildMarkoutQuery scopes through fill facts and honors horizon filters', () => {
    const query = buildMarkoutQuery('sub-2', {
        executionScope: 'sub_account',
        ownershipConfidence: 'hard',
        symbol: 'ethusdt',
        originType: 'bot',
        horizonMs: '5000',
    });

    assert.deepEqual(query.where, {
        fillFact: {
            subAccountId: 'sub-2',
            executionScope: 'SUB_ACCOUNT',
            ownershipConfidence: 'HARD',
            symbol: 'ETHUSDT',
            originType: 'BOT',
        },
        horizonMs: 5000,
    });
});

test('buildStrategySessionQuery can scope by started-at window', () => {
    const query = buildStrategySessionQuery('sub-3', {
        from: '2026-03-03T00:00:00.000Z',
        to: '2026-03-04T00:00:00.000Z',
    });

    assert.equal(query.where.subAccountId, 'sub-3');
    assert.equal(query.where.startedAt.gte.toISOString(), '2026-03-03T00:00:00.000Z');
    assert.equal(query.where.startedAt.lte.toISOString(), '2026-03-04T00:00:00.000Z');
});

test('buildRollupQuery and buildStrategySessionQuery never drop sub-account ownership', () => {
    const rollup = buildRollupQuery('sub-3', { executionScope: 'main_account' });
    const strategy = buildStrategySessionQuery('sub-3', { strategyType: 'scalper', symbol: 'dogeusdt' });
    const strategyRollup = buildStrategyRollupQuery('sub-3', { ownershipConfidence: 'hard', strategyType: 'scalper' });

    assert.equal(rollup.where.subAccountId, 'sub-3');
    assert.equal(strategy.where.subAccountId, 'sub-3');
    assert.equal(Array.isArray(strategy.where.OR), true);
    assert.equal(strategy.where.OR[0].strategyType, 'SCALPER');
    assert.equal(strategy.where.OR[1].id.startsWith, 'scalper_');
    assert.equal(strategy.where.symbol, 'DOGEUSDT');
    assert.equal(strategyRollup.where.subAccountId, 'sub-3');
    assert.equal(strategyRollup.where.strategyType, 'SCALPER');
});

test('buildStrategySessionPageQuery defaults to root scalper paging and normalized sort controls', () => {
    const query = buildStrategySessionPageQuery('sub-9', {
        page: '3',
        pageSize: '50',
        sortBy: 'netPnl',
        sortDir: 'asc',
        status: 'active',
        symbol: 'ethusdt',
    });

    assert.equal(query.where.subAccountId, 'sub-9');
    assert.equal(query.where.sessionRole, 'ROOT');
    assert.equal(Array.isArray(query.where.OR), true);
    assert.equal(query.where.OR[0].strategyType, 'SCALPER');
    assert.equal(query.where.symbol, 'ETHUSDT');
    assert.equal(query.page, 3);
    assert.equal(query.pageSize, 50);
    assert.equal(query.skip, 100);
    assert.equal(query.take, 50);
    assert.equal(query.sortBy, 'netPnl');
    assert.equal(query.sortDir, 'asc');
    assert.equal(query.status, 'ACTIVE');
});

test('buildStrategyTimeseriesQuery derives adaptive bucket defaults and accepts explicit series selection', () => {
    const query = buildStrategyTimeseriesQuery({
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-10T00:00:00.000Z',
        series: 'pnl,params',
    });

    assert.equal(query.requestedBucketMs, 300000);
    assert.equal(query.bucketMs, 2592000);
    assert.equal(query.maxPoints, 300);
    assert.equal(query.series.has('pnl'), true);
    assert.equal(query.series.has('params'), true);
    assert.equal(query.series.has('quality'), false);
    assert.equal(query.eventsPage, 1);
    assert.equal(query.eventsPageSize, 12);
    assert.equal(query.eventsSkip, 0);
    assert.equal(query.defaultedWindow, false);
    assert.equal(query.defaultWindowMs, 15 * 60 * 1000);
});

test('buildStrategyTimeseriesQuery defaults missing from to the last 15 minutes', () => {
    const before = Date.now();
    const query = buildStrategyTimeseriesQuery({});
    const after = Date.now();

    assert.equal(query.defaultedWindow, true);
    assert.equal(query.defaultWindowMs, 15 * 60 * 1000);
    assert.ok(query.to.getTime() >= before);
    assert.ok(query.to.getTime() <= after + 1000);
    assert.equal(query.to.getTime() - query.from.getTime(), 15 * 60 * 1000);
});

test('buildRollupQuery and buildStrategyRollupQuery honor updated-at date filters', () => {
    const rollup = buildRollupQuery('sub-5', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-02T00:00:00.000Z',
    });
    const strategyRollup = buildStrategyRollupQuery('sub-5', {
        from: '2026-03-03T00:00:00.000Z',
        to: '2026-03-04T00:00:00.000Z',
    });

    assert.equal(rollup.where.subAccountId, 'sub-5');
    assert.equal(rollup.where.updatedAt.gte.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(rollup.where.updatedAt.lte.toISOString(), '2026-03-02T00:00:00.000Z');

    assert.equal(strategyRollup.where.subAccountId, 'sub-5');
    assert.equal(strategyRollup.where.updatedAt.gte.toISOString(), '2026-03-03T00:00:00.000Z');
    assert.equal(strategyRollup.where.updatedAt.lte.toISOString(), '2026-03-04T00:00:00.000Z');
});

test('serializeLifecycleSummary exposes arrival and latency metrics from dedicated lifecycle rows', () => {
    const summary = serializeLifecycleSummary({
        id: 'lc-1',
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        originPath: 'PYTHON_CMD',
        strategyType: 'TWAP',
        strategySessionId: 'twap-1',
        parentId: 'twap-1',
        clientOrderId: 'coid-1',
        exchangeOrderId: 'oid-1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        reduceOnly: false,
        requestedQty: 2,
        limitPrice: 100,
        decisionBid: 99.5,
        decisionAsk: 100.5,
        decisionMid: 100,
        decisionSpreadBps: 100,
        intentTs: new Date('2026-03-04T10:00:00.000Z'),
        ackTs: new Date('2026-03-04T10:00:00.200Z'),
        firstFillTs: new Date('2026-03-04T10:00:00.250Z'),
        doneTs: new Date('2026-03-04T10:00:00.500Z'),
        finalStatus: 'FILLED',
        filledQty: 2,
        avgFillPrice: 101,
        repriceCount: 1,
        reconciliationStatus: 'LIVE',
        reconciliationReason: null,
        updatedAt: new Date('2026-03-04T10:00:01.000Z'),
        _count: { events: 3, fillFacts: 1 },
        fillFacts: [
            {
                markouts: [
                    { horizonMs: 1000, markoutBps: 3.5 },
                    { horizonMs: 5000, markoutBps: 2.2 },
                ],
            },
        ],
    });

    assert.equal(summary.subAccountId, 'sub-1');
    assert.equal(summary.arrivalSlippageBps, 100);
    assert.equal(summary.ackLatencyMs, 200);
    assert.equal(summary.workingTimeMs, 300);
    assert.equal(summary.eventCount, 3);
    assert.equal(summary.orderRole, 'UNKNOWN');
    assert.equal(summary.avgMarkout1sBps, 3.5);
    assert.equal(summary.avgMarkout5sBps, 2.2);
    assert.equal(summary.lineageStatus, 'UNKNOWN');
});

test('serializeSubAccountRollup keeps scope and confidence visible to agent consumers', () => {
    const row = serializeSubAccountRollup({
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        orderCount: 4,
        terminalOrderCount: 4,
        fillCount: 3,
        cancelCount: 1,
        rejectCount: 0,
        totalRequestedQty: 10,
        totalFilledQty: 8,
        totalFillNotional: 800,
        fillRatio: 0.8,
        cancelToFillRatio: 1 / 3,
        avgArrivalSlippageBps: 12.5,
        avgAckLatencyMs: 150,
        avgWorkingTimeMs: 1200,
        avgMarkout1sBps: 3,
        avgMarkout5sBps: 5,
        avgMarkout30sBps: 8,
        qualityByRole: {
            ADD: {
                avgArrivalSlippageBps: 11,
                avgMarkout1sBps: 2,
                avgMarkout5sBps: 4,
                avgMarkout30sBps: 6,
                toxicityScore: 1,
            },
        },
        totalRepriceCount: 2,
        updatedAt: new Date('2026-03-04T10:00:01.000Z'),
    });

    assert.equal(row.executionScope, 'SUB_ACCOUNT');
    assert.equal(row.ownershipConfidence, 'HARD');
    assert.equal(row.avgArrivalSlippageBps, 12.5);
    assert.equal(row.avgArrivalSlippageBpsByRole.ADD, 11);
    assert.ok(Number.isFinite(row.toxicityScore));
});

test('serializeStrategyRollup exposes rollup level and economic fields', () => {
    const row = serializeStrategyRollup({
        strategySessionId: 'scalper-1',
        subAccountId: 'sub-1',
        strategyType: 'SCALPER',
        rollupLevel: 'ROOT',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        orderCount: 5,
        terminalOrderCount: 4,
        fillCount: 4,
        cancelCount: 1,
        rejectCount: 0,
        totalRequestedQty: 9,
        totalFilledQty: 8,
        totalFillNotional: 800,
        fillRatio: 0.88,
        cancelToFillRatio: 0.25,
        avgArrivalSlippageBps: 1.2,
        avgAckLatencyMs: 15,
        avgWorkingTimeMs: 100,
        avgMarkout1sBps: -0.5,
        avgMarkout5sBps: 0.2,
        avgMarkout30sBps: 1.5,
        realizedPnl: 12,
        unrealizedPnl: 3,
        netPnl: 15,
        feesTotal: 0.8,
        openQty: 1.5,
        openNotional: 150,
        closeCount: 2,
        winCount: 1,
        lossCount: 1,
        winRate: 0.5,
        maxDrawdownPnl: -5,
        maxRunupPnl: 18,
        totalRepriceCount: 1,
        updatedAt: new Date('2026-03-04T10:00:01.000Z'),
    });

    assert.equal(row.rollupLevel, 'ROOT');
    assert.equal(row.netPnl, 15);
    assert.equal(row.openNotional, 150);
    assert.equal(row.maxDrawdownPnl, -5);
    assert.equal(row.maxRunupPnl, 18);
});

test('serializeLifecycleDetail exposes nested fills, markouts, and parsed event payloads', () => {
    const detail = serializeLifecycleDetail({
        id: 'lc-1',
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        originPath: 'PROXY_BOT',
        strategyType: 'CHASE',
        orderRole: 'UNWIND',
        strategySessionId: 'chase-1',
        parentId: 'chase-1',
        clientOrderId: 'coid-1',
        exchangeOrderId: 'oid-1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        reduceOnly: false,
        requestedQty: 2,
        limitPrice: 100,
        decisionBid: 99.5,
        decisionAsk: 100.5,
        decisionMid: 100,
        decisionSpreadBps: 100,
        intentTs: new Date('2026-03-04T10:00:00.000Z'),
        ackTs: new Date('2026-03-04T10:00:00.200Z'),
        firstFillTs: new Date('2026-03-04T10:00:00.250Z'),
        doneTs: new Date('2026-03-04T10:00:00.500Z'),
        finalStatus: 'FILLED',
        filledQty: 2,
        avgFillPrice: 101,
        repriceCount: 1,
        reconciliationStatus: 'LIVE',
        reconciliationReason: null,
        updatedAt: new Date('2026-03-04T10:00:01.000Z'),
        strategySession: {
            id: 'chase-1',
            subAccountId: 'sub-1',
            origin: 'BOT',
            strategyType: 'CHASE',
            symbol: 'BTCUSDT',
            side: 'BUY',
            startedAt: new Date('2026-03-04T09:59:59.000Z'),
            endedAt: new Date('2026-03-04T10:00:01.000Z'),
            updatedAt: new Date('2026-03-04T10:00:01.000Z'),
            _count: { lifecycles: 4, rollups: 1 },
        },
        events: [
            {
                id: 'evt-1',
                streamEventId: '1-0',
                eventType: 'ORDER_INTENT',
                sourceTs: new Date('2026-03-04T10:00:00.000Z'),
                ingestedTs: new Date('2026-03-04T10:00:00.010Z'),
                createdAt: new Date('2026-03-04T10:00:00.010Z'),
                payloadJson: JSON.stringify({ type: 'ORDER_INTENT', symbol: 'BTCUSDT' }),
            },
        ],
        fillFacts: [
            {
                id: 'fill-1',
                lifecycleId: 'lc-1',
                subAccountId: 'sub-1',
                sourceEventId: '2-0',
                executionScope: 'SUB_ACCOUNT',
                ownershipConfidence: 'HARD',
                symbol: 'BTCUSDT',
                side: 'BUY',
                fillTs: new Date('2026-03-04T10:00:00.250Z'),
                fillQty: 2,
                fillPrice: 101,
                fillBid: 100.5,
                fillAsk: 101.5,
                fillMid: 101,
                fillSpreadBps: 99,
                sampledAt: new Date('2026-03-04T10:00:00.251Z'),
                fee: 0.5,
                makerTaker: 'TAKER',
                originType: 'BOT',
                createdAt: new Date('2026-03-04T10:00:00.251Z'),
                markouts: [
                    {
                        fillFactId: 'fill-1',
                        horizonMs: 1000,
                        measuredTs: new Date('2026-03-04T10:00:01.250Z'),
                        midPrice: 101,
                        markPrice: 102,
                        markoutBps: 99.01,
                        createdAt: new Date('2026-03-04T10:00:01.250Z'),
                    },
                    {
                        fillFactId: 'fill-1',
                        horizonMs: 5000,
                        measuredTs: new Date('2026-03-04T10:00:05.250Z'),
                        midPrice: 101,
                        markPrice: 103,
                        markoutBps: 198.02,
                        createdAt: new Date('2026-03-04T10:00:05.250Z'),
                    },
                ],
            },
        ],
    });

    assert.equal(detail.strategySession.strategySessionId, 'chase-1');
    assert.equal(detail.fills.length, 1);
    assert.equal(detail.fills[0].markouts.length, 2);
    assert.equal(detail.markoutSummary.avgMarkout1sBps, 99.01);
    assert.equal(detail.markoutSummary.avgMarkout5sBps, 198.02);
    assert.equal(detail.events[0].payload.type, 'ORDER_INTENT');
    assert.equal(detail.orderRole, 'UNWIND');
    assert.ok(detail.qualityByRole.UNWIND);
    assert.equal(detail.lineageGraph, null);
});

test('computeRoleQualityFromLifecycles groups toxicity inputs by order role', () => {
    const byRole = computeRoleQualityFromLifecycles([
        {
            orderRole: 'ADD',
            side: 'BUY',
            decisionMid: 100,
            avgFillPrice: 101,
            fillFacts: [
                {
                    markouts: [
                        { horizonMs: 1000, markoutBps: 5 },
                        { horizonMs: 5000, markoutBps: 2 },
                    ],
                },
            ],
        },
        {
            orderRole: 'UNWIND',
            side: 'SELL',
            decisionMid: 100,
            avgFillPrice: 99,
            fillFacts: [
                {
                    markouts: [{ horizonMs: 1000, markoutBps: -4 }],
                },
            ],
        },
    ]);

    assert.equal(Object.keys(byRole).length, 2);
    assert.equal(byRole.ADD.avgArrivalSlippageBps, 100);
    assert.equal(byRole.ADD.avgMarkout1sBps, 5);
    assert.equal(byRole.UNWIND.avgMarkout1sBps, -4);
});

test('buildRecursiveLineageGraph walks recursively and truncates at caps', async () => {
    const edges = [
        {
            parentNodeType: 'STRATEGY_SESSION',
            parentNodeId: 'scalper-1',
            childNodeType: 'STRATEGY_SESSION',
            childNodeId: 'chase-1',
            relationType: 'SPAWNS_SESSION',
        },
        {
            parentNodeType: 'STRATEGY_SESSION',
            parentNodeId: 'chase-1',
            childNodeType: 'ORDER_LIFECYCLE',
            childNodeId: 'lc-1',
            relationType: 'SUBMITS_ORDER',
        },
    ];
    const graph = await buildRecursiveLineageGraph({
        rootNodeType: 'STRATEGY_SESSION',
        rootNodeId: 'scalper-1',
        fetchEdgesForNodes: async (frontier) => {
            const keys = new Set(frontier.map((n) => `${n.nodeType}:${n.nodeId}`));
            return edges.filter((edge) =>
                keys.has(`${edge.parentNodeType}:${edge.parentNodeId}`)
                || keys.has(`${edge.childNodeType}:${edge.childNodeId}`));
        },
        maxNodes: 2,
        maxEdges: 10,
    });

    assert.equal(graph.truncated, true);
    assert.equal(graph.stats.maxNodes, 2);
    assert.ok(graph.nodes.length >= 2);
});

test('bucketTimeSeries keeps the last point by default and can aggregate custom buckets', () => {
    const points = [
        { ts: '2026-03-05T10:00:01.000Z', value: 1 },
        { ts: '2026-03-05T10:00:03.000Z', value: 2 },
        { ts: '2026-03-05T10:00:06.000Z', value: 3 },
    ];

    const lastOnly = bucketTimeSeries(points, 5000);
    const aggregated = bucketTimeSeries(points, 5000, (bucket, items) => ({
        ts: new Date(bucket),
        count: items.length,
    }));

    assert.equal(lastOnly.length, 2);
    assert.equal(lastOnly[0].value, 2);
    assert.equal(aggregated[0].count, 2);
});
