/**
 * TCA Dashboard — Transaction Cost Analysis monitoring page.
 *
 * Displays execution quality, latency, repricing stats, reconciliation
 * health, and fill-level detail. Auto-refreshes every 10s.
 */

import { api } from '../core/index.js';
import { cuteSpinner } from '../lib/cute-empty.js';

let refreshTimer = null;
let currentWindow = 3600000; // 1h default

export function renderTcaPage(container) {
    container.innerHTML = `
    <div id="tca-page">
        <div class="section-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h2 class="section-title" style="margin:0;">📊 TCA Monitor</h2>
            <div style="display:flex; gap:6px; align-items:center;">
                <select id="tca-window" style="background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:5px 8px; font-size:11px; font-family:var(--font-mono);">
                    <option value="300000">5m</option>
                    <option value="900000">15m</option>
                    <option value="3600000" selected>1h</option>
                    <option value="14400000">4h</option>
                    <option value="43200000">12h</option>
                    <option value="86400000">24h</option>
                    <option value="259200000">3d</option>
                    <option value="604800000">7d</option>
                </select>
                <button class="btn btn-outline btn-sm" id="tca-refresh" style="font-size:10px; padding:4px 8px;">⟳</button>
            </div>
        </div>

        <!-- Health Panel -->
        <div class="glass-card" id="tca-health">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-secondary);">System Health</div>
                <div id="tca-health-dot" style="display:flex; align-items:center; gap:6px;">
                    <span class="status-dot online" id="tca-status-dot"></span>
                    <span style="font-size:11px; color:var(--text-muted);" id="tca-status-label">Loading...</span>
                </div>
            </div>
            <div class="stat-grid" style="grid-template-columns: repeat(4, 1fr);">
                <div class="stat-item">
                    <div class="stat-label">Fill Rate</div>
                    <div class="stat-value" id="tca-fill-rate">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Avg Slippage</div>
                    <div class="stat-value" id="tca-avg-slippage">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">REST p95</div>
                    <div class="stat-value" id="tca-rest-p95">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Mismatches</div>
                    <div class="stat-value" id="tca-mismatches">—</div>
                </div>
            </div>
        </div>

        <!-- Execution Quality -->
        <div class="glass-card" id="tca-execution">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">Execution Quality</div>
            </div>
            <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr);">
                <div class="stat-item">
                    <div class="stat-label">Chases (Total)</div>
                    <div class="stat-value" id="tca-chases-total">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Filled</div>
                    <div class="stat-value pnl-positive" id="tca-chases-filled">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Cancelled</div>
                    <div class="stat-value pnl-negative" id="tca-chases-cancelled">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Slippage p50</div>
                    <div class="stat-value" id="tca-slip-p50">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Slippage p95</div>
                    <div class="stat-value" id="tca-slip-p95">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Fill Time p50</div>
                    <div class="stat-value" id="tca-fill-time-p50">—</div>
                </div>
            </div>
        </div>

        <!-- Repricing Stats -->
        <div class="glass-card">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">Repricing</div>
            </div>
            <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr);">
                <div class="stat-item">
                    <div class="stat-label">Total Reprices</div>
                    <div class="stat-value" id="tca-reprices-total">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Wasted</div>
                    <div class="stat-value pnl-negative" id="tca-reprices-wasted">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Efficiency</div>
                    <div class="stat-value" id="tca-reprices-efficiency">—</div>
                </div>
            </div>
        </div>

        <!-- REST Latency Breakdown -->
        <div class="glass-card" id="tca-latency-section">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">Exchange REST Latency</div>
            </div>
            <div id="tca-latency-table">${cuteSpinner()}</div>
        </div>

        <!-- WS Event Latency -->
        <div class="glass-card">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">WebSocket Event Latency</div>
            </div>
            <div id="tca-ws-latency-table">${cuteSpinner()}</div>
        </div>

        <!-- Reconciliation Log -->
        <div class="glass-card">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">Reconciliation Log</div>
            </div>
            <div id="tca-reconciliation-log">${cuteSpinner()}</div>
        </div>

        <!-- Recent Fills -->
        <div class="glass-card">
            <div class="card-header" style="margin-bottom:10px;">
                <div class="card-title">Recent Fills</div>
            </div>
            <div id="tca-fills-list">${cuteSpinner()}</div>
        </div>
    </div>`;

    // Event listeners
    document.getElementById('tca-window')?.addEventListener('change', (e) => {
        currentWindow = parseInt(e.target.value);
        loadAll();
    });
    document.getElementById('tca-refresh')?.addEventListener('click', loadAll);

    loadAll();
    refreshTimer = setInterval(loadAll, 10000); // auto-refresh every 10s
}

export function cleanup() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

// ── Data Loading ─────────────────────────────────────────────

async function loadAll() {
    await Promise.allSettled([
        loadSummary(),
        loadLatency(),
        loadWsLatency(),
        loadReconciliation(),
        loadFills(),
    ]);
}

