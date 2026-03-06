const MAX_EVENTS = 64;

function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function isoNow() {
    return new Date().toISOString();
}

function pushBounded(list, item, max = MAX_EVENTS) {
    list.unshift(item);
    if (list.length > max) {
        list.length = max;
    }
}

function createRenderBucket() {
    return {
        count: 0,
        changed: 0,
        skipped: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        lastDurationMs: 0,
        lastReason: null,
        lastDomNodes: 0,
        lastUpdatedAt: null,
    };
}

function createFetchBucket() {
    return {
        started: 0,
        ok: 0,
        error: 0,
        abort: 0,
        inflight: 0,
        maxInflight: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        lastDurationMs: 0,
        lastPath: null,
        lastMeta: null,
        lastUpdatedAt: null,
    };
}

function createScheduleBucket() {
    return {
        count: 0,
        lastDelayMs: 0,
        lastSource: null,
        lastUpdatedAt: null,
    };
}

function ensureBucket(collection, key, createBucket) {
    if (!collection[key]) {
        collection[key] = createBucket();
    }
    return collection[key];
}

export function createTcaInstrumentation({ enabled = false } = {}) {
    const state = {
        enabled: Boolean(enabled),
        mountedAt: isoNow(),
        renders: {},
        fetches: {},
        schedules: {},
        events: [],
    };

    function addEvent(type, name, data = {}) {
        if (!state.enabled) return;
        pushBounded(state.events, {
            ts: isoNow(),
            type,
            name,
            ...data,
        });
    }

    return {
        setEnabled(nextEnabled) {
            state.enabled = Boolean(nextEnabled);
        },
        isEnabled() {
            return state.enabled;
        },
        reset() {
            state.renders = {};
            state.fetches = {};
            state.schedules = {};
            state.events = [];
            state.mountedAt = isoNow();
        },
        recordRender(name, {
            changed = false,
            durationMs = 0,
            reason = 'state',
            domNodes = 0,
        } = {}) {
            const bucket = ensureBucket(state.renders, name, createRenderBucket);
            const duration = Number(durationMs || 0);
            bucket.count += 1;
            bucket.changed += changed ? 1 : 0;
            bucket.skipped += changed ? 0 : 1;
            bucket.totalDurationMs += duration;
            bucket.maxDurationMs = Math.max(bucket.maxDurationMs, duration);
            bucket.lastDurationMs = duration;
            bucket.lastReason = reason || 'state';
            bucket.lastDomNodes = Number(domNodes || 0);
            bucket.lastUpdatedAt = isoNow();
            addEvent('render', name, {
                changed: Boolean(changed),
                durationMs: Number(duration.toFixed(2)),
                reason: bucket.lastReason,
                domNodes: bucket.lastDomNodes,
            });
        },
        beginFetch(name, {
            path = name,
            ...meta
        } = {}) {
            const bucket = ensureBucket(state.fetches, name, createFetchBucket);
            const startedAt = nowMs();
            let finished = false;

            bucket.started += 1;
            bucket.inflight += 1;
            bucket.maxInflight = Math.max(bucket.maxInflight, bucket.inflight);
            bucket.lastPath = path || name;
            bucket.lastMeta = meta;
            bucket.lastUpdatedAt = isoNow();
            addEvent('fetch:start', name, { path: bucket.lastPath });

            return {
                finish(status = 'ok', extra = {}) {
                    if (finished) return;
                    finished = true;

                    const duration = Number((nowMs() - startedAt).toFixed(2));
                    bucket.inflight = Math.max(0, bucket.inflight - 1);
                    if (status === 'abort') bucket.abort += 1;
                    else if (status === 'error') bucket.error += 1;
                    else bucket.ok += 1;
                    bucket.totalDurationMs += duration;
                    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, duration);
                    bucket.lastDurationMs = duration;
                    bucket.lastUpdatedAt = isoNow();
                    bucket.lastMeta = {
                        ...meta,
                        ...extra,
                    };
                    addEvent(`fetch:${status}`, name, {
                        durationMs: duration,
                        path: bucket.lastPath,
                    });
                },
            };
        },
        recordSchedule(name, {
            delayMs = 0,
            source = 'unknown',
        } = {}) {
            const bucket = ensureBucket(state.schedules, name, createScheduleBucket);
            bucket.count += 1;
            bucket.lastDelayMs = Number(delayMs || 0);
            bucket.lastSource = source || 'unknown';
            bucket.lastUpdatedAt = isoNow();
            addEvent('schedule', name, {
                delayMs: bucket.lastDelayMs,
                source: bucket.lastSource,
            });
        },
        snapshot() {
            return JSON.parse(JSON.stringify(state));
        },
    };
}
