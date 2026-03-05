import { state, api, formatUsd, formatPrice, formatPnlClass, showToast } from '../core/index.js';
import { subscribeAppStore } from '../store/app-store.js';
import { cuteKey, cuteSadFace, cuteSpinner } from '../lib/cute-empty.js';

const DEFAULT_FILTERS = {
    symbol: '',
    strategyType: '',
    finalStatus: '',
    lookback: '7d',
    includeNonHard: false,
    benchmarkMs: 5000,
};

const PAGE = {
    container: null,
    filters: { ...DEFAULT_FILTERS },
    data: null,
    loading: false,
    error: null,
    selectedLifecycleId: null,
    detail: null,
    detailLoading: false,
    unsubscribe: null,
    refreshTimer: null,
    inputTimer: null,
    requestSeq: 0,
    detailSeq: 0,
    onClick: null,
    onInput: null,
    onChange: null,
};

export function renderTcaPage(container) {
    cleanup();

    PAGE.container = container;
    PAGE.filters = { ...DEFAULT_FILTERS };
    PAGE.loading = false;
    PAGE.error = null;
    PAGE.data = null;
    PAGE.selectedLifecycleId = null;
    PAGE.detail = null;
    PAGE.detailLoading = false;

    bindEvents();
    PAGE.unsubscribe = subscribeAppStore(({ type }) => {
        if (type === 'currentAccount' && location.hash === '#/tca') {
            PAGE.selectedLifecycleId = null;
            PAGE.detail = null;
            loadPage();
        }
    });
    PAGE.refreshTimer = setInterval(() => {
        if (PAGE.container && location.hash === '#/tca') loadPage({ silent: true });
    }, 30000);

    render();
    loadPage();
}

export function cleanup() {
    if (PAGE.refreshTimer) clearInterval(PAGE.refreshTimer);
    if (PAGE.inputTimer) clearTimeout(PAGE.inputTimer);
    if (PAGE.unsubscribe) PAGE.unsubscribe();
    if (PAGE.container && PAGE.onClick) PAGE.container.removeEventListener('click', PAGE.onClick);
    if (PAGE.container && PAGE.onInput) PAGE.container.removeEventListener('input', PAGE.onInput);
    if (PAGE.container && PAGE.onChange) PAGE.container.removeEventListener('change', PAGE.onChange);

    PAGE.container = null;
    PAGE.unsubscribe = null;
    PAGE.refreshTimer = null;
    PAGE.inputTimer = null;
    PAGE.onClick = null;
    PAGE.onInput = null;
    PAGE.onChange = null;
}

function bindEvents() {
    if (!PAGE.container) return;

    PAGE.onClick = (event) => {
        const actionEl = event.target.closest('[data-action]');
        if (actionEl) {
            const { action } = actionEl.dataset;
            if (action === 'refresh') {
                loadPage();
                return;
            }
            if (action === 'set-benchmark') {
                const next = Number.parseInt(actionEl.dataset.benchmarkMs || '', 10);
                if (Number.isFinite(next)) {
                    PAGE.filters.benchmarkMs = next;
                    render();
                }
                return;
            }
            if (action === 'close-drawer') {
                PAGE.selectedLifecycleId = null;
                PAGE.detail = null;
                PAGE.detailLoading = false;
                render();
                return;
            }
            if (action === 'open-lifecycle') {
                const lifecycleId = actionEl.dataset.lifecycleId;
                if (lifecycleId) {
                    PAGE.selectedLifecycleId = lifecycleId;
                    PAGE.detail = null;
                    loadLifecycleDetail(lifecycleId);
                    render();
                }
                return;
            }
        }

        if (event.target.classList.contains('tca-drawer-overlay')) {
            PAGE.selectedLifecycleId = null;
            PAGE.detail = null;
            PAGE.detailLoading = false;
            render();
        }
    };

    PAGE.onInput = (event) => {
        const target = event.target.closest('[data-filter]');
        if (!target || target.dataset.filter !== 'symbol') return;
        PAGE.filters.symbol = target.value.trim().toUpperCase();
        debounceReload();
    };

    PAGE.onChange = (event) => {
        const target = event.target.closest('[data-filter]');
        if (!target) return;

        const { filter } = target.dataset;
        if (filter === 'strategyType') PAGE.filters.strategyType = target.value;
        if (filter === 'finalStatus') PAGE.filters.finalStatus = target.value;
        if (filter === 'lookback') PAGE.filters.lookback = target.value;
        if (filter === 'includeNonHard') PAGE.filters.includeNonHard = !!target.checked;
        loadPage();
    };

    PAGE.container.addEventListener('click', PAGE.onClick);
    PAGE.container.addEventListener('input', PAGE.onInput);
    PAGE.container.addEventListener('change', PAGE.onChange);
}

