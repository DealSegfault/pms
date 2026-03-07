import { state, api, formatUsd, formatPrice, formatPnlClass, showToast } from '../core/index.js';
import { subscribeAppStore } from '../store/app-store.js';
import { cuteKey, cuteSadFace, cuteSpinner } from '../lib/cute-empty.js';
import { createTcaInstrumentation } from './tca/instrumentation.js';
import { ensureTcaPageShell, ensureTcaStrategyShell, patchTcaRegion } from './tca/render-islands.js';
import { openTcaStrategyModal } from './tca/strategy-modal.js';
import {
    ensureLiveAlgoState,
    ensureLiveStrategySamples,
    getStrategyLiveState,
    subscribeLiveStrategyStore,
} from './trading/live-strategy-store.js';

const TCA_TABS = new Set(['overview', 'lifecycles', 'strategies']);
const DEFAULT_TAB = 'overview';
const DEFAULT_SORT_BY = 'updatedAt';
const DEFAULT_SORT_DIR = 'desc';
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_STRATEGY_SORT_BY = 'updatedAt';
const DEFAULT_STRATEGY_SORT_DIR = 'desc';
const DEFAULT_STRATEGY_PAGE_SIZE = 25;
const DEFAULT_TIMELINE_PAGE_SIZE = 10;

const WS_LIFECYCLE_EVENTS = ['order_placed', 'order_active', 'order_filled', 'order_cancelled', 'order_failed'];
const WS_OVERVIEW_EVENTS = ['order_filled', 'order_cancelled', 'order_failed'];
const WS_STRATEGY_EVENTS = [
    'scalper_progress',
    'scalper_filled',
    'scalper_cancelled',
    'strategy_sample',
    'order_filled',
    'order_cancelled',
    'pnl_update',
    'position_updated',
    'position_closed',
];

const DEFAULT_FILTERS = {
    symbol: '',
    strategyType: '',
    finalStatus: 'FILLED',
    strategyStatus: 'ACTIVE',
    lookback: '7d',
    includeNonHard: false,
    benchmarkMs: 5000,
};

const ROLE_LABELS = {
    ENTRY: 'First entry into a new position path.',
    ADD: 'Adds more size into an existing root position.',
    UNWIND: 'Reduce-only close flow used to exit owned exposure.',
    FLATTEN: 'Forced or terminal flattening of residual position.',
    REPRICE: 'Replacement/amend flow. Not economic intent on its own.',
    HEDGE: 'Balancing leg used by neutral or paired logic.',
    UNKNOWN: 'Role metadata was missing at submit time, so TCA cannot classify intent precisely.',
};

const INFO_TIPS = {
    overviewScore: 'Composite 0-100 score from fill ratio, short-horizon markouts, arrival slippage, reject rate, and reprice load.',
    benchmarkPulse: 'Arrival slippage compares the fill versus the decision mid. Markout shows what happened after the fill at 1s, 5s, or 30s.',
    lifecycleQuality: 'Top line shows arrival slippage and the selected benchmark markout. Positive post-fill markout is favorable; negative means adverse selection.',
    lifecycleToxicity: 'Toxicity weights negative short-horizon markouts and absolute arrival slippage. Higher means the flow looked more toxic.',
    lifecycleLineage: 'Lineage tracks how the order was spawned through parent algos and replacement flows.',
    pnlCurve: '5-second economic samples. Net = realized + unrealized - fees. Exposure tracks open notional, so flat PnL with changing exposure is still meaningful.',
    parameterEvolution: 'Raw 5-second runtime checkpoints for scalper controls. Flat lines mean the parameter stayed constant, not that sampling stopped.',
    executionQuality: 'Arrival slippage measures entry quality at fill time. Markouts measure price movement after the fill. Negative short-horizon markouts imply more toxic flow.',
    stateTimeline: 'Recent runtime checkpoints only. This feed is paginated to keep the studio fast. Browse older pages for older pauses/restarts.',
    lifecycleDrawer: 'Lifecycle detail loads core execution facts first, then lineage in a separate request so the drawer stays responsive.',
};

const PAGE = {
    container: null,
    filters: { ...DEFAULT_FILTERS },
    tab: DEFAULT_TAB,
    sortBy: DEFAULT_SORT_BY,
    sortDir: DEFAULT_SORT_DIR,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    loading: false,
    error: null,
    overviewLoading: false,
    lifecycleLoading: false,
    data: {
        rollups: [],
        strategyRollups: [],
        strategySessions: [],
    },
    lifecyclePage: {
        items: [],
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasPrev: false,
        hasNext: false,
        sortBy: DEFAULT_SORT_BY,
        sortDir: DEFAULT_SORT_DIR,
    },
    strategyPage: {
        items: [],
        page: 1,
        pageSize: DEFAULT_STRATEGY_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasPrev: false,
        hasNext: false,
        sortBy: DEFAULT_STRATEGY_SORT_BY,
        sortDir: DEFAULT_STRATEGY_SORT_DIR,
    },
    strategyTimelinePage: 1,
    strategyTimelinePageSize: DEFAULT_TIMELINE_PAGE_SIZE,
    selectedLifecycleId: null,
    selectedStrategySessionId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    strategyLoading: false,
    strategyDetailLoading: false,
    strategyTimeseriesLoading: false,
    strategyLedgerLoading: false,
    strategyLineageLoading: false,
    strategyParamsExpanded: false,
    strategyDetail: null,
    strategyTimeseries: null,
    strategyLedger: null,
    unsubscribe: null,
    liveStoreUnsubscribe: null,
    refreshTimer: null,
    strategyLiveTimer: null,
    inputTimer: null,
    wsLifecycleTimer: null,
    wsOverviewTimer: null,
    wsDetailTimer: null,
    wsStrategyListTimer: null,
    wsStrategyDetailTimer: null,
    requestSeqOverview: 0,
    requestSeqLifecycle: 0,
    detailSeq: 0,
    detailLineageSeq: 0,
    requestSeqStrategy: 0,
    requestSeqStrategyDetail: 0,
    requestSeqStrategyTimeseries: 0,
    requestSeqStrategyLedger: 0,
    requestSeqStrategyLineage: 0,
    onClick: null,
    onInput: null,
    onChange: null,
    _lifecycleHandler: null,
    _lifecycleByOrderHandler: null,
    wsHandlers: [],
    controllers: {
        overview: null,
        lifecycles: null,
        detail: null,
        detailLineage: null,
        strategies: null,
        strategyDetail: null,
        strategyTimeseries: null,
        strategyLedger: null,
        strategyLineage: null,
    },
    pendingStrategyRefresh: null,
    graphTruncatedCount: 0,
    truncatedLifecycleIds: new Set(),
    debugPerf: false,
    instrumentation: createTcaInstrumentation(),
};

function readPersistedDebugPerf() {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    try {
        return window.localStorage.getItem('tca.debugPerf') === '1';
    } catch {
        return false;
    }
}

function persistDebugPerf(enabled) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        if (enabled) {
            window.localStorage.setItem('tca.debugPerf', '1');
        } else {
            window.localStorage.removeItem('tca.debugPerf');
        }
    } catch {
        // Ignore storage failures in private contexts.
    }
}

function publishDebugApi() {
    if (typeof window === 'undefined') return;
    window.__TCA_DEBUG = {
        snapshot: () => PAGE.instrumentation.snapshot(),
        reset: () => {
            PAGE.instrumentation.reset();
            render('debug-reset');
        },
        enable: () => {
            PAGE.debugPerf = true;
            PAGE.instrumentation.setEnabled(true);
            persistDebugPerf(true);
            syncHashState();
            render('debug-enable');
        },
        disable: () => {
            PAGE.debugPerf = false;
            PAGE.instrumentation.setEnabled(false);
            persistDebugPerf(false);
            syncHashState();
            render('debug-disable');
        },
    };
}

async function tcaApi(path, options = {}, meta = {}) {
    const trace = PAGE.instrumentation.beginFetch(meta.key || path, {
        path,
        ...meta,
    });
    try {
        const payload = await api(path, options);
        trace.finish('ok');
        return payload;
    } catch (err) {
        trace.finish(err?.name === 'AbortError' ? 'abort' : 'error', {
            message: err?.message || null,
        });
        throw err;
    }
}

export function renderTcaPage(container) {
    cleanup();

    PAGE.container = container;
    PAGE.instrumentation.reset();
    PAGE.filters = { ...DEFAULT_FILTERS };
    PAGE.tab = DEFAULT_TAB;
    PAGE.sortBy = DEFAULT_SORT_BY;
    PAGE.sortDir = DEFAULT_SORT_DIR;
    PAGE.page = 1;
    PAGE.pageSize = DEFAULT_PAGE_SIZE;
    PAGE.loading = false;
    PAGE.error = null;
    PAGE.overviewLoading = false;
    PAGE.lifecycleLoading = false;
    PAGE.data = {
        rollups: [],
        strategyRollups: [],
        strategySessions: [],
    };
    PAGE.lifecyclePage = {
        items: [],
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasPrev: false,
        hasNext: false,
        sortBy: DEFAULT_SORT_BY,
        sortDir: DEFAULT_SORT_DIR,
    };
    PAGE.strategyPage = {
        items: [],
        page: 1,
        pageSize: DEFAULT_STRATEGY_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasPrev: false,
        hasNext: false,
        sortBy: DEFAULT_STRATEGY_SORT_BY,
        sortDir: DEFAULT_STRATEGY_SORT_DIR,
    };
    PAGE.strategyTimelinePage = 1;
    PAGE.strategyTimelinePageSize = DEFAULT_TIMELINE_PAGE_SIZE;
    PAGE.selectedLifecycleId = null;
    PAGE.selectedStrategySessionId = null;
    PAGE.detail = null;
    PAGE.detailLoading = false;
    PAGE.detailError = null;
    PAGE.strategyLoading = false;
    PAGE.strategyDetailLoading = false;
    PAGE.strategyTimeseriesLoading = false;
    PAGE.strategyLedgerLoading = false;
    PAGE.strategyLineageLoading = false;
    PAGE.strategyParamsExpanded = false;
    PAGE.strategyDetail = null;
    PAGE.strategyTimeseries = null;
    PAGE.strategyLedger = null;
    PAGE.pendingStrategyRefresh = null;
    PAGE.graphTruncatedCount = 0;
    PAGE.truncatedLifecycleIds = new Set();
    PAGE.debugPerf = readPersistedDebugPerf();

    applyHashState(parseTcaHashState(location.hash));
    PAGE.instrumentation.setEnabled(PAGE.debugPerf);
    publishDebugApi();
    bindEvents();
    syncHashState();

    PAGE.unsubscribe = subscribeAppStore(({ type }) => {
        if (type === 'currentAccount' && location.hash.startsWith('#/tca')) {
            PAGE.selectedLifecycleId = null;
            PAGE.selectedStrategySessionId = null;
            PAGE.detail = null;
            PAGE.detailError = null;
            PAGE.strategyDetail = null;
            PAGE.strategyTimeseries = null;
            PAGE.strategyLedger = null;
            PAGE.page = 1;
            PAGE.strategyPage.page = 1;
            PAGE.strategyTimelinePage = 1;
            loadInitialData();
        }
    });
    PAGE.liveStoreUnsubscribe = subscribeLiveStrategyStore((change) => {
        handleStrategyLiveStoreChange(change);
    });

    PAGE.refreshTimer = setInterval(() => {
        if (!PAGE.container || !location.hash.startsWith('#/tca')) return;
        PAGE.instrumentation.recordSchedule('timer.page-refresh', { delayMs: 30000, source: 'interval' });
        refreshFromTimer();
    }, 30000);

    PAGE.strategyLiveTimer = setInterval(() => {
        if (!PAGE.container || PAGE.tab !== 'strategies' || !PAGE.selectedStrategySessionId) return;
        if (!isSelectedStrategyLive()) return;
        PAGE.instrumentation.recordSchedule('timer.strategy-live', { delayMs: 5000, source: 'interval' });
        void ensureSelectedStrategyLiveHydrated();
    }, 5000);

    PAGE._lifecycleHandler = (e) => {
        const id = e?.detail?.lifecycleId;
        if (!id || !PAGE.container) return;
        PAGE.tab = 'lifecycles';
        PAGE.selectedLifecycleId = id;
        PAGE.detail = null;
        syncHashState();
        render('external-open-lifecycle');
        loadLifecycleDetail(id);
    };
    window.addEventListener('open_lifecycle', PAGE._lifecycleHandler);

    PAGE._lifecycleByOrderHandler = async (e) => {
        const clientOrderId = e?.detail?.clientOrderId;
        if (!clientOrderId || !PAGE.container || !state.currentAccount) return;

        const existing = (PAGE.lifecyclePage?.items || []).find((lc) => lc.clientOrderId === clientOrderId);
        if (existing) {
            PAGE.tab = 'lifecycles';
            PAGE.selectedLifecycleId = existing.lifecycleId;
            PAGE.detail = null;
            syncHashState();
            render('lookup-open-lifecycle');
            loadLifecycleDetail(existing.lifecycleId);
            return;
        }

        try {
            const results = await tcaApi(
                `/trade/tca/lifecycles/${state.currentAccount}?clientOrderId=${encodeURIComponent(clientOrderId)}&limit=1`,
                {},
                { key: 'lookup.lifecycle-by-order' },
            );
            const lc = Array.isArray(results) && results[0];
            if (lc?.lifecycleId) {
                PAGE.tab = 'lifecycles';
                PAGE.selectedLifecycleId = lc.lifecycleId;
                PAGE.detail = null;
                syncHashState();
                render('lookup-open-lifecycle');
                loadLifecycleDetail(lc.lifecycleId);
            }
        } catch {
            showToast('Could not find lifecycle for this order', 'warning');
        }
    };
    window.addEventListener('open_lifecycle_by_order', PAGE._lifecycleByOrderHandler);

    registerWsRefreshListeners();
    render('mount');
    loadInitialData();
}

export function cleanup() {
    if (PAGE.refreshTimer) clearInterval(PAGE.refreshTimer);
    if (PAGE.strategyLiveTimer) clearInterval(PAGE.strategyLiveTimer);
    if (PAGE.inputTimer) clearTimeout(PAGE.inputTimer);
    if (PAGE.wsLifecycleTimer) clearTimeout(PAGE.wsLifecycleTimer);
    if (PAGE.wsOverviewTimer) clearTimeout(PAGE.wsOverviewTimer);
    if (PAGE.wsDetailTimer) clearTimeout(PAGE.wsDetailTimer);
    if (PAGE.wsStrategyListTimer) clearTimeout(PAGE.wsStrategyListTimer);
    if (PAGE.wsStrategyDetailTimer) clearTimeout(PAGE.wsStrategyDetailTimer);
    if (PAGE.unsubscribe) PAGE.unsubscribe();
    if (PAGE.liveStoreUnsubscribe) PAGE.liveStoreUnsubscribe();

    if (PAGE.controllers.overview) PAGE.controllers.overview.abort();
    if (PAGE.controllers.lifecycles) PAGE.controllers.lifecycles.abort();
    if (PAGE.controllers.detail) PAGE.controllers.detail.abort();
    if (PAGE.controllers.detailLineage) PAGE.controllers.detailLineage.abort();
    if (PAGE.controllers.strategies) PAGE.controllers.strategies.abort();
    if (PAGE.controllers.strategyDetail) PAGE.controllers.strategyDetail.abort();
    if (PAGE.controllers.strategyTimeseries) PAGE.controllers.strategyTimeseries.abort();
    if (PAGE.controllers.strategyLedger) PAGE.controllers.strategyLedger.abort();
    if (PAGE.controllers.strategyLineage) PAGE.controllers.strategyLineage.abort();

    if (PAGE.container && PAGE.onClick) PAGE.container.removeEventListener('click', PAGE.onClick);
    if (PAGE.container && PAGE.onInput) PAGE.container.removeEventListener('input', PAGE.onInput);
    if (PAGE.container && PAGE.onChange) PAGE.container.removeEventListener('change', PAGE.onChange);
    if (PAGE._lifecycleHandler) window.removeEventListener('open_lifecycle', PAGE._lifecycleHandler);
    if (PAGE._lifecycleByOrderHandler) window.removeEventListener('open_lifecycle_by_order', PAGE._lifecycleByOrderHandler);

    for (const { eventName, handler } of PAGE.wsHandlers) {
        window.removeEventListener(eventName, handler);
    }
    PAGE.wsHandlers = [];

    PAGE.container = null;
    PAGE.unsubscribe = null;
    PAGE.liveStoreUnsubscribe = null;
    PAGE.refreshTimer = null;
    PAGE.strategyLiveTimer = null;
    PAGE.inputTimer = null;
    PAGE.wsLifecycleTimer = null;
    PAGE.wsOverviewTimer = null;
    PAGE.wsDetailTimer = null;
    PAGE.wsStrategyListTimer = null;
    PAGE.wsStrategyDetailTimer = null;
    PAGE.strategyParamsExpanded = false;
    PAGE.onClick = null;
    PAGE.onInput = null;
    PAGE.onChange = null;
    PAGE._lifecycleHandler = null;
    PAGE._lifecycleByOrderHandler = null;
    PAGE.controllers.overview = null;
    PAGE.controllers.lifecycles = null;
    PAGE.controllers.detail = null;
    PAGE.controllers.detailLineage = null;
    PAGE.controllers.strategies = null;
    PAGE.controllers.strategyDetail = null;
    PAGE.controllers.strategyTimeseries = null;
    PAGE.controllers.strategyLedger = null;
    PAGE.controllers.strategyLineage = null;
    PAGE.debugPerf = false;
}

function parseTcaHashState(hash) {
    const stateFromHash = {
        tab: DEFAULT_TAB,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        sortBy: DEFAULT_SORT_BY,
        sortDir: DEFAULT_SORT_DIR,
        strategyPage: 1,
        strategyPageSize: DEFAULT_STRATEGY_PAGE_SIZE,
        strategySortBy: DEFAULT_STRATEGY_SORT_BY,
        strategySortDir: DEFAULT_STRATEGY_SORT_DIR,
        selectedStrategySessionId: null,
        filters: { ...DEFAULT_FILTERS },
        debugPerf: readPersistedDebugPerf(),
    };
    if (!hash || !hash.startsWith('#/tca')) return stateFromHash;
    const qIndex = hash.indexOf('?');
    if (qIndex < 0) return stateFromHash;

    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const tab = String(params.get('tab') || DEFAULT_TAB).toLowerCase();
    if (TCA_TABS.has(tab)) stateFromHash.tab = tab;

    stateFromHash.page = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);
    const pageSize = Number.parseInt(params.get('pageSize'), 10);
    stateFromHash.pageSize = PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;

    const sortBy = String(params.get('sortBy') || DEFAULT_SORT_BY);
    stateFromHash.sortBy = sortBy || DEFAULT_SORT_BY;
    stateFromHash.sortDir = String(params.get('sortDir') || DEFAULT_SORT_DIR).toLowerCase() === 'asc' ? 'asc' : 'desc';

    stateFromHash.filters.symbol = String(params.get('symbol') || '');
    stateFromHash.filters.strategyType = String(params.get('strategyType') || '');
    stateFromHash.filters.finalStatus = String(params.get('finalStatus') || DEFAULT_FILTERS.finalStatus);
    stateFromHash.filters.strategyStatus = String(params.get('sessionStatus') || DEFAULT_FILTERS.strategyStatus);
    stateFromHash.filters.lookback = String(params.get('lookback') || DEFAULT_FILTERS.lookback);
    stateFromHash.filters.includeNonHard = params.get('includeNonHard') === '1';
    stateFromHash.selectedStrategySessionId = String(params.get('sessionId') || '') || null;

    stateFromHash.strategyPage = Math.max(1, Number.parseInt(params.get('strategyPage'), 10) || 1);
    const strategyPageSize = Number.parseInt(params.get('strategyPageSize'), 10);
    stateFromHash.strategyPageSize = PAGE_SIZES.includes(strategyPageSize) ? strategyPageSize : DEFAULT_STRATEGY_PAGE_SIZE;
    stateFromHash.strategySortBy = String(params.get('strategySortBy') || DEFAULT_STRATEGY_SORT_BY) || DEFAULT_STRATEGY_SORT_BY;
    stateFromHash.strategySortDir = String(params.get('strategySortDir') || DEFAULT_STRATEGY_SORT_DIR).toLowerCase() === 'asc' ? 'asc' : 'desc';

    const benchmark = Number.parseInt(params.get('benchmarkMs'), 10);
    if ([1000, 5000, 30000].includes(benchmark)) stateFromHash.filters.benchmarkMs = benchmark;
    if (params.has('debugPerf')) stateFromHash.debugPerf = params.get('debugPerf') === '1';

    return stateFromHash;
}

