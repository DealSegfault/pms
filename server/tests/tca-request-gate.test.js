import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TcaReadAdmissionError,
    createTcaReadGate,
    deriveTcaReadCapacity,
} from '../tca-request-gate.js';

function buildSnapshot({
    availableMb = 256,
    warn = false,
    critical = false,
    minAvailable = 128,
} = {}) {
    return {
        budgetMb: {
            minAvailable,
        },
        system: {
            availableMb,
        },
        memoryPressure: {
            warn,
            critical,
        },
    };
}

test('deriveTcaReadCapacity collapses to one slot under critical pressure', () => {
    const capacity = deriveTcaReadCapacity(buildSnapshot({
        availableMb: 64,
        warn: true,
        critical: true,
    }));
    assert.equal(capacity, 1);
});

test('TCA read gate serializes overweight tasks when memory is tight', async () => {
    const gate = createTcaReadGate({
        getSnapshot: async () => buildSnapshot({
            availableMb: 64,
            warn: true,
            critical: true,
        }),
        maxQueue: 8,
        queueTimeoutMs: 2_000,
    });

    const events = [];
    let releaseFirst = null;

    const first = gate.run({ route: 'strategy-timeseries', weight: 4 }, async () => {
        events.push('first-start');
        await new Promise((resolve) => {
            releaseFirst = resolve;
        });
        events.push('first-end');
        return 'first';
    });

    const second = gate.run({ route: 'strategy-page', weight: 4 }, async () => {
        events.push('second-start');
        events.push('second-end');
        return 'second';
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(events, ['first-start']);

    releaseFirst();

    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('TCA read gate rejects new work when queue is saturated', async () => {
    const gate = createTcaReadGate({
        getSnapshot: async () => buildSnapshot({
            availableMb: 64,
            warn: true,
            critical: true,
        }),
        maxQueue: 1,
        queueTimeoutMs: 2_000,
    });

    let releaseFirst = null;
    const first = gate.run({ route: 'strategy-timeseries', weight: 4 }, async () => (
        new Promise((resolve) => {
            releaseFirst = () => resolve('first');
        })
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = gate.run({ route: 'strategy-page', weight: 4 }, async () => 'second');

    await new Promise((resolve) => setTimeout(resolve, 40));

    await assert.rejects(
        gate.run({ route: 'strategy-ledger', weight: 3 }, async () => 'third'),
        (error) => {
            assert.ok(error instanceof TcaReadAdmissionError);
            assert.equal(error.code, 'TCA_READ_QUEUE_SATURATED');
            return true;
        },
    );

    releaseFirst();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
});
