import { api, formatPnlClass, formatUsd, showToast } from '../../core/index.js';

const MODAL_ID = 'tca-strategy-modal-overlay';
const DEFAULT_MAX_POINTS = 180;
const DEFAULT_EVENTS_PAGE_SIZE = 8;

let activeOverlay = null;
let activeKeyHandler = null;
let activeRequestSeq = 0;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function shortId(value, length = 18) {
    const text = String(value || '');
    if (!text) return '—';
    if (text.length <= length) return text;
    return `${text.slice(0, length)}…`;
}

function formatBps(value) {
    if (!Number.isFinite(Number(value))) return '—';
    const num = Number(value);
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(1)} bps`;
}

function formatQty(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return Number(value).toFixed(4).replace(/\.?0+$/, '');
}

function formatRelativeTime(value) {
    if (!value) return '—';
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) return '—';
    const diffMs = Date.now() - ts;
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

function toxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps) {
    const clip = (value) => Math.min(50, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
    const adverse1 = clip(-Number(avgMarkout1sBps));
    const adverse5 = clip(-Number(avgMarkout5sBps));
    const arrival = clip(Math.abs(Number(avgArrivalSlippageBps)));
    return (0.5 * adverse1) + (0.3 * adverse5) + (0.2 * arrival);
}

function formatLayerSide(side) {
    const sideUpper = String(side || '').toUpperCase();
    if (sideUpper === 'BUY' || sideUpper === 'LONG') return 'LONG';
    if (sideUpper === 'SELL' || sideUpper === 'SHORT') return 'SHORT';
    return sideUpper || 'SIDE';
}

function formatCompactPrice(value) {
    const price = Number(value);
    if (!(price > 0)) return '—';
    if (price >= 1000) return `$${price.toFixed(2)}`;
    if (price >= 1) return `$${price.toFixed(4)}`;
    if (price >= 0.01) return `$${price.toFixed(5)}`;
    return `$${price.toFixed(6)}`;
}

function checkpointTone(row = {}) {
    const type = String(row.type || '').toUpperCase();
    const status = String(row.status || '').toUpperCase();
    if (type.includes('FAIL') || status.includes('FAILED')) return 'is-bad';
    if (type.includes('PAUSE') || status.includes('PAUSED')) return 'is-warn';
    if (type.includes('STOP') || status.includes('CANCELLED')) return 'is-muted';
    return 'is-good';
}

function _formatAxisValue(value, isBps = false) {
    if (isBps) {
        return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
    }
    const abs = Math.abs(value);
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
    return `$${value.toFixed(2)}`;
}

function buildSeriesChart(points = [], seriesDefs = [], { yAxisLabel = '', isBps = false } = {}) {
    const rows = Array.isArray(points) ? points : [];
    if (!rows.length) {
        return '<div class="tca-chart-empty">No samples in the selected window.</div>';
    }

    const width = 860;
    const height = 220;
    const padLeft = 58;
    const padTop = 9;
    const padBottom = 9;
    const plotW = width - padLeft - 6;
    const plotH = height - padTop - padBottom;
    const values = [];
    for (const row of rows) {
        for (const [key] of seriesDefs) {
            const value = Number(row?.[key]);
            if (Number.isFinite(value)) values.push(value);
        }
    }
    if (!values.length) {
        return '<div class="tca-chart-empty">No numeric series available.</div>';
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = Math.max(1e-9, max - min);

    // Y-axis grid lines (4 ticks)
    const ticks = 4;
    let gridLines = '';
    let axisLabels = '';
    for (let i = 0; i <= ticks; i++) {
        const ratio = i / ticks;
        const val = max - ratio * spread;
        const y = padTop + ratio * plotH;
        gridLines += `<line x1="${padLeft}" y1="${y}" x2="${width - 6}" y2="${y}" stroke="rgba(148,163,184,0.1)" stroke-width="1" stroke-dasharray="4 3"></line>`;
        axisLabels += `<text x="${padLeft - 6}" y="${y + 3.5}" text-anchor="end" fill="rgba(148,163,184,0.5)" font-size="9" font-family="var(--font-mono)">${escapeHtml(_formatAxisValue(val, isBps))}</text>`;
    }

    // Zero line if range crosses zero
    let zeroLine = '';
    if (min < 0 && max > 0) {
        const zeroY = padTop + ((max - 0) / spread) * plotH;
        zeroLine = `<line x1="${padLeft}" y1="${zeroY}" x2="${width - 6}" y2="${zeroY}" stroke="rgba(148,163,184,0.28)" stroke-width="1"></line>`;
    }

    const lines = seriesDefs.map(([key, label, color]) => {
        const coords = rows
            .map((row, index) => {
                const value = Number(row?.[key]);
                if (!Number.isFinite(value)) return null;
                const x = padLeft + (index / Math.max(rows.length - 1, 1)) * plotW;
                const y = padTop + ((max - value) / spread) * plotH;
                return `${x},${y}`;
            })
            .filter(Boolean)
            .join(' ');
        if (!coords) return '';
        return `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
    }).join('');

    // Last values for each series
    const lastValues = seriesDefs.map(([key, label, color]) => {
        for (let i = rows.length - 1; i >= 0; i--) {
            const v = Number(rows[i]?.[key]);
            if (Number.isFinite(v)) return { label, color, value: v };
        }
        return null;
    }).filter(Boolean);

    return `
        <div class="tca-series-chart">
            <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                ${gridLines}
                ${zeroLine}
                ${axisLabels}
                ${lines}
            </svg>
            <div class="tca-series-legend">
                ${lastValues.map(({ label, color, value }) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${color};"></i>${escapeHtml(label)} <b style="color:${color};font-family:var(--font-mono);font-size:11px;">${escapeHtml(_formatAxisValue(value, isBps))}</b></span>`).join('')}
            </div>
        </div>
    `;
}

function renderSummaryCards(detail = {}) {
    const strategySession = detail.strategySession || {};
    const rollup = detail.rollup || {};
    const runtime = detail.runtime || {};
    const latestPnlSample = detail.latestPnlSample || {};
    const netPnl = rollup.netPnl ?? latestPnlSample.netPnl ?? 0;
    const fillCount = rollup.fillCount ?? latestPnlSample.fillCount ?? 0;
    const openNotional = rollup.openNotional ?? latestPnlSample.openNotional ?? 0;
    const tox = rollup.toxicityScore ?? toxicityScore(
        rollup.avgArrivalSlippageBps,
        rollup.avgMarkout1sBps,
        rollup.avgMarkout5sBps,
    );
    const anomalyCount = Number(detail?.anomalyCounts?.unknownLineageCount || 0) + Number(detail?.anomalyCounts?.sessionPnlAnomalyCount || 0);

    return `
        <div class="tca-modal-summary-grid">
            <div class="stat-item tca-signal-card tca-signal-card-pnl">
                <div class="stat-label">Net PnL</div>
                <div class="stat-value ${formatPnlClass(netPnl)}">${formatUsd(netPnl, 2)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-fill">
                <div class="stat-label">Fills</div>
                <div class="stat-value">${Number(fillCount || 0)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-open">
                <div class="stat-label">Open Notional</div>
                <div class="stat-value">${formatUsd(openNotional, 0)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-toxic">
                <div class="stat-label">Toxicity</div>
                <div class="stat-value">${Number(tox || 0).toFixed(2)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-runtime">
                <div class="stat-label">Runtime</div>
                <div class="stat-value">${escapeHtml(runtime.status || strategySession.status || 'UNKNOWN')}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-arrival">
                <div class="stat-label">Arrival</div>
                <div class="stat-value ${formatPnlClass(-(rollup.avgArrivalSlippageBps || 0))}">${formatBps(rollup.avgArrivalSlippageBps)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-markout">
                <div class="stat-label">5s Markout</div>
                <div class="stat-value ${formatPnlClass(rollup.avgMarkout5sBps || 0)}">${formatBps(rollup.avgMarkout5sBps)}</div>
            </div>
            <div class="stat-item tca-signal-card tca-signal-card-anomaly">
                <div class="stat-label">Anomalies</div>
                <div class="stat-value">${anomalyCount}</div>
            </div>
        </div>
    `;
}

function renderActiveLayers(activeLayers = {}) {
    const scalper = activeLayers.scalper || null;
    const chases = Array.isArray(activeLayers.chases) ? activeLayers.chases : [];
    if (!scalper && !chases.length) return '';

    const buys = chases
        .filter((row) => ['BUY', 'LONG'].includes(String(row.side || '').toUpperCase()))
        .sort((left, right) => Number(right.currentOrderPrice || 0) - Number(left.currentOrderPrice || 0));
    const sells = chases
        .filter((row) => ['SELL', 'SHORT'].includes(String(row.side || '').toUpperCase()))
        .sort((left, right) => Number(left.currentOrderPrice || 0) - Number(right.currentOrderPrice || 0));

    const renderColumn = (title, rows, tone) => {
        const duplicateCounts = new Map();
        for (const row of rows) {
            const priceKey = Number(row.currentOrderPrice || 0).toFixed(8);
            if (!Number.isFinite(Number(priceKey))) continue;
            duplicateCounts.set(priceKey, (duplicateCounts.get(priceKey) || 0) + 1);
        }

        return `
            <div class="tca-live-layer-card ${tone}">
                <div class="tca-live-layer-head">
                    <div class="card-title">${title}</div>
                    <div class="tca-live-layer-meta">${rows.length} active</div>
                </div>
                ${rows.length ? `
                    <div class="tca-live-layer-list">
                        ${rows.map((row) => {
            const price = Number(row.currentOrderPrice || 0);
            const qty = Number(row.quantity || row.qty || 0);
            const offset = Number(row.stalkOffsetPct || 0);
            const notional = price > 0 && qty > 0 ? price * qty : 0;
            const priceKey = price.toFixed(8);
            const duplicateCount = duplicateCounts.get(priceKey) || 0;
            const isDuplicateTick = duplicateCount > 1;
            const status = String(row.status || row.runtimeStatus || 'ACTIVE').toUpperCase();
            return `
                                <div class="tca-live-layer-row ${isDuplicateTick ? 'is-duplicate-tick' : ''}">
                                    <div>
                                        <div class="tca-leader-title tca-live-layer-title">
                                            <span>${escapeHtml(shortId(row.chaseId || row.currentOrderClientId || 'layer', 12))}</span>
                                            <span class="tca-meta-pill">${formatLayerSide(row.side)}</span>
                                            <span class="tca-meta-pill">${escapeHtml(status)}</span>
                                            ${isDuplicateTick ? `<span class="tca-meta-pill tca-meta-pill-alert">shared tick x${duplicateCount}</span>` : ''}
                                        </div>
                                        <div class="tca-leader-subtitle">Offset ${offset.toFixed(3)}% · Qty ${formatQty(qty)}</div>
                                    </div>
                                    <div class="tca-live-layer-price">
                                        <strong>${formatCompactPrice(price)}</strong>
                                        <span>${notional > 0 ? formatUsd(notional, 2) : '—'}</span>
                                    </div>
                                </div>
                            `;
        }).join('')}
                    </div>
                ` : '<div class="tca-chart-empty">No working layers.</div>'}
            </div>
        `;
    };

    return `
        <div class="glass-card tca-detail-card">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Active Layers</div>
                    <div class="tca-panel-caption">Live working child chases for this scalper. This is the closest view to the actual open-order stack.</div>
                </div>
                ${scalper ? `<div class="tca-detail-badges"><span class="tca-meta-pill">${escapeHtml(String(scalper.status || 'ACTIVE').toUpperCase())}</span><span class="tca-meta-pill">${Number(scalper.childCount || 0)} layers/side</span></div>` : ''}
            </div>
            <div class="tca-live-layer-grid">
                ${renderColumn('Long Ladder', buys, 'is-long')}
                ${renderColumn('Short Ladder', sells, 'is-short')}
            </div>
        </div>
    `;
}

function renderRuntimeConfig(detail = {}) {
    const strategySession = detail.strategySession || {};
    const runtime = detail.runtime || {};
    const params = detail.latestParamSample || {};
    const pauseReasons = Object.keys(params.pauseReasons || {});
    const statusRaw = String(runtime.status || strategySession.status || 'UNKNOWN').toUpperCase();
    const isPaused = pauseReasons.length > 0 || statusRaw.includes('PAUSE');
    const isStopped = statusRaw.includes('STOP') || statusRaw.includes('CANCEL') || statusRaw.includes('DONE');
    const toneCls = isStopped ? 'is-stopped' : isPaused ? 'is-paused' : 'is-running';
    const statusIcon = isStopped ? '⏹' : isPaused ? '⏸' : '●';
    const layers = params.childCount ?? runtime.currentConfig?.childCount ?? '—';
    const longOff = params.longOffsetPct == null ? '—' : `${Number(params.longOffsetPct).toFixed(2)}%`;
    const shortOff = params.shortOffsetPct == null ? '—' : `${Number(params.shortOffsetPct).toFixed(2)}%`;
    const pauseLabel = pauseReasons.length ? `${pauseReasons.length} pause${pauseReasons.length > 1 ? 's' : ''}` : '';
    const age = formatRelativeTime(runtime.updatedAt || strategySession.updatedAt);

    return `
        <details class="tca-runtime-strip-wrap ${toneCls}">
            <summary class="tca-runtime-strip">
                <span class="tca-runtime-strip-status">${statusIcon} ${escapeHtml(statusRaw)}</span>
                <span class="tca-runtime-strip-info">
                    <span>${layers} layers</span>
                    <span class="tca-rs-sep">·</span>
                    <span style="color:#06b6d4;">L ${longOff}</span>
                    <span class="tca-rs-sep">/</span>
                    <span style="color:#f97316;">S ${shortOff}</span>
                    ${pauseLabel ? `<span class="tca-rs-sep">·</span><span style="color:#fbbf24;">${escapeHtml(pauseLabel)}</span>` : ''}
                    <span class="tca-rs-sep">·</span>
                    <span style="opacity:0.6;">${escapeHtml(age)}</span>
                </span>
                <span class="tca-runtime-strip-arrow">▾</span>
            </summary>
            <div class="tca-runtime-strip-body">
                <div class="tca-lineage-grid">
                    <div><span>Session</span><strong>${escapeHtml(shortId(strategySession.strategySessionId || runtime.strategySessionId || '—'))}</strong></div>
                    <div><span>Status</span><strong>${escapeHtml(runtime.status || 'UNKNOWN')}</strong></div>
                    <div><span>Started</span><strong>${escapeHtml(formatRelativeTime(strategySession.startedAt || runtime.startedAt))}</strong></div>
                    <div><span>Updated</span><strong>${escapeHtml(age)}</strong></div>
                    <div><span>Child Count</span><strong>${layers}</strong></div>
                    <div><span>Skew</span><strong>${params.skew ?? runtime.currentConfig?.skew ?? '—'}</strong></div>
                    <div><span>Long Offset</span><strong>${longOff}</strong></div>
                    <div><span>Short Offset</span><strong>${shortOff}</strong></div>
                    <div><span>Min Fill Spread</span><strong>${params.minFillSpreadPct == null ? '—' : `${Number(params.minFillSpreadPct).toFixed(2)}%`}</strong></div>
                    <div><span>Min Refill Delay</span><strong>${params.minRefillDelayMs == null ? '—' : `${Math.round(Number(params.minRefillDelayMs))} ms`}</strong></div>
                    <div><span>Reduce Only</span><strong>${params.reduceOnlyArmed ? 'Armed' : 'Off'}</strong></div>
                    <div><span>Pause Reasons</span><strong>${pauseReasons.length ? escapeHtml(pauseReasons.join(', ')) : 'None'}</strong></div>
                </div>
            </div>
        </details>
    `;
}

function renderRoleQuality(detail = {}) {
    const qualityByRole = detail.qualityByRole || {};
    const entries = Object.entries(qualityByRole || {});
    if (!entries.length) {
        return '<div class="glass-card tca-detail-card"><div class="card-title">Role Quality</div><div class="tca-chart-empty">No role-quality data yet.</div></div>';
    }

    return `
        <div class="glass-card tca-detail-card">
            <div class="card-title">Role Quality</div>
            <div class="tca-fill-list">
                ${entries.map(([role, row]) => `
                    <div class="tca-fill-row">
                        <div class="tca-leader-title">
                            <span>${escapeHtml(role)}</span>
                            <span class="tca-meta-pill">${Number(row.fillCount || 0)} fills</span>
                            <span class="tca-meta-pill">${Number(row.lifecycleCount || 0)} lc</span>
                        </div>
                        <div class="tca-leader-metrics">
                            <span class="${formatPnlClass(-(row.avgArrivalSlippageBps || 0))}">Arrival ${formatBps(row.avgArrivalSlippageBps)}</span>
                            <span class="${formatPnlClass(row.avgMarkout1sBps || 0)}">1s ${formatBps(row.avgMarkout1sBps)}</span>
                            <span class="${formatPnlClass(row.avgMarkout5sBps || 0)}">5s ${formatBps(row.avgMarkout5sBps)}</span>
                            <span>Tox ${Number(row.toxicityScore || 0).toFixed(2)}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderCheckpointTimeline(timeseries = {}) {
    const events = Array.isArray(timeseries?.events?.items) ? timeseries.events.items : [];
    if (!events.length) {
        return '';
    }

    const latestTone = checkpointTone(events[0] || {});
    const latestType = String(events[0]?.type || 'EVENT').toUpperCase();

    return `
        <details class="glass-card tca-detail-card tca-checkpoint-drawer">
            <summary class="tca-checkpoint-drawer-summary">
                <div class="tca-checkpoint-drawer-head">
                    <span class="card-title">Checkpoints</span>
                    <span class="tca-checkpoint-pill ${latestTone}" style="font-size:9px;padding:3px 7px;">${escapeHtml(latestType)}</span>
                    <span style="color:var(--text-muted);font-size:11px;">${events.length} event${events.length !== 1 ? 's' : ''}</span>
                </div>
                <span class="tca-checkpoint-drawer-arrow">▸</span>
            </summary>
            <div class="tca-timeline" style="padding:12px 16px 16px;">
                ${events.map((row) => `
                    <div class="tca-timeline-row tca-checkpoint-row ${checkpointTone(row)}">
                        <div class="tca-timeline-meta">
                            <strong><span class="tca-checkpoint-pill ${checkpointTone(row)}">${escapeHtml(row.type || 'EVENT')}</span></strong>
                            <span class="tca-meta-pill">${escapeHtml(row.status || 'UNKNOWN')}</span>
                        </div>
                        <div class="tca-leader-subtitle">
                            ${escapeHtml(formatRelativeTime(row.ts))} · ${escapeHtml(formatAbsoluteTime(row.ts))} · seq ${Number(row.checkpointSeq || 0)}
                        </div>
                    </div>
                `).join('')}
            </div>
        </details>
    `;
}

function renderLotLedger(ledger = {}) {
    const openLots = Array.isArray(ledger.openLots) ? ledger.openLots : [];
    const realizations = Array.isArray(ledger.realizations) ? ledger.realizations : [];
    const anomalies = Array.isArray(ledger.anomalies) ? ledger.anomalies : [];
    if (!openLots.length && !realizations.length && !anomalies.length) return '';

    return `
        <div class="glass-card tca-detail-card">
            <div class="tca-panel-head">
                <div>
                    <div class="card-title">Inventory</div>
                    <div class="tca-panel-caption">Open lots and realized closes from the position ledger.</div>
                </div>
                <div class="tca-detail-badges">
                    ${openLots.length ? `<span class="tca-meta-pill">${openLots.length} open</span>` : ''}
                    ${realizations.length ? `<span class="tca-meta-pill">${realizations.length} closed</span>` : ''}
                </div>
            </div>
            ${openLots.length ? `
                <div class="tca-lot-section-label">Open Lots</div>
                <div class="tca-live-layer-list">
                ${openLots.slice(0, 4).map((lot) => {
        const sideUpper = String(lot.positionSide || '').toUpperCase();
        const isLong = sideUpper === 'LONG' || sideUpper === 'BUY';
        return `
                    <div class="tca-live-layer-row">
                        <div>
                            <div class="tca-leader-title tca-live-layer-title">
                                <span class="tca-meta-pill" style="background:${isLong ? 'rgba(34,197,94,0.14)' : 'rgba(249,115,22,0.14)'};color:${isLong ? '#4ade80' : '#fb923c'};border:1px solid ${isLong ? 'rgba(34,197,94,0.22)' : 'rgba(249,115,22,0.22)'};">${isLong ? 'LONG' : 'SHORT'}</span>
                                <span style="font-family:var(--font-mono);font-size:12px;">${formatQty(lot.remainingQty)} <span style="color:var(--text-muted);font-size:10px;">/ ${formatQty(lot.openQty)} qty</span></span>
                            </div>
                            <div class="tca-leader-subtitle">Entry ${formatCompactPrice(lot.openPrice)} · opened ${escapeHtml(formatRelativeTime(lot.openedTs))}</div>
                        </div>
                        <div class="tca-live-layer-price">
                            <strong style="color:${lot.status === 'OPEN' ? '#4ade80' : 'var(--text-muted)'}">${lot.status || 'OPEN'}</strong>
                            <span>${lot.openFee ? `fee ${formatUsd(lot.openFee, 4)}` : ''}</span>
                        </div>
                    </div>
                `}).join('')}
                </div>
            ` : ''}
            ${realizations.length ? `
                <div class="tca-lot-section-label" style="margin-top:14px;">Realized Closes</div>
                <div class="tca-live-layer-list">
                    ${realizations.slice(0, 4).map((row) => {
            const pnl = row.netRealizedPnl || 0;
            const totalFees = (row.openFeeAllocated || 0) + (row.closeFeeAllocated || 0);
            return `
                        <div class="tca-live-layer-row">
                            <div>
                                <div class="tca-leader-title tca-live-layer-title">
                                    <span style="font-family:var(--font-mono);font-size:12px;">${formatQty(row.allocatedQty)} qty</span>
                                    <span class="${formatPnlClass(pnl)}" style="font-weight:700;font-size:13px;">${pnl >= 0 ? '+' : ''}${formatUsd(pnl, 2)}</span>
                                </div>
                                <div class="tca-leader-subtitle">${formatCompactPrice(row.openPrice)} → ${formatCompactPrice(row.closePrice)} · ${escapeHtml(formatRelativeTime(row.realizedTs))}</div>
                            </div>
                            <div class="tca-live-layer-price">
                                <strong>${formatUsd(row.grossRealizedPnl || 0, 2)} gross</strong>
                                <span>${totalFees > 0 ? `−${formatUsd(totalFees, 4)} fees` : ''}</span>
                            </div>
                        </div>
                    `}).join('')}
                </div>
            ` : ''}
            ${anomalies.length ? `
                <div class="tca-session-strip" style="margin-top:12px;border-color:rgba(255,127,80,.35);color:#ffd9c9;">
                    <span>⚠ Ledger anomaly</span>
                    <span>${escapeHtml(String(anomalies[0]?.payload?.reason || anomalies[0]?.anomalyType || 'UNKNOWN'))}</span>
                </div>
            ` : ''}
        </div>
    `;
}

function renderModalBody({ detail, timeseries, ledger, activeLayers }) {
    const strategySession = detail?.strategySession || {};
    const runtime = detail?.runtime || {};
    const rollup = detail?.rollup || {};
    const pnlPoints = Array.isArray(timeseries?.series?.pnl) ? timeseries.series.pnl : [];
    const qualityPoints = Array.isArray(timeseries?.series?.quality) ? timeseries.series.quality : [];
    const symbol = strategySession.symbol || 'Unknown';
    const strategyType = strategySession.strategyType || runtime.strategyType || rollup.strategyType || 'Strategy';
    const status = runtime.status || 'UNKNOWN';
    const side = strategySession.side || '—';

    return `
        <div class="modal-header">
            <div>
                <div class="modal-title">${escapeHtml(strategyType)} · ${escapeHtml(symbol)}</div>
                <div class="tca-leader-subtitle">${escapeHtml(shortId(strategySession.strategySessionId || runtime.strategySessionId || '—'))} · ${escapeHtml(formatAbsoluteTime(strategySession.startedAt || runtime.startedAt))}</div>
            </div>
            <button class="modal-close" type="button" data-action="close-strategy-modal">×</button>
        </div>
        <div class="tca-detail-badges" style="margin-bottom:12px;">
            <span class="tca-state-pill is-live">${escapeHtml(status)}</span>
            <span class="badge badge-${String(side).toUpperCase() === 'SHORT' || String(side).toUpperCase() === 'SELL' ? 'short' : 'long'}">${escapeHtml(side)}</span>
            <span class="tca-meta-pill">${escapeHtml(strategySession.sessionRole || 'ROOT')}</span>
            <span class="tca-meta-pill">${escapeHtml(formatRelativeTime(strategySession.updatedAt || runtime.updatedAt))}</span>
        </div>
        ${renderRuntimeConfig(detail)}
        ${renderSummaryCards(detail)}
        <div class="tca-modal-body">
            <div class="glass-card tca-detail-card">
                <div class="card-title">PnL Curve</div>
                ${buildSeriesChart(pnlPoints, [
        ['netPnl', 'Net', '#16a34a'],
        ['realizedPnl', 'Realized', '#0ea5e9'],
        ['unrealizedPnl', 'Unrealized', '#f97316'],
    ], { yAxisLabel: 'USD' })}
            </div>
            <div class="glass-card tca-detail-card">
                <div class="card-title">Execution Quality</div>
                ${buildSeriesChart(qualityPoints, [
        ['avgMarkout1sBps', '1s Markout', '#38bdf8'],
        ['avgMarkout5sBps', '5s Markout', '#818cf8'],
        ['avgArrivalSlippageBps', 'Arrival', '#fb7185'],
    ], { yAxisLabel: 'bps', isBps: true })}
            </div>
            ${renderActiveLayers(activeLayers)}
            ${renderLotLedger(ledger)}
            ${renderRoleQuality(detail)}
            ${renderCheckpointTimeline(timeseries)}
        </div>
    `;
}

function buildLoadingMarkup(strategySessionId) {
    return `
        <div class="modal-header">
            <div>
                <div class="modal-title">Strategy TCA</div>
                <div class="tca-leader-subtitle">${escapeHtml(shortId(strategySessionId))}</div>
            </div>
            <button class="modal-close" type="button" data-action="close-strategy-modal">×</button>
        </div>
        <div class="tca-chart-empty">Loading strategy details…</div>
    `;
}

function buildErrorMarkup(message, strategySessionId) {
    return `
        <div class="modal-header">
            <div>
                <div class="modal-title">Strategy TCA</div>
                <div class="tca-leader-subtitle">${escapeHtml(shortId(strategySessionId))}</div>
            </div>
            <button class="modal-close" type="button" data-action="close-strategy-modal">×</button>
        </div>
        <div class="tca-inline-error">${escapeHtml(message || 'Failed to load strategy TCA.')}</div>
    `;
}

function bindOverlayEvents(overlay) {
    overlay.addEventListener('click', (event) => {
        const target = event.target;
        if (target === overlay || target?.closest?.('[data-action="close-strategy-modal"]')) {
            closeTcaStrategyModal();
        }
    });
}

function detachKeyHandler() {
    if (activeKeyHandler) {
        window.removeEventListener('keydown', activeKeyHandler);
        activeKeyHandler = null;
    }
}

export function closeTcaStrategyModal() {
    if (activeOverlay?.isConnected) activeOverlay.remove();
    activeOverlay = null;
    detachKeyHandler();
}

async function loadStrategyPayload(subAccountId, strategySessionId) {
    const timeseriesParams = new URLSearchParams({
        series: 'pnl,quality',
        maxPoints: String(DEFAULT_MAX_POINTS),
        eventsPage: '1',
        eventsPageSize: String(DEFAULT_EVENTS_PAGE_SIZE),
    });

    const [detailResult, timeseriesResult, ledgerResult, scalperResult, chaseResult] = await Promise.allSettled([
        api(`/trade/tca/strategy-session/${subAccountId}/${strategySessionId}?includeLineage=0`),
        api(`/trade/tca/strategy-session-timeseries/${subAccountId}/${strategySessionId}?${timeseriesParams.toString()}`),
        api(`/trade/tca/strategy-session-lot-ledger/${subAccountId}/${strategySessionId}`),
        api(`/trade/scalper/active/${subAccountId}`),
        api(`/trade/chase-limit/active/${subAccountId}`),
    ]);

    if (detailResult.status !== 'fulfilled') throw detailResult.reason;
    const scalpers = scalperResult.status === 'fulfilled' && Array.isArray(scalperResult.value) ? scalperResult.value : [];
    const chases = chaseResult.status === 'fulfilled' && Array.isArray(chaseResult.value) ? chaseResult.value : [];

    return {
        detail: detailResult.value,
        timeseries: timeseriesResult.status === 'fulfilled' ? timeseriesResult.value : null,
        ledger: ledgerResult.status === 'fulfilled' ? ledgerResult.value : null,
        activeLayers: {
            scalper: scalpers.find((row) => String(row.scalperId || '') === String(strategySessionId || '')) || null,
            chases: chases.filter((row) => String(row.parentScalperId || '') === String(strategySessionId || '')),
        },
    };
}

export async function openTcaStrategyModal({ subAccountId, strategySessionId } = {}) {
    if (!subAccountId || !strategySessionId) return;

    closeTcaStrategyModal();

    const requestSeq = ++activeRequestSeq;
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content tca-modal-content">
            <div data-role="strategy-modal-body">
                ${buildLoadingMarkup(strategySessionId)}
            </div>
        </div>
    `;
    bindOverlayEvents(overlay);
    document.body.appendChild(overlay);
    activeOverlay = overlay;
    activeKeyHandler = (event) => {
        if (event.key === 'Escape') closeTcaStrategyModal();
    };
    window.addEventListener('keydown', activeKeyHandler);

    try {
        const payload = await loadStrategyPayload(subAccountId, strategySessionId);
        if (activeOverlay !== overlay || requestSeq !== activeRequestSeq) return;
        const body = overlay.querySelector('[data-role="strategy-modal-body"]');
        if (body) body.innerHTML = renderModalBody(payload);
    } catch (err) {
        if (activeOverlay !== overlay || requestSeq !== activeRequestSeq) return;
        const message = err?.message || 'Failed to load strategy TCA.';
        const body = overlay.querySelector('[data-role="strategy-modal-body"]');
        if (body) body.innerHTML = buildErrorMarkup(message, strategySessionId);
        showToast(message, 'error');
    }
}
