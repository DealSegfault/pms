/**
 * Standalone lifecycle detail drawer – can be opened from any page.
 * Fetches /trade/tca/lifecycle/{subAccountId}/{lifecycleId} and renders a
 * right-side panel overlay identical to the TCA page drawer.
 */
import { formatPnlClass, formatPrice } from '../../core/index.js';
import { getToken } from '../../core/session.js';

/** Inline toast – always visible, bypasses notification-disabled setting */
function infoToast(message) {
    const el = document.createElement('div');
    el.className = 'toast info';
    el.textContent = message;
    el.style.cssText = 'top:calc(var(--header-height) + var(--safe-top) + 8px)';
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch { } }, 2500);
}

const DRAWER_ID = 'standalone-lifecycle-drawer';

function escapeHtml(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function shortId(v, len = 14) { if (!v) return '—'; const t = String(v); return t.length <= len ? t : `${t.slice(0, len)}…`; }
function formatBps(v) { if (!Number.isFinite(Number(v))) return '—'; const n = Number(v); return `${n > 0 ? '+' : ''}${n.toFixed(1)} bps`; }
function formatQty(v) { if (!Number.isFinite(Number(v))) return '—'; return Number(v).toFixed(4).replace(/\.?0+$/, ''); }
function formatRelativeTime(v) {
    if (!v) return '—';
    const ts = new Date(v).getTime(); if (!Number.isFinite(ts)) return '—';
    const d = Date.now() - ts, a = Math.abs(d), m = 60000, h = 3600000, day = 86400000;
    if (a < m) return 'just now';
    const s = d >= 0 ? 'ago' : 'ahead';
    if (a < h) return `${Math.round(a / m)}m ${s}`;
    if (a < day) return `${Math.round(a / h)}h ${s}`;
    return `${Math.round(a / day)}d ${s}`;
}
function average(vals) { const n = vals.filter(v => Number.isFinite(v)); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : null; }
function statusClass(st) { if (st === 'FILLED') return 'is-filled'; if (st === 'REJECTED') return 'is-rejected'; if (st === 'CANCELLED' || st === 'EXPIRED') return 'is-cancelled'; return 'is-live'; }

function buildPricePathPoints(detail) {
    const points = [];
    if (Number.isFinite(detail.decisionMid)) points.push({ label: 'Decision', value: detail.decisionMid });
    if (Array.isArray(detail.fills) && detail.fills.length) {
        const anchor = average(detail.fills.map(f => f.fillMid || f.fillPrice));
        if (Number.isFinite(anchor)) points.push({ label: 'Fill', value: anchor });
    } else if (Number.isFinite(detail.avgFillPrice)) {
        points.push({ label: 'Fill', value: detail.avgFillPrice });
    }
    for (const [ms, lbl] of [[1000, '1s'], [5000, '5s'], [30000, '30s']]) {
        const vals = (detail.fills || []).map(f => f.markouts.find(m => m.horizonMs === ms)?.markPrice).filter(v => Number.isFinite(v));
        const pt = average(vals);
        if (Number.isFinite(pt)) points.push({ label: lbl, value: pt });
    }
    return points;
}

function renderPricePath(points) {
    if (!points.length) return '<div class="tca-chart-empty">No price path data.</div>';
    const w = 500, h = 160;
    const min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value));
    const spread = max - min || 1;
    const coords = points.map((p, i) => {
        const x = (i / Math.max(points.length - 1, 1)) * (w - 40) + 20;
        const y = h - (((p.value - min) / spread) * (h - 40) + 20);
        return { ...p, x, y };
    });
    return `
        <svg viewBox="0 0 ${w} ${h}" class="tca-price-path" preserveAspectRatio="none">
            <polyline points="${coords.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
            ${coords.map(p => `
                <circle cx="${p.x}" cy="${p.y}" r="5"></circle>
                <text x="${p.x}" y="${p.y - 10}" text-anchor="middle">${escapeHtml(p.label)}</text>
                <text x="${p.x}" y="${h - 10}" text-anchor="middle">$${formatPrice(p.value)}</text>
            `).join('')}
        </svg>
    `;
}

