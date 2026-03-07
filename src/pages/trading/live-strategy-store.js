import { api } from '../../core/index.js';

const LIVE_SAMPLE_CAP = 720;
const LIVE_SAMPLE_WINDOW_MS = 60 * 60 * 1000;

const accountStores = new Map();
const listeners = new Set();
let eventsBound = false;

function nowMs() {
    return Date.now();
}

function normalizeId(value) {
    return String(value || '');
}

function normalizeSample(sample = {}) {
    const sampledAt = new Date(sample.sampledAt || sample.timestamp || Date.now());
    return {
        strategySessionId: normalizeId(sample.strategySessionId),
        subAccountId: normalizeId(sample.subAccountId),
        symbol: sample.symbol || '',
        status: sample.status || 'ACTIVE',
        sampledAt: Number.isNaN(sampledAt.getTime()) ? new Date() : sampledAt,
        netPnl: Number(sample.netPnl || 0),
        realizedPnl: Number(sample.realizedPnl || 0),
        unrealizedPnl: Number(sample.unrealizedPnl || 0),
        openQty: Number(sample.openQty || 0),
        openNotional: Number(sample.openNotional || 0),
        fillCount: Number(sample.fillCount || 0),
        closeCount: Number(sample.closeCount || 0),
        winCount: Number(sample.winCount || 0),
        lossCount: Number(sample.lossCount || 0),
        longActiveSlots: Number(sample.longActiveSlots || 0),
        shortActiveSlots: Number(sample.shortActiveSlots || 0),
        longPausedSlots: Number(sample.longPausedSlots || 0),
        shortPausedSlots: Number(sample.shortPausedSlots || 0),
        longRetryingSlots: Number(sample.longRetryingSlots || 0),
        shortRetryingSlots: Number(sample.shortRetryingSlots || 0),
    };
}

function trimSamples(samples = []) {
    const cutoff = nowMs() - LIVE_SAMPLE_WINDOW_MS;
    const filtered = samples
        .filter((sample) => sample?.sampledAt instanceof Date && sample.sampledAt.getTime() >= cutoff)
        .sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime());
    return filtered.slice(-LIVE_SAMPLE_CAP);
}

function getAccountStore(subAccountId) {
    const key = normalizeId(subAccountId);
    if (!accountStores.has(key)) {
        accountStores.set(key, {
            scalpers: new Map(),
            chases: new Map(),
            samples: new Map(),
            bootstrapped: false,
            bootstrapPromise: null,
            samplePromises: new Map(),
        });
    }
    return accountStores.get(key);
}

function notify(subAccountId, strategySessionId = null) {
    for (const listener of listeners) {
        try {
            listener({
                subAccountId: normalizeId(subAccountId),
                strategySessionId: strategySessionId ? normalizeId(strategySessionId) : null,
            });
        } catch {
            // Ignore listener errors to keep the live store hot path safe.
        }
    }
}

function upsertScalper(subAccountId, scalper) {
    const account = getAccountStore(subAccountId);
    account.scalpers.set(normalizeId(scalper.scalperId), { ...scalper });
    notify(subAccountId, scalper.scalperId);
}

function removeScalper(subAccountId, scalperId) {
    const account = getAccountStore(subAccountId);
    account.scalpers.delete(normalizeId(scalperId));
    for (const [chaseId, chase] of account.chases.entries()) {
        if (normalizeId(chase.parentScalperId) === normalizeId(scalperId)) {
            account.chases.delete(chaseId);
        }
    }
    notify(subAccountId, scalperId);
}

function upsertChase(subAccountId, chase) {
    const account = getAccountStore(subAccountId);
    account.chases.set(normalizeId(chase.chaseId), { ...chase });
    notify(subAccountId, chase.parentScalperId || null);
}

function removeChase(subAccountId, chaseId, parentScalperId = null) {
    const account = getAccountStore(subAccountId);
    account.chases.delete(normalizeId(chaseId));
    notify(subAccountId, parentScalperId);
}

function appendSample(subAccountId, strategySessionId, sample) {
    const account = getAccountStore(subAccountId);
    const key = normalizeId(strategySessionId);
    const next = trimSamples([...(account.samples.get(key) || []), normalizeSample(sample)]);
    account.samples.set(key, next);
    notify(subAccountId, key);
}

