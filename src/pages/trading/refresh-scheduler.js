import * as S from './state.js';
import { noteQueueDepth, recordLatency } from './perf-metrics.js';

const pending = {
    openOrders: false,
    positions: false,
    annotations: false,
    forceAnnotations: false,
    account: false,
};

let timerId = null;
let inFlight = false;
let positionsModulePromise = null;
let orderFormModulePromise = null;

function _perfNow() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

function _timedTask(metricName, run) {
    const started = _perfNow();
    return Promise.resolve()
        .then(run)
        .finally(() => {
            recordLatency(metricName, _perfNow() - started);
        });
}

function _pendingCount() {
    let count = 0;
    if (pending.openOrders) count += 1;
    if (pending.positions) count += 1;
    if (pending.annotations) count += 1;
    if (pending.account) count += 1;
    return count;
}

function _markPending(opts) {
    pending.openOrders = pending.openOrders || !!opts.openOrders;
    pending.positions = pending.positions || !!opts.positions;
    pending.annotations = pending.annotations || !!opts.annotations;
    pending.forceAnnotations = pending.forceAnnotations || !!opts.forceAnnotations;
    pending.account = pending.account || !!opts.account;
}

function _consumePending() {
    const snapshot = { ...pending };
    pending.openOrders = false;
    pending.positions = false;
    pending.annotations = false;
    pending.forceAnnotations = false;
    pending.account = false;
    return snapshot;
}

function _ensurePositionsModule() {
    if (!positionsModulePromise) {
        positionsModulePromise = import('./positions-panel.js');
    }
    return positionsModulePromise;
}

function _ensureOrderFormModule() {
    if (!orderFormModulePromise) {
        orderFormModulePromise = import('./order-form.js');
    }
    return orderFormModulePromise;
}

async function _flushPendingRefreshes() {
    timerId = null;
    const flushStarted = _perfNow();
    if (!S._tradingMounted) {
        _consumePending();
        noteQueueDepth('refresh', 0);
        return;
    }

    if (inFlight) {
        scheduleTradingRefresh({}, 80);
        return;
    }

    const next = _consumePending();
    noteQueueDepth('refresh', _pendingCount());

    inFlight = true;
    try {
        const tasks = [];

        if (next.openOrders || next.positions || next.annotations) {
            const positionsPanel = await _ensurePositionsModule();
            if (next.openOrders) tasks.push(_timedTask('refresh_open_orders_ms', () => positionsPanel.loadOpenOrders()));
            if (next.positions) tasks.push(_timedTask('refresh_positions_ms', () => positionsPanel.loadTradingPositions()));
            if (next.annotations) tasks.push(_timedTask('refresh_annotations_ms', () => positionsPanel.loadChartAnnotations(!!next.forceAnnotations)));
        }

        if (next.account) {
            const orderForm = await _ensureOrderFormModule();
            tasks.push(_timedTask('refresh_account_ms', () => orderForm.updateAccountDisplay()));
        }

        if (tasks.length > 0) {
            await Promise.allSettled(tasks);
        }
    } catch (err) {
        console.debug('[RefreshScheduler] refresh flush error:', err?.message || err);
    } finally {
        recordLatency('refresh_flush_ms', _perfNow() - flushStarted);
        inFlight = false;
        if (_pendingCount() > 0) {
            scheduleTradingRefresh({}, 80);
        }
    }
}

export function scheduleTradingRefresh(opts = {}, delayMs = 120) {
    _markPending(opts);
    noteQueueDepth('refresh', _pendingCount());

    if (timerId != null) return;
    timerId = setTimeout(_flushPendingRefreshes, Math.max(0, delayMs));
}

export function clearTradingRefreshScheduler() {
    if (timerId != null) {
        clearTimeout(timerId);
        timerId = null;
    }
    inFlight = false;
    _consumePending();
    noteQueueDepth('refresh', 0);
}
