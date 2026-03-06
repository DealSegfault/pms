import test from 'node:test';
import assert from 'node:assert/strict';

import { __tcaTestHooks } from '../../src/pages/tca.js';

test('parseTcaHashState restores tab, filters, pagination, and sort from hash query', () => {
    const parsed = __tcaTestHooks.parseTcaHashState(
        '#/tca?tab=lifecycles&page=3&pageSize=50&sortBy=createdAt&sortDir=asc&symbol=BTCUSDT&strategyType=SCALPER&finalStatus=FILLED&lookback=24h&includeNonHard=1&benchmarkMs=1000',
    );

    assert.equal(parsed.tab, 'lifecycles');
    assert.equal(parsed.page, 3);
    assert.equal(parsed.pageSize, 50);
    assert.equal(parsed.sortBy, 'createdAt');
    assert.equal(parsed.sortDir, 'asc');
    assert.equal(parsed.filters.symbol, 'BTCUSDT');
    assert.equal(parsed.filters.strategyType, 'SCALPER');
    assert.equal(parsed.filters.finalStatus, 'FILLED');
    assert.equal(parsed.filters.lookback, '24h');
    assert.equal(parsed.filters.includeNonHard, true);
    assert.equal(parsed.filters.benchmarkMs, 1000);
});

test('parseTcaHashState defaults lifecycle status filter to FILLED when absent', () => {
    const parsed = __tcaTestHooks.parseTcaHashState('#/tca?tab=lifecycles&page=1');

    assert.equal(parsed.filters.finalStatus, 'FILLED');
});

test('parseTcaHashState ignores removed lineage tab hashes', () => {
    const parsed = __tcaTestHooks.parseTcaHashState('#/tca?tab=lineage&page=2');

    assert.equal(parsed.tab, 'overview');
});

test('parseTcaHashState restores debug performance mode from hash', () => {
    const parsed = __tcaTestHooks.parseTcaHashState('#/tca?tab=strategies&debugPerf=1');

    assert.equal(parsed.tab, 'strategies');
    assert.equal(parsed.debugPerf, true);
});

test('buildPaginationWindow returns stable page list with first/last always included', () => {
    const pages = __tcaTestHooks.buildPaginationWindow(8, 20, 2);
    assert.deepEqual(pages, [1, 6, 7, 8, 9, 10, 20]);
});

test('parseTcaHashState restores strategy-studio paging and selected session', () => {
    const parsed = __tcaTestHooks.parseTcaHashState(
        '#/tca?tab=strategies&strategyPage=4&strategyPageSize=100&strategySortBy=netPnl&strategySortDir=asc&sessionId=scalper-1&sessionStatus=ACTIVE&lookback=30d',
    );

    assert.equal(parsed.tab, 'strategies');
    assert.equal(parsed.strategyPage, 4);
    assert.equal(parsed.strategyPageSize, 100);
    assert.equal(parsed.strategySortBy, 'netPnl');
    assert.equal(parsed.strategySortDir, 'asc');
    assert.equal(parsed.selectedStrategySessionId, 'scalper-1');
    assert.equal(parsed.filters.strategyStatus, 'ACTIVE');
    assert.equal(parsed.filters.lookback, '30d');
});

test('resolveLineageRoleMetrics falls back to visible lifecycle summaries when rollups do not expose role slices', () => {
    const metrics = __tcaTestHooks.resolveLineageRoleMetrics(
        null,
        [],
        [
            {
                orderRole: 'ADD',
                fillCount: 2,
                arrivalSlippageBps: 1.5,
                avgMarkout1sBps: -0.5,
                avgMarkout5sBps: 0.25,
                avgMarkout30sBps: 1.1,
            },
            {
                orderRole: 'UNWIND',
                fillCount: 1,
                arrivalSlippageBps: -0.8,
                avgMarkout1sBps: 0.4,
                avgMarkout5sBps: 0.6,
                avgMarkout30sBps: 0.9,
            },
        ],
    );

    assert.equal(metrics.ADD.lifecycleCount, 1);
    assert.equal(metrics.ADD.fillCount, 2);
    assert.equal(metrics.ADD.avgArrivalSlippageBps, 1.5);
    assert.equal(metrics.UNWIND.lifecycleCount, 1);
    assert.equal(metrics.UNWIND.avgMarkout5sBps, 0.6);
});