function debounceReload() {
    if (PAGE.inputTimer) clearTimeout(PAGE.inputTimer);
    PAGE.inputTimer = setTimeout(() => loadPage(), 400);
}

async function loadPage({ silent = false } = {}) {
    if (!PAGE.container) return;
    const subAccountId = state.currentAccount;
    const requestSeq = ++PAGE.requestSeq;

    PAGE.error = null;
    PAGE.loading = !silent || !PAGE.data;
    render();

    if (!subAccountId) {
        PAGE.loading = false;
        PAGE.data = null;
        render();
        return;
    }

    const commonParams = buildCommonParams();
    const lifecycleParams = new URLSearchParams(commonParams);
    lifecycleParams.set('limit', '200');
    if (PAGE.filters.finalStatus) lifecycleParams.set('finalStatus', PAGE.filters.finalStatus);

    const strategyRollupParams = new URLSearchParams(commonParams);
    if (PAGE.filters.strategyType) strategyRollupParams.set('strategyType', PAGE.filters.strategyType);

    const sessionParams = new URLSearchParams();
    sessionParams.set('limit', '120');
    if (PAGE.filters.symbol) sessionParams.set('symbol', PAGE.filters.symbol);
    if (PAGE.filters.strategyType) sessionParams.set('strategyType', PAGE.filters.strategyType);
    const lookbackStart = getLookbackStart(PAGE.filters.lookback);
    if (lookbackStart) sessionParams.set('from', lookbackStart.toISOString());

    try {
        const [rollups, strategyRollups, lifecycles, markouts, strategySessions] = await Promise.all([
            api(`/trade/tca/rollups/${subAccountId}?${commonParams.toString()}`),
            api(`/trade/tca/strategy-rollups/${subAccountId}?${strategyRollupParams.toString()}`),
            api(`/trade/tca/lifecycles/${subAccountId}?${lifecycleParams.toString()}`),
            api(`/trade/tca/markouts/${subAccountId}?${new URLSearchParams([...commonParams, ['limit', '500']]).toString()}`),
            api(`/trade/tca/strategy-sessions/${subAccountId}?${sessionParams.toString()}`),
        ]);

        if (requestSeq !== PAGE.requestSeq) return;

        PAGE.data = {
            rollups: Array.isArray(rollups) ? rollups : [],
            strategyRollups: Array.isArray(strategyRollups) ? strategyRollups : [],
            lifecycles: Array.isArray(lifecycles) ? lifecycles : [],
            markouts: Array.isArray(markouts) ? markouts : [],
            strategySessions: Array.isArray(strategySessions) ? strategySessions : [],
        };
        PAGE.loading = false;
        PAGE.error = null;
        render();

        if (PAGE.selectedLifecycleId) loadLifecycleDetail(PAGE.selectedLifecycleId, { silent: true });
    } catch (err) {
        if (requestSeq !== PAGE.requestSeq) return;
        PAGE.loading = false;
        PAGE.error = err;
        render();
    }
}