function renderPricePathBpsRow(points) {
    if (points.length < 2) return '';
    const steps = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1], curr = points[i];
        const bps = ((curr.value - prev.value) / prev.value) * 10000;
        const cls = bps >= 0 ? 'pnl-up' : 'pnl-down';
        const sign = bps > 0 ? '+' : '';
        steps.push(`<span class="tca-pp-step"><span>${escapeHtml(prev.label)}</span><span class="pp-arrow">→</span><span>${escapeHtml(curr.label)}</span><span class="${cls}" style="font-weight:600;">${sign}${bps.toFixed(1)} bps</span></span>`);
    }
    return `<div class="tca-pricepath-detail">${steps.join('')}</div>`;
}

function renderRoleQuality(detail) {
    const rows = Object.entries(detail.qualityByRole || {});
    if (!rows.length) return '';
    return `
        <div class="tca-fill-list">
            ${rows.map(([role, m]) => {
        const tox = Number(m?.toxicityScore || 0);
        return `
                <div class="tca-fill-row">
                    <div>
                        <div class="tca-leader-title">
                            <span>${escapeHtml(role)}</span>
                            <span style="font-family:var(--font-mono);font-weight:700;font-size:14px;">${tox.toFixed(1)}</span>
                        </div>
                        <div class="tca-leader-subtitle" style="font-size:11px;opacity:0.7;">
                            Arr ${formatBps(m?.avgArrivalSlippageBps)} ·
                            1s ${formatBps(m?.avgMarkout1sBps)} ·
                            5s ${formatBps(m?.avgMarkout5sBps)} ·
                            30s ${formatBps(m?.avgMarkout30sBps)}
                        </div>
                    </div>
                </div>
            `;
    }).join('')}
        </div>
    `;
}