function applyHashState(nextState) {
    PAGE.tab = nextState.tab;
    PAGE.page = nextState.page;
    PAGE.pageSize = nextState.pageSize;
    PAGE.sortBy = nextState.sortBy;
    PAGE.sortDir = nextState.sortDir;
    PAGE.strategyPage.page = nextState.strategyPage;
    PAGE.strategyPage.pageSize = nextState.strategyPageSize;
    PAGE.strategyPage.sortBy = nextState.strategySortBy;
    PAGE.strategyPage.sortDir = nextState.strategySortDir;
    PAGE.selectedStrategySessionId = nextState.selectedStrategySessionId;
    PAGE.filters = { ...DEFAULT_FILTERS, ...nextState.filters };
    PAGE.debugPerf = !!nextState.debugPerf;
    PAGE.instrumentation.setEnabled(PAGE.debugPerf);
    persistDebugPerf(PAGE.debugPerf);
}

function syncHashState() {
    const params = new URLSearchParams();
    params.set('tab', PAGE.tab);
    params.set('page', String(PAGE.page));
    params.set('pageSize', String(PAGE.pageSize));
    params.set('sortBy', PAGE.sortBy);
    params.set('sortDir', PAGE.sortDir);
    params.set('strategyPage', String(PAGE.strategyPage.page));
    params.set('strategyPageSize', String(PAGE.strategyPage.pageSize));
    params.set('strategySortBy', PAGE.strategyPage.sortBy);
    params.set('strategySortDir', PAGE.strategyPage.sortDir);
    if (PAGE.filters.symbol) params.set('symbol', PAGE.filters.symbol);
    if (PAGE.filters.strategyType) params.set('strategyType', PAGE.filters.strategyType);
    if (PAGE.filters.finalStatus) params.set('finalStatus', PAGE.filters.finalStatus);
    if (PAGE.filters.strategyStatus) params.set('sessionStatus', PAGE.filters.strategyStatus);
    if (PAGE.filters.lookback !== DEFAULT_FILTERS.lookback) params.set('lookback', PAGE.filters.lookback);
    if (PAGE.filters.includeNonHard) params.set('includeNonHard', '1');
    if (PAGE.filters.benchmarkMs !== DEFAULT_FILTERS.benchmarkMs) params.set('benchmarkMs', String(PAGE.filters.benchmarkMs));
    if (PAGE.selectedStrategySessionId) params.set('sessionId', PAGE.selectedStrategySessionId);
    if (PAGE.debugPerf) params.set('debugPerf', '1');
    const nextHash = `#/tca?${params.toString()}`;
    if (location.hash !== nextHash) {
        history.replaceState(null, '', nextHash);
    }
}

function renderInfoHelp(tip) {
    if (!tip) return '';
    return `<span class="tca-kpi-help">ⓘ<span class="tca-tip">${escapeHtml(tip)}</span></span>`;
}

function isSelectedStrategyLive() {
    const selected = PAGE.strategyPage.items.find((row) => row.strategySessionId === PAGE.selectedStrategySessionId);
    const runtimeStatus = PAGE.strategyDetail?.runtime?.status || selected?.runtimeStatus || '';
    return String(runtimeStatus).toUpperCase() === 'ACTIVE';
}

function eventStrategySessionId(detail) {
    return detail?.strategySessionId
        || detail?.strategy_session_id
        || detail?.scalperId
        || detail?.scalper_id
        || null;
}

function normalizeStrategySampleTime(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function mergeSortedSeriesPoints(points = [], incoming = [], maxPoints = 300) {
    const lookbackStart = getLookbackStart(PAGE.filters.lookback)?.getTime() || null;
    const merged = new Map();
    for (const row of [...(Array.isArray(points) ? points : []), ...(Array.isArray(incoming) ? incoming : [])]) {
        if (!row) continue;
        const ts = normalizeStrategySampleTime(row.ts);
        const tsMs = ts.getTime();
        if (lookbackStart && tsMs < lookbackStart) continue;
        const previous = merged.get(tsMs) || {};
        merged.set(tsMs, { ...previous, ...row, ts });
    }
    return Array.from(merged.entries())
        .sort((left, right) => left[0] - right[0])
        .slice(-Math.max(24, maxPoints))
        .map((entry) => entry[1]);
}

function toLivePnlPoint(sample) {
    return {
        ts: normalizeStrategySampleTime(sample.sampledAt),
        realizedPnl: Number(sample.realizedPnl || 0),
        unrealizedPnl: Number(sample.unrealizedPnl || 0),
        netPnl: Number(sample.netPnl || 0),
        openQty: Number(sample.openQty || 0),
        openNotional: Number(sample.openNotional || 0),
        fillCount: Number(sample.fillCount || 0),
        closeCount: Number(sample.closeCount || 0),
    };
}

function toLiveParamPoint(sample) {
    return {
        ts: normalizeStrategySampleTime(sample.sampledAt),
        longActiveSlots: Number(sample.longActiveSlots || 0),
        shortActiveSlots: Number(sample.shortActiveSlots || 0),
        longPausedSlots: Number(sample.longPausedSlots || 0),
        shortPausedSlots: Number(sample.shortPausedSlots || 0),
        longRetryingSlots: Number(sample.longRetryingSlots || 0),
        shortRetryingSlots: Number(sample.shortRetryingSlots || 0),
    };
}

function toSparklinePoint(sample) {
    return {
        ts: normalizeStrategySampleTime(sample.sampledAt),
        value: Number(sample.netPnl || 0),
    };
}

function mergeStrategyCardSparkline(existing = [], samples = []) {
    return mergeSortedSeriesPoints(existing, samples.map((sample) => toSparklinePoint(sample)), 30)
        .map((row) => ({ ts: row.ts, value: Number(row.value || 0) }));
}

function buildLatestPnlSample(sample) {
    return {
        sampledAt: normalizeStrategySampleTime(sample.sampledAt),
        realizedPnl: Number(sample.realizedPnl || 0),
        unrealizedPnl: Number(sample.unrealizedPnl || 0),
        netPnl: Number(sample.netPnl || 0),
        openQty: Number(sample.openQty || 0),
        openNotional: Number(sample.openNotional || 0),
        fillCount: Number(sample.fillCount || 0),
        closeCount: Number(sample.closeCount || 0),
        winCount: Number(sample.winCount || 0),
        lossCount: Number(sample.lossCount || 0),
    };
}

function applyStrategyLiveState(strategySessionId) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return false;
    const liveState = getStrategyLiveState(state.currentAccount, strategySessionId);
    const samples = Array.isArray(liveState.samples) ? liveState.samples : [];
    const latestSample = samples[samples.length - 1] || null;
    const runtimeStatus = liveState.scalper?.status || latestSample?.status || null;
    let changed = false;

    if (Array.isArray(PAGE.strategyPage.items) && PAGE.strategyPage.items.length) {
        let rowChanged = false;
        PAGE.strategyPage.items = PAGE.strategyPage.items.map((row) => {
            if (row.strategySessionId !== strategySessionId) return row;
            rowChanged = true;
            return {
                ...row,
                runtimeStatus: runtimeStatus || row.runtimeStatus,
                netPnl: latestSample?.netPnl ?? row.netPnl,
                realizedPnl: latestSample?.realizedPnl ?? row.realizedPnl,
                unrealizedPnl: latestSample?.unrealizedPnl ?? row.unrealizedPnl,
                openNotional: latestSample?.openNotional ?? row.openNotional,
                fillCount: latestSample?.fillCount ?? row.fillCount,
                closeCount: latestSample?.closeCount ?? row.closeCount,
                updatedAt: latestSample?.sampledAt || row.updatedAt,
                sparkline: samples.length ? mergeStrategyCardSparkline(row.sparkline || [], samples) : row.sparkline,
            };
        });
        changed = changed || rowChanged;
    }

    if (PAGE.selectedStrategySessionId !== strategySessionId) {
        return changed;
    }

    if (runtimeStatus || latestSample) {
        PAGE.strategyDetail = {
            ...(PAGE.strategyDetail || {}),
            runtime: {
                ...(PAGE.strategyDetail?.runtime || {}),
                status: runtimeStatus || PAGE.strategyDetail?.runtime?.status || 'ACTIVE',
            },
            latestPnlSample: latestSample
                ? {
                    ...(PAGE.strategyDetail?.latestPnlSample || {}),
                    ...buildLatestPnlSample(latestSample),
                }
                : (PAGE.strategyDetail?.latestPnlSample || null),
        };
        changed = true;
    }

    if (samples.length) {
        const previous = PAGE.strategyTimeseries || {
            series: {},
            events: { items: [], total: 0, page: PAGE.strategyTimelinePage, totalPages: 1 },
        };
        const nextSeries = {
            ...(previous.series || {}),
            pnl: mergeSortedSeriesPoints(previous.series?.pnl || [], samples.map((sample) => toLivePnlPoint(sample)), 300),
        };
        if (PAGE.strategyParamsExpanded || Array.isArray(previous.series?.params)) {
            nextSeries.params = mergeSortedSeriesPoints(previous.series?.params || [], samples.map((sample) => toLiveParamPoint(sample)), 300);
        }
        PAGE.strategyTimeseries = {
            ...previous,
            series: nextSeries,
        };
        changed = true;
    }

    return changed;
}

function handleStrategyLiveStoreChange(change) {
    if (!PAGE.container || !state.currentAccount) return;
    if (change?.subAccountId && change.subAccountId !== state.currentAccount) return;
    let changed = false;
    if (change?.strategySessionId) {
        changed = applyStrategyLiveState(change.strategySessionId);
    } else {
        for (const row of PAGE.strategyPage.items || []) {
            changed = applyStrategyLiveState(row.strategySessionId) || changed;
        }
        if (PAGE.selectedStrategySessionId) {
            changed = applyStrategyLiveState(PAGE.selectedStrategySessionId) || changed;
        }
    }
    if (changed) render('strategy-live-store-update');
}

async function ensureSelectedStrategyLiveHydrated({ forceSamples = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !PAGE.selectedStrategySessionId) return;
    if (!isSelectedStrategyLive()) return;
    const subAccountId = state.currentAccount;
    const strategySessionId = PAGE.selectedStrategySessionId;
    try {
        await ensureLiveAlgoState(subAccountId);
        await ensureLiveStrategySamples(subAccountId, strategySessionId, { points: 180, force: forceSamples });
        if (PAGE.selectedStrategySessionId !== strategySessionId || state.currentAccount !== subAccountId) return;
        if (applyStrategyLiveState(strategySessionId)) {
            render('strategy-live-hydrated');
        }
    } catch {
        // Keep the studio on the last known snapshot if the live bootstrap is unavailable.
    }
}

function roleDescription(role) {
    return ROLE_LABELS[String(role || 'UNKNOWN').toUpperCase()] || ROLE_LABELS.UNKNOWN;
}

function mergeStrategyLineage(strategySessionId, lineageGraph, lineGraphState = {}) {
    if (PAGE.selectedStrategySessionId !== strategySessionId) return;
    PAGE.strategyDetail = {
        ...(PAGE.strategyDetail || {}),
        lineageGraph: lineageGraph || null,
        lineageGraphLoading: !!lineGraphState.loading,
        lineageGraphError: lineGraphState.error || null,
    };
}

function hasRoleMetrics(roleMetrics) {
    return !!roleMetrics && Object.keys(roleMetrics).length > 0;
}

function aggregateRoleMetricMaps(metricMaps = []) {
    const buckets = new Map();
    for (const metricMap of metricMaps) {
        if (!metricMap || typeof metricMap !== 'object') continue;
        for (const [roleKey, metrics] of Object.entries(metricMap)) {
            const role = String(roleKey || 'UNKNOWN').toUpperCase();
            if (!metrics || typeof metrics !== 'object') continue;
            const bucket = buckets.get(role) || {
                lifecycleCount: 0,
                fillCount: 0,
                arrivalTotal: 0,
                arrivalWeight: 0,
                mark1Total: 0,
                mark1Weight: 0,
                mark5Total: 0,
                mark5Weight: 0,
                mark30Total: 0,
                mark30Weight: 0,
            };
            const lifecycleCount = Number.isFinite(metrics.lifecycleCount) ? Number(metrics.lifecycleCount) : 0;
            const fillCount = Number.isFinite(metrics.fillCount) ? Number(metrics.fillCount) : 0;
            const arrivalWeight = lifecycleCount > 0 ? lifecycleCount : (Number.isFinite(metrics.avgArrivalSlippageBps) ? 1 : 0);
            const markWeight = fillCount > 0 ? fillCount : (lifecycleCount > 0 ? lifecycleCount : 0);

            bucket.lifecycleCount += lifecycleCount;
            bucket.fillCount += fillCount;
            if (Number.isFinite(metrics.avgArrivalSlippageBps) && arrivalWeight > 0) {
                bucket.arrivalTotal += Number(metrics.avgArrivalSlippageBps) * arrivalWeight;
                bucket.arrivalWeight += arrivalWeight;
            }
            if (Number.isFinite(metrics.avgMarkout1sBps) && markWeight > 0) {
                bucket.mark1Total += Number(metrics.avgMarkout1sBps) * markWeight;
                bucket.mark1Weight += markWeight;
            }
            if (Number.isFinite(metrics.avgMarkout5sBps) && markWeight > 0) {
                bucket.mark5Total += Number(metrics.avgMarkout5sBps) * markWeight;
                bucket.mark5Weight += markWeight;
            }
            if (Number.isFinite(metrics.avgMarkout30sBps) && markWeight > 0) {
                bucket.mark30Total += Number(metrics.avgMarkout30sBps) * markWeight;
                bucket.mark30Weight += markWeight;
            }
            buckets.set(role, bucket);
        }
    }

    const out = {};
    for (const [role, bucket] of buckets.entries()) {
        const avgArrivalSlippageBps = bucket.arrivalWeight > 0 ? bucket.arrivalTotal / bucket.arrivalWeight : null;
        const avgMarkout1sBps = bucket.mark1Weight > 0 ? bucket.mark1Total / bucket.mark1Weight : null;
        const avgMarkout5sBps = bucket.mark5Weight > 0 ? bucket.mark5Total / bucket.mark5Weight : null;
        const avgMarkout30sBps = bucket.mark30Weight > 0 ? bucket.mark30Total / bucket.mark30Weight : null;
        out[role] = {
            lifecycleCount: bucket.lifecycleCount,
            fillCount: bucket.fillCount,
            avgArrivalSlippageBps,
            avgMarkout1sBps,
            avgMarkout5sBps,
            avgMarkout30sBps,
            toxicityScore: computeToxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps),
        };
    }
    return out;
}

function extractRoleMetricsFromLifecycleRows(lifecycles = []) {
    return aggregateRoleMetricMaps((lifecycles || []).map((row) => ({
        [String(row.orderRole || 'UNKNOWN').toUpperCase()]: {
            lifecycleCount: 1,
            fillCount: Number(row.fillCount || 0),
            avgArrivalSlippageBps: Number.isFinite(row.arrivalSlippageBps) ? row.arrivalSlippageBps : null,
            avgMarkout1sBps: Number.isFinite(row.avgMarkout1sBps) ? row.avgMarkout1sBps : null,
            avgMarkout5sBps: Number.isFinite(row.avgMarkout5sBps) ? row.avgMarkout5sBps : null,
            avgMarkout30sBps: Number.isFinite(row.avgMarkout30sBps) ? row.avgMarkout30sBps : null,
        },
    })));
}

function resolveLineageRoleMetrics(primaryRollup, strategyRollups = [], lifecycles = []) {
    const primaryMetrics = extractRoleMetrics(primaryRollup);
    if (hasRoleMetrics(primaryMetrics)) return primaryMetrics;
    const strategyMetrics = aggregateRoleMetricMaps((strategyRollups || []).map((row) => extractRoleMetrics(row)));
    if (hasRoleMetrics(strategyMetrics)) return strategyMetrics;
    return extractRoleMetricsFromLifecycleRows(lifecycles);
}

function ensureLineagePreviewSelection() {
    if (PAGE.tab !== 'lineage') return false;
    const items = Array.isArray(PAGE.lifecyclePage?.items) ? PAGE.lifecyclePage.items : [];
    if (!items.length) return false;
    const stillVisible = PAGE.selectedLifecycleId
        ? items.some((row) => row.lifecycleId === PAGE.selectedLifecycleId)
        : false;
    if (stillVisible) return false;
    PAGE.selectedLifecycleId = items[0].lifecycleId;
    PAGE.detail = null;
    PAGE.detailError = null;
    loadLifecycleDetail(PAGE.selectedLifecycleId, { silent: true });
    return true;
}

