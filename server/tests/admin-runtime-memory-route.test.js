import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import adminRouter from '../routes/admin.js';
import {
    __resetRuntimeMemorySnapshotProviderForTests,
    __setRuntimeMemorySnapshotProviderForTests,
} from '../runtime-metrics.js';

async function withAdminServer(run) {
    const app = express();
    app.use((req, _res, next) => {
        req.user = { id: 'admin-user', role: 'ADMIN' };
        next();
    });
    app.use('/api/admin', adminRouter);

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

test('GET /api/admin/runtime/memory returns the runtime snapshot payload', async () => {
    __setRuntimeMemorySnapshotProviderForTests(() => ({
        sampledAt: '2026-03-07T10:00:00.000Z',
        budgetMb: { hostTotal: 1024, warn: 700, critical: 850, minAvailable: 128 },
        system: { totalMb: 1024, freeMb: 256, availableMb: 200, loadAvg1m: 0.5, swapFreeMb: 0 },
        node: { pid: 123, rssMb: 90, heapUsedMb: 30, heapTotalMb: 40, externalMb: 5, uptimeSec: 12 },
        python: { pid: 456, running: true, rssMb: 120, restartAttempt: 0 },
        postgres: {
            hostMode: 'local',
            localRssMb: 160,
            processCount: 4,
            connections: { total: 3, active: 1, idle: 2, idleInTxn: 0 },
            oldestActiveQuerySec: 1.2,
            activeQueries: [],
            databaseSizeMb: 512,
        },
        combinedLocalRssMb: 370,
        memoryPressure: { warn: false, critical: false, availableBelowFloor: false },
    }));

    try {
        await withAdminServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/admin/runtime/memory`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.node.pid, 123);
            assert.equal(payload.python.pid, 456);
            assert.equal(payload.postgres.localRssMb, 160);
            assert.equal(payload.combinedLocalRssMb, 370);
        });
    } finally {
        __resetRuntimeMemorySnapshotProviderForTests();
    }
});
