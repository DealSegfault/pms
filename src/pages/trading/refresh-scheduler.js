import * as S from './state.js';
import { noteQueueDepth } from './perf-metrics.js';

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
            if (next.openOrders) tasks.push(positionsPanel.loadOpenOrders());
            if (next.positions) tasks.push(positionsPanel.loadTradingPositions());
            if (next.annotations) tasks.push(positionsPanel.loadChartAnnotations(!!next.forceAnnotations));
        }

        if (next.account) {
            const orderForm = await _ensureOrderFormModule();
            tasks.push(orderForm.updateAccountDisplay());
        }

        if (tasks.length > 0) {
            await Promise.allSettled(tasks);
        }
    } catch (err) {
        console.debug('[RefreshScheduler] refresh flush error:', err?.message || err);
    } finally {
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