function bindEvents() {
    if (!PAGE.container) return;

    PAGE.onClick = (event) => {
        const actionEl = event.target.closest('[data-action]');
        if (actionEl) {
            const { action } = actionEl.dataset;
            if (action === 'refresh') {
                loadOverview();
                return;
            }
            if (action === 'refresh-lifecycles') {
                loadLifecyclePage();
                return;
            }
            if (action === 'refresh-strategies') {
                loadStrategyPage();
                if (PAGE.selectedStrategySessionId) loadStrategySessionBundle(PAGE.selectedStrategySessionId);
                return;
            }
            if (action === 'reset-debug-metrics') {
                PAGE.instrumentation.reset();
                render('debug-reset');
                return;
            }
            if (action === 'set-benchmark') {
                const next = Number.parseInt(actionEl.dataset.benchmarkMs || '', 10);
                if (Number.isFinite(next)) {
                    PAGE.filters.benchmarkMs = next;
                    syncHashState();
                    render('benchmark-change');
                }
                return;
            }
            if (action === 'set-tab') {
                const tab = String(actionEl.dataset.tab || '').toLowerCase();
                if (!TCA_TABS.has(tab)) return;
                PAGE.tab = tab;
                syncHashState();
                render('tab-change');
                if (tab === 'overview') loadOverview({ silent: true });
                if (tab === 'lifecycles') loadLifecyclePage({ silent: true });
                if (tab === 'strategies') {
                    loadStrategyPage({ silent: true });
                    if (PAGE.selectedStrategySessionId) loadStrategySessionBundle(PAGE.selectedStrategySessionId, { silent: true });
                }
                return;
            }
            if (action === 'close-drawer') {
                PAGE.selectedLifecycleId = null;
                PAGE.detail = null;
                PAGE.detailLoading = false;
                render('drawer-close');
                return;
            }
            if (action === 'open-lifecycle') {
                const lifecycleId = actionEl.dataset.lifecycleId;
                if (lifecycleId) {
                    PAGE.selectedLifecycleId = lifecycleId;
                    PAGE.detail = null;
                    PAGE.detailError = null;
                    render('open-lifecycle');
                    loadLifecycleDetail(lifecycleId);
                }
                return;
            }
            if (action === 'inspect-lineage') {
                const lifecycleId = actionEl.dataset.lifecycleId;
                if (lifecycleId) {
                    PAGE.tab = 'lifecycles';
                    PAGE.selectedLifecycleId = lifecycleId;
                    PAGE.detail = null;
                    PAGE.detailError = null;
                    syncHashState();
                    render('inspect-lineage');
                    loadLifecycleDetail(lifecycleId);
                }
                return;
            }
            if (action === 'set-page') {
                const page = Math.max(1, Number.parseInt(actionEl.dataset.page || '', 10) || 1);
                if (page === PAGE.page) return;
                PAGE.page = page;
                syncHashState();
                render('lifecycle-page-change');
                loadLifecyclePage({ silent: true });
                return;
            }
            if (action === 'sort-lifecycles') {
                const sortBy = String(actionEl.dataset.sortBy || DEFAULT_SORT_BY);
                if (sortBy === PAGE.sortBy) {
                    PAGE.sortDir = PAGE.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    PAGE.sortBy = sortBy;
                    PAGE.sortDir = 'desc';
                }
                PAGE.page = 1;
                syncHashState();
                render('lifecycle-sort-change');
                loadLifecyclePage({ silent: true });
                return;
            }
            if (action === 'jump-page') {
                const input = PAGE.container.querySelector('[data-jump-page]');
                const value = Number.parseInt(input?.value || '', 10);
                const maxPage = Math.max(1, PAGE.lifecyclePage.totalPages || 1);
                if (!Number.isFinite(value)) return;
                const nextPage = Math.min(maxPage, Math.max(1, value));
                if (nextPage === PAGE.page) return;
                PAGE.page = nextPage;
                syncHashState();
                render('lifecycle-jump-page');
                loadLifecyclePage({ silent: true });
                return;
            }
            if (action === 'open-strategy-session') {
                const strategySessionId = actionEl.dataset.sessionId;
                if (!strategySessionId) return;
                PAGE.selectedStrategySessionId = strategySessionId;
                PAGE.strategyTimelinePage = 1;
                PAGE.strategyParamsExpanded = false;
                PAGE.strategyDetail = null;
                PAGE.strategyTimeseries = null;
                PAGE.strategyLedger = null;
                PAGE.tab = 'strategies';
                syncHashState();
                render('strategy-open');
                loadStrategySessionBundle(strategySessionId);
                return;
            }
            if (action === 'open-strategy-modal') {
                const strategySessionId = actionEl.dataset.sessionId;
                const subAccountId = actionEl.dataset.subAccountId || state.currentAccount;
                if (!strategySessionId || !subAccountId) return;
                void openTcaStrategyModal({
                    subAccountId,
                    strategySessionId,
                });
                return;
            }
            if (action === 'toggle-parameter-evolution') {
                PAGE.strategyParamsExpanded = !PAGE.strategyParamsExpanded;
                render('toggle-params');
                if (PAGE.strategyParamsExpanded && PAGE.selectedStrategySessionId) {
                    loadStrategySessionBundle(PAGE.selectedStrategySessionId, {
                        silent: true,
                        parts: { detail: false, timeseries: true, ledger: false, lineage: false },
                    });
                }
                return;
            }
            if (action === 'set-timeline-page') {
                const page = Math.max(1, Number.parseInt(actionEl.dataset.page || '', 10) || 1);
                if (page === PAGE.strategyTimelinePage || !PAGE.selectedStrategySessionId) return;
                PAGE.strategyTimelinePage = page;
                render('timeline-page-change');
                loadStrategySessionBundle(PAGE.selectedStrategySessionId, {
                    silent: true,
                    parts: { detail: false, timeseries: true, ledger: false, lineage: false },
                });
                return;
            }
            if (action === 'set-strategy-page') {
                const page = Math.max(1, Number.parseInt(actionEl.dataset.page || '', 10) || 1);
                if (page === PAGE.strategyPage.page) return;
                PAGE.strategyPage.page = page;
                syncHashState();
                render('strategy-page-change');
                loadStrategyPage({ silent: true });
                return;
            }
            if (action === 'sort-strategies') {
                const sortBy = String(actionEl.dataset.sortBy || DEFAULT_STRATEGY_SORT_BY);
                if (sortBy === PAGE.strategyPage.sortBy) {
                    PAGE.strategyPage.sortDir = PAGE.strategyPage.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    PAGE.strategyPage.sortBy = sortBy;
                    PAGE.strategyPage.sortDir = 'desc';
                }
                PAGE.strategyPage.page = 1;
                syncHashState();
                render('strategy-sort-change');
                loadStrategyPage({ silent: true });
                return;
            }
            if (action === 'jump-strategy-page') {
                const input = PAGE.container.querySelector('[data-jump-strategy-page]');
                const value = Number.parseInt(input?.value || '', 10);
                const maxPage = Math.max(1, PAGE.strategyPage.totalPages || 1);
                if (!Number.isFinite(value)) return;
                const nextPage = Math.min(maxPage, Math.max(1, value));
                if (nextPage === PAGE.strategyPage.page) return;
                PAGE.strategyPage.page = nextPage;
                syncHashState();
                render('strategy-jump-page');
                loadStrategyPage({ silent: true });
                return;
            }
        }

        if (event.target.classList.contains('tca-drawer-overlay')) {
            PAGE.selectedLifecycleId = null;
            PAGE.detail = null;
            PAGE.detailLoading = false;
            render('drawer-overlay-close');
        }
    };

    PAGE.onInput = (event) => {
        const target = event.target.closest('[data-filter]');
        if (!target || target.dataset.filter !== 'symbol') return;
        PAGE.filters.symbol = target.value.trim().toUpperCase();
        PAGE.page = 1;
        PAGE.strategyPage.page = 1;
        PAGE.strategyTimelinePage = 1;
        debounceReload();
    };

    PAGE.onChange = (event) => {
        const target = event.target;
        if (!target) return;

        if (target.dataset?.action === 'set-page-size') {
            const nextSize = Number.parseInt(target.value, 10);
            if (!PAGE_SIZES.includes(nextSize)) return;
            PAGE.pageSize = nextSize;
            PAGE.page = 1;
            syncHashState();
            render('lifecycle-page-size');
            loadLifecyclePage({ silent: true });
            return;
        }
        if (target.dataset?.action === 'set-strategy-page-size') {
            const nextSize = Number.parseInt(target.value, 10);
            if (!PAGE_SIZES.includes(nextSize)) return;
            PAGE.strategyPage.pageSize = nextSize;
            PAGE.strategyPage.page = 1;
            syncHashState();
            render('strategy-page-size');
            loadStrategyPage({ silent: true });
            return;
        }

        const filterTarget = target.closest('[data-filter]');
        if (!filterTarget) return;

        const { filter } = filterTarget.dataset;
        if (filter === 'strategyType') PAGE.filters.strategyType = filterTarget.value;
        if (filter === 'finalStatus') PAGE.filters.finalStatus = filterTarget.value;
        if (filter === 'strategyStatus') PAGE.filters.strategyStatus = filterTarget.value;
        if (filter === 'lookback') PAGE.filters.lookback = filterTarget.value;
        if (filter === 'includeNonHard') PAGE.filters.includeNonHard = !!filterTarget.checked;
        PAGE.page = 1;
        PAGE.strategyPage.page = 1;
        PAGE.strategyTimelinePage = 1;
        syncHashState();
        loadOverview();
        if (PAGE.tab === 'lifecycles') {
            loadLifecyclePage({ silent: true });
        }
        if (PAGE.tab === 'strategies' || PAGE.selectedStrategySessionId) {
            loadStrategyPage({ silent: true });
            if (PAGE.selectedStrategySessionId) loadStrategySessionBundle(PAGE.selectedStrategySessionId, { silent: true });
        }
    };

    PAGE.container.addEventListener('click', PAGE.onClick);
    PAGE.container.addEventListener('input', PAGE.onInput);
    PAGE.container.addEventListener('change', PAGE.onChange);
}

function debounceReload() {
    if (PAGE.inputTimer) clearTimeout(PAGE.inputTimer);
    PAGE.instrumentation.recordSchedule('filters.symbol-input', { delayMs: 400, source: 'input' });
    PAGE.inputTimer = setTimeout(() => {
        syncHashState();
        loadOverview();
        if (PAGE.tab === 'lifecycles') {
            loadLifecyclePage({ silent: true });
        }
        if (PAGE.tab === 'strategies' || PAGE.selectedStrategySessionId) {
            loadStrategyPage({ silent: true });
            if (PAGE.selectedStrategySessionId) loadStrategySessionBundle(PAGE.selectedStrategySessionId, { silent: true });
        }
    }, 400);
}

function nextRequestController(key) {
    if (PAGE.controllers[key]) {
        PAGE.controllers[key].abort();
    }
    const controller = new AbortController();
    PAGE.controllers[key] = controller;
    return controller;
}

async function loadInitialData() {
    if (!PAGE.container) return;
    PAGE.error = null;
    PAGE.loading = true;
    render('initial-loading');

    if (!state.currentAccount) {
        PAGE.loading = false;
        render('initial-no-account');
        return;
    }

    await loadOverview({ silent: true });
    if (PAGE.tab === 'lifecycles' || PAGE.selectedLifecycleId) {
        await loadLifecyclePage({ silent: true });
    }
    if (PAGE.tab === 'strategies' || PAGE.selectedStrategySessionId) {
        await loadStrategyPage({ silent: true });
        const strategyId = PAGE.selectedStrategySessionId || PAGE.strategyPage.items[0]?.strategySessionId || null;
        if (strategyId) {
            PAGE.selectedStrategySessionId = strategyId;
            await loadStrategySessionBundle(strategyId, { silent: true });
        }
    }
    PAGE.loading = false;
    render('initial-complete');
}

async function loadOverview({ silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount) return;
    const subAccountId = state.currentAccount;
    const requestSeq = ++PAGE.requestSeqOverview;
    const controller = nextRequestController('overview');

    PAGE.overviewLoading = true;
    if (!silent) render('overview-loading');

    const commonParams = buildCommonParams();
    const strategyRollupParams = new URLSearchParams(commonParams);
    if (PAGE.filters.strategyType) strategyRollupParams.set('strategyType', PAGE.filters.strategyType);

    const sessionParams = new URLSearchParams();
    sessionParams.set('limit', '120');
    if (PAGE.filters.symbol) sessionParams.set('symbol', PAGE.filters.symbol);
    if (PAGE.filters.strategyType) sessionParams.set('strategyType', PAGE.filters.strategyType);
    const lookbackStart = getLookbackStart(PAGE.filters.lookback);
    if (lookbackStart) sessionParams.set('from', lookbackStart.toISOString());

    try {
        // Sequential to reduce peak DB memory (3 parallel queries crashed 500MB VPS)
        const rollups = await tcaApi(`/trade/tca/rollups/${subAccountId}?${commonParams.toString()}`, { signal: controller.signal }, { key: 'overview.rollups' });
        if (requestSeq !== PAGE.requestSeqOverview) return;
        const strategyRollups = await tcaApi(`/trade/tca/strategy-rollups/${subAccountId}?${strategyRollupParams.toString()}`, { signal: controller.signal }, { key: 'overview.strategy-rollups' });
        if (requestSeq !== PAGE.requestSeqOverview) return;
        const strategySessions = await tcaApi(`/trade/tca/strategy-sessions/${subAccountId}?${sessionParams.toString()}`, { signal: controller.signal }, { key: 'overview.strategy-sessions' });
        if (requestSeq !== PAGE.requestSeqOverview) return;
        PAGE.data = {
            rollups: Array.isArray(rollups) ? rollups : [],
            strategyRollups: Array.isArray(strategyRollups) ? strategyRollups : [],
            strategySessions: Array.isArray(strategySessions) ? strategySessions : [],
        };
        PAGE.error = null;
    } catch (err) {
        if (requestSeq !== PAGE.requestSeqOverview) return;
        if (err?.name === 'AbortError') return;
        PAGE.error = err;
    } finally {
        if (requestSeq !== PAGE.requestSeqOverview) return;
        PAGE.overviewLoading = false;
        render('overview-complete');
    }
}

async function loadLifecyclePage({ silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount) return;
    const subAccountId = state.currentAccount;
    const requestSeq = ++PAGE.requestSeqLifecycle;
    const controller = nextRequestController('lifecycles');

    PAGE.lifecycleLoading = true;
    if (!silent) render('lifecycles-loading');

    const params = buildCommonParams();
    params.set('page', String(PAGE.page));
    params.set('pageSize', String(PAGE.pageSize));
    params.set('sortBy', PAGE.sortBy);
    params.set('sortDir', PAGE.sortDir);
    if (PAGE.filters.finalStatus) params.set('finalStatus', PAGE.filters.finalStatus);

    try {
        const payload = await tcaApi(
            `/trade/tca/lifecycles-page/${subAccountId}?${params.toString()}`,
            { signal: controller.signal },
            { key: 'lifecycles.page' },
        );
        if (requestSeq !== PAGE.requestSeqLifecycle) return;
        PAGE.lifecyclePage = {
            items: Array.isArray(payload?.items) ? payload.items : [],
            page: Number(payload?.page || PAGE.page),
            pageSize: Number(payload?.pageSize || PAGE.pageSize),
            total: Number(payload?.total || 0),
            totalPages: Number(payload?.totalPages || 0),
            hasPrev: !!payload?.hasPrev,
            hasNext: !!payload?.hasNext,
            sortBy: String(payload?.sortBy || PAGE.sortBy),
            sortDir: String(payload?.sortDir || PAGE.sortDir),
        };
        PAGE.page = PAGE.lifecyclePage.page || 1;
        PAGE.pageSize = PAGE.lifecyclePage.pageSize || PAGE.pageSize;
        PAGE.sortBy = PAGE.lifecyclePage.sortBy || PAGE.sortBy;
        PAGE.sortDir = PAGE.lifecyclePage.sortDir || PAGE.sortDir;
        ensureLineagePreviewSelection();
        PAGE.error = null;
    } catch (err) {
        if (requestSeq !== PAGE.requestSeqLifecycle) return;
        if (err?.name === 'AbortError') return;
        PAGE.error = err;
    } finally {
        if (requestSeq !== PAGE.requestSeqLifecycle) return;
        PAGE.lifecycleLoading = false;
        render('lifecycles-complete');
    }
}

async function loadLifecycleDetail(lifecycleId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !lifecycleId) return;
    const detailSeq = ++PAGE.detailSeq;
    const controller = nextRequestController('detail');

    PAGE.detailLoading = !silent || !PAGE.detail;
    PAGE.detailError = null;
    render('lifecycle-detail-loading');

    try {
        const detail = await tcaApi(
            `/trade/tca/lifecycle/${state.currentAccount}/${lifecycleId}?includeLineage=0`,
            { signal: controller.signal },
            { key: 'lifecycle.detail' },
        );
        if (detailSeq !== PAGE.detailSeq || PAGE.selectedLifecycleId !== lifecycleId) return;
        PAGE.detail = {
            ...detail,
            lineageGraph: detail?.lineageGraph || null,
            lineageGraphLoading: true,
            lineageGraphError: null,
        };
        PAGE.detailError = null;
        PAGE.detailLoading = false;
        render('lifecycle-detail-loaded');
        loadLifecycleLineage(lifecycleId);
    } catch (err) {
        if (detailSeq !== PAGE.detailSeq || PAGE.selectedLifecycleId !== lifecycleId) return;
        if (err?.name === 'AbortError') return;
        PAGE.detailLoading = false;
        PAGE.detail = null;
        PAGE.detailError = err.message || 'Failed to load TCA detail';
        if (!silent) showToast(err.message || 'Failed to load TCA detail', 'error');
        render('lifecycle-detail-error');
    }
}

async function loadLifecycleLineage(lifecycleId) {
    if (!PAGE.container || !state.currentAccount || !lifecycleId) return;
    const requestSeq = ++PAGE.detailLineageSeq;
    const controller = nextRequestController('detailLineage');

    if (PAGE.selectedLifecycleId === lifecycleId && PAGE.detail) {
        PAGE.detail = {
            ...PAGE.detail,
            lineageGraphLoading: true,
            lineageGraphError: null,
        };
        render('lifecycle-lineage-loading');
    }

    try {
        const graph = await tcaApi(
            `/trade/tca/lineage/${state.currentAccount}/ORDER_LIFECYCLE/${lifecycleId}`,
            { signal: controller.signal },
            { key: 'lifecycle.lineage' },
        );
        if (requestSeq !== PAGE.detailLineageSeq || PAGE.selectedLifecycleId !== lifecycleId || !PAGE.detail) return;
        PAGE.detail = {
            ...PAGE.detail,
            lineageGraph: graph,
            lineageGraphLoading: false,
            lineageGraphError: null,
        };
        if (graph?.truncated && !PAGE.truncatedLifecycleIds.has(lifecycleId)) {
            PAGE.truncatedLifecycleIds.add(lifecycleId);
            PAGE.graphTruncatedCount += 1;
        }
        render('lifecycle-lineage-loaded');
    } catch (err) {
        if (requestSeq !== PAGE.detailLineageSeq || PAGE.selectedLifecycleId !== lifecycleId || !PAGE.detail) return;
        if (err?.name === 'AbortError') return;
        PAGE.detail = {
            ...PAGE.detail,
            lineageGraphLoading: false,
            lineageGraphError: err.message || 'Failed to load lineage graph',
        };
        render('lifecycle-lineage-error');
    }
}

async function loadStrategyPage({ silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount) return;
    const subAccountId = state.currentAccount;
    const requestSeq = ++PAGE.requestSeqStrategy;
    const controller = nextRequestController('strategies');
    PAGE.strategyLoading = true;
    if (!silent) render('strategies-loading');

    const params = new URLSearchParams();
    params.set('page', String(PAGE.strategyPage.page));
    params.set('pageSize', String(PAGE.strategyPage.pageSize));
    params.set('sortBy', PAGE.strategyPage.sortBy);
    params.set('sortDir', PAGE.strategyPage.sortDir);
    params.set('strategyType', PAGE.filters.strategyType || 'SCALPER');
    params.set('sessionRole', 'ROOT');
    if (PAGE.filters.strategyStatus) params.set('status', PAGE.filters.strategyStatus);
    if (PAGE.filters.symbol) params.set('symbol', PAGE.filters.symbol);
    const lookbackStart = getLookbackStart(PAGE.filters.lookback);
    if (lookbackStart) params.set('from', lookbackStart.toISOString());

    const previousSelected = PAGE.selectedStrategySessionId;
    try {
        const payload = await tcaApi(
            `/trade/tca/strategy-sessions-page/${subAccountId}?${params.toString()}`,
            { signal: controller.signal },
            { key: 'strategies.page' },
        );
        if (requestSeq !== PAGE.requestSeqStrategy) return;
        PAGE.strategyPage = {
            items: Array.isArray(payload?.items) ? payload.items : [],
            page: Number(payload?.page || PAGE.strategyPage.page),
            pageSize: Number(payload?.pageSize || PAGE.strategyPage.pageSize),
            total: Number(payload?.total || 0),
            totalPages: Number(payload?.totalPages || 0),
            hasPrev: !!payload?.hasPrev,
            hasNext: !!payload?.hasNext,
            sortBy: String(payload?.sortBy || PAGE.strategyPage.sortBy),
            sortDir: String(payload?.sortDir || PAGE.strategyPage.sortDir),
        };
        if (PAGE.selectedStrategySessionId) {
            const stillVisible = PAGE.strategyPage.items.some((row) => row.strategySessionId === PAGE.selectedStrategySessionId);
            if (!stillVisible && PAGE.strategyPage.items[0]?.strategySessionId) {
                PAGE.selectedStrategySessionId = PAGE.strategyPage.items[0].strategySessionId;
                PAGE.strategyTimelinePage = 1;
            }
        } else if (PAGE.strategyPage.items[0]?.strategySessionId) {
            PAGE.selectedStrategySessionId = PAGE.strategyPage.items[0].strategySessionId;
            PAGE.strategyTimelinePage = 1;
        }
        syncHashState();
        PAGE.error = null;
        void ensureSelectedStrategyLiveHydrated();
        if (PAGE.selectedStrategySessionId && PAGE.selectedStrategySessionId !== previousSelected && PAGE.tab === 'strategies') {
            PAGE.strategyTimelinePage = 1;
            PAGE.strategyDetail = null;
            PAGE.strategyTimeseries = null;
            PAGE.strategyLedger = null;
            loadStrategySessionBundle(PAGE.selectedStrategySessionId, { silent: true });
        }
    } catch (err) {
        if (requestSeq !== PAGE.requestSeqStrategy) return;
        if (err?.name === 'AbortError') return;
        PAGE.error = err;
    } finally {
        if (requestSeq !== PAGE.requestSeqStrategy) return;
        PAGE.strategyLoading = false;
        render('strategies-complete');
    }
}