async function loadLifecycleDetail(lifecycleId, { silent = false } = {}) {
    if (!PAGE.container || !state.currentAccount || !lifecycleId) return;
    const detailSeq = ++PAGE.detailSeq;

    PAGE.detailLoading = !silent || !PAGE.detail;
    render();

    try {
        const detail = await api(`/trade/tca/lifecycle/${state.currentAccount}/${lifecycleId}`);
        if (detailSeq !== PAGE.detailSeq || PAGE.selectedLifecycleId !== lifecycleId) return;
        PAGE.detail = detail;
        PAGE.detailLoading = false;
        render();
    } catch (err) {
        if (detailSeq !== PAGE.detailSeq || PAGE.selectedLifecycleId !== lifecycleId) return;
        PAGE.detailLoading = false;
        PAGE.detail = null;
        showToast(err.message || 'Failed to load TCA detail', 'error');
        render();
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

function render() {
    if (!PAGE.container) return;

    const symbolInput = PAGE.container.querySelector('[data-filter="symbol"]');
    const hadSymbolFocus = symbolInput && document.activeElement === symbolInput;
    const cursorPos = hadSymbolFocus ? symbolInput.selectionStart : null;

    if (!state.currentAccount) {
        PAGE.container.innerHTML = cuteKey({
            title: 'No Account Selected ✨',
            subtitle: 'Pick a sub-account to review execution quality.',
        });
        return;
    }

    if (PAGE.loading && !PAGE.data) {
        PAGE.container.innerHTML = cuteSpinner();
        return;
    }

    if (PAGE.error && !PAGE.data) {
        PAGE.container.innerHTML = cuteSadFace({
            title: 'TCA Unavailable',
            subtitle: PAGE.error.message || 'Failed to load execution quality data.',
        });
        return;
    }

    const view = buildViewModel(PAGE.data);
    PAGE.container.innerHTML = `
        <div class="tca-page">
            <section class="glass-card tca-hero">
                <div class="tca-hero-copy">
                    <div class="tca-eyebrow">Execution Quality</div>
                    <div class="section-header" style="margin-bottom:8px;">
                        <h2 class="section-title">Trade Cost Analysis</h2>
                    </div>
                    <p class="tca-hero-text">
                        Review fill quality, latency, and markouts for the current sub-account.
                        Default scope is <strong>SUB_ACCOUNT</strong> with <strong>HARD</strong> ownership only.
                    </p>
                </div>
                <div class="tca-filter-rail">
                    ${renderFilterBar(view)}
                </div>
            </section>

            ${renderSummary(view)}

            <section class="tca-grid">
                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">Benchmark Pulse</div>
                            <div class="tca-panel-caption">Recent filtered slice across ${view.summary.orderCount} lifecycle(s).</div>
                        </div>
                        <div class="tca-segmented">
                            ${renderBenchmarkButtons()}
                        </div>
                    </div>
                    <div class="tca-chart-card">
                        <div class="tca-spark-wrap">
                            ${renderSparkline(view.sparklinePoints)}
                        </div>
                        <div class="tca-bar-list">
                            ${renderBenchmarkBars(view)}
                        </div>
                    </div>
                </div>

                <div class="glass-card tca-panel">
                    <div class="tca-panel-head">
                        <div>
                            <div class="card-title">Strategy Footprint</div>
                            <div class="tca-panel-caption">Sessions ranked by filled notional inside the current filter window.</div>
                        </div>
                    </div>
                    ${renderStrategyLeaders(view)}
                </div>
            </section>

            <section class="glass-card tca-panel">
                <div class="tca-panel-head">
                    <div>
                        <div class="card-title">Review Queue</div>
                        <div class="tca-panel-caption">
                            Click a lifecycle to inspect fills, stream events, markouts, and strategy lineage.
                        </div>
                    </div>
                    <button class="btn btn-outline btn-sm" type="button" data-action="refresh">Refresh</button>
                </div>
                ${renderLifecycleTable(view)}
            </section>

            ${PAGE.error ? `<div class="tca-inline-error">${escapeHtml(PAGE.error.message || 'Refresh failed')}</div>` : ''}
            ${renderDrawer(view)}
        </div>
    `;

    if (hadSymbolFocus) {
        const restored = PAGE.container.querySelector('[data-filter="symbol"]');
        if (restored) {
            restored.focus();
            if (cursorPos !== null) {
                restored.setSelectionRange(cursorPos, cursorPos);
            }
        }
    }
}

function buildViewModel(data) {
    const rollups = data?.rollups || [];
    const strategyRollups = data?.strategyRollups || [];
    const lifecycles = (data?.lifecycles || []).slice();
    const strategySessions = data?.strategySessions || [];
    const markoutLookup = buildLifecycleMarkoutLookup(data?.markouts || []);
    const availableStrategyTypes = Array.from(new Set(
        [
            ...lifecycles.map((row) => row.strategyType),
            ...strategyRollups.map((row) => row.strategyType),
            ...strategySessions.map((row) => row.strategyType),
        ].filter(Boolean),
    )).sort();

    const enrichedLifecycles = lifecycles.map((row) => {
        const markouts = markoutLookup.get(row.lifecycleId) || {};
        const selectedMarkout = markouts[PAGE.filters.benchmarkMs] ?? null;
        const severityScore = buildSeverityScore(row, selectedMarkout);
        return { ...row, markouts, selectedMarkout, severityScore };
    }).sort((left, right) => {
        if (right.severityScore !== left.severityScore) return right.severityScore - left.severityScore;
        return new Date(right.updatedAt || right.doneTs || right.intentTs || 0).getTime()
            - new Date(left.updatedAt || left.doneTs || left.intentTs || 0).getTime();
    });

    const summary = buildSliceSummary(enrichedLifecycles, strategySessions);
    const baseline = buildRollupBaseline(rollups);
    const sessionById = new Map(strategySessions.map((row) => [row.strategySessionId, row]));
    const strategyLeaders = strategyRollups
        .map((row) => ({ ...row, session: sessionById.get(row.strategySessionId) || null }))
        .sort((left, right) => (right.totalFillNotional || 0) - (left.totalFillNotional || 0))
        .slice(0, 5);

    return {
        availableStrategyTypes,
        benchmarkMs: PAGE.filters.benchmarkMs,
        benchmarkLabel: labelForHorizon(PAGE.filters.benchmarkMs),
        baseline,
        lifecycles: enrichedLifecycles,
        sparklinePoints: enrichedLifecycles
            .slice(0, 24)
            .reverse()
            .map((row) => row.selectedMarkout)
            .filter((value) => Number.isFinite(value)),
        strategyLeaders,
        strategySessions,
        summary,
    };
}

function buildLifecycleMarkoutLookup(markouts) {
    const grouped = new Map();
    for (const row of markouts || []) {
        if (!row.lifecycleId || !Number.isFinite(row.markoutBps)) continue;
        const lifecycleEntry = grouped.get(row.lifecycleId) || {};
        const bucket = lifecycleEntry[row.horizonMs] || [];
        bucket.push(row.markoutBps);
        lifecycleEntry[row.horizonMs] = bucket;
        grouped.set(row.lifecycleId, lifecycleEntry);
    }

    const averages = new Map();
    for (const [lifecycleId, horizonMap] of grouped.entries()) {
        const next = {};
        for (const [horizonMs, values] of Object.entries(horizonMap)) {
            next[horizonMs] = average(values);
        }
        averages.set(lifecycleId, next);
    }
    return averages;
}

function buildSliceSummary(lifecycles, strategySessions) {
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

    if (!lifecycles.length) return summary;

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
        if (row.fillCount > 0 || (row.filledQty || 0) > 0) summary.fillCount += 1;
        if (row.finalStatus === 'REJECTED') summary.rejectCount += 1;
        if (row.finalStatus === 'CANCELLED' || row.finalStatus === 'EXPIRED') summary.cancelCount += 1;
        summary.totalRequestedQty += Number(row.requestedQty || 0);
        summary.totalFilledQty += Number(row.filledQty || 0);
        summary.totalFillNotional += Number(row.avgFillPrice || 0) * Number(row.filledQty || 0);
        summary.totalRepriceCount += Number(row.repriceCount || 0);
        if (Number.isFinite(row.arrivalSlippageBps)) arrivals.push(row.arrivalSlippageBps);
        if (Number.isFinite(row.ackLatencyMs)) acks.push(row.ackLatencyMs);
        if (Number.isFinite(row.workingTimeMs)) workings.push(row.workingTimeMs);
        if (Number.isFinite(row.markouts[1000])) markout1s.push(row.markouts[1000]);
        if (Number.isFinite(row.markouts[5000])) markout5s.push(row.markouts[5000]);
        if (Number.isFinite(row.markouts[30000])) markout30s.push(row.markouts[30000]);
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
            <label class="tca-filter-field">
                <span>Status</span>
                <select data-filter="finalStatus">
                    <option value="">All</option>
                    ${['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map((status) => `
                        <option value="${status}" ${PAGE.filters.finalStatus === status ? 'selected' : ''}>${status}</option>
                    `).join('')}
                </select>
            </label>
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
                <span>Include non-hard rows</span>
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
                <div class="price-label">Execution Score</div>
                <div class="tca-score-row">
                    <div class="price-big">${summary.qualityScore.toFixed(0)}</div>
                    <div class="tca-score-pill ${qualityClass}">${qualityBand(summary.qualityScore)}</div>
                </div>
                <div class="tca-muted-line">Filtered slice. Benchmark: ${view.benchmarkLabel}.</div>
            </div>
            <div class="glass-card tca-kpi-card">
                <div class="price-label">Avg Arrival</div>
                <div class="price-big ${formatPnlClass(-(summary.avgArrivalSlippageBps || 0))}">${formatBps(summary.avgArrivalSlippageBps)}</div>
                <div class="tca-muted-line">Lower is better for urgent buys.</div>
            </div>
            <div class="glass-card tca-kpi-card">
                <div class="price-label">Avg ${view.benchmarkLabel}</div>
                <div class="price-big ${formatPnlClass(summary.selectedMarkoutBps || 0)}">${formatBps(summary.selectedMarkoutBps)}</div>
                <div class="tca-muted-line">Markout of fills in current filter slice.</div>
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
            value: summary.avgArrivalSlippageBps,
            width: pctWidth(Math.abs(summary.avgArrivalSlippageBps || 0), 25),
            className: 'tca-bar-negative',
            text: formatBps(summary.avgArrivalSlippageBps),
        },
        {
            label: `${view.benchmarkLabel} markout`,
            value: summary.selectedMarkoutBps,
            width: pctWidth(Math.abs(summary.selectedMarkoutBps || 0), 25),
            className: (summary.selectedMarkoutBps || 0) >= 0 ? 'tca-bar-positive' : 'tca-bar-negative',
            text: formatBps(summary.selectedMarkoutBps),
        },
        {
            label: 'Fill ratio',
            value: summary.fillRatio,
            width: pctWidth((summary.fillRatio || 0) * 100, 100),
            className: 'tca-bar-neutral',
            text: formatRatio(summary.fillRatio),
        },
        {
            label: 'Reject rate',
            value: summary.rejectRate,
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
        return `<div class="tca-chart-empty">No strategy sessions match the current filters.</div>`;
    }

    return `
        <div class="tca-leader-list">
            ${view.strategyLeaders.map((row) => {
        const sessionLabel = row.session?.symbol || row.strategyType || 'Session';
        const selectedMarkout = selectedMarkoutFromRollup(row);
        return `
                    <div class="tca-leader-row">
                        <div>
                            <div class="tca-leader-title">${escapeHtml(row.strategyType || 'MANUAL')} · ${escapeHtml(sessionLabel || 'Unknown')}</div>
                            <div class="tca-leader-subtitle">${escapeHtml(shortId(row.strategySessionId))} · ${row.session?.startedAt ? formatRelativeTime(row.session.startedAt) : 'No start time'}</div>
                        </div>
                        <div class="tca-leader-metrics">
                            <span class="${formatPnlClass(-(row.avgArrivalSlippageBps || 0))}">${formatBps(row.avgArrivalSlippageBps)}</span>
                            <span class="${formatPnlClass(selectedMarkout || 0)}">${formatBps(selectedMarkout)}</span>
                            <span>${formatUsd(row.totalFillNotional || 0, 0)}</span>
                        </div>
                    </div>
                `;
    }).join('')}
        </div>
    `;
}

function renderLifecycleTable(view) {
    if (!view.lifecycles.length) {
        return `<div class="tca-chart-empty">No lifecycle rows match the current filter window.</div>`;
    }

    return `
        <div class="tca-table-wrap">
            <table class="data-table tca-table">
                <thead>
                    <tr>
                        <th>Trade</th>
                        <th>Quality</th>
                        <th>Latency</th>
                        <th>Fills</th>
                        <th>Lineage</th>
                    </tr>
                </thead>
                <tbody>
                    ${view.lifecycles.map((row) => `
                        <tr class="${PAGE.selectedLifecycleId === row.lifecycleId ? 'tca-row-active' : ''}">
                            <td>
                                <button type="button" class="tca-row-button" data-action="open-lifecycle" data-lifecycle-id="${row.lifecycleId}">
                                    <div class="tca-row-title">
                                        <span>${escapeHtml(row.symbol || 'Unknown')}</span>
                                        <span class="badge badge-${row.side === 'SELL' ? 'short' : 'long'}">${escapeHtml(row.side || 'N/A')}</span>
                                        <span class="tca-state-pill ${statusClass(row.finalStatus)}">${escapeHtml(row.finalStatus || 'LIVE')}</span>
                                    </div>
                                    <div class="tca-row-subtitle">${formatRelativeTime(row.doneTs || row.firstFillTs || row.intentTs || row.updatedAt)} · ${escapeHtml(row.originPath || 'UNKNOWN')}</div>
                                </button>
                            </td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span class="${formatPnlClass(-(row.arrivalSlippageBps || 0))}">${formatBps(row.arrivalSlippageBps)}</span>
                                    <span class="${formatPnlClass(row.selectedMarkout || 0)}">${formatBps(row.selectedMarkout)}</span>
                                </div>
                            </td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span>${formatMs(row.ackLatencyMs)}</span>
                                    <span>${formatMs(row.workingTimeMs)}</span>
                                </div>
                            </td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span>${formatQty(row.filledQty)} / ${formatQty(row.requestedQty)}</span>
                                    <span>${row.avgFillPrice ? `$${formatPrice(row.avgFillPrice)}` : 'No fill price'}</span>
                                </div>
                            </td>
                            <td>
                                <div class="tca-cell-stack">
                                    <span>${escapeHtml(row.strategyType || 'MANUAL')}</span>
                                    <span>${escapeHtml(shortId(row.strategySessionId || row.parentId || row.clientOrderId || row.lifecycleId))}</span>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
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
                        <div class="card-title">Lifecycle Detail</div>
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
                <span class="tca-meta-pill">${escapeHtml(detail.reconciliationStatus || 'PENDING')}</span>
            </div>

            <div class="tca-detail-grid">
                <div class="stat-item">
                    <div class="stat-label">Arrival</div>
                    <div class="stat-value ${formatPnlClass(-(detail.arrivalSlippageBps || 0))}">${formatBps(detail.arrivalSlippageBps)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Ack Latency</div>
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
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Lineage</div>
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
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Fill Context</div>
                ${fillRows.length ? `
                    <div class="tca-fill-list">
                        ${fillRows.map((fill) => `
                            <div class="tca-fill-row">
                                <div>
                                    <div class="tca-leader-title">${formatQty(fill.fillQty)} @ $${formatPrice(fill.fillPrice)}</div>
                                    <div class="tca-leader-subtitle">${formatRelativeTime(fill.fillTs)} · ${escapeHtml(fill.makerTaker || 'Unknown liquidity')}</div>
                                </div>
                                <div class="tca-leader-metrics">
                                    <span>${fill.fillMid ? `$${formatPrice(fill.fillMid)}` : 'No mid'}</span>
                                    <span>${formatBps(fill.markouts.find((row) => row.horizonMs === 1000)?.markoutBps)}</span>
                                    <span>${formatBps(fill.markouts.find((row) => row.horizonMs === 5000)?.markoutBps)}</span>
                                    <span>${formatBps(fill.markouts.find((row) => row.horizonMs === 30000)?.markoutBps)}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                ` : '<div class="tca-chart-empty">No fills recorded for this lifecycle.</div>'}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Timeline</div>
                ${eventRows.length ? `
                    <div class="tca-timeline">
                        ${eventRows.map((event) => `
                            <div class="tca-timeline-row">
                                <div class="tca-timeline-meta">
                                    <strong>${escapeHtml(event.eventType)}</strong>
                                    <span>${formatAbsoluteTime(event.sourceTs || event.createdAt)}</span>
                                </div>
                                <details class="tca-event-details">
                                    <summary>${escapeHtml(shortId(event.streamEventId, 28))}</summary>
                                    <pre>${escapeHtml(JSON.stringify(event.payload || {}, null, 2))}</pre>
                                </details>
                            </div>
                        `).join('')}
                    </div>
                ` : '<div class="tca-chart-empty">No lifecycle events persisted.</div>'}
            </div>
        </div>
    `;
}

function buildPricePathPoints(detail) {
    const points = [];
    if (Number.isFinite(detail.decisionMid)) {
        points.push({ label: 'Decision', value: detail.decisionMid });
    }
    if (Array.isArray(detail.fills) && detail.fills.length) {
        const fillAnchor = average(detail.fills.map((fill) => fill.fillMid || fill.fillPrice));
        if (Number.isFinite(fillAnchor)) points.push({ label: 'Fill', value: fillAnchor });
    } else if (Number.isFinite(detail.avgFillPrice)) {
        points.push({ label: 'Fill', value: detail.avgFillPrice });
    }

    const horizons = [
        [1000, '1s'],
        [5000, '5s'],
        [30000, '30s'],
    ];
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
    if (!points.length) {
        return `<div class="tca-chart-empty">Not enough market context to draw a price path.</div>`;
    }

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

function selectedMarkoutFromDetail(detail, benchmarkMs) {
    if (benchmarkMs === 1000) return detail.markoutSummary?.avgMarkout1sBps;
    if (benchmarkMs === 30000) return detail.markoutSummary?.avgMarkout30sBps;
    return detail.markoutSummary?.avgMarkout5sBps;
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
