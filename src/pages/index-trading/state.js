// ── Shared state & persistence for index-trading ─
// All sibling modules import `st` to read/write shared state.

const LS_INDEXES_KEY = 'pms_indexes';
const LS_PAIR_SELECTIONS_KEY = 'pms_pair_selections';
const LS_CUSTOM_PAIRS_KEY = 'pms_custom_ls_pairs';

/** Mutable state bag – every sibling module shares this single object. */
export const st = {
    indexes: [],           // [{ id, name, formula: [{ symbol, factor }] }]
    selectedIndex: null,
    tradeSize: 100,
    leverage: 20,
    isExecuting: false,
    idxExecMode: 'instant', // 'instant' | 'twap'
    idxTwapLots: 10,
    idxTwapDuration: 30,
    idxTwapJitter: false,
    idxTwapIrregular: false,
    activeTwapBasketIds: [],

    // Live UPNL tracking
    basketPriceUnsubs: {},
    basketLatestPrices: {},
    basketUpnlInterval: null,

    // Chart
    chart: null,
    compositeSeries: null,
    volumeSeries: null,
    chartReady: false,
    currentTimeframe: '5m',
    compositeStreamUnsubs: {},
    compositeContext: null,
    compositeLoadVersion: 0,

    // Symbols
    allSymbols: [],
    symbolsLoaded: false,
    baseToSymbol: new Map(),

    // Editor
    editorVisible: false,
    editorSymbols: [],
    editorName: '',
    editingId: null,

    // Composite data cache
    compositeCache: {},

    // Beta pair builder
    pairBuilderVisible: false,
    pairBuilderLoading: false,
    pairBuilderTimeframe: '1h',
    pairBuilderTopCount: 20,
    pairBuilderBottomCount: 20,
    pairBuilderLimit: 200,
    pairBuilderSearch: '',
    pairBuilderSortColumn: 'score',
    pairBuilderSortDirection: 'desc',
    pairBuilderLong: [],
    pairBuilderShort: [],
    pairMatrix: [],
    pairBuilderTab: 'matrix',

    // All-symbols tab
    allTickerRows: [],
    allTickerLoading: false,
    allTickerSearch: '',
    allTickerSortCol: 'change24h',
    allTickerSortDir: 'desc',
    symbolSelLong: [],
    symbolSelShort: [],
    pairKlineCache: new Map(),
    vinePairSignalMap: new Map(),
    vineSignalSource: null,
    vineSignalGeneratedAt: null,
    topIndexPicks: [],
    topIndexPicksLoading: false,
    topIndexPicksSource: null,
    topIndexPicksGeneratedAt: null,
    topIndexRecommendations: {
        longNow: [],
        shortNow: [],
        mostVolatile: [],
        diversified: [],
    },

    // Cleanup registry
    cleanupFns: [],
};

// ── Persistence helpers ──────────────────────────

export function loadIndexes() {
    try {
        const raw = localStorage.getItem(LS_INDEXES_KEY);
        if (raw) st.indexes = JSON.parse(raw);
    } catch { st.indexes = []; }
}

export function saveIndexes() {
    try {
        localStorage.setItem(LS_INDEXES_KEY, JSON.stringify(st.indexes));
    } catch { }
}

export function loadPairSelections() {
    try {
        const raw = localStorage.getItem(LS_PAIR_SELECTIONS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        st.pairBuilderLong = Array.isArray(parsed?.basketLong) ? parsed.basketLong : [];
        st.pairBuilderShort = Array.isArray(parsed?.basketShort) ? parsed.basketShort : [];
    } catch {
        st.pairBuilderLong = [];
        st.pairBuilderShort = [];
    }
}

export function savePairSelections() {
    try {
        localStorage.setItem(LS_PAIR_SELECTIONS_KEY, JSON.stringify({
            basketLong: st.pairBuilderLong,
            basketShort: st.pairBuilderShort,
            basketChart: [],
        }));
    } catch { }
}

export function loadCustomPairs() {
    try {
        const raw = localStorage.getItem(LS_CUSTOM_PAIRS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveCustomPairs(pairs) {
    try {
        localStorage.setItem(LS_CUSTOM_PAIRS_KEY, JSON.stringify(pairs));
    } catch { }
}

export function addCustomPair(pairStats) {
    const pairs = loadCustomPairs();
    const idx = pairs.findIndex((x) => x.pair === pairStats.pair);
    if (idx >= 0) pairs[idx] = pairStats;
    else pairs.push(pairStats);
    saveCustomPairs(pairs);
}

export function removeCustomPair(pairName) {
    const filtered = loadCustomPairs().filter((x) => x.pair !== pairName);
    saveCustomPairs(filtered);
}

export function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