function buildStrategyTimeseriesParams() {
    const range = new URLSearchParams();
    range.set('series', PAGE.strategyParamsExpanded ? 'pnl,params,quality,exposure' : 'pnl,quality,exposure');
    range.set('includeEvents', '1');
    const lookbackStart = getLookbackStart(PAGE.filters.lookback);
    if (lookbackStart) range.set('from', lookbackStart.toISOString());
    range.set('to', new Date().toISOString());
    range.set('eventsPage', String(PAGE.strategyTimelinePage));
    range.set('eventsPageSize', String(PAGE.strategyTimelinePageSize));
    range.set('maxPoints', '300');
    return range;
}

async function loadStrategyDetail(strategySessionId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return;
    const detailSeq = ++PAGE.requestSeqStrategyDetail;
    const controller = nextRequestController('strategyDetail');
    PAGE.strategyDetailLoading = !silent || !PAGE.strategyDetail;
    if (!silent) render('strategy-detail-loading');

    try {
        const detail = await tcaApi(
            `/trade/tca/strategy-session/${state.currentAccount}/${strategySessionId}?includeLineage=0`,
            { signal: controller.signal },
            { key: 'strategy.detail' },
        );
        if (detailSeq !== PAGE.requestSeqStrategyDetail || PAGE.selectedStrategySessionId !== strategySessionId) return;
        const previousGraph = PAGE.strategyDetail?.lineageGraph || null;
        const previousError = PAGE.strategyDetail?.lineageGraphError || null;
        PAGE.strategyDetail = {
            ...detail,
            lineageGraph: previousGraph,
            lineageGraphLoading: PAGE.strategyLineageLoading,
            lineageGraphError: previousError,
        };
        PAGE.strategyDetailLoading = false;
        PAGE.error = null;
        void ensureSelectedStrategyLiveHydrated();
        render('strategy-detail-loaded');
    } catch (err) {
        if (err?.name === 'AbortError') return;
        if (detailSeq !== PAGE.requestSeqStrategyDetail || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyDetailLoading = false;
        PAGE.strategyDetail = null;
        if (!silent) showToast(err.message || 'Failed to load strategy detail', 'error');
        render('strategy-detail-error');
    }
}

async function loadStrategyTimeseries(strategySessionId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return;
    const timeseriesSeq = ++PAGE.requestSeqStrategyTimeseries;
    const controller = nextRequestController('strategyTimeseries');
    PAGE.strategyTimeseriesLoading = !silent || !PAGE.strategyTimeseries;
    if (!silent) render('strategy-timeseries-loading');

    try {
        const timeseries = await tcaApi(
            `/trade/tca/strategy-session-timeseries/${state.currentAccount}/${strategySessionId}?${buildStrategyTimeseriesParams().toString()}`,
            { signal: controller.signal },
            { key: 'strategy.timeseries' },
        );
        if (timeseriesSeq !== PAGE.requestSeqStrategyTimeseries || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyTimeseries = timeseries;
        applyStrategyLiveState(strategySessionId);
        PAGE.strategyTimeseriesLoading = false;
        PAGE.error = null;
        render('strategy-timeseries-loaded');
    } catch (err) {
        if (err?.name === 'AbortError') return;
        if (timeseriesSeq !== PAGE.requestSeqStrategyTimeseries || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyTimeseriesLoading = false;
        PAGE.strategyTimeseries = null;
        if (!silent) showToast(err.message || 'Failed to load strategy timeseries', 'error');
        render('strategy-timeseries-error');
    }
}

async function loadStrategyLedger(strategySessionId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return;
    const ledgerSeq = ++PAGE.requestSeqStrategyLedger;
    const controller = nextRequestController('strategyLedger');
    PAGE.strategyLedgerLoading = !silent || !PAGE.strategyLedger;
    if (!silent) render('strategy-ledger-loading');

    try {
        const ledger = await tcaApi(
            `/trade/tca/strategy-session-lot-ledger/${state.currentAccount}/${strategySessionId}`,
            { signal: controller.signal },
            { key: 'strategy.ledger' },
        );
        if (ledgerSeq !== PAGE.requestSeqStrategyLedger || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyLedger = ledger;
        PAGE.strategyLedgerLoading = false;
        PAGE.error = null;
        render('strategy-ledger-loaded');
    } catch (err) {
        if (err?.name === 'AbortError') return;
        if (ledgerSeq !== PAGE.requestSeqStrategyLedger || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyLedgerLoading = false;
        PAGE.strategyLedger = null;
        if (!silent) showToast(err.message || 'Failed to load strategy lot ledger', 'error');
        render('strategy-ledger-error');
    }
}

async function loadStrategyLineage(strategySessionId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return;
    const requestSeq = ++PAGE.requestSeqStrategyLineage;
    const controller = nextRequestController('strategyLineage');
    PAGE.strategyLineageLoading = true;
    mergeStrategyLineage(strategySessionId, PAGE.strategyDetail?.lineageGraph || null, { loading: true, error: null });
    if (!silent) render('strategy-lineage-loading');

    try {
        const graph = await tcaApi(
            `/trade/tca/lineage/${state.currentAccount}/STRATEGY_SESSION/${strategySessionId}`,
            { signal: controller.signal },
            { key: 'strategy.lineage' },
        );
        if (requestSeq !== PAGE.requestSeqStrategyLineage || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyLineageLoading = false;
        mergeStrategyLineage(strategySessionId, graph, { loading: false, error: null });
        render('strategy-lineage-loaded');
    } catch (err) {
        if (err?.name === 'AbortError') return;
        if (requestSeq !== PAGE.requestSeqStrategyLineage || PAGE.selectedStrategySessionId !== strategySessionId) return;
        PAGE.strategyLineageLoading = false;
        mergeStrategyLineage(strategySessionId, PAGE.strategyDetail?.lineageGraph || null, {
            loading: false,
            error: err.message || 'Failed to load lineage graph',
        });
        render('strategy-lineage-error');
    }
}

async function loadStrategySessionBundle(
    strategySessionId,
    { silent = false, parts = { detail: true, timeseries: true, ledger: true, lineage: false } } = {},
) {
    if (!PAGE.container || !state.currentAccount || !strategySessionId) return;
    const tasks = [];
    if (parts.detail) tasks.push(loadStrategyDetail(strategySessionId, { silent }));
    if (parts.timeseries) tasks.push(loadStrategyTimeseries(strategySessionId, { silent }));
    if (parts.ledger) tasks.push(loadStrategyLedger(strategySessionId, { silent }));
    if (parts.lineage) tasks.push(loadStrategyLineage(strategySessionId, { silent: true }));
    if (!tasks.length) return;
    await Promise.allSettled(tasks);
}

function registerWsRefreshListeners() {
    for (const eventName of WS_LIFECYCLE_EVENTS) {
        const handler = (event) => handleLifecycleWsEvent(event);
        PAGE.wsHandlers.push({ eventName, handler });
        window.addEventListener(eventName, handler);
    }
    for (const eventName of WS_OVERVIEW_EVENTS) {
        const handler = (event) => handleOverviewWsEvent(event);
        PAGE.wsHandlers.push({ eventName, handler });
        window.addEventListener(eventName, handler);
    }
    for (const eventName of WS_STRATEGY_EVENTS) {
        const handler = (event) => handleStrategyWsEvent(event);
        PAGE.wsHandlers.push({ eventName, handler });
        window.addEventListener(eventName, handler);
    }
}

function isCurrentSubAccountEvent(detail) {
    const eventSub = detail?.subAccountId || detail?.sub_account_id || null;
    if (!eventSub) return true;
    return eventSub === state.currentAccount;
}

function eventClientOrderId(detail) {
    return detail?.clientOrderId || detail?.client_order_id || null;
}

function scheduleLifecycleRefresh() {
    if (PAGE.wsLifecycleTimer) clearTimeout(PAGE.wsLifecycleTimer);
    PAGE.instrumentation.recordSchedule('ws.lifecycle-refresh', { delayMs: 300, source: 'websocket' });
    PAGE.wsLifecycleTimer = setTimeout(() => {
        PAGE.wsLifecycleTimer = null;
        if (!PAGE.container || !state.currentAccount) return;
        if (PAGE.tab === 'lifecycles' || PAGE.selectedLifecycleId) {
            loadLifecyclePage({ silent: true });
        }
    }, 300);
}

function scheduleOverviewRefresh() {
    if (PAGE.wsOverviewTimer) clearTimeout(PAGE.wsOverviewTimer);
    PAGE.instrumentation.recordSchedule('ws.overview-refresh', { delayMs: 800, source: 'websocket' });
    PAGE.wsOverviewTimer = setTimeout(() => {
        PAGE.wsOverviewTimer = null;
        if (!PAGE.container || !state.currentAccount) return;
        loadOverview({ silent: true });
    }, 800);
}

function scheduleDetailRefresh() {
    if (PAGE.wsDetailTimer) clearTimeout(PAGE.wsDetailTimer);
    PAGE.instrumentation.recordSchedule('ws.detail-refresh', { delayMs: 300, source: 'websocket' });
    PAGE.wsDetailTimer = setTimeout(() => {
        PAGE.wsDetailTimer = null;
        if (!PAGE.selectedLifecycleId) return;
        loadLifecycleDetail(PAGE.selectedLifecycleId, { silent: true });
    }, 300);
}

function scheduleStrategyListRefresh() {
    if (PAGE.wsStrategyListTimer) clearTimeout(PAGE.wsStrategyListTimer);
    PAGE.instrumentation.recordSchedule('ws.strategy-list-refresh', { delayMs: 800, source: 'websocket' });
    PAGE.wsStrategyListTimer = setTimeout(() => {
        PAGE.wsStrategyListTimer = null;
        if (!PAGE.container || !state.currentAccount) return;
        if (PAGE.tab === 'strategies') loadStrategyPage({ silent: true });
    }, 800);
}

function scheduleStrategyDetailRefresh(parts = { detail: true, timeseries: true, ledger: true, lineage: false }) {
    PAGE.pendingStrategyRefresh = {
        detail: Boolean(PAGE.pendingStrategyRefresh?.detail || parts.detail),
        timeseries: Boolean(PAGE.pendingStrategyRefresh?.timeseries || parts.timeseries),
        ledger: Boolean(PAGE.pendingStrategyRefresh?.ledger || parts.ledger),
        lineage: Boolean(PAGE.pendingStrategyRefresh?.lineage || parts.lineage),
    };
    if (PAGE.wsStrategyDetailTimer) clearTimeout(PAGE.wsStrategyDetailTimer);
    PAGE.instrumentation.recordSchedule('ws.strategy-detail-refresh', { delayMs: 300, source: 'websocket' });
    PAGE.wsStrategyDetailTimer = setTimeout(() => {
        PAGE.wsStrategyDetailTimer = null;
        if (!PAGE.selectedStrategySessionId) return;
        const nextParts = PAGE.pendingStrategyRefresh || { detail: true, timeseries: true, ledger: true, lineage: false };
        PAGE.pendingStrategyRefresh = null;
        loadStrategySessionBundle(PAGE.selectedStrategySessionId, { silent: true, parts: nextParts });
    }, 300);
}

function handleLifecycleWsEvent(event) {
    const detail = event?.detail || {};
    if (!isCurrentSubAccountEvent(detail)) return;
    scheduleLifecycleRefresh();
    if (PAGE.selectedLifecycleId && PAGE.detail?.clientOrderId) {
        const coid = eventClientOrderId(detail);
        if (coid && coid === PAGE.detail.clientOrderId) {
            scheduleDetailRefresh();
        }
    }
}

function handleOverviewWsEvent(event) {
    const detail = event?.detail || {};
    if (!isCurrentSubAccountEvent(detail)) return;
    scheduleOverviewRefresh();
}

function handleStrategyWsEvent(event) {
    const detail = event?.detail || {};
    if (!isCurrentSubAccountEvent(detail)) return;
    const eventType = String(event?.type || '').toLowerCase();
    const strategySessionId = eventStrategySessionId(detail);
    if (eventType === 'strategy_sample' || eventType === 'scalper_progress' || eventType === 'scalper_filled' || eventType === 'scalper_cancelled' || eventType === 'pnl_update') {
        const changed = strategySessionId ? applyStrategyLiveState(strategySessionId) : false;
        if (changed) render('strategy-live-event');
        if (strategySessionId === PAGE.selectedStrategySessionId || isSelectedStrategyLive()) {
            void ensureSelectedStrategyLiveHydrated();
        }
        return;
    }
    scheduleStrategyListRefresh();
    if (!PAGE.selectedStrategySessionId) return;
    if (isSelectedStrategyLive()) {
        scheduleStrategyDetailRefresh({ detail: true, timeseries: false, ledger: true, lineage: false });
        return;
    }
    scheduleStrategyDetailRefresh({ detail: true, timeseries: true, ledger: true, lineage: false });
}

function refreshFromTimer() {
    loadOverview({ silent: true });
    if (PAGE.tab === 'lifecycles' || PAGE.selectedLifecycleId) {
        loadLifecyclePage({ silent: true });
    }
    if (PAGE.selectedLifecycleId) {
        loadLifecycleDetail(PAGE.selectedLifecycleId, { silent: true });
    }
    if (PAGE.tab === 'strategies' || PAGE.selectedStrategySessionId) {
        loadStrategyPage({ silent: true });
        if (PAGE.selectedStrategySessionId) {
            loadStrategySessionBundle(PAGE.selectedStrategySessionId, {
                silent: true,
                parts: isSelectedStrategyLive()
                    ? { detail: true, timeseries: false, ledger: true, lineage: false }
                    : { detail: true, timeseries: true, ledger: true, lineage: false },
            });
        }
    }
}

function buildCommonParams() {
    const params = new URLSearchParams();
    params.set('executionScope', 'SUB_ACCOUNT');
    if (!PAGE.filters.includeNonHard) params.set('ownershipConfidence', 'HARD');
    if (PAGE.filters.symbol) params.set('symbol', PAGE.filters.symbol);
    if (PAGE.filters.strategyType) params.set('strategyType', PAGE.filters.strategyType);
    const lookbackStart = getLookbackStart(PAGE.filters.lookback);
    if (lookbackStart) params.set('from', lookbackStart.toISOString());
    return params;
}

function getLookbackStart(lookback) {
    const now = Date.now();
    if (lookback === '24h') return new Date(now - 24 * 60 * 60 * 1000);
    if (lookback === '7d') return new Date(now - 7 * 24 * 60 * 60 * 1000);
    if (lookback === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000);
    return null;
}

function renderTerminalState(name, html, reason) {
    const changed = PAGE.container.innerHTML !== html;
    PAGE.container.innerHTML = html;
    PAGE.instrumentation.recordRender(name, {
        changed,
        durationMs: 0,
        reason,
        domNodes: 0,
    });
}

function renderDebugPanel() {
    const snapshot = PAGE.instrumentation.snapshot();
    const renderRows = Object.entries(snapshot.renders || {})
        .sort((left, right) => (right[1]?.count || 0) - (left[1]?.count || 0))
        .slice(0, 6);
    const fetchRows = Object.entries(snapshot.fetches || {})
        .sort((left, right) => (right[1]?.started || 0) - (left[1]?.started || 0))
        .slice(0, 6);
    const scheduleRows = Object.entries(snapshot.schedules || {})
        .sort((left, right) => (right[1]?.count || 0) - (left[1]?.count || 0))
        .slice(0, 6);
    const events = (snapshot.events || []).slice(0, 6);

    const renderList = renderRows.length
        ? renderRows.map(([name, bucket]) => `
            <div class="tca-fill-row tca-fill-row-compact">
                <div>
                    <div class="tca-leader-title">${escapeHtml(name)}</div>
                    <div class="tca-leader-subtitle">${bucket.changed} changed / ${bucket.skipped} skipped</div>
                </div>
                <div class="tca-muted-line">${bucket.count}x · avg ${(bucket.totalDurationMs / Math.max(bucket.count, 1)).toFixed(2)}ms</div>
            </div>
        `).join('')
        : '<div class="tca-muted-line">No render samples yet.</div>';

    const fetchList = fetchRows.length
        ? fetchRows.map(([name, bucket]) => `
            <div class="tca-fill-row tca-fill-row-compact">
                <div>
                    <div class="tca-leader-title">${escapeHtml(name)}</div>
                    <div class="tca-leader-subtitle">ok ${bucket.ok} · abort ${bucket.abort} · err ${bucket.error}</div>
                </div>
                <div class="tca-muted-line">${bucket.started}x · avg ${(bucket.totalDurationMs / Math.max(bucket.ok + bucket.error + bucket.abort, 1)).toFixed(2)}ms</div>
            </div>
        `).join('')
        : '<div class="tca-muted-line">No TCA fetches recorded yet.</div>';

    const scheduleList = scheduleRows.length
        ? scheduleRows.map(([name, bucket]) => `
            <div class="tca-fill-row tca-fill-row-compact">
                <div>
                    <div class="tca-leader-title">${escapeHtml(name)}</div>
                    <div class="tca-leader-subtitle">${escapeHtml(bucket.lastSource || 'unknown')}</div>
                </div>
                <div class="tca-muted-line">${bucket.count}x · ${bucket.lastDelayMs}ms</div>
            </div>
        `).join('')
        : '<div class="tca-muted-line">No refresh schedules recorded yet.</div>';

    const eventList = events.length
        ? events.map((event) => `
            <div class="tca-fill-row tca-fill-row-compact">
                <div>
                    <div class="tca-leader-title">${escapeHtml(event.type || 'event')} · ${escapeHtml(event.name || 'unknown')}</div>
                    <div class="tca-leader-subtitle">${escapeHtml(event.ts || '')}</div>
                </div>
                <div class="tca-muted-line">${event.durationMs != null ? `${Number(event.durationMs).toFixed(2)}ms` : escapeHtml(event.source || '')}</div>
            </div>
        `).join('')
        : '<div class="tca-muted-line">Recent events appear here once debug mode is enabled.</div>';

    return `
        <section class="glass-card tca-panel">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Debug Instrumentation</div>
                    <div class="tca-panel-caption">Hash flag <code>debugPerf=1</code> enables recent-event history and keeps this panel visible.</div>
                </div>
                <div class="tca-panel-actions">
                    <button class="btn btn-outline btn-sm" type="button" data-action="reset-debug-metrics">Reset Metrics</button>
                </div>
            </div>
            <div class="tca-grid">
                <div class="glass-card tca-panel">
                    <div class="card-title">Renders</div>
                    <div class="tca-fill-list">${renderList}</div>
                </div>
                <div class="glass-card tca-panel">
                    <div class="card-title">Fetch Churn</div>
                    <div class="tca-fill-list">${fetchList}</div>
                </div>
            </div>
            <div class="tca-grid">
                <div class="glass-card tca-panel">
                    <div class="card-title">Schedules</div>
                    <div class="tca-fill-list">${scheduleList}</div>
                </div>
                <div class="glass-card tca-panel">
                    <div class="card-title">Recent Events</div>
                    <div class="tca-fill-list">${eventList}</div>
                </div>
            </div>
        </section>
    `;
}

function render(reason = 'state') {
    if (!PAGE.container) return;

    const symbolInput = PAGE.container.querySelector('[data-filter="symbol"]');
    const hadSymbolFocus = symbolInput && document.activeElement === symbolInput;
    const cursorPos = hadSymbolFocus ? symbolInput.selectionStart : null;

    const tableWrap = PAGE.container.querySelector('.tca-table-wrap');
    const savedScroll = tableWrap ? tableWrap.scrollTop : 0;

    if (!state.currentAccount) {
        renderTerminalState('terminal-empty', cuteKey({
            title: 'No Account Selected ✨',
            subtitle: 'Pick a sub-account to review execution quality.',
        }), reason);
        return;
    }

    if (PAGE.loading && !PAGE.data.rollups.length && !PAGE.lifecyclePage.items.length && !PAGE.strategyPage.items.length) {
        renderTerminalState('terminal-loading', cuteSpinner(), reason);
        return;
    }

    if (PAGE.error && !PAGE.data.rollups.length && !PAGE.lifecyclePage.items.length && !PAGE.strategyPage.items.length) {
        renderTerminalState('terminal-error', cuteSadFace({
            title: 'TCA Unavailable',
            subtitle: PAGE.error.message || 'Failed to load execution quality data.',
        }), reason);
        return;
    }

    const view = buildViewModel(PAGE.data, PAGE.lifecyclePage);
    const shell = ensureTcaPageShell(PAGE.container);
    if (shell.created) {
        PAGE.instrumentation.recordRender('page-shell', {
            changed: true,
            durationMs: shell.durationMs,
            reason,
            domNodes: 0,
        });
    }

    const heroChanged = patchTcaRegion(shell.hero, `
        <section class="glass-card tca-hero">
            <div class="tca-hero-copy">
                <div class="tca-eyebrow">Execution Quality</div>
                <div class="section-header" style="margin-bottom:8px;">
                    <h2 class="section-title">Trade Cost Analysis</h2>
                </div>
                <p class="tca-hero-text">
                    Review fill quality, lineage, and toxicity by sub-account.
                    Scope defaults to <strong>SUB_ACCOUNT</strong> and <strong>HARD</strong> ownership.
                </p>
            </div>
            <div class="tca-filter-rail">
                ${renderFilterBar(view)}
            </div>
        </section>
    `, { name: 'hero', reason, instrumentation: PAGE.instrumentation });
    patchTcaRegion(shell.tabs, renderTabBar(), { name: 'tabs', reason, instrumentation: PAGE.instrumentation });

    if (PAGE.tab === 'strategies') {
        const strategyShell = ensureTcaStrategyShell(shell.active);
        if (strategyShell.created) {
            PAGE.instrumentation.recordRender('strategy-shell', {
                changed: true,
                durationMs: strategyShell.durationMs,
                reason,
                domNodes: 0,
            });
        }
        patchTcaRegion(strategyShell.rail, renderStrategyRail(), {
            name: 'strategy-rail',
            reason,
            instrumentation: PAGE.instrumentation,
        });
        patchTcaRegion(strategyShell.studio, renderStrategyStudio(), {
            name: 'strategy-studio',
            reason,
            instrumentation: PAGE.instrumentation,
        });
    } else {
        patchTcaRegion(shell.active, renderActiveTab(view), {
            name: 'active-tab',
            reason,
            instrumentation: PAGE.instrumentation,
        });
    }

    patchTcaRegion(shell.error, PAGE.error ? `<div class="tca-inline-error">${escapeHtml(PAGE.error.message || 'Refresh failed')}</div>` : '', {
        name: 'inline-error',
        reason,
        instrumentation: PAGE.instrumentation,
    });
    patchTcaRegion(shell.drawer, renderDrawer(view), {
        name: 'drawer',
        reason,
        instrumentation: PAGE.instrumentation,
    });
    patchTcaRegion(shell.debug, PAGE.debugPerf ? renderDebugPanel() : '', {
        name: 'debug-panel',
        reason,
        instrumentation: PAGE.instrumentation,
    });

    if (typeof window !== 'undefined') {
        window.__TCA_DEBUG_STATE = PAGE.instrumentation.snapshot();
    }

    if (heroChanged && hadSymbolFocus) {
        const restored = PAGE.container.querySelector('[data-filter="symbol"]');
        if (restored) {
            restored.focus();
            if (cursorPos !== null) restored.setSelectionRange(cursorPos, cursorPos);
        }
    }

    const restoredTableWrap = PAGE.container.querySelector('.tca-table-wrap');
    if (restoredTableWrap && savedScroll > 0) restoredTableWrap.scrollTop = savedScroll;
}

function renderTabBar() {
    const tabs = [
        ['overview', 'Overview'],
        ['lifecycles', 'Lifecycles'],
        ['strategies', 'Strategies'],
    ];
    return `
        <section class="glass-card tca-panel tca-tabs-panel">
            <div class="tca-tabs">
                ${tabs.map(([tab, label]) => `
                    <button
                        type="button"
                        class="tca-tab-btn ${PAGE.tab === tab ? 'active' : ''}"
                        data-action="set-tab"
                        data-tab="${tab}"
                    >${label}</button>
                `).join('')}
            </div>
        </section>
    `;
}

function renderActiveTab(view) {
    if (PAGE.tab === 'lifecycles') return renderLifecyclesTab(view);
    if (PAGE.tab === 'strategies') return renderStrategiesTab();
    return renderOverviewTab(view);
}

function renderOverviewTab(view) {
    return `
        <section class="tca-grid">
            <div class="glass-card tca-panel">
                <div class="tca-panel-head">
                    <div>
                        <div class="card-title">Role Metrics ${renderInfoHelp(INFO_TIPS.executionQuality)}</div>
                        <div class="tca-panel-caption">Arrival and markout quality by role for the current lifecycle slice.</div>
                    </div>
                    ${PAGE.overviewLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                </div>
                ${renderExecutionQualityGuide(view.anomalySummary)}
                ${renderRoleMetricCards(view.roleMetrics)}
            </div>

            <div class="glass-card tca-panel">
                <div class="tca-panel-head">
                    <div>
                        <div class="card-title">Strategy Footprint</div>
                        <div class="tca-panel-caption">Top strategy sessions by filled notional.</div>
                    </div>
                    ${PAGE.overviewLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                </div>
                ${renderStrategyLeaders(view)}
            </div>
        </section>
    `;
}

function renderLifecyclesTab(view) {
    return `
        <section class="glass-card tca-panel">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Review Queue ${renderInfoHelp(INFO_TIPS.lifecycleDrawer)}</div>
                    <div class="tca-panel-caption">Paginated lifecycle feed with role, toxicity, and lineage status. Defaults to filled executions so repriced and cancelled cleanup legs do not dominate the queue.</div>
                </div>
                <div class="tca-panel-actions">
                    ${PAGE.lifecycleLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                    <button class="btn btn-outline btn-sm" type="button" data-action="refresh-lifecycles">Refresh</button>
                </div>
            </div>
            ${renderLifecycleTable(view)}
            ${renderPaginationBar(PAGE.lifecyclePage)}
        </section>
    `;
}

function renderLineageTab(view) {
    const roleCards = renderRoleMetricCards(view.roleMetrics);
    const anomalies = view.anomalySummary;
    return `
        <section class="tca-grid">
            <div class="glass-card tca-panel">
                <div class="tca-panel-head">
                    <div>
                        <div class="card-title">Role Metrics ${renderInfoHelp(INFO_TIPS.executionQuality)}</div>
                        <div class="tca-panel-caption">Arrival and markout quality by order role.</div>
                    </div>
                    ${PAGE.overviewLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                </div>
                ${renderExecutionQualityGuide({ unknownRoleCount: anomalies.unknownRoleCount })}
                ${roleCards}
            </div>

            <div class="glass-card tca-panel">
                <div class="tca-panel-head">
                    <div>
                        <div class="card-title">Anomaly Health</div>
                        <div class="tca-panel-caption">Unknown role/lineage and graph truncation signals.</div>
                    </div>
                </div>
                <div class="tca-lineage-health">
                    <div class="stat-item"><div class="stat-label">Unknown Roles</div><div class="stat-value">${anomalies.unknownRoleCount}</div></div>
                    <div class="stat-item"><div class="stat-label">Unknown / Partial Lineage</div><div class="stat-value">${anomalies.unknownLineageCount}</div></div>
                    <div class="stat-item"><div class="stat-label">Graph Truncated</div><div class="stat-value">${anomalies.graphTruncatedCount}</div></div>
                </div>
                <div class="tca-muted-line">Counts are based on current page + opened detail graphs in this session.</div>
            </div>
        </section>
        <section class="glass-card tca-panel">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Lineage Preview</div>
                    <div class="tca-panel-caption">Open a lifecycle to inspect recursive graph and anomalies.</div>
                </div>
            </div>
            ${PAGE.detail
            ? renderLineageGraph(PAGE.detail)
            : PAGE.detailError
                ? `<div class="tca-inline-error">${escapeHtml(PAGE.detailError)}</div>`
                : (PAGE.lifecyclePage.items?.length
                    ? '<div class="tca-chart-empty">Loading preview from the newest visible lifecycle…</div>'
                    : '<div class="tca-chart-empty">No lifecycle rows are available in the current filter window.</div>')}
        </section>
    `;
}

function renderStrategiesTab() {
    return `
        <section class="tca-strategy-layout">
            ${renderStrategyRail()}
            <div class="tca-strategy-studio">
                ${renderStrategyStudio()}
            </div>
        </section>
    `;
}

function renderStrategyRail() {
    return `
        <div class="glass-card tca-panel tca-strategy-rail">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Root Sessions ${renderInfoHelp('Root scalper sessions only in this view. Each card rolls child chase activity into one economic root session.')}</div>
                    <div class="tca-panel-caption">Scalper-first command center with root-session PnL, toxicity, and runtime state.</div>
                </div>
                <div class="tca-panel-actions">
                    ${PAGE.strategyLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                    <button class="btn btn-outline btn-sm" type="button" data-action="refresh-strategies">Refresh</button>
                </div>
            </div>
            <div class="tca-strategy-sortbar">
                <button type="button" class="btn btn-outline btn-sm" data-action="sort-strategies" data-sort-by="updatedAt">Updated</button>
                <button type="button" class="btn btn-outline btn-sm" data-action="sort-strategies" data-sort-by="netPnl">Net PnL</button>
                <button type="button" class="btn btn-outline btn-sm" data-action="sort-strategies" data-sort-by="toxicityScore">Toxicity</button>
                <button type="button" class="btn btn-outline btn-sm" data-action="sort-strategies" data-sort-by="fillCount">Fills</button>
            </div>
            ${renderStrategySessionList(PAGE.strategyPage.items)}
            ${renderStrategyPaginationBar(PAGE.strategyPage)}
        </div>
    `;
}

function renderStrategyStudio() {
    const selected = PAGE.strategyPage.items.find((row) => row.strategySessionId === PAGE.selectedStrategySessionId)
        || PAGE.strategyPage.items[0]
        || null;
    const detail = PAGE.strategyDetail;
    const timeseries = PAGE.strategyTimeseries;
    const ledger = PAGE.strategyLedger;
    const roleMetrics = roleMetricsFromStrategyDetail(detail);
    const livePnl = latestStrategyPnlSnapshot(detail, timeseries, selected);
    const runtimeStatus = detail?.runtime?.status || selected?.runtimeStatus || 'UNKNOWN';

    return `
        ${selected ? `
            <section class="tca-summary-grid tca-strategy-summary-grid">
                <div class="glass-card tca-kpi-card tca-kpi-score">
                    <div class="price-label">Net PnL ${renderInfoHelp(INFO_TIPS.pnlCurve)}</div>
                    <div class="price-big ${formatPnlClass(livePnl.netPnl || 0)}">${formatUsd(livePnl.netPnl || 0, 2)}</div>
                    <div class="tca-muted-line">${escapeHtml(selected.symbol || 'Unknown')} · ${escapeHtml(runtimeStatus)}</div>
                </div>
                <div class="glass-card tca-kpi-card">
                    <div class="price-label">Realized ${renderInfoHelp('Closed FIFO lot allocations net of fees. This only moves when owned lots are closed.')}</div>
                    <div class="price-big ${formatPnlClass(livePnl.realizedPnl || 0)}">${formatUsd(livePnl.realizedPnl || 0, 2)}</div>
                    <div class="tca-muted-line">${renderSampleStatusLine(livePnl.sampledAt, 'Last PnL sample')}</div>
                </div>
                <div class="glass-card tca-kpi-card">
                    <div class="price-label">Unrealized ${renderInfoHelp('Mark-to-market value of still-open root-session lots at the latest sampled mark price.')}</div>
                    <div class="price-big ${formatPnlClass(livePnl.unrealizedPnl || 0)}">${formatUsd(livePnl.unrealizedPnl || 0, 2)}</div>
                    <div class="tca-muted-line">Open exposure ${formatUsd(livePnl.openNotional || 0, 2)}</div>
                </div>
                <div class="glass-card tca-kpi-card">
                    <div class="price-label">Execution Quality ${renderInfoHelp(INFO_TIPS.executionQuality)}</div>
                    <div class="price-big ${formatPnlClass(-(detail?.rollup?.toxicityScore ?? selected.toxicityScore ?? 0))}">${Number(detail?.rollup?.toxicityScore ?? selected.toxicityScore ?? 0).toFixed(2)}</div>
                    <div class="tca-muted-line">${livePnl.fillCount || selected.fillCount || 0} fills · ${livePnl.closeCount || selected.closeCount || 0} closes</div>
                </div>
            </section>
            <section class="tca-grid tca-strategy-grid">
                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">PnL Curve ${renderInfoHelp(INFO_TIPS.pnlCurve)}</div>
                            <div class="tca-panel-caption">Net, realized, unrealized, and open exposure. ${renderSampleStatusLine(livePnl.sampledAt, '5s live sample')}</div>
                        </div>
                        ${PAGE.strategyTimeseriesLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                    </div>
                    ${renderMultiSeriesChart(
        (timeseries?.series?.pnl?.length ? timeseries.series.pnl : (livePnl.sampledAt ? [{ ts: livePnl.sampledAt, netPnl: livePnl.netPnl || 0, realizedPnl: livePnl.realizedPnl || 0, unrealizedPnl: livePnl.unrealizedPnl || 0, openNotional: livePnl.openNotional || 0 }] : [])),
        [
            ['netPnl', 'Net', '#16a34a'],
            ['realizedPnl', 'Realized', '#0ea5e9'],
            ['unrealizedPnl', 'Unrealized', '#f59e0b'],
            ['openNotional', 'Exposure', '#f97316'],
        ],
    )}
                </div>
                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">Parameter Evolution ${renderInfoHelp(INFO_TIPS.parameterEvolution)}</div>
                            <div class="tca-panel-caption">Offsets, slot pressure, and refill guards over time. Loaded on demand so the default studio stays focused on economics.</div>
                        </div>
                        <div class="tca-panel-actions">
                            <button class="btn btn-outline btn-sm" type="button" data-action="toggle-parameter-evolution">${PAGE.strategyParamsExpanded ? 'Hide' : 'Load'} Params</button>
                        </div>
                    </div>
                    ${PAGE.strategyParamsExpanded
                ? renderMultiSeriesChart(
                    timeseries?.series?.params || [],
                    [
                        ['longOffsetPct', 'Long Offset', '#8b5cf6'],
                        ['shortOffsetPct', 'Short Offset', '#ec4899'],
                        ['longActiveSlots', 'Long Active', '#14b8a6'],
                        ['shortPausedSlots', 'Short Paused', '#ef4444'],
                    ],
                )
                : '<div class="tca-chart-empty">Parameter evolution is hidden until requested. Open it when you need slot pressure or offset drift without paying for it on every default load.</div>'}
                </div>
            </section>
            <section class="tca-grid tca-strategy-grid">
                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">Execution Quality ${renderInfoHelp(INFO_TIPS.executionQuality)}</div>
                            <div class="tca-panel-caption">Role-sliced arrival and markout quality.</div>
                        </div>
                    </div>
                    ${renderExecutionQualityGuide(detail?.anomalyCounts || {})}
                    ${renderRoleMetricCards(roleMetrics)}
                </div>
                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">Trade Ledger</div>
                            <div class="tca-panel-caption">Recent fills and PnL per trade.</div>
                        </div>
                        ${PAGE.strategyLedgerLoading ? '<span class="tca-refreshing">Refreshing…</span>' : ''}
                    </div>
                    ${renderStrategyLotLedger(ledger)}
                </div>
            </section>
        ` : '<section class="glass-card tca-panel"><div class="tca-chart-empty">No strategy session matches the current filter.</div></section>'}
    `;
}

function renderPaginationBar(meta) {
    const totalPages = Math.max(1, Number(meta?.totalPages || 1));
    const currentPage = Math.min(totalPages, Math.max(1, Number(meta?.page || 1)));
    const pages = buildPaginationWindow(currentPage, totalPages);
    return `
        <div class="tca-pagination-wrap">
            <div class="tca-pagination-meta">
                <span>${Number(meta?.total || 0)} rows</span>
                <span>Page ${currentPage} / ${totalPages}</span>
            </div>
            <div class="tca-pagination">
                <button type="button" class="btn btn-outline btn-sm" data-action="set-page" data-page="${Math.max(1, currentPage - 1)}" ${currentPage <= 1 ? 'disabled' : ''}>Prev</button>
                ${pages.map((page) => `
                    <button
                        type="button"
                        class="btn btn-sm ${page === currentPage ? 'btn-primary' : 'btn-outline'}"
                        data-action="set-page"
                        data-page="${page}"
                    >${page}</button>
                `).join('')}
                <button type="button" class="btn btn-outline btn-sm" data-action="set-page" data-page="${Math.min(totalPages, currentPage + 1)}" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
            </div>
            <div class="tca-pagination-tools">
                <label class="tca-filter-field" style="min-width:96px;">
                    <span>Rows</span>
                    <select data-action="set-page-size">
                        ${PAGE_SIZES.map((size) => `<option value="${size}" ${PAGE.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
                    </select>
                </label>
                <label class="tca-filter-field" style="min-width:120px;">
                    <span>Jump</span>
                    <div style="display:flex; gap:6px;">
                        <input class="search-input" data-jump-page type="number" min="1" max="${totalPages}" placeholder="${currentPage}" />
                        <button type="button" class="btn btn-outline btn-sm" data-action="jump-page">Go</button>
                    </div>
                </label>
            </div>
        </div>
    `;
}

function renderStrategyPaginationBar(meta) {
    const totalPages = Math.max(1, Number(meta?.totalPages || 1));
    const currentPage = Math.min(totalPages, Math.max(1, Number(meta?.page || 1)));
    const pages = buildPaginationWindow(currentPage, totalPages);
    return `
        <div class="tca-pagination-wrap">
            <div class="tca-pagination-meta">
                <span>${Number(meta?.total || 0)} sessions</span>
                <span>Page ${currentPage} / ${totalPages}</span>
            </div>
            <div class="tca-pagination">
                <button type="button" class="btn btn-outline btn-sm" data-action="set-strategy-page" data-page="${Math.max(1, currentPage - 1)}" ${currentPage <= 1 ? 'disabled' : ''}>Prev</button>
                ${pages.map((page) => `
                    <button
                        type="button"
                        class="btn btn-sm ${page === currentPage ? 'btn-primary' : 'btn-outline'}"
                        data-action="set-strategy-page"
                        data-page="${page}"
                    >${page}</button>
                `).join('')}
                <button type="button" class="btn btn-outline btn-sm" data-action="set-strategy-page" data-page="${Math.min(totalPages, currentPage + 1)}" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
            </div>
            <div class="tca-pagination-tools">
                <label class="tca-filter-field" style="min-width:96px;">
                    <span>Rows</span>
                    <select data-action="set-strategy-page-size">
                        ${PAGE_SIZES.map((size) => `<option value="${size}" ${PAGE.strategyPage.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
                    </select>
                </label>
                <label class="tca-filter-field" style="min-width:120px;">
                    <span>Jump</span>
                    <div style="display:flex; gap:6px;">
                        <input class="search-input" data-jump-strategy-page type="number" min="1" max="${totalPages}" placeholder="${currentPage}" />
                        <button type="button" class="btn btn-outline btn-sm" data-action="jump-strategy-page">Go</button>
                    </div>
                </label>
            </div>
        </div>
    `;
}

function buildPaginationWindow(currentPage, totalPages, radius = 2) {
    const pages = [];
    const start = Math.max(1, currentPage - radius);
    const end = Math.min(totalPages, currentPage + radius);
    for (let page = start; page <= end; page += 1) pages.push(page);
    if (!pages.includes(1)) pages.unshift(1);
    if (!pages.includes(totalPages)) pages.push(totalPages);
    return Array.from(new Set(pages)).sort((a, b) => a - b);
}

function buildViewModel(overviewData, lifecyclePage) {
    const rollups = overviewData?.rollups || [];
    const strategyRollups = overviewData?.strategyRollups || [];
    const strategySessions = overviewData?.strategySessions || [];
    const lifecycles = (lifecyclePage?.items || []).map((row) => {
        const selectedMarkout = selectedMarkoutFromLifecycle(row, PAGE.filters.benchmarkMs);
        const severityScore = buildSeverityScore(row, selectedMarkout);
        return { ...row, selectedMarkout, severityScore };
    });

    const availableStrategyTypes = Array.from(new Set(
        [
            ...lifecycles.map((row) => row.strategyType),
            ...strategyRollups.map((row) => row.strategyType),
            ...strategySessions.map((row) => row.strategyType),
            ...(PAGE.strategyPage.items || []).map((row) => row.strategyType),
        ].filter(Boolean),
    )).sort();

    const primaryRollup = rollups[0] || null;
    const summary = buildSliceSummary(lifecycles, strategySessions, primaryRollup);
    const baseline = buildRollupBaseline(rollups);
    const sessionById = new Map(strategySessions.map((row) => [row.strategySessionId, row]));
    const strategyLeaders = strategyRollups
        .map((row) => ({ ...row, session: sessionById.get(row.strategySessionId) || null }))
        .filter(shouldDisplayStrategyLeader)
        .sort((left, right) => (right.totalFillNotional || 0) - (left.totalFillNotional || 0))
        .slice(0, 5);

    return {
        availableStrategyTypes,
        benchmarkMs: PAGE.filters.benchmarkMs,
        benchmarkLabel: labelForHorizon(PAGE.filters.benchmarkMs),
        baseline,
        lifecycles,
        sparklinePoints: strategyLeaders
            .slice(0, 24)
            .reverse()
            .map((row) => selectedMarkoutFromRollup(row))
            .filter((value) => Number.isFinite(value)),
        strategyLeaders,
        strategySessions,
        summary,
        roleMetrics: resolveLineageRoleMetrics(primaryRollup, strategyRollups, lifecycles),
        anomalySummary: buildAnomalySummary(lifecycles),
    };
}

function isLiquidationStrategyValue(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) return false;
    return normalized.includes('LIQUIDATION') || normalized === 'FULL_LIQUIDATION';
}

function shouldDisplayStrategyLeader(row) {
    if (!row) return false;
    if (isLiquidationStrategyValue(row.strategyType)) return false;
    if (isLiquidationStrategyValue(row.session?.strategyType)) return false;
    if (isLiquidationStrategyValue(row.session?.origin)) return false;
    return true;
}

function extractRoleMetrics(rollup) {
    const out = {};
    if (!rollup) return out;
    const qualityByRole = rollup.qualityByRole || {};
    const arrival = rollup.avgArrivalSlippageBpsByRole || {};
    const mk1 = rollup.avgMarkout1sBpsByRole || {};
    const mk5 = rollup.avgMarkout5sBpsByRole || {};
    const mk30 = rollup.avgMarkout30sBpsByRole || {};
    const roles = new Set([...Object.keys(arrival), ...Object.keys(mk1), ...Object.keys(mk5), ...Object.keys(mk30), ...Object.keys(qualityByRole)]);
    for (const role of roles) {
        const avgArrivalSlippageBps = arrival[role] ?? null;
        const avgMarkout1sBps = mk1[role] ?? null;
        const avgMarkout5sBps = mk5[role] ?? null;
        const avgMarkout30sBps = mk30[role] ?? null;
        out[role] = {
            lifecycleCount: qualityByRole[role]?.lifecycleCount ?? null,
            fillCount: qualityByRole[role]?.fillCount ?? null,
            avgArrivalSlippageBps,
            avgMarkout1sBps,
            avgMarkout5sBps,
            avgMarkout30sBps,
            toxicityScore: computeToxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps),
        };
    }
    return out;
}

function buildAnomalySummary(lifecycles) {
    const unknownRoleCount = lifecycles.filter((row) => String(row.orderRole || '').toUpperCase() === 'UNKNOWN').length;
    const unknownLineageCount = lifecycles.filter((row) => String(row.lineageStatus || '').toUpperCase() !== 'COMPLETE').length;
    return {
        unknownRoleCount,
        unknownLineageCount,
        graphTruncatedCount: PAGE.graphTruncatedCount,
    };
}

function renderRoleMetricCards(roleMetrics) {
    const rows = Object.entries(roleMetrics || {}).filter(([role]) => role !== 'REPRICE');
    if (!rows.length) {
        return '<div class="tca-chart-empty">No role-sliced metrics available in this window yet. Quality needs fills plus sampled markouts, so live sessions can still have runtime PnL while this panel stays empty.</div>';
    }
    return `
        <div class="tca-fill-list">
            ${rows.map(([role, metrics]) => `
                <div class="tca-fill-row">
                    <div>
                        <div class="tca-leader-title">${escapeHtml(role)}</div>
                        <div class="tca-muted-line">${escapeHtml(roleDescription(role))}</div>
                        <div class="tca-leader-subtitle">
                            Arrival ${formatBps(metrics.avgArrivalSlippageBps)} ·
                            1s ${formatBps(metrics.avgMarkout1sBps)} ·
                            5s ${formatBps(metrics.avgMarkout5sBps)} ·
                            30s ${formatBps(metrics.avgMarkout30sBps)}
                        </div>
                        <div class="tca-muted-line">${metrics.lifecycleCount ?? 0} lifecycle(s) · ${metrics.fillCount ?? 0} fill sample(s)</div>
                    </div>
                    <div class="tca-fill-mkbadge ${formatPnlClass(-(metrics.toxicityScore || 0))}">
                        Toxicity ${Number.isFinite(metrics.toxicityScore) ? metrics.toxicityScore.toFixed(2) : '—'}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function roleMetricsFromStrategyDetail(detail) {
    const rollup = detail?.rollup || {};
    const qualityByRole = detail?.qualityByRole || rollup.qualityByRole || {};
    const out = {};
    const arrival = rollup.avgArrivalSlippageBpsByRole || {};
    const mk1 = rollup.avgMarkout1sBpsByRole || {};
    const mk5 = rollup.avgMarkout5sBpsByRole || {};
    const mk30 = rollup.avgMarkout30sBpsByRole || {};
    const roles = new Set([...Object.keys(arrival), ...Object.keys(mk1), ...Object.keys(mk5), ...Object.keys(mk30), ...Object.keys(qualityByRole)]);
    for (const role of roles) {
        out[role] = {
            lifecycleCount: qualityByRole[role]?.lifecycleCount ?? null,
            fillCount: qualityByRole[role]?.fillCount ?? null,
            avgArrivalSlippageBps: arrival[role] ?? null,
            avgMarkout1sBps: mk1[role] ?? null,
            avgMarkout5sBps: mk5[role] ?? null,
            avgMarkout30sBps: mk30[role] ?? null,
            toxicityScore: computeToxicityScore(arrival[role], mk1[role], mk5[role]),
        };
    }
    return out;
}

function latestStrategyPnlSnapshot(detail, timeseries, selected) {
    const latestPoint = (timeseries?.series?.pnl || []).slice(-1)[0] || null;
    const latestSample = detail?.latestPnlSample || null;
    return {
        sampledAt: latestPoint?.ts || latestSample?.sampledAt || selected?.updatedAt || null,
        realizedPnl: latestPoint?.realizedPnl ?? latestSample?.realizedPnl ?? detail?.rollup?.realizedPnl ?? selected?.realizedPnl ?? 0,
        unrealizedPnl: latestPoint?.unrealizedPnl ?? latestSample?.unrealizedPnl ?? detail?.rollup?.unrealizedPnl ?? selected?.unrealizedPnl ?? 0,
        netPnl: latestPoint?.netPnl ?? latestSample?.netPnl ?? detail?.rollup?.netPnl ?? selected?.netPnl ?? 0,
        openNotional: latestPoint?.openNotional ?? latestSample?.openNotional ?? detail?.rollup?.openNotional ?? selected?.openNotional ?? 0,
        fillCount: latestPoint?.fillCount ?? latestSample?.fillCount ?? detail?.rollup?.fillCount ?? selected?.fillCount ?? 0,
        closeCount: latestPoint?.closeCount ?? latestSample?.closeCount ?? detail?.rollup?.closeCount ?? selected?.closeCount ?? 0,
    };
}

function latestStrategyParamSnapshot(detail, timeseries) {
    const latestPoint = (timeseries?.series?.params || []).slice(-1)[0] || null;
    return {
        sampledAt: latestPoint?.ts || detail?.latestParamSample?.sampledAt || null,
        longOffsetPct: latestPoint?.longOffsetPct ?? detail?.latestParamSample?.longOffsetPct ?? null,
        shortOffsetPct: latestPoint?.shortOffsetPct ?? detail?.latestParamSample?.shortOffsetPct ?? null,
    };
}

function renderSampleStatusLine(ts, label = 'Last sample') {
    if (!ts) return `${label}: waiting for data`;
    return `${label}: ${formatRelativeTime(ts)} (${formatAbsoluteTime(ts)})`;
}

function renderExecutionQualityGuide(anomalyCounts = {}) {
    return '';
}

function renderStrategySessionList(items) {
    if (!items.length) {
        return '<div class="tca-chart-empty">No root strategy sessions match the current filters.</div>';
    }
    return `
        <div class="tca-strategy-list">
            ${items.map((row) => {
        const isActive = row.strategySessionId === PAGE.selectedStrategySessionId;
        const anomalyClass = row.hasAnomaly ? 'is-anomaly' : 'is-clean';
        return `
                    <button
                        type="button"
                        class="tca-strategy-card ${isActive ? 'active' : ''}"
                        data-action="open-strategy-session"
                        data-session-id="${row.strategySessionId}"
                    >
                        <div class="tca-strategy-card-head">
                            <div>
                                <div class="tca-leader-title">${escapeHtml(row.symbol || 'Unknown')} · ${escapeHtml(row.strategyType || 'SCALPER')}</div>
                                <div class="tca-leader-subtitle">${escapeHtml(shortId(row.strategySessionId))} · ${escapeHtml(row.runtimeStatus || 'UNKNOWN')}</div>
                            </div>
                            <span class="tca-lineage-pill ${anomalyClass}">${row.hasAnomaly ? `${row.anomalyCount} anomaly` : 'clean'}</span>
                        </div>
                        <div class="tca-strategy-card-metrics">
                            <span class="${formatPnlClass(row.netPnl || 0)}">${formatUsd(row.netPnl || 0, 2)}</span>
                            <span>${row.fillCount || 0} fills</span>
                            <span>${formatUsd(row.openNotional || 0, 0)}</span>
                        </div>
                        <div class="tca-strategy-card-spark">${renderMiniSparkline(row.sparkline || [])}</div>
                    </button>
                `;
    }).join('')}
        </div>
    `;
}

function renderMiniSparkline(points) {
    const values = (points || []).map((row) => Number(row?.value)).filter(Number.isFinite);
    if (!values.length) return '<div class="tca-muted-line">No samples</div>';
    const width = 160;
    const height = 42;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const coords = values.map((value, index) => {
        const x = (index / Math.max(values.length - 1, 1)) * (width - 6) + 3;
        const y = height - (((value - min) / spread) * (height - 8) + 4);
        return `${x},${y}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" class="tca-mini-spark ${values[values.length - 1] >= 0 ? 'positive' : 'negative'}" preserveAspectRatio="none"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}

function renderMultiSeriesChart(points, seriesDefs) {
    const rows = Array.isArray(points) ? points : [];
    if (!rows.length) return '<div class="tca-chart-empty">No samples in the selected lookback.</div>';
    const width = 820;
    const height = 220;
    const values = [];
    for (const row of rows) {
        for (const [key] of seriesDefs) {
            const value = Number(row?.[key]);
            if (Number.isFinite(value)) values.push(value);
        }
    }
    if (!values.length) return '<div class="tca-chart-empty">No numeric values available for this series.</div>';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const lastTs = rows[rows.length - 1]?.ts || null;
    const lines = seriesDefs.map(([key, label, color]) => {
        const coords = rows.map((row, index) => {
            const value = Number(row?.[key]);
            if (!Number.isFinite(value)) return null;
            const x = (index / Math.max(rows.length - 1, 1)) * (width - 16) + 8;
            const y = height - (((value - min) / spread) * (height - 28) + 14);
            return `${x},${y}`;
        }).filter(Boolean).join(' ');
        return { key, label, color, coords };
    }).filter((line) => line.coords);
    return `
        <div class="tca-series-chart">
            <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                ${lines.map((line) => `<polyline points="${line.coords}" fill="none" stroke="${line.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>`).join('')}
            </svg>
            <div class="tca-series-legend">
                ${lines.map((line) => `<span><i style="background:${line.color}"></i>${escapeHtml(line.label)}</span>`).join('')}
            </div>
            <div class="tca-series-meta">
                <span>${rows.length} sample(s)</span>
                <span>${renderSampleStatusLine(lastTs, 'Last point')}</span>
            </div>
        </div>
    `;
}

function renderStrategyTimeline(events, anomalyCounts) {
    const page = Math.max(1, Number(events?.page || PAGE.strategyTimelinePage || 1));
    const totalPages = Math.max(1, Number(events?.totalPages || 1));
    const items = Array.isArray(events?.items) ? events.items : (Array.isArray(events) ? events : []);
    const rows = items.map((row) => ({
        ts: row.ts,
        label: row.type,
        detail: row.status || 'runtime',
        seq: row.checkpointSeq,
    }));
    if (anomalyCounts?.unknownLineageCount > 0) {
        rows.push({ ts: null, label: 'LINEAGE_ANOMALY', detail: `${anomalyCounts.unknownLineageCount} event(s)` });
    }
    if (anomalyCounts?.sessionPnlAnomalyCount > 0) {
        rows.push({ ts: null, label: 'PNL_ANOMALY', detail: `${anomalyCounts.sessionPnlAnomalyCount} event(s)` });
    }
    if (!rows.length) return '<div class="tca-chart-empty">No runtime checkpoints or anomalies recorded in this window.</div>';
    return `
        <div class="tca-timeline-wrap">
            <div class="tca-timeline-summary">
                <span>${Number(events?.total || items.length || 0)} checkpoint(s) in range</span>
                <span>${anomalyCounts?.unknownLineageCount || 0} lineage anomaly count</span>
                <span>${anomalyCounts?.sessionPnlAnomalyCount || 0} PnL anomaly count</span>
            </div>
            <div class="tca-fill-list">
                ${rows.map((row) => `
                <div class="tca-fill-row tca-fill-row-compact">
                    <div>
                        <div class="tca-leader-title">${escapeHtml(row.label)}</div>
                        <div class="tca-leader-subtitle">${escapeHtml(row.detail)}</div>
                    </div>
                    <div class="tca-muted-line">${row.ts ? formatAbsoluteTime(row.ts) : 'Aggregated'}${row.seq != null ? ` · #${row.seq}` : ''}</div>
                </div>
            `).join('')}
        </div>
            ${totalPages > 1 ? `
                <div class="tca-pagination-inline">
                    <button type="button" class="btn btn-outline btn-sm" data-action="set-timeline-page" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${page} / ${totalPages}</span>
                    <button type="button" class="btn btn-outline btn-sm" data-action="set-timeline-page" data-page="${Math.min(totalPages, page + 1)}" ${page >= totalPages ? 'disabled' : ''}>Next</button>
                </div>
            ` : ''}
        </div>
    `;
}

function renderStrategyLotLedger(ledger) {
    if (!ledger) return '<div class="tca-chart-empty">Select a strategy session to load its trade ledger.</div>';
    const realizations = ledger.realizations || [];
    if (!realizations.length) return '<div class="tca-chart-empty">No fills recorded yet.</div>';
    return `
        <div class="tca-ledger-block">
            <div class="tca-ledger-table">
                <div class="tca-ledger-row head"><span>Qty</span><span>Entry</span><span>Exit</span><span>PnL</span></div>
                ${realizations.slice(0, 15).map((row) => `<div class="tca-ledger-row"><span>${formatQty(row.allocatedQty)}</span><span>${formatPrice(row.openPrice)}</span><span>${formatPrice(row.closePrice)}</span><span class="${formatPnlClass(row.netRealizedPnl || 0)}">${formatUsd(row.netRealizedPnl || 0, 4)}</span></div>`).join('')}
            </div>
            ${realizations.length > 15 ? `<div class="tca-muted-line">${realizations.length - 15} more realization(s) not shown.</div>` : ''}
        </div>
    `;
}

function buildSliceSummary(lifecycles, strategySessions, fallbackRollup) {
    if (!lifecycles.length) {
        if (!fallbackRollup) {
            return {
                orderCount: 0,
                terminalOrderCount: 0,
                fillCount: 0,
                rejectCount: 0,
                cancelCount: 0,
                totalRequestedQty: 0,
                totalFilledQty: 0,
                totalFillNotional: 0,
                totalRepriceCount: 0,
                avgArrivalSlippageBps: null,
                avgAckLatencyMs: null,
                avgWorkingTimeMs: null,
                avgMarkout1sBps: null,
                avgMarkout5sBps: null,
                avgMarkout30sBps: null,
                selectedMarkoutBps: null,
                fillRatio: null,
                rejectRate: null,
                sessionCount: strategySessions.length,
                qualityScore: 0,
                updatedAt: null,
            };
        }
        const selectedMarkoutBps = selectedMarkoutFromRollup(fallbackRollup);
        const rejectRate = Number(fallbackRollup.orderCount || 0) > 0
            ? Number(fallbackRollup.rejectCount || 0) / Number(fallbackRollup.orderCount || 1)
            : null;
        const fillRatio = fallbackRollup.fillRatio ?? null;
        const summary = {
            orderCount: Number(fallbackRollup.orderCount || 0),
            terminalOrderCount: Number(fallbackRollup.terminalOrderCount || 0),
            fillCount: Number(fallbackRollup.fillCount || 0),
            rejectCount: Number(fallbackRollup.rejectCount || 0),
            cancelCount: Number(fallbackRollup.cancelCount || 0),
            totalRequestedQty: Number(fallbackRollup.totalRequestedQty || 0),
            totalFilledQty: Number(fallbackRollup.totalFilledQty || 0),
            totalFillNotional: Number(fallbackRollup.totalFillNotional || 0),
            totalRepriceCount: Number(fallbackRollup.totalRepriceCount || 0),
            avgArrivalSlippageBps: fallbackRollup.avgArrivalSlippageBps ?? null,
            avgAckLatencyMs: fallbackRollup.avgAckLatencyMs ?? null,
            avgWorkingTimeMs: fallbackRollup.avgWorkingTimeMs ?? null,
            avgMarkout1sBps: fallbackRollup.avgMarkout1sBps ?? null,
            avgMarkout5sBps: fallbackRollup.avgMarkout5sBps ?? null,
            avgMarkout30sBps: fallbackRollup.avgMarkout30sBps ?? null,
            selectedMarkoutBps,
            fillRatio,
            rejectRate,
            sessionCount: strategySessions.length,
            qualityScore: 0,
            updatedAt: fallbackRollup.updatedAt || null,
        };
        summary.qualityScore = buildQualityScore(summary);
        return summary;
    }

    const summary = {
        orderCount: lifecycles.length,
        terminalOrderCount: 0,
        fillCount: 0,
        rejectCount: 0,
        cancelCount: 0,
        totalRequestedQty: 0,
        totalFilledQty: 0,
        totalFillNotional: 0,
        totalRepriceCount: 0,
        avgArrivalSlippageBps: null,
        avgAckLatencyMs: null,
        avgWorkingTimeMs: null,
        avgMarkout1sBps: null,
        avgMarkout5sBps: null,
        avgMarkout30sBps: null,
        selectedMarkoutBps: null,
        fillRatio: null,
        rejectRate: null,
        sessionCount: strategySessions.length,
        qualityScore: 0,
        updatedAt: null,
    };

    const arrivals = [];
    const acks = [];
    const workings = [];
    const markout1s = [];
    const markout5s = [];
    const markout30s = [];
    const selected = [];
    const updateTimes = [];

    for (const row of lifecycles) {
        if (row.finalStatus && ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.finalStatus)) {
            summary.terminalOrderCount += 1;
        }
        if ((row.fillCount || 0) > 0 || (row.filledQty || 0) > 0) summary.fillCount += 1;
        if (row.finalStatus === 'REJECTED') summary.rejectCount += 1;
        if (row.finalStatus === 'CANCELLED' || row.finalStatus === 'EXPIRED') summary.cancelCount += 1;
        summary.totalRequestedQty += Number(row.requestedQty || 0);
        summary.totalFilledQty += Number(row.filledQty || 0);
        summary.totalFillNotional += Number(row.avgFillPrice || 0) * Number(row.filledQty || 0);
        summary.totalRepriceCount += Number(row.repriceCount || 0);
        if (Number.isFinite(row.arrivalSlippageBps)) arrivals.push(row.arrivalSlippageBps);
        if (Number.isFinite(row.ackLatencyMs)) acks.push(row.ackLatencyMs);
        if (Number.isFinite(row.workingTimeMs)) workings.push(row.workingTimeMs);
        if (Number.isFinite(row.avgMarkout1sBps)) markout1s.push(row.avgMarkout1sBps);
        if (Number.isFinite(row.avgMarkout5sBps)) markout5s.push(row.avgMarkout5sBps);
        if (Number.isFinite(row.avgMarkout30sBps)) markout30s.push(row.avgMarkout30sBps);
        if (Number.isFinite(row.selectedMarkout)) selected.push(row.selectedMarkout);
        const updateTime = new Date(row.updatedAt || row.doneTs || row.firstFillTs || row.intentTs || 0).getTime();
        if (updateTime > 0) updateTimes.push(updateTime);
    }

    summary.avgArrivalSlippageBps = average(arrivals);
    summary.avgAckLatencyMs = average(acks);
    summary.avgWorkingTimeMs = average(workings);
    summary.avgMarkout1sBps = average(markout1s);
    summary.avgMarkout5sBps = average(markout5s);
    summary.avgMarkout30sBps = average(markout30s);
    summary.selectedMarkoutBps = average(selected);
    summary.fillRatio = summary.totalRequestedQty > 0 ? summary.totalFilledQty / summary.totalRequestedQty : null;
    summary.rejectRate = summary.orderCount > 0 ? summary.rejectCount / summary.orderCount : null;
    summary.updatedAt = updateTimes.length ? new Date(Math.max(...updateTimes)) : null;
    summary.qualityScore = buildQualityScore(summary);
    return summary;
}

function buildRollupBaseline(rollups) {
    if (!rollups.length) {
        return {
            rollupCount: 0,
            orderCount: 0,
            fillCount: 0,
            updatedAt: null,
        };
    }
    return {
        rollupCount: rollups.length,
        orderCount: rollups.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
        fillCount: rollups.reduce((sum, row) => sum + Number(row.fillCount || 0), 0),
        updatedAt: rollups
            .map((row) => new Date(row.updatedAt || 0).getTime())
            .filter((value) => value > 0)
            .sort((left, right) => right - left)[0] || null,
    };
}

function buildQualityScore(summary) {
    const fillBoost = Number.isFinite(summary.fillRatio) ? summary.fillRatio * 35 : 0;
    const markoutBoost = Number.isFinite(summary.selectedMarkoutBps) ? clamp(summary.selectedMarkoutBps, -25, 25) * 0.8 : 0;
    const arrivalPenalty = Number.isFinite(summary.avgArrivalSlippageBps)
        ? Math.max(summary.avgArrivalSlippageBps, 0) * 1.5
        : 0;
    const rejectPenalty = Number.isFinite(summary.rejectRate) ? summary.rejectRate * 40 : 0;
    const repricePenalty = summary.orderCount > 0 ? (summary.totalRepriceCount / summary.orderCount) * 6 : 0;
    return clamp(55 + fillBoost + markoutBoost - arrivalPenalty - rejectPenalty - repricePenalty, 0, 100);
}

function buildSeverityScore(row, selectedMarkout) {
    let score = 0;
    if (row.finalStatus === 'REJECTED') score += 40;
    if (row.finalStatus === 'CANCELLED' || row.finalStatus === 'EXPIRED') score += 18;
    if (Number.isFinite(row.arrivalSlippageBps)) score += Math.abs(row.arrivalSlippageBps) * 0.9;
    if (Number.isFinite(selectedMarkout) && selectedMarkout < 0) score += Math.abs(selectedMarkout) * 1.5;
    if (Number.isFinite(row.ackLatencyMs)) score += clamp(row.ackLatencyMs / 250, 0, 20);
    if (row.ownershipConfidence && row.ownershipConfidence !== 'HARD') score += 8;
    return Number(score.toFixed(2));
}

function renderFilterBar(view) {
    const statusField = PAGE.tab === 'strategies'
        ? `
            <label class="tca-filter-field">
                <span>Session</span>
                <select data-filter="strategyStatus">
                    <option value="">All</option>
                    ${['ACTIVE', 'PAUSED_RESTARTABLE', 'COMPLETED', 'CANCELLED', 'FAILED'].map((status) => `
                        <option value="${status}" ${PAGE.filters.strategyStatus === status ? 'selected' : ''}>${status}</option>
                    `).join('')}
                </select>
            </label>
        `
        : `
            <label class="tca-filter-field">
                <span>Status</span>
                <select data-filter="finalStatus">
                    <option value="">All</option>
                    ${['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map((status) => `
                        <option value="${status}" ${PAGE.filters.finalStatus === status ? 'selected' : ''}>${status}</option>
                    `).join('')}
                </select>
            </label>
        `;
    return `
        <div class="tca-filter-grid">
            <label class="tca-filter-field">
                <span>Symbol</span>
                <input class="search-input" data-filter="symbol" value="${escapeHtml(PAGE.filters.symbol)}" placeholder="BTCUSDT" />
            </label>
            <label class="tca-filter-field">
                <span>Strategy</span>
                <select data-filter="strategyType">
                    <option value="">All</option>
                    ${view.availableStrategyTypes.map((type) => `
                        <option value="${escapeHtml(type)}" ${PAGE.filters.strategyType === type ? 'selected' : ''}>${escapeHtml(type)}</option>
                    `).join('')}
                </select>
            </label>
            ${statusField}
            <label class="tca-filter-field">
                <span>Window</span>
                <select data-filter="lookback">
                    <option value="24h" ${PAGE.filters.lookback === '24h' ? 'selected' : ''}>24h</option>
                    <option value="7d" ${PAGE.filters.lookback === '7d' ? 'selected' : ''}>7d</option>
                    <option value="30d" ${PAGE.filters.lookback === '30d' ? 'selected' : ''}>30d</option>
                    <option value="all" ${PAGE.filters.lookback === 'all' ? 'selected' : ''}>All</option>
                </select>
            </label>
            <label class="tca-toggle">
                <input type="checkbox" data-filter="includeNonHard" ${PAGE.filters.includeNonHard ? 'checked' : ''} />
                <span>Show uncertain matches</span>
                <span class="tca-kpi-help" style="margin-left:2px;">ⓘ<span class="tca-tip">Include rows that are not hard ownership matches.</span></span>
            </label>
        </div>
    `;
}

function renderSummary(view) {
    const summary = view.summary;
    const qualityClass = formatPnlClass((summary.selectedMarkoutBps || 0) - Math.max(summary.avgArrivalSlippageBps || 0, 0));
    return `
        <section class="tca-summary-grid">
            <div class="glass-card tca-kpi-card tca-kpi-score">
                <div class="price-label">Execution Score ${renderInfoHelp(INFO_TIPS.overviewScore)}</div>
                <div class="tca-score-row">
                    <div class="price-big">${summary.qualityScore.toFixed(0)}</div>
                    <div class="tca-score-pill ${qualityClass}">${qualityBand(summary.qualityScore)}</div>
                </div>
                <div class="tca-muted-line">Filtered slice. Benchmark: ${view.benchmarkLabel}.</div>
            </div>
            <div class="glass-card tca-kpi-card">
                <div class="price-label">Avg Arrival ${renderInfoHelp('Average fill versus decision mid across the filtered slice. Lower absolute slippage is cleaner.')}</div>
                <div class="price-big ${formatPnlClass(-(summary.avgArrivalSlippageBps || 0))}">${formatBps(summary.avgArrivalSlippageBps)}</div>
                <div class="tca-muted-line">Lower is better for urgent execution.</div>
            </div>
            <div class="glass-card tca-kpi-card">
                <div class="price-label">Avg ${view.benchmarkLabel} ${renderInfoHelp('Average post-fill move at the selected horizon. Positive means the market moved in your favor after the fill.')}</div>
                <div class="price-big ${formatPnlClass(summary.selectedMarkoutBps || 0)}">${formatBps(summary.selectedMarkoutBps)}</div>
                <div class="tca-muted-line">Markout quality for the selected benchmark horizon.</div>
            </div>
            <div class="glass-card tca-kpi-card">
                <div class="price-label">Fill Ratio</div>
                <div class="price-big">${formatRatio(summary.fillRatio)}</div>
                <div class="tca-muted-line">${summary.fillCount} fill-bearing lifecycle(s), ${summary.rejectCount} rejected.</div>
            </div>
            <div class="glass-card tca-kpi-card tca-kpi-meta">
                <div class="card-title">Coverage</div>
                <div class="stat-grid">
                    <div class="stat-item">
                        <div class="stat-label">Visible Orders</div>
                        <div class="stat-value">${summary.orderCount}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Sessions</div>
                        <div class="stat-value">${summary.sessionCount}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Ack Latency</div>
                        <div class="stat-value">${formatMs(summary.avgAckLatencyMs)}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Reprice Load</div>
                        <div class="stat-value">${summary.totalRepriceCount}</div>
                    </div>
                </div>
                <div class="tca-meta-footer">
                    <span>Baseline rollups: ${view.baseline.orderCount} orders / ${view.baseline.fillCount} fills</span>
                    <span>${view.baseline.updatedAt ? `Updated ${formatRelativeTime(view.baseline.updatedAt)}` : 'No rollup baseline yet'}</span>
                </div>
            </div>
        </section>
    `;
}

function renderBenchmarkButtons() {
    return [1000, 5000, 30000].map((horizonMs) => `
        <button
            type="button"
            class="${PAGE.filters.benchmarkMs === horizonMs ? 'active' : ''}"
            data-action="set-benchmark"
            data-benchmark-ms="${horizonMs}"
        >${labelForHorizon(horizonMs)}</button>
    `).join('');
}

function renderBenchmarkBars(view) {
    const summary = view.summary;
    const bars = [
        {
            label: 'Arrival slippage',
            width: pctWidth(Math.abs(summary.avgArrivalSlippageBps || 0), 25),
            className: 'tca-bar-negative',
            text: formatBps(summary.avgArrivalSlippageBps),
        },
        {
            label: `${view.benchmarkLabel} markout`,
            width: pctWidth(Math.abs(summary.selectedMarkoutBps || 0), 25),
            className: (summary.selectedMarkoutBps || 0) >= 0 ? 'tca-bar-positive' : 'tca-bar-negative',
            text: formatBps(summary.selectedMarkoutBps),
        },
        {
            label: 'Fill ratio',
            width: pctWidth((summary.fillRatio || 0) * 100, 100),
            className: 'tca-bar-neutral',
            text: formatRatio(summary.fillRatio),
        },
        {
            label: 'Reject rate',
            width: pctWidth((summary.rejectRate || 0) * 100, 100),
            className: 'tca-bar-negative',
            text: formatRatio(summary.rejectRate),
        },
    ];

    return bars.map((bar) => `
        <div class="tca-bar-row">
            <div class="tca-bar-copy">
                <span>${bar.label}</span>
                <span>${bar.text}</span>
            </div>
            <div class="tca-bar-track">
                <div class="tca-bar-fill ${bar.className}" style="width:${bar.width}%"></div>
            </div>
        </div>
    `).join('');
}

function renderSparkline(points) {
    if (!points.length) {
        return `<div class="tca-chart-empty">No benchmark markouts in the current filter slice.</div>`;
    }

    const width = 420;
    const height = 140;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const spread = max - min || 1;
    const coords = points.map((value, index) => {
        const x = (index / Math.max(points.length - 1, 1)) * (width - 12) + 6;
        const y = height - (((value - min) / spread) * (height - 24) + 12);
        return `${x},${y}`;
    }).join(' ');
    const last = points[points.length - 1];
    const fillClass = last >= 0 ? 'positive' : 'negative';

    return `
        <svg viewBox="0 0 ${width} ${height}" class="tca-sparkline ${fillClass}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="tcaSparkGradient" x1="0%" x2="0%" y1="0%" y2="100%">
                    <stop offset="0%" stop-color="rgba(16,185,129,0.36)" />
                    <stop offset="100%" stop-color="rgba(15,23,42,0.02)" />
                </linearGradient>
            </defs>
            <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
            <polyline points="6,${height - 8} ${coords} ${width - 6},${height - 8}" fill="url(#tcaSparkGradient)" opacity="0.4"></polyline>
        </svg>
        <div class="tca-spark-meta">
            <span>Min ${formatBps(min)}</span>
            <span>Max ${formatBps(max)}</span>
            <span>Last ${formatBps(last)}</span>
        </div>
    `;
}

function renderStrategyLeaders(view) {
    if (!view.strategyLeaders.length) {
        return '<div class="tca-chart-empty">No strategy sessions match the current filters.</div>';
    }

    return `
        <div class="tca-leader-list">
            ${view.strategyLeaders.map((row) => {
        const sessionLabel = row.session?.symbol || row.strategyType || 'Session';
        const selectedMarkout = selectedMarkoutFromRollup(row);
        return `
                    <button
                        type="button"
                        class="tca-leader-row tca-leader-row-button"
                        data-action="open-strategy-modal"
                        data-session-id="${row.strategySessionId}"
                        data-sub-account-id="${row.subAccountId || row.session?.subAccountId || state.currentAccount || ''}"
                    >
                        <div>
                            <div class="tca-leader-title">${escapeHtml(row.strategyType || 'MANUAL')} · ${escapeHtml(sessionLabel || 'Unknown')}</div>
                            <div class="tca-leader-subtitle">${escapeHtml(shortId(row.strategySessionId))} · ${row.session?.startedAt ? formatRelativeTime(row.session.startedAt) : 'No start time'} · inspect TCA</div>
                        </div>
                        <div class="tca-leader-metrics">
                            <span class="${formatPnlClass(-(row.avgArrivalSlippageBps || 0))}">${formatBps(row.avgArrivalSlippageBps)}</span>
                            <span class="${formatPnlClass(selectedMarkout || 0)}">${formatBps(selectedMarkout)}</span>
                            <span>${formatUsd(row.totalFillNotional || 0, 0)}</span>
                        </div>
                    </button>
                `;
    }).join('')}
        </div>
    `;
}

function renderLifecycleTable(view) {
    if (!view.lifecycles.length) {
        return '<div class="tca-chart-empty">No lifecycle rows match the current filter window.</div>';
    }

    const sortArrow = (field) => {
        if (PAGE.sortBy !== field) return '';
        return PAGE.sortDir === 'asc' ? ' ↑' : ' ↓';
    };

    return `
        <div class="tca-table-wrap">
            <table class="data-table tca-table">
                <thead>
                    <tr>
                        <th><button type="button" class="tca-sort-btn" data-action="sort-lifecycles" data-sort-by="updatedAt">Trade${sortArrow('updatedAt')}</button></th>
                        <th><button type="button" class="tca-sort-btn" data-action="sort-lifecycles" data-sort-by="finalStatus">Status${sortArrow('finalStatus')}</button></th>
                        <th>Arrival / Markout ${renderInfoHelp(INFO_TIPS.lifecycleQuality)}</th>
                        <th>Toxicity ${renderInfoHelp(INFO_TIPS.lifecycleToxicity)}</th>
                        <th>Lineage ${renderInfoHelp(INFO_TIPS.lifecycleLineage)}</th>
                        <th>Fills</th>
                    </tr>
                </thead>
                <tbody>
                    ${view.lifecycles.map((row) => {
        const lineageStatus = String(row.lineageStatus || 'UNKNOWN').toUpperCase();
        const lineageClass = lineageStatus === 'COMPLETE' ? 'is-complete' : (lineageStatus === 'PARTIAL' ? 'is-partial' : 'is-unknown');
        return `
                        <tr class="${PAGE.selectedLifecycleId === row.lifecycleId ? 'tca-row-active' : ''}">
                            <td>
                                <button type="button" class="tca-row-button" data-action="open-lifecycle" data-lifecycle-id="${row.lifecycleId}">
                                    <div class="tca-row-title">
                                        <span>${escapeHtml(row.symbol || 'Unknown')}</span>
                                        <span class="badge badge-${row.side === 'SELL' ? 'short' : 'long'}">${escapeHtml(row.side || 'N/A')}</span>
                                        <span class="tca-meta-pill">${escapeHtml(row.orderRole || 'UNKNOWN')}</span>
                                    </div>
                                    <div class="tca-row-subtitle">${formatRelativeTime(row.doneTs || row.firstFillTs || row.intentTs || row.updatedAt)} · ${escapeHtml(row.originPath || 'UNKNOWN')}</div>
                                </button>
                            </td>
                            <td><span class="tca-state-pill ${statusClass(row.finalStatus)}">${escapeHtml(row.finalStatus || 'LIVE')}</span></td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span class="${formatPnlClass(-(row.arrivalSlippageBps || 0))}">${formatBps(row.arrivalSlippageBps)}</span>
                                    <span class="${formatPnlClass(row.selectedMarkout || 0)}">${formatBps(row.selectedMarkout)}</span>
                                </div>
                            </td>
                            <td><span class="tca-meta-pill ${formatPnlClass(-(row.toxicityScore || 0))}">${Number.isFinite(row.toxicityScore) ? row.toxicityScore.toFixed(2) : '—'}</span></td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span class="tca-lineage-pill ${lineageClass}">${lineageStatus}</span>
                                    <button type="button" class="btn btn-outline btn-sm" data-action="inspect-lineage" data-lifecycle-id="${row.lifecycleId}">View</button>
                                </div>
                            </td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span>${formatQty(row.filledQty)} / ${formatQty(row.requestedQty)}</span>
                                    <span>${row.avgFillPrice ? `$${formatPrice(row.avgFillPrice)}` : 'No fill price'}</span>
                                </div>
                            </td>
                        </tr>
                    `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderDrawer(view) {
    if (!PAGE.selectedLifecycleId) return '';
    return `
        <div class="tca-drawer-overlay">
            <aside class="tca-drawer">
                <div class="tca-drawer-header">
                    <div>
                        <div class="card-title">Lifecycle Detail ${renderInfoHelp(INFO_TIPS.lifecycleDrawer)}</div>
                        <div class="tca-drawer-title">${PAGE.detail ? escapeHtml(PAGE.detail.symbol || 'Unknown') : 'Loading lifecycle'}</div>
                    </div>
                    <button type="button" class="modal-close" data-action="close-drawer">×</button>
                </div>
                ${PAGE.detailLoading && !PAGE.detail ? cuteSpinner() : ''}
                ${PAGE.detail ? renderDetailContent(view, PAGE.detail) : ''}
            </aside>
        </div>
    `;
}

function renderDetailContent(view, detail) {
    const pricePathPoints = buildPricePathPoints(detail);
    const fillRows = detail.fills || [];
    const eventRows = detail.events || [];
    const strategySession = detail.strategySession;

    return `
        <div class="tca-detail-stack">
            <div class="tca-detail-badges">
                <span class="badge badge-${detail.side === 'SELL' ? 'short' : 'long'}">${escapeHtml(detail.side || 'N/A')}</span>
                <span class="tca-state-pill ${statusClass(detail.finalStatus)}">${escapeHtml(detail.finalStatus || 'LIVE')}</span>
                <span class="tca-meta-pill">${escapeHtml(detail.executionScope || 'SUB_ACCOUNT')}</span>
                <span class="tca-meta-pill">${escapeHtml(detail.ownershipConfidence || 'HARD')}</span>
                <span class="tca-meta-pill">${escapeHtml(detail.orderRole || 'UNKNOWN')}</span>
                <span class="tca-meta-pill">${escapeHtml(detail.reconciliationStatus || 'PENDING')}</span>
            </div>

            <div class="tca-detail-grid">
                <div class="stat-item">
                    <div class="stat-label">Arrival <span class="tca-kpi-help">ⓘ<span class="tca-tip">Slippage from decision mid to fill price.</span></span></div>
                    <div class="stat-value ${formatPnlClass(-(detail.arrivalSlippageBps || 0))}">${formatBps(detail.arrivalSlippageBps)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Ack Latency <span class="tca-kpi-help">ⓘ<span class="tca-tip">Time from submit to exchange acknowledgement.</span></span></div>
                    <div class="stat-value">${formatMs(detail.ackLatencyMs)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Working Time</div>
                    <div class="stat-value">${formatMs(detail.workingTimeMs)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">${view.benchmarkLabel}</div>
                    <div class="stat-value ${formatPnlClass(detail.markoutSummary?.[`avgMarkout${view.benchmarkMs === 1000 ? '1s' : view.benchmarkMs === 5000 ? '5s' : '30s'}Bps`] || 0)}">
                        ${formatBps(selectedMarkoutFromDetail(detail, view.benchmarkMs))}
                    </div>
                </div>
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Price Path</div>
                ${renderPricePath(pricePathPoints)}
                ${renderPricePathBpsRow(pricePathPoints)}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Lineage ${renderInfoHelp(INFO_TIPS.lifecycleLineage)}</div>
                <div class="tca-lineage-grid">
                    <div><span>Strategy</span><strong>${escapeHtml(detail.strategyType || 'MANUAL')}</strong></div>
                    <div><span>Session</span><strong>${escapeHtml(shortId(detail.strategySessionId || detail.parentId || 'N/A'))}</strong></div>
                    <div><span>Client Order</span><strong>${escapeHtml(shortId(detail.clientOrderId || 'N/A', 22))}</strong></div>
                    <div><span>Exchange Order</span><strong>${escapeHtml(shortId(detail.exchangeOrderId || 'N/A', 22))}</strong></div>
                    <div><span>Requested</span><strong>${formatQty(detail.requestedQty)}</strong></div>
                    <div><span>Filled</span><strong>${formatQty(detail.filledQty)}</strong></div>
                </div>
                ${strategySession ? `
                    <div class="tca-session-strip">
                        <span>${escapeHtml(strategySession.strategyType || 'MANUAL')} session</span>
                        <span>${strategySession.lifecycleCount} lifecycle(s)</span>
                        <span>${strategySession.startedAt ? formatRelativeTime(strategySession.startedAt) : 'No start time'}</span>
                    </div>
                ` : ''}
                ${(detail.lineageAnomalies || []).length ? `
                    <div class="tca-session-strip" style="border-color:rgba(255,127,80,.35);color:#ffd9c9;">
                        <span>Lineage anomaly</span>
                        <span>${escapeHtml(detail.lineageAnomalies[0]?.payload?.reason || 'UNKNOWN')}</span>
                    </div>
                ` : ''}
                ${renderLineageGraph(detail)}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Role Quality ${renderInfoHelp(INFO_TIPS.executionQuality)}</div>
                ${renderExecutionQualityGuide({ unknownRoleCount: detail.orderRole === 'UNKNOWN' ? 1 : 0 })}
                ${renderRoleQuality(detail)}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Fill Context</div>
                ${fillRows.length ? `
                    <div class="tca-fill-list">
                        ${fillRows.map((fill) => {
        const liqClass = (fill.makerTaker || '').toLowerCase().includes('maker') ? 'liq-maker' : 'liq-taker';
        const liqLabel = (fill.makerTaker || '').toLowerCase().includes('maker') ? 'MAKER' : 'TAKER';
        const mk1 = fill.markouts.find((r) => r.horizonMs === 1000);
        const mk5 = fill.markouts.find((r) => r.horizonMs === 5000);
        const mk30 = fill.markouts.find((r) => r.horizonMs === 30000);
        const mkBadge = (label, mk) => {
            if (!mk || !Number.isFinite(mk.markoutBps)) return `<span class="tca-fill-mkbadge mk-neutral">${label} —</span>`;
            const cls = mk.markoutBps >= 0 ? 'mk-pos' : 'mk-neg';
            const sign = mk.markoutBps > 0 ? '+' : '';
            return `<span class="tca-fill-mkbadge ${cls}">${label} ${sign}${mk.markoutBps.toFixed(1)}</span>`;
        };
        return `
                                <div class="tca-fill-row">
                                    <div>
                                        <div class="tca-leader-title" style="gap:6px;">
                                            <span>${formatQty(fill.fillQty)} @ $${formatPrice(fill.fillPrice)}</span>
                                            <span class="tca-fill-liq-pill ${liqClass}">${liqLabel}</span>
                                        </div>
                                        <div class="tca-leader-subtitle">${formatRelativeTime(fill.fillTs)} · Mid: ${fill.fillMid ? '$' + formatPrice(fill.fillMid) : '—'}</div>
                                        <div class="tca-fill-markouts">
                                            ${mkBadge('1s', mk1)}
                                            ${mkBadge('5s', mk5)}
                                            ${mkBadge('30s', mk30)}
                                        </div>
                                    </div>
                                </div>
                            `;
    }).join('')}
                    </div>
                ` : '<div class="tca-chart-empty">No fills recorded for this lifecycle.</div>'}
            </div>

        </div>
    `;
}

function renderRoleQuality(detail) {
    const rows = Object.entries(detail.qualityByRole || {});
    if (!rows.length) return '';
    return `
        <div class="tca-fill-list">
            ${rows.map(([role, metrics]) => {
        const tox = Number(metrics?.toxicityScore || 0);
        return `
                <div class="tca-fill-row">
                    <div>
                        <div class="tca-leader-title">
                            <span>${escapeHtml(role)}</span>
                            <span style="font-family:var(--font-mono);font-weight:700;font-size:14px;">${tox.toFixed(1)}</span>
                        </div>
                        <div class="tca-leader-subtitle" style="font-size:11px;opacity:0.7;">
                            Arr ${formatBps(metrics?.avgArrivalSlippageBps)} ·
                            1s ${formatBps(metrics?.avgMarkout1sBps)} ·
                            5s ${formatBps(metrics?.avgMarkout5sBps)} ·
                            30s ${formatBps(metrics?.avgMarkout30sBps)}
                        </div>
                    </div>
                </div>
            `;
    }).join('')}
        </div>
    `;
}

function renderLineageGraph(detail) {
    if (detail?.lineageGraphLoading) {
        return '<div class="tca-chart-empty">Loading lineage graph…</div>';
    }
    if (detail?.lineageGraphError) {
        return `<div class="tca-inline-error">${escapeHtml(detail.lineageGraphError)}</div>`;
    }
    const graph = detail.lineageGraph;
    if (!graph || (!graph.nodes?.length && !graph.edges?.length)) {
        return '<div class="tca-chart-empty">No lineage graph edges persisted yet.</div>';
    }
    const nodes = (graph.nodes || []).slice(0, 24);
    const edges = (graph.edges || []).slice(0, 32);
    return `
        <div class="tca-session-strip">
            <span>${graph.stats?.nodeCount || nodes.length} node(s)</span>
            <span>${graph.stats?.edgeCount || edges.length} edge(s)</span>
            ${graph.truncated ? '<span>truncated</span>' : ''}
        </div>
        <div class="tca-session-strip">
            <span>Root</span>
            <span>${escapeHtml(graph.stats?.rootNodeType || 'NODE')}</span>
            <span>${escapeHtml(shortId(graph.stats?.rootNodeId || 'N/A', 22))}</span>
        </div>
        <div class="tca-fill-list">
            ${nodes.map((node) => `
                <div class="tca-fill-row">
                    <div class="tca-leader-title">${escapeHtml(node.nodeType || 'NODE')}</div>
                    <div class="tca-leader-subtitle">${escapeHtml(shortId(node.nodeId || 'N/A', 24))}</div>
                </div>
            `).join('')}
        </div>
        <div class="tca-timeline" style="gap:6px;">
            ${edges.map((edge) => `
                <div class="tca-evt-card">
                    <div class="tca-evt-header">
                        <span class="tca-evt-type evt-default">${escapeHtml(edge.relationType || 'REL')}</span>
                        <span class="tca-evt-time">${formatAbsoluteTime(edge.sourceTs || edge.createdAt)}</span>
                    </div>
                    <div class="tca-evt-fields">
                        <div class="tca-evt-field"><span class="tca-evt-field-label">From</span><span class="tca-evt-field-value">${escapeHtml(shortId(edge.parentNodeId || 'N/A', 22))}</span></div>
                        <div class="tca-evt-field"><span class="tca-evt-field-label">To</span><span class="tca-evt-field-value">${escapeHtml(shortId(edge.childNodeId || 'N/A', 22))}</span></div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function getEventTypeClass(eventType) {
    if (!eventType) return 'evt-default';
    const t = eventType.toUpperCase();
    if (t.includes('PLACE') || t.includes('NEW') || t.includes('SUBMIT')) return 'evt-placed';
    if (t.includes('ACK') || t.includes('ACCEPT')) return 'evt-ack';
    if (t.includes('FILL') || t.includes('TRADE')) return 'evt-fill';
    if (t.includes('CANCEL') || t.includes('EXPIRE')) return 'evt-cancel';
    if (t.includes('REJECT') || t.includes('ERROR')) return 'evt-reject';
    if (t.includes('REPLACE') || t.includes('AMEND') || t.includes('REPRICE')) return 'evt-replace';
    return 'evt-default';
}

function parseEventPayload(event) {
    const payload = event.payload || {};
    const fields = [];
    const KEYS = [
        'price',
        'stopPrice',
        'quantity',
        'filledQty',
        'side',
        'status',
        'orderType',
        'order_role',
        'strategy_session_id',
        'parent_strategy_session_id',
        'root_strategy_session_id',
        'replaces_client_order_id',
        'timeInForce',
        'reason',
        'rejectReason',
        'executionType',
        'makerTaker',
    ];
    for (const key of KEYS) {
        if (payload[key] != null && payload[key] !== '') {
            let val = payload[key];
            if (typeof val === 'number') {
                if (key.toLowerCase().includes('price')) val = '$' + formatPrice(val);
                else if (key.toLowerCase().includes('qty') || key.toLowerCase().includes('quantity')) val = formatQty(val);
            }
            fields.push({ label: key.replace(/([A-Z])/g, ' $1').trim(), value: String(val) });
        }
    }
    return fields;
}

function renderPricePathBpsRow(points) {
    if (points.length < 2) return '';
    const steps = [];
    for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const curr = points[i];
        const bps = ((curr.value - prev.value) / prev.value) * 10000;
        const cls = bps >= 0 ? 'pnl-up' : 'pnl-down';
        const sign = bps > 0 ? '+' : '';
        steps.push(`<span class="tca-pp-step"><span>${escapeHtml(prev.label)}</span><span class="pp-arrow">→</span><span>${escapeHtml(curr.label)}</span><span class="${cls}" style="font-weight:600;">${sign}${bps.toFixed(1)} bps</span></span>`);
    }
    return `<div class="tca-pricepath-detail">${steps.join('')}</div>`;
}

function buildPricePathPoints(detail) {
    const points = [];
    if (Number.isFinite(detail.decisionMid)) points.push({ label: 'Decision', value: detail.decisionMid });
    if (Array.isArray(detail.fills) && detail.fills.length) {
        const fillAnchor = average(detail.fills.map((fill) => fill.fillMid || fill.fillPrice));
        if (Number.isFinite(fillAnchor)) points.push({ label: 'Fill', value: fillAnchor });
    } else if (Number.isFinite(detail.avgFillPrice)) {
        points.push({ label: 'Fill', value: detail.avgFillPrice });
    }
    const horizons = [[1000, '1s'], [5000, '5s'], [30000, '30s']];
    for (const [horizonMs, label] of horizons) {
        const values = (detail.fills || [])
            .map((fill) => fill.markouts.find((markout) => markout.horizonMs === horizonMs)?.markPrice)
            .filter((value) => Number.isFinite(value));
        const point = average(values);
        if (Number.isFinite(point)) points.push({ label, value: point });
    }
    return points;
}

function renderPricePath(points) {
    if (!points.length) return '<div class="tca-chart-empty">Not enough market context to draw a price path.</div>';

    const width = 500;
    const height = 160;
    const min = Math.min(...points.map((point) => point.value));
    const max = Math.max(...points.map((point) => point.value));
    const spread = max - min || 1;
    const coords = points.map((point, index) => {
        const x = (index / Math.max(points.length - 1, 1)) * (width - 40) + 20;
        const y = height - (((point.value - min) / spread) * (height - 40) + 20);
        return { ...point, x, y };
    });

    return `
        <svg viewBox="0 0 ${width} ${height}" class="tca-price-path" preserveAspectRatio="none">
            <polyline
                points="${coords.map((point) => `${point.x},${point.y}`).join(' ')}"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
            ></polyline>
            ${coords.map((point) => `
                <circle cx="${point.x}" cy="${point.y}" r="5"></circle>
                <text x="${point.x}" y="${point.y - 10}" text-anchor="middle">${escapeHtml(point.label)}</text>
                <text x="${point.x}" y="${height - 10}" text-anchor="middle">$${formatPrice(point.value)}</text>
            `).join('')}
        </svg>
    `;
}

function selectedMarkoutFromRollup(row) {
    if (PAGE.filters.benchmarkMs === 1000) return row.avgMarkout1sBps;
    if (PAGE.filters.benchmarkMs === 30000) return row.avgMarkout30sBps;
    return row.avgMarkout5sBps;
}

function selectedMarkoutFromLifecycle(row, benchmarkMs) {
    if (benchmarkMs === 1000) return row.avgMarkout1sBps;
    if (benchmarkMs === 30000) return row.avgMarkout30sBps;
    return row.avgMarkout5sBps;
}

function selectedMarkoutFromDetail(detail, benchmarkMs) {
    if (benchmarkMs === 1000) return detail.markoutSummary?.avgMarkout1sBps;
    if (benchmarkMs === 30000) return detail.markoutSummary?.avgMarkout30sBps;
    return detail.markoutSummary?.avgMarkout5sBps;
}

function computeToxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps) {
    const mark1 = clamp(-(Number(avgMarkout1sBps) || 0), 0, 50);
    const mark5 = clamp(-(Number(avgMarkout5sBps) || 0), 0, 50);
    const arrival = clamp(Math.abs(Number(avgArrivalSlippageBps) || 0), 0, 50);
    return (0.5 * mark1) + (0.3 * mark5) + (0.2 * arrival);
}

function average(values) {
    const nums = values.filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function pctWidth(value, max) {
    return clamp((value / max) * 100, 2, 100);
}

function labelForHorizon(horizonMs) {
    if (horizonMs === 1000) return '1s';
    if (horizonMs === 30000) return '30s';
    return '5s';
}

function qualityBand(score) {
    if (score >= 85) return 'Strong';
    if (score >= 70) return 'Healthy';
    if (score >= 55) return 'Mixed';
    return 'Needs review';
}

function formatBps(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)} bps`;
}

function formatRatio(value) {
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
    return `${Math.round(value)}ms`;
}

function formatQty(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return Number(value).toFixed(4).replace(/\.?0+$/, '');
}

function formatRelativeTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const diffMs = Date.now() - date.getTime();
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (absMs < minute) return 'just now';
    const suffix = diffMs >= 0 ? 'ago' : 'ahead';
    if (absMs < hour) return `${Math.round(absMs / minute)}m ${suffix}`;
    if (absMs < day) return `${Math.round(absMs / hour)}h ${suffix}`;
    return `${Math.round(absMs / day)}d ${suffix}`;
}

function formatAbsoluteTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function statusClass(status) {
    if (status === 'FILLED') return 'is-filled';
    if (status === 'REJECTED') return 'is-rejected';
    if (status === 'CANCELLED' || status === 'EXPIRED') return 'is-cancelled';
    return 'is-live';
}

function shortId(value, length = 14) {
    if (!value) return '—';
    const text = String(value);
    if (text.length <= length) return text;
    return `${text.slice(0, length)}…`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const __tcaTestHooks = {
    parseTcaHashState,
    buildPaginationWindow,
    buildViewModel,
    resolveLineageRoleMetrics,
    renderStrategyLeaders,
    renderDetailContent,
    renderRoleQuality,
    renderLineageGraph,
    renderStrategyLotLedger,
    renderStrategyTimeline,
    renderMultiSeriesChart,
    roleMetricsFromStrategyDetail,
};
