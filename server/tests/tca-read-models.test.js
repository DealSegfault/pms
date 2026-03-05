import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildLifecycleQuery,
    buildMarkoutQuery,
    buildRollupQuery,
    buildStrategyRollupQuery,
    buildStrategySessionQuery,
    serializeLifecycleDetail,
    serializeLifecycleSummary,
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
    assert.equal(strategy.where.strategyType, 'SCALPER');
    assert.equal(strategy.where.symbol, 'DOGEUSDT');
    assert.equal(strategyRollup.where.subAccountId, 'sub-3');
    assert.equal(strategyRollup.where.strategyType, 'SCALPER');
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
    });

    assert.equal(summary.subAccountId, 'sub-1');
    assert.equal(summary.arrivalSlippageBps, 100);
    assert.equal(summary.ackLatencyMs, 200);
    assert.equal(summary.workingTimeMs, 300);
    assert.equal(summary.eventCount, 3);
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
        totalRepriceCount: 2,
        updatedAt: new Date('2026-03-04T10:00:01.000Z'),
    });

    assert.equal(row.executionScope, 'SUB_ACCOUNT');
    assert.equal(row.ownershipConfidence, 'HARD');
    assert.equal(row.avgArrivalSlippageBps, 12.5);
});

test('serializeLifecycleDetail exposes nested fills, markouts, and parsed event payloads', () => {
    const detail = serializeLifecycleDetail({
        id: 'lc-1',
        subAccountId: 'sub-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        originPath: 'PROXY_BOT',
        strategyType: 'CHASE',
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
});
