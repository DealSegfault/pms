import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTcaCacheKey, createScopedAsyncCache } from '../tca-modal-cache.js';

test('buildTcaCacheKey scopes modal keys by ownership and window fields', () => {
    const base = buildTcaCacheKey({
        scope: 'modal',
        subAccountId: 'sub-1',
        strategySessionId: 'scalper-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        sections: ['detail', 'timeseries'],
        from: '2026-03-07T10:00:00.000Z',
        to: '2026-03-07T10:15:00.000Z',
        bucketMs: 5000,
        maxPoints: 120,
        eventsPage: 1,
        eventsPageSize: 8,
    });

    const differentScope = buildTcaCacheKey({
        scope: 'modal',
        subAccountId: 'sub-1',
        strategySessionId: 'scalper-1',
        executionScope: 'MAIN_ACCOUNT',
        ownershipConfidence: 'HARD',
        sections: ['detail', 'timeseries'],
        from: '2026-03-07T10:00:00.000Z',
        to: '2026-03-07T10:15:00.000Z',
        bucketMs: 5000,
        maxPoints: 120,
        eventsPage: 1,
        eventsPageSize: 8,
    });

    const differentWindow = buildTcaCacheKey({
        scope: 'modal',
        subAccountId: 'sub-1',
        strategySessionId: 'scalper-1',
        executionScope: 'SUB_ACCOUNT',
        ownershipConfidence: 'HARD',
        sections: ['detail', 'timeseries'],
        from: '2026-03-07T09:00:00.000Z',
        to: '2026-03-07T10:00:00.000Z',
        bucketMs: 30000,
        maxPoints: 120,
        eventsPage: 1,
        eventsPageSize: 8,
    });

    assert.notEqual(base, differentScope);
    assert.notEqual(base, differentWindow);
});

test('createScopedAsyncCache dedupes identical in-flight misses', async () => {
    const cache = createScopedAsyncCache({
        ttlMs: 10_000,
        maxEntries: 4,
        maxBytes: 128 * 1024,
        globalBudget: { bytes: 0, maxBytes: 256 * 1024 },
    });
    let loaderCalls = 0;

    const loader = async () => {
        loaderCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, value: 42 };
    };

    const [left, right] = await Promise.all([
        cache.getOrCreate('same-key', loader),
        cache.getOrCreate('same-key', loader),
    ]);

    assert.equal(loaderCalls, 1);
    assert.deepEqual(left, right);
    assert.equal(cache.inflightSize, 0);
    assert.deepEqual(cache.get('same-key'), { ok: true, value: 42 });
});