function replaceSamples(subAccountId, strategySessionId, samples = []) {
    const account = getAccountStore(subAccountId);
    account.samples.set(
        normalizeId(strategySessionId),
        trimSamples((samples || []).map((sample) => normalizeSample(sample))),
    );
    notify(subAccountId, strategySessionId);
}

function bindEvents() {
    if (eventsBound || typeof window === 'undefined') return;
    eventsBound = true;

    window.addEventListener('scalper_progress', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.scalperId) return;
        upsertScalper(payload.subAccountId, payload);
    });

    window.addEventListener('scalper_filled', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.scalperId) return;
        const account = getAccountStore(payload.subAccountId);
        const current = account.scalpers.get(normalizeId(payload.scalperId)) || {};
        upsertScalper(payload.subAccountId, {
            ...current,
            ...payload,
            totalFillCount: payload.totalFillCount ?? current.totalFillCount ?? 0,
        });
    });

    window.addEventListener('scalper_cancelled', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.scalperId) return;
        removeScalper(payload.subAccountId, payload.scalperId);
    });

    window.addEventListener('chase_progress', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.chaseId) return;
        upsertChase(payload.subAccountId, payload);
    });

    window.addEventListener('chase_filled', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.chaseId) return;
        removeChase(payload.subAccountId, payload.chaseId, payload.parentScalperId || null);
    });

    window.addEventListener('chase_cancelled', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.chaseId) return;
        removeChase(payload.subAccountId, payload.chaseId, payload.parentScalperId || null);
    });

    window.addEventListener('strategy_sample', (event) => {
        const payload = event.detail || {};
        if (!payload.subAccountId || !payload.strategySessionId) return;
        appendSample(payload.subAccountId, payload.strategySessionId, payload);
    });
}

export function primeLiveAlgoState(subAccountId, payload = {}) {
    bindEvents();
    const account = getAccountStore(subAccountId);
    account.scalpers.clear();
    account.chases.clear();
    for (const scalper of payload.scalpers || []) {
        if (!scalper?.scalperId) continue;
        account.scalpers.set(normalizeId(scalper.scalperId), { ...scalper });
    }
    for (const chase of payload.chases || []) {
        if (!chase?.chaseId) continue;
        account.chases.set(normalizeId(chase.chaseId), { ...chase });
    }
    account.bootstrapped = true;
    notify(subAccountId);
}

export async function ensureLiveAlgoState(subAccountId) {
    bindEvents();
    const account = getAccountStore(subAccountId);
    if (account.bootstrapped) {
        return {
            scalpers: Array.from(account.scalpers.values()),
            chases: Array.from(account.chases.values()),
        };
    }
    if (!account.bootstrapPromise) {
        account.bootstrapPromise = api(`/trade/live/algo-state/${subAccountId}`)
            .then((payload) => {
                primeLiveAlgoState(subAccountId, payload || {});
                return payload || { scalpers: [], chases: [] };
            })
            .finally(() => {
                account.bootstrapPromise = null;
            });
    }
    return account.bootstrapPromise;
}

export async function ensureLiveStrategySamples(subAccountId, strategySessionId, { points = 180, force = false } = {}) {
    bindEvents();
    const account = getAccountStore(subAccountId);
    const key = normalizeId(strategySessionId);
    if (!force && (account.samples.get(key) || []).length) {
        return account.samples.get(key);
    }
    if (!force && account.samplePromises.has(key)) {
        return account.samplePromises.get(key);
    }
    const promise = api(`/trade/live/strategy-samples/${subAccountId}/${strategySessionId}?points=${Math.max(10, points)}`)
        .then((payload) => {
            replaceSamples(subAccountId, strategySessionId, payload?.points || []);
            return account.samples.get(key) || [];
        })
        .finally(() => {
            account.samplePromises.delete(key);
        });
    account.samplePromises.set(key, promise);
    return promise;
}

export function getStrategyLiveState(subAccountId, strategySessionId) {
    bindEvents();
    const account = getAccountStore(subAccountId);
    const key = normalizeId(strategySessionId);
    const scalper = account.scalpers.get(key) || null;
    const chases = Array.from(account.chases.values())
        .filter((chase) => normalizeId(chase.parentScalperId) === key)
        .sort((left, right) => Number(left.currentOrderPrice || 0) - Number(right.currentOrderPrice || 0));
    const samples = account.samples.get(key) || [];
    return {
        scalper,
        chases,
        samples,
        bootstrapped: account.bootstrapped,
    };
}

export function subscribeLiveStrategyStore(listener) {
    bindEvents();
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}
