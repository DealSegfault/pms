import test from 'node:test';
import assert from 'node:assert/strict';

import { createTcaInstrumentation } from '../../src/pages/tca/instrumentation.js';

test('TCA instrumentation tracks render, fetch, and schedule counters', () => {
    const instrumentation = createTcaInstrumentation({ enabled: true });

    instrumentation.recordRender('hero', {
        changed: true,
        durationMs: 1.75,
        reason: 'mount',
        domNodes: 12,
    });
    instrumentation.recordSchedule('ws.strategy-detail-refresh', {
        delayMs: 300,
        source: 'websocket',
    });
    const fetchTrace = instrumentation.beginFetch('strategy.timeseries', {
        path: '/trade/tca/strategy-session-timeseries/sub-1/scalper-1',
    });
    fetchTrace.finish('ok');

    const snapshot = instrumentation.snapshot();
    assert.equal(snapshot.renders.hero.count, 1);
    assert.equal(snapshot.renders.hero.changed, 1);
    assert.equal(snapshot.renders.hero.lastReason, 'mount');
    assert.equal(snapshot.fetches['strategy.timeseries'].started, 1);
    assert.equal(snapshot.fetches['strategy.timeseries'].ok, 1);
    assert.equal(snapshot.fetches['strategy.timeseries'].inflight, 0);
    assert.equal(snapshot.schedules['ws.strategy-detail-refresh'].count, 1);
    assert.ok(snapshot.events.some((event) => event.type === 'fetch:ok' && event.name === 'strategy.timeseries'));
});