function renderDetailContent(detail) {
    const ppPoints = buildPricePathPoints(detail);
    const fillRows = detail.fills || [];
    const strategySession = detail.strategySession;

    return `
        <div class="tca-detail-stack">
            <div class="tca-detail-badges">
                <span class="badge badge-${detail.side === 'SELL' ? 'short' : 'long'}">${escapeHtml(detail.side || 'N/A')}</span>
                <span class="tca-state-pill ${statusClass(detail.finalStatus)}">${escapeHtml(detail.finalStatus || 'LIVE')}</span>
                <span class="tca-meta-pill">${escapeHtml(detail.orderRole || 'UNKNOWN')}</span>
            </div>

            <div class="tca-detail-grid">
                <div class="stat-item">
                    <div class="stat-label">Arrival <span class="tca-kpi-help">ⓘ<span class="tca-tip">Slippage from decision mid to fill price.</span></span></div>
                    <div class="stat-value ${formatPnlClass(-(detail.arrivalSlippageBps || 0))}">${formatBps(detail.arrivalSlippageBps)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">5s Markout</div>
                    <div class="stat-value ${formatPnlClass(detail.markoutSummary?.avgMarkout5sBps || 0)}">${formatBps(detail.markoutSummary?.avgMarkout5sBps)}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Toxicity</div>
                    <div class="stat-value">${Number(detail.markoutSummary?.toxicityScore || 0).toFixed(1)}</div>
                </div>
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Price Path</div>
                ${renderPricePath(ppPoints)}
                ${renderPricePathBpsRow(ppPoints)}
                ${fillRows.length ? `
                    <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;">
                    <div class="tca-fill-list">
                        ${fillRows.map(fill => {
        const liqClass = (fill.makerTaker || '').toLowerCase().includes('maker') ? 'liq-maker' : 'liq-taker';
        const liqLabel = (fill.makerTaker || '').toLowerCase().includes('maker') ? 'MAKER' : 'TAKER';
        const mk = (label, ms) => {
            const m = fill.markouts.find(r => r.horizonMs === ms);
            if (!m || !Number.isFinite(m.markoutBps)) return `<span class="tca-fill-mkbadge mk-neutral">${label} —</span>`;
            const cls = m.markoutBps >= 0 ? 'mk-pos' : 'mk-neg';
            const sign = m.markoutBps > 0 ? '+' : '';
            return `<span class="tca-fill-mkbadge ${cls}">${label} ${sign}${m.markoutBps.toFixed(1)}</span>`;
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
                                            ${mk('1s', 1000)}
                                            ${mk('5s', 5000)}
                                            ${mk('30s', 30000)}
                                        </div>
                                    </div>
                                </div>
                            `;
    }).join('')}
                    </div>
                    </div>
                ` : ''}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Lineage</div>
                <div class="tca-lineage-grid">
                    <div><span>Strategy</span><strong>${escapeHtml(detail.strategyType || 'MANUAL')}</strong></div>
                    <div><span>Session</span><strong>${escapeHtml(shortId(detail.strategySessionId || detail.parentId || 'N/A'))}</strong></div>
                    <div><span>Requested</span><strong>${formatQty(detail.requestedQty)}</strong></div>
                    <div><span>Filled</span><strong>${formatQty(detail.filledQty)}</strong></div>
                </div>
                ${strategySession ? `
                    <div class="tca-session-strip">
                        <span>${escapeHtml(strategySession.strategyType || 'MANUAL')} session</span>
                        <span>${strategySession.lifecycleCount} lifecycle(s)</span>
                        <span>${strategySession.startedAt ? formatRelativeTime(strategySession.startedAt) : '—'}</span>
                    </div>
                ` : ''}
            </div>

            <div class="glass-card tca-detail-card">
                <div class="card-title">Execution Quality</div>
                ${renderRoleQuality(detail)}
            </div>
        </div>
    `;
}

function closeDrawer() {
    const existing = document.getElementById(DRAWER_ID);
    if (existing) existing.remove();
    if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
}

let _keyHandler = null;

/**
 * Open the lifecycle detail drawer from anywhere.
 * Uses raw fetch (not api()) to avoid maintenance overlay blocking.
 * All API calls happen BEFORE any DOM is created — zero flash.
 */
export async function openLifecycleDrawer({ subAccountId, clientOrderId }) {
    if (!subAccountId || !clientOrderId) return;
    closeDrawer();

    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    // Step 1: Look up lifecycle by clientOrderId
    let lc = null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`/api/trade/tca/lifecycles/${subAccountId}?clientOrderId=${encodeURIComponent(clientOrderId)}&limit=1`, {
            headers, signal: ctrl.signal, cache: 'no-store',
        });
        clearTimeout(timer);
        if (!res.ok) {
            infoToast('No TCA data for this order');
            return;
        }
        const body = await res.json();
        const items = Array.isArray(body) ? body : (Array.isArray(body?.items) ? body.items : []);
        lc = items[0] || null;
    } catch {
        infoToast('No TCA data for this order');
        return;
    }

    if (!lc || !lc.lifecycleId) {
        infoToast('No TCA data for this order');
        return;
    }

    // Step 2: Fetch full lifecycle detail
    let detail = null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`/api/trade/tca/lifecycle/${subAccountId}/${lc.lifecycleId}?includeLineage=0`, {
            headers, signal: ctrl.signal, cache: 'no-store',
        });
        clearTimeout(timer);
        if (!res.ok) {
            infoToast('Could not load TCA details');
            return;
        }
        detail = await res.json();
    } catch {
        infoToast('Could not load TCA details');
        return;
    }

    if (!detail) {
        infoToast('No TCA data for this order');
        return;
    }

    // Step 3: Data confirmed — create drawer
    const overlay = document.createElement('div');
    overlay.id = DRAWER_ID;
    overlay.className = 'tca-drawer-overlay';
    overlay.innerHTML = `
        <aside class="tca-drawer">
            <div class="tca-drawer-header">
                <div>
                    <div class="card-title">Lifecycle Detail</div>
                    <div class="tca-drawer-title">${escapeHtml(detail.symbol || 'Unknown')}</div>
                </div>
                <button type="button" class="modal-close" data-action="close-drawer">×</button>
            </div>
            ${renderDetailContent(detail)}
        </aside>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-action="close-drawer"]')) closeDrawer();
    });
    _keyHandler = (e) => { if (e.key === 'Escape') closeDrawer(); };
    document.addEventListener('keydown', _keyHandler);
}
