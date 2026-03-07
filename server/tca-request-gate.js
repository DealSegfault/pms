import { getRuntimeMemorySnapshot } from './runtime-metrics.js';

const SNAPSHOT_CACHE_TTL_MS = 250;

function readPositiveInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function deriveTcaReadCapacity(snapshot = {}) {
    const budget = snapshot?.budgetMb || {};
    const memoryPressure = snapshot?.memoryPressure || {};
    const availableMb = toFiniteNumber(snapshot?.system?.availableMb, 0);
    const minAvailableMb = toFiniteNumber(budget.minAvailable, 128);

    const criticalCapacity = readPositiveInt('TCA_READ_GATE_CRITICAL_CAPACITY', 1);
    const warnCapacity = readPositiveInt('TCA_READ_GATE_WARN_CAPACITY', 2);
    const normalCapacity = readPositiveInt('TCA_READ_GATE_NORMAL_CAPACITY', 4);

    if (memoryPressure.critical || availableMb < minAvailableMb) {
        return criticalCapacity;
    }
    if (memoryPressure.warn || availableMb < Math.ceil(minAvailableMb * 1.5)) {
        return Math.max(criticalCapacity, warnCapacity);
    }
    return Math.max(warnCapacity, normalCapacity);
}

export function classifyTcaReadWeight({
    route = 'unknown',
    sections = [],
    series = [],
    includeEvents = false,
    includeLineage = false,
    rangeMs = 0,
    maxPoints = 0,
} = {}) {
    const sectionSet = new Set((sections || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
    const seriesSet = new Set((series || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
    const boundedPoints = Math.max(0, Math.min(500, Number.parseInt(maxPoints, 10) || 0));
    const normalizedRoute = String(route || '').trim().toLowerCase();

    if (normalizedRoute === 'strategy-page') return 4;
    if (normalizedRoute === 'embed-summary') return 1;
    if (normalizedRoute === 'strategy-ledger') return 3;
    if (normalizedRoute === 'strategy-detail') {
        return includeLineage ? 2 : 1;
    }
    if (normalizedRoute === 'strategy-modal') {
        let weight = 0;
        if (sectionSet.has('detail')) weight += 1;
        if (sectionSet.has('ledger')) weight += 3;
        if (sectionSet.has('timeseries')) {
            weight += classifyTcaReadWeight({
                route: 'strategy-timeseries',
                series: Array.from(seriesSet),
                includeEvents,
                rangeMs,
                maxPoints: boundedPoints,
            });
        }
        return Math.max(1, Math.min(6, weight || 1));
    }
    if (normalizedRoute === 'strategy-timeseries') {
        let weight = 2;
        if (seriesSet.has('quality')) weight += 2;
        if (includeEvents) weight += 1;
        if (rangeMs > 60 * 60 * 1000) weight += 1;
        if (boundedPoints > 180) weight += 1;
        return Math.max(2, Math.min(6, weight));
    }
    return 1;
}

export class TcaReadAdmissionError extends Error {
    constructor(message = 'TCA read queue saturated under memory pressure', details = {}) {
        super(message);
        this.name = 'TcaReadAdmissionError';
        this.status = 503;
        this.code = 'TCA_READ_QUEUE_SATURATED';
        this.category = 'INFRA';
        this.retryable = true;
        this.details = details;
    }
}

function createSnapshotReader() {
    let cachedAt = 0;
    let cachedSnapshot = null;

    return async function getSnapshot() {
        const now = Date.now();
        if (cachedSnapshot && (now - cachedAt) < SNAPSHOT_CACHE_TTL_MS) {
            return cachedSnapshot;
        }
        cachedSnapshot = await getRuntimeMemorySnapshot();
        cachedAt = now;
        return cachedSnapshot;
    };
}

export function createTcaReadGate({
    maxQueue = readPositiveInt('TCA_READ_GATE_MAX_QUEUE', 48),
    queueTimeoutMs = readPositiveInt('TCA_READ_GATE_TIMEOUT_MS', 15_000),
    getSnapshot = createSnapshotReader(),
} = {}) {
    const queue = [];
    let activeWeight = 0;
    let draining = false;

    function rejectExpired() {
        const now = Date.now();
        for (let index = queue.length - 1; index >= 0; index -= 1) {
            const entry = queue[index];
            if (entry.expiresAt > now) continue;
            queue.splice(index, 1);
            entry.reject(new TcaReadAdmissionError(
                'TCA read waited too long for memory-safe admission',
                {
                    queueLength: queue.length,
                    waitMs: now - entry.enqueuedAt,
                    descriptor: entry.descriptor,
                },
            ));
        }
    }

    async function drain() {
        if (draining) return;
        draining = true;
        try {
            rejectExpired();
            while (queue.length > 0) {
                const snapshot = await getSnapshot();
                const capacity = Math.max(1, deriveTcaReadCapacity(snapshot));
                const availableWeight = capacity - activeWeight;

                if (availableWeight <= 0) return;

                const [entry] = queue;
                if (!entry) return;
                if (activeWeight > 0 && entry.weight > availableWeight) {
                    return;
                }

                queue.shift();
                const effectiveWeight = Math.min(Math.max(1, entry.weight), capacity);
                activeWeight += effectiveWeight;

                Promise.resolve()
                    .then(async () => {
                        const queuedMs = Date.now() - entry.enqueuedAt;
                        const value = await entry.task({
                            queueWaitMs: queuedMs,
                            gateCapacity: capacity,
                            gateWeight: entry.weight,
                        });
                        entry.resolve(value);
                    })
                    .catch(entry.reject)
                    .finally(() => {
                        activeWeight = Math.max(0, activeWeight - effectiveWeight);
                        void drain();
                    });
            }
        } finally {
            draining = false;
        }
    }

    async function run(descriptor, task) {
        const weight = Math.max(1, Number.parseInt(descriptor?.weight, 10) || 1);

        return new Promise((resolve, reject) => {
            rejectExpired();
            if (queue.length >= maxQueue) {
                reject(new TcaReadAdmissionError(undefined, {
                    queueLength: queue.length,
                    descriptor,
                }));
                return;
            }

            queue.push({
                descriptor,
                weight,
                task,
                resolve,
                reject,
                enqueuedAt: Date.now(),
                expiresAt: Date.now() + queueTimeoutMs,
            });
            void drain();
        });
    }

    function reset() {
        while (queue.length) {
            const entry = queue.shift();
            entry.reject(new TcaReadAdmissionError('TCA read queue reset', {
                descriptor: entry.descriptor,
            }));
        }
        activeWeight = 0;
        draining = false;
    }

    return {
        run,
        reset,
        get activeWeight() {
            return activeWeight;
        },
        get queueLength() {
            rejectExpired();
            return queue.length;
        },
    };
}

const defaultTcaReadGate = createTcaReadGate();

export async function runTcaReadTask(descriptor, task) {
    return defaultTcaReadGate.run(descriptor, task);
}

export const __tcaReadGateTestHooks = {
    defaultTcaReadGate,
};