async function loadSummary() {
    try {
        const data = await api(`/tca/summary?window=${currentWindow}`);
        if (!data) return;

        // Health status dot
        const dot = document.getElementById('tca-status-dot');
        const label = document.getElementById('tca-status-label');
        if (data.reconciliation?.mismatches > 5) {
            dot?.classList.replace('online', 'offline');
            if (label) label.textContent = 'Issues Detected';
        } else {
            dot?.classList.replace('offline', 'online');
            if (label) label.textContent = 'Healthy';
        }

        // Top-line health stats
        setText('tca-fill-rate', data.chases?.fillRatePct != null ? `${data.chases.fillRatePct}%` : '—');
        setText('tca-avg-slippage', data.slippage?.avgBps != null ? `${data.slippage.avgBps.toFixed(1)} bps` : '—');
        setText('tca-rest-p95', data.exchangeLatency?.p95 != null ? `${data.exchangeLatency.p95}ms` : '—');
        setText('tca-mismatches', data.reconciliation?.mismatches ?? '—');

        // Execution quality
        setText('tca-chases-total', data.chases?.total ?? '—');
        setText('tca-chases-filled', data.chases?.filled ?? '—');
        setText('tca-chases-cancelled', data.chases?.cancelled ?? '—');
        setText('tca-slip-p50', data.slippage?.p50Bps != null ? `${data.slippage.p50Bps.toFixed(1)} bps` : '—');
        setText('tca-slip-p95', data.slippage?.p95Bps != null ? `${data.slippage.p95Bps.toFixed(1)} bps` : '—');
        setText('tca-fill-time-p50', data.timeToFill?.p50 != null ? fmtMs(data.timeToFill.p50) : '—');

        // Repricing
        setText('tca-reprices-total', data.repricing?.totalReprices ?? '—');
        setText('tca-reprices-wasted', data.repricing?.wastedReprices ?? '—');
        setText('tca-reprices-efficiency', data.repricing?.efficiencyPct != null ? `${data.repricing.efficiencyPct}%` : '—');
    } catch (err) {
        console.warn('[TCA] Summary load failed:', err.message);
    }
}

async function loadLatency() {
    try {
        const data = await api(`/tca/latency?window=${currentWindow}`);
        const container = document.getElementById('tca-latency-table');
        if (!container || !data?.methods) return;

        const methods = Object.entries(data.methods);
        if (methods.length === 0) {
            container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:12px;">No exchange calls yet</div>`;
            return;
        }

        container.innerHTML = `
            <table style="width:100%; font-size:11px; border-collapse:collapse;">
                <thead>
                    <tr style="color:var(--text-muted); text-transform:uppercase; font-size:9px; letter-spacing:0.5px;">
                        <th style="text-align:left; padding:6px 4px;">Method</th>
                        <th style="text-align:right; padding:6px 4px;">Count</th>
                        <th style="text-align:right; padding:6px 4px;">p50</th>
                        <th style="text-align:right; padding:6px 4px;">p95</th>
                        <th style="text-align:right; padding:6px 4px;">p99</th>
                        <th style="text-align:right; padding:6px 4px;">Err%</th>
                    </tr>
                </thead>
                <tbody>
                    ${methods.map(([method, stats]) => `
                        <tr style="border-top:1px solid var(--border);">
                            <td style="padding:6px 4px; font-family:var(--font-mono); font-weight:600; color:var(--text-primary);">${shortMethodName(method)}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${stats.count}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${latencyColor(stats.p50)}">${stats.p50 != null ? `${stats.p50}ms` : '—'}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${latencyColor(stats.p95)}">${stats.p95 != null ? `${stats.p95}ms` : '—'}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${latencyColor(stats.p99)}">${stats.p99 != null ? `${stats.p99}ms` : '—'}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${stats.errorRate > 5 ? 'color:var(--red);' : ''}">${stats.errorRate}%</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } catch (err) {
        console.warn('[TCA] Latency load failed:', err.message);
    }
}

async function loadWsLatency() {
    try {
        const data = await api(`/tca/ws-latency?window=${currentWindow}`);
        const container = document.getElementById('tca-ws-latency-table');
        if (!container || !data?.eventTypes) return;

        const types = Object.entries(data.eventTypes);
        if (types.length === 0) {
            container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:12px;">No WS events yet</div>`;
            return;
        }

        container.innerHTML = `
            <table style="width:100%; font-size:11px; border-collapse:collapse;">
                <thead>
                    <tr style="color:var(--text-muted); text-transform:uppercase; font-size:9px; letter-spacing:0.5px;">
                        <th style="text-align:left; padding:6px 4px;">Event</th>
                        <th style="text-align:right; padding:6px 4px;">Count</th>
                        <th style="text-align:right; padding:6px 4px;">Avg</th>
                        <th style="text-align:right; padding:6px 4px;">p95</th>
                        <th style="text-align:right; padding:6px 4px;">Max</th>
                    </tr>
                </thead>
                <tbody>
                    ${types.map(([type, stats]) => `
                        <tr style="border-top:1px solid var(--border);">
                            <td style="padding:6px 4px; font-family:var(--font-mono); font-weight:600; color:var(--text-primary); font-size:10px;">${type}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${stats.count}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${stats.avg != null ? `${stats.avg}ms` : '—'}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${latencyColor(stats.p95)}">${stats.p95 != null ? `${stats.p95}ms` : '—'}</td>
                            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${latencyColor(stats.max)}">${stats.max != null ? `${stats.max}ms` : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } catch (err) {
        console.warn('[TCA] WS latency load failed:', err.message);
    }
}

