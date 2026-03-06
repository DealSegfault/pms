import test from 'node:test';
import assert from 'node:assert/strict';

import { __tcaTestHooks } from '../../src/pages/tca.js';

test('TCA detail renderer includes order role badge and lineage anomaly warning', () => {
    const view = { benchmarkMs: 5000, benchmarkLabel: '5s Markout' };
    const detail = {
        side: 'SELL',
        finalStatus: 'FILLED',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        orderRole: 'UNWIND',
        reconciliationStatus: 'LIVE',
        arrivalSlippageBps: -2.4,
        ackLatencyMs: 123,
        workingTimeMs: 456,
        markoutSummary: {
            avgMarkout1sBps: -1.5,
            avgMarkout5sBps: -2.1,
            avgMarkout30sBps: -3.9,
        },
        strategyType: 'SCALPER',
        strategySessionId: 'scalper-1',
        parentId: 'scalper-1',
        clientOrderId: 'coid-1',
        exchangeOrderId: 'oid-1',
        requestedQty: 1.25,
        filledQty: 1.25,
        fills: [],
        events: [],
        qualityByRole: {
            UNWIND: {
                avgArrivalSlippageBps: -2.4,
                avgMarkout1sBps: -1.5,
                avgMarkout5sBps: -2.1,
                avgMarkout30sBps: -3.9,
                toxicityScore: 1.23,
            },
        },
        lineageGraph: {
            nodes: [{ nodeType: 'ORDER_LIFECYCLE', nodeId: 'lc-1' }],
            edges: [],
            stats: { nodeCount: 1, edgeCount: 0 },
            truncated: false,
        },
        lineageAnomalies: [
            {
                payload: { reason: 'UNKNOWN_ORDER_ROLE|MISSING_STRATEGY_SESSION' },
            },
        ],
    };

    const html = __tcaTestHooks.renderDetailContent(view, detail);
    assert.match(html, /UNWIND/);
    assert.match(html, /Lineage anomaly/);
    assert.match(html, /UNKNOWN_ORDER_ROLE\|MISSING_STRATEGY_SESSION/);
});

test('TCA role quality renderer shows role chips and toxicity values', () => {
    const html = __tcaTestHooks.renderRoleQuality({
        qualityByRole: {
            ADD: {
                avgArrivalSlippageBps: 1.1,
                avgMarkout1sBps: 2.2,
                avgMarkout5sBps: 3.3,
                avgMarkout30sBps: 4.4,
                toxicityScore: 5.4321,
            },
        },
    });

    assert.match(html, /ADD/);
    assert.match(html, /Arrival \+1\.1 bps/);
    assert.match(html, /Toxicity 5\.43/);
});

test('TCA lineage graph renderer exposes relation badges and truncation marker', () => {
    const html = __tcaTestHooks.renderLineageGraph({
        lineageGraph: {
            nodes: [
                { nodeType: 'STRATEGY_SESSION', nodeId: 'scalper-1' },
                { nodeType: 'ORDER_LIFECYCLE', nodeId: 'lc-1' },
            ],
            edges: [
                {
                    parentNodeType: 'STRATEGY_SESSION',
                    parentNodeId: 'scalper-1',
                    childNodeType: 'ORDER_LIFECYCLE',
                    childNodeId: 'lc-1',
                    relationType: 'SUBMITS_ORDER',
                    sourceTs: new Date('2026-03-05T11:00:00.000Z'),
                },
            ],
            stats: { nodeCount: 2, edgeCount: 1 },
            truncated: true,
        },
    });

    assert.match(html, /2 node\(s\)/);
    assert.match(html, /1 edge\(s\)/);
    assert.match(html, /SUBMITS_ORDER/);
    assert.match(html, /truncated/);
});