async function loadReconciliation() {
    try {
        const data = await api(`/tca/reconciliation?window=${currentWindow}&limit=20`);
        const container = document.getElementById('tca-reconciliation-log');
        if (!container) return;

        const allEvents = [...(data?.events || []), ...(data?.mismatches || [])].sort((a, b) => b.ts - a.ts).slice(0, 20);

        if (allEvents.length === 0) {
            container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:12px;">✓ No reconciliation events</div>`;
            return;
        }

        container.innerHTML = allEvents.map(evt => {
            const time = new Date(evt.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const isError = evt.type?.includes('mismatch') || evt.type?.includes('orphan') || evt.pmsStatus;
            const typeLabel = evt.pmsStatus ? `${evt.pmsStatus} → ${evt.exchangeStatus}` : evt.type;
            const typeColor = isError ? 'var(--yellow)' : 'var(--text-muted)';
            const detail = evt.detail || evt.orderId || '';

            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:11px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="color:${typeColor}; font-weight:600; font-size:10px; font-family:var(--font-mono);">${typeLabel}</span>
                        ${evt.symbol ? `<span style="color:var(--text-primary); font-weight:600;">${evt.symbol.split('/')[0] || evt.symbol}</span>` : ''}
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="color:var(--text-muted); font-size:10px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${detail}</span>
                        <span style="color:var(--text-muted); font-size:9px; font-family:var(--font-mono);">${time}</span>
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        console.warn('[TCA] Reconciliation load failed:', err.message);
    }
}

async function loadFills() {
    try {
        const data = await api(`/tca/fills?window=${currentWindow}&limit=30`);
        const container = document.getElementById('tca-fills-list');
        if (!container || !data?.fills) return;

        if (data.fills.length === 0) {
            container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:12px;">No fills in this window</div>`;
            return;
        }

        container.innerHTML = data.fills.map(fill => {
            const time = new Date(fill.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const slip = fill.slippageBps != null ? fill.slippageBps.toFixed(1) : '—';
            const slipColor = fill.slippageBps == null ? '' : (Math.abs(fill.slippageBps) < 1 ? 'color:var(--green);' : (Math.abs(fill.slippageBps) > 5 ? 'color:var(--red);' : 'color:var(--yellow);'));
            const sideClass = fill.side === 'LONG' ? 'badge-long' : 'badge-short';
            const fillTimeStr = fill.intentToFillMs != null ? fmtMs(fill.intentToFillMs) : '—';

            return `
                <div class="card" style="padding:8px 10px; margin-bottom:4px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="font-weight:700; font-size:12px;">${fill.symbol?.split('/')[0] || '?'}</span>
                            <span class="badge ${sideClass}" style="font-size:8px; padding:2px 6px;">${fill.side}</span>
                            ${fill.reduceOnly ? '<span style="font-size:8px; color:var(--yellow); font-weight:600;">RO</span>' : ''}
                        </div>
                        <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-muted);">${time}</span>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; margin-top:4px; font-size:10px;">
                        <div>
                            <span style="color:var(--text-muted);">Slip</span>
                            <span style="font-family:var(--font-mono); font-weight:600; ${slipColor}">${slip} bps</span>
                        </div>
                        <div>
                            <span style="color:var(--text-muted);">Reprices</span>
                            <span style="font-family:var(--font-mono);">${fill.repriceCount ?? 0}</span>
                        </div>
                        <div>
                            <span style="color:var(--text-muted);">T2F</span>
                            <span style="font-family:var(--font-mono);">${fillTimeStr}</span>
                        </div>
                        <div>
                            <span style="color:var(--text-muted);">Price</span>
                            <span style="font-family:var(--font-mono);">$${fill.fillPrice?.toFixed(2) || '?'}</span>
                        </div>
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        console.warn('[TCA] Fills load failed:', err.message);
    }
}

// ── Helpers ──────────────────────────────────────────────────

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function shortMethodName(method) {
    const map = {
        createLimitOrder: 'Limit',
        createMarketOrder: 'Market',
        createBatchLimitOrders: 'Batch',
        cancelOrder: 'Cancel',
    };
    return map[method] || method;
}

function latencyColor(ms) {
    if (ms == null) return '';
    if (ms < 200) return 'color:var(--green);';
    if (ms < 500) return 'color:var(--yellow);';
    return 'color:var(--red);';
}