test('TCA strategy lot ledger renderer surfaces lots, realizations, and anomalies', () => {
    const html = __tcaTestHooks.renderStrategyLotLedger({
        openLots: [
            { positionSide: 'LONG', openQty: 2, remainingQty: 1, openPrice: 100 },
        ],
        realizations: [
            { allocatedQty: 1, openPrice: 100, closePrice: 110, netRealizedPnl: 9.5 },
        ],
        anomalies: [
            { payload: { reason: 'UNMATCHED_CLOSE_QTY' }, sourceTs: '2026-03-05T10:00:00.000Z' },
        ],
    });

    assert.match(html, /Open Lots/);
    assert.match(html, /Recent Realizations/);
    assert.match(html, /UNMATCHED_CLOSE_QTY/);
});

test('TCA strategy chart renderer draws legends for multiple series', () => {
    const html = __tcaTestHooks.renderMultiSeriesChart(
        [
            { ts: '2026-03-05T10:00:00.000Z', netPnl: 1, realizedPnl: 1 },
            { ts: '2026-03-05T10:00:05.000Z', netPnl: 2, realizedPnl: 1.5 },
        ],
        [
            ['netPnl', 'Net', '#16a34a'],
            ['realizedPnl', 'Realized', '#0ea5e9'],
        ],
    );

    assert.match(html, /Net/);
    assert.match(html, /Realized/);
    assert.match(html, /polyline/);
});

test('TCA Strategy Footprint filters liquidation rows before ranking', () => {
    const view = __tcaTestHooks.buildViewModel(
        {
            rollups: [],
            strategyRollups: [
                {
                    strategySessionId: 'liq-1',
                    subAccountId: 'sub-1',
                    strategyType: 'LIQUIDATION',
                    totalFillNotional: 9999,
                },
                {
                    strategySessionId: 'scalper-1',
                    subAccountId: 'sub-1',
                    strategyType: 'SCALPER',
                    totalFillNotional: 1000,
                },
            ],
            strategySessions: [
                {
                    strategySessionId: 'liq-1',
                    subAccountId: 'sub-1',
                    strategyType: 'LIQUIDATION',
                    origin: 'LIQUIDATION',
                    symbol: 'BTCUSDT',
                },
                {
                    strategySessionId: 'scalper-1',
                    subAccountId: 'sub-1',
                    strategyType: 'SCALPER',
                    origin: 'SCALPER',
                    symbol: 'ETHUSDT',
                    startedAt: '2026-03-05T10:00:00.000Z',
                },
            ],
        },
        { items: [] },
    );

    assert.equal(view.strategyLeaders.length, 1);
    assert.equal(view.strategyLeaders[0].strategySessionId, 'scalper-1');
});

test('TCA Strategy Footprint rows open the shared strategy modal action', () => {
    const html = __tcaTestHooks.renderStrategyLeaders({
        strategyLeaders: [
            {
                strategySessionId: 'scalper-1',
                subAccountId: 'sub-1',
                strategyType: 'SCALPER',
                avgArrivalSlippageBps: 1.2,
                avgMarkout1sBps: -0.5,
                avgMarkout5sBps: 0.1,
                totalFillNotional: 1200,
                session: {
                    symbol: 'BTCUSDT',
                    subAccountId: 'sub-1',
                    startedAt: '2026-03-05T10:00:00.000Z',
                },
            },
        ],
    });

    assert.match(html, /data-action="open-strategy-modal"/);
    assert.match(html, /data-session-id="scalper-1"/);
    assert.match(html, /inspect TCA/);
});

test('TCA strategy timeline renderer paginates compact checkpoint items', () => {
    const html = __tcaTestHooks.renderStrategyTimeline(
        {
            items: [
                { ts: '2026-03-05T10:00:05.000Z', type: 'HEARTBEAT', status: 'ACTIVE', checkpointSeq: 12 },
                { ts: '2026-03-05T10:00:00.000Z', type: 'PAUSE', status: 'PAUSED_RESTARTABLE', checkpointSeq: 11 },
            ],
            page: 2,
            total: 18,
            totalPages: 3,
        },
        { unknownLineageCount: 1, sessionPnlAnomalyCount: 2 },
    );

    assert.match(html, /18 checkpoint\(s\) in range/);
    assert.match(html, /HEARTBEAT/);
    assert.match(html, /Page 2 \/ 3/);
    assert.match(html, /PNL_ANOMALY/);
});
