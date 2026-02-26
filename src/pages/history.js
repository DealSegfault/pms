import { state, api, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { cuteSpinner, cuteKey, cuteBunnyHistory, cuteSadFace } from '../lib/cute-empty.js';

let historyOffset = 0;
let historyTotal = 0;
const HISTORY_LIMIT = 50;
let _tcaRefreshTimer = null;

export function renderHistoryPage(container) {
  historyOffset = 0;
  container.innerHTML = `
    <div id="history-page">
      <!-- Tab Bar -->
      <div class="tab-bar" id="history-tabs" style="margin-bottom:12px;">
        <button class="active" data-htab="trades">Trades</button>
        <button data-htab="tca">TCA Explorer</button>
      </div>

      <!-- ═══ Trades Tab ═══ -->
      <div id="htab-trades">
        <div class="glass-card" style="padding:10px 12px;">
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <input class="search-input" id="hist-symbol-filter" placeholder="Symbol..." style="flex:1; min-width:100px; margin:0; padding:6px 10px; font-size:12px;" />
            <select id="hist-period" style="background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px;">
              <option value="">All Time</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </select>
            <select id="hist-action" style="background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px;">
              <option value="">All Actions</option>
              <option value="OPEN">Open</option>
              <option value="CLOSE">Close</option>
              <option value="LIQUIDATE">Liquidate</option>
              <option value="ADD">Add</option>
            </select>
            <button class="btn btn-outline btn-sm" id="hist-export" style="font-size:11px; padding:4px 10px;">CSV</button>
          </div>
        </div>
        <div class="glass-card" id="history-summary">
          <div style="display: flex; justify-content: space-between;">
            <div>
              <div class="price-label">Total Realized PnL</div>
              <div id="total-rpnl" class="price-big" style="font-size: 22px;">$0.00</div>
            </div>
            <div style="text-align: right;">
              <div class="price-label">Win Rate</div>
              <div id="win-rate" class="price-big" style="font-size: 22px;">—</div>
            </div>
          </div>
          <div class="stat-grid" style="margin-top: 14px;">
            <div class="stat-item"><div class="stat-label">Total Trades</div><div class="stat-value" id="total-trades">0</div></div>
            <div class="stat-item"><div class="stat-label">Avg PnL</div><div class="stat-value" id="avg-pnl">$0.00</div></div>
            <div class="stat-item"><div class="stat-label">Total Fees</div><div class="stat-value" id="total-fees">$0.00</div></div>
            <div class="stat-item"><div class="stat-label">Showing</div><div class="stat-value" id="showing-count">0</div></div>
          </div>
        </div>
        <div id="history-list">${cuteSpinner()}</div>
        <div id="history-load-more" style="display:none; text-align:center; padding:12px;">
          <button class="btn btn-outline btn-block" id="load-more-btn">Load More</button>
        </div>
      </div>

      <!-- ═══ TCA Explorer Tab ═══ -->
      <div id="htab-tca" style="display:none;">
        <!-- Window select -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <span style="font-size:13px; font-weight:700; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px;">📊 Execution Quality</span>
          <select id="tca-hist-window" style="background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:5px 8px; font-size:11px; font-family:var(--font-mono);">
            <option value="3600000">1h</option>
            <option value="14400000">4h</option>
            <option value="43200000">12h</option>
            <option value="86400000" selected>24h</option>
            <option value="259200000">3d</option>
            <option value="604800000">7d</option>
          </select>
        </div>

        <!-- Health banner -->
        <div class="glass-card" id="tca-hist-health" style="padding:14px;">
          <div class="stat-grid" style="grid-template-columns: repeat(4, 1fr);">
            <div class="stat-item"><div class="stat-label">Chase Fill Rate</div><div class="stat-value" id="th-fill-rate">—</div></div>
            <div class="stat-item"><div class="stat-label">Avg Slippage</div><div class="stat-value" id="th-avg-slip">—</div></div>
            <div class="stat-item"><div class="stat-label">REST p95</div><div class="stat-value" id="th-rest-p95">—</div></div>
            <div class="stat-item"><div class="stat-label">Mismatches</div><div class="stat-value" id="th-mismatches">—</div></div>
          </div>
          <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-top:8px;">
            <div class="stat-item"><div class="stat-label">Total Chases</div><div class="stat-value" id="th-chases-total">—</div></div>
            <div class="stat-item"><div class="stat-label">Filled</div><div class="stat-value pnl-positive" id="th-chases-filled">—</div></div>
            <div class="stat-item"><div class="stat-label">Cancelled</div><div class="stat-value pnl-negative" id="th-chases-cancelled">—</div></div>
          </div>
          <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-top:8px;">
            <div class="stat-item"><div class="stat-label">Slippage p50</div><div class="stat-value" id="th-slip-p50">—</div></div>
            <div class="stat-item"><div class="stat-label">Slippage p95</div><div class="stat-value" id="th-slip-p95">—</div></div>
            <div class="stat-item"><div class="stat-label">Fill Time p50</div><div class="stat-value" id="th-fill-p50">—</div></div>
          </div>
          <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-top:8px;">
            <div class="stat-item"><div class="stat-label">Total Reprices</div><div class="stat-value" id="th-reprices">—</div></div>
            <div class="stat-item"><div class="stat-label">Wasted</div><div class="stat-value pnl-negative" id="th-wasted">—</div></div>
            <div class="stat-item"><div class="stat-label">Efficiency</div><div class="stat-value" id="th-efficiency">—</div></div>
          </div>
        </div>

        <!-- REST Latency Table -->
        <div class="glass-card">
          <div class="card-header" style="margin-bottom:8px;"><div class="card-title">REST Latency</div></div>
          <div id="th-rest-table">${cuteSpinner()}</div>
        </div>

        <!-- WS Latency Table -->
        <div class="glass-card">
          <div class="card-header" style="margin-bottom:8px;"><div class="card-title">WebSocket Latency</div></div>
          <div id="th-ws-table">${cuteSpinner()}</div>
        </div>

        <!-- Reconciliation -->
        <div class="glass-card">
          <div class="card-header" style="margin-bottom:8px;"><div class="card-title">Reconciliation Log</div></div>
          <div id="th-reconc-log">${cuteSpinner()}</div>
        </div>

        <!-- Fill Detail -->
        <div class="glass-card">
          <div class="card-header" style="margin-bottom:8px;"><div class="card-title">Recent Fills</div></div>
          <div id="th-fills-list">${cuteSpinner()}</div>
        </div>
      </div>
    </div>
  `;

  // Tab switching
  document.querySelectorAll('#history-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#history-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.htab;
      document.getElementById('htab-trades').style.display = tab === 'trades' ? '' : 'none';
      document.getElementById('htab-tca').style.display = tab === 'tca' ? '' : 'none';
      if (tab === 'tca') loadTcaAll();
    });
  });

  // Trade tab listeners
  const filterDelayed = debounce(() => { historyOffset = 0; loadHistory(true); }, 300);
  document.getElementById('hist-symbol-filter')?.addEventListener('input', filterDelayed);
  document.getElementById('hist-period')?.addEventListener('change', () => { historyOffset = 0; loadHistory(true); });
  document.getElementById('hist-action')?.addEventListener('change', () => { historyOffset = 0; loadHistory(true); });
  document.getElementById('load-more-btn')?.addEventListener('click', () => { historyOffset += HISTORY_LIMIT; loadHistory(false); });
  document.getElementById('hist-export')?.addEventListener('click', exportCSV);

  // TCA tab listeners
  document.getElementById('tca-hist-window')?.addEventListener('change', loadTcaAll);

  loadHistory(true);
}

// ── Tab cleanup ──────────────────────────────────
export function cleanup() {
  if (_tcaRefreshTimer) { clearInterval(_tcaRefreshTimer); _tcaRefreshTimer = null; }
}

// ══════════════════════════════════════════════════
//  TRADES TAB (unchanged logic)
// ══════════════════════════════════════════════════

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function getFilters() {
  const symbol = document.getElementById('hist-symbol-filter')?.value?.trim() || '';
  const period = document.getElementById('hist-period')?.value || '';
  const action = document.getElementById('hist-action')?.value || '';

  const params = new URLSearchParams();
  params.set('limit', HISTORY_LIMIT);
  params.set('offset', historyOffset);
  if (symbol) params.set('symbol', symbol.toUpperCase().includes('/') ? symbol : `${symbol.toUpperCase()}/USDT:USDT`);
  if (action) params.set('action', action);

  if (period) {
    const now = new Date();
    let from;
    if (period === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (period === '7d') from = new Date(now - 7 * 86400000);
    else if (period === '30d') from = new Date(now - 30 * 86400000);
    if (from) params.set('from', from.toISOString());
  }

  return params.toString();
}

async function loadHistory(reset) {
  if (!state.currentAccount) {
    document.getElementById('history-list').innerHTML = cuteKey({ title: 'No Account Selected ✨', subtitle: 'Go to the Trade tab first~' });
    return;
  }

  if (reset) {
    document.getElementById('history-list').innerHTML = cuteSpinner();
  }

  try {
    const data = await api(`/trade/history/${state.currentAccount}?${getFilters()}`);
    const { trades } = data;
    const total = data.total ?? trades.length;
    historyTotal = total;

    if (reset) {
      renderHistoryStats(trades, total);
      renderTradesList(trades, true);
    } else {
      renderTradesList(trades, false);
    }

    const loadMore = document.getElementById('history-load-more');
    if (loadMore) loadMore.style.display = (historyOffset + HISTORY_LIMIT < total) ? '' : 'none';
    const showEl = document.getElementById('showing-count');
    if (showEl) showEl.textContent = `${Math.min(historyOffset + HISTORY_LIMIT, total)} / ${total}`;
  } catch (err) {
    document.getElementById('history-list').innerHTML = cuteSadFace({ subtitle: err.message });
  }
}

function renderHistoryStats(trades, total) {
  const closeTrades = trades.filter(t => t.action !== 'OPEN' && t.action !== 'ADD');
  const totalRpnl = closeTrades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const wins = closeTrades.filter(t => (t.realizedPnl || 0) > 0).length;
  const winRate = closeTrades.length > 0 ? ((wins / closeTrades.length) * 100).toFixed(1) : '—';
  const avgPnl = closeTrades.length > 0 ? totalRpnl / closeTrades.length : 0;
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);

  const rpnlEl = document.getElementById('total-rpnl');
  if (rpnlEl) {
    rpnlEl.textContent = formatUsd(totalRpnl, 4);
    rpnlEl.className = `price-big ${formatPnlClass(totalRpnl)}`;
    rpnlEl.style.fontSize = '22px';
  }
  const wrEl = document.getElementById('win-rate');
  if (wrEl) wrEl.textContent = winRate !== '—' ? `${winRate}%` : '—';
  const ttEl = document.getElementById('total-trades');
  if (ttEl) ttEl.textContent = total;
  const apEl = document.getElementById('avg-pnl');
  if (apEl) { apEl.textContent = formatUsd(avgPnl, 4); apEl.className = `stat-value ${formatPnlClass(avgPnl)}`; }
  const feesEl = document.getElementById('total-fees');
  if (feesEl) feesEl.textContent = `$${totalFees.toFixed(4)}`;
}

function renderTradesList(trades, reset) {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (reset && (!trades || trades.length === 0)) {
    list.innerHTML = cuteBunnyHistory({ title: 'No Trades Yet~', subtitle: 'Your trades will appear here ✨' });
    return;
  }

  const html = trades.map(trade => {
    const time = new Date(trade.timestamp).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const actionColors = { OPEN: 'var(--accent)', CLOSE: 'var(--text-secondary)', LIQUIDATE: 'var(--red)', ADD: 'var(--yellow)' };
    const pnlHtml = trade.realizedPnl != null
      ? `<span class="${formatPnlClass(trade.realizedPnl)}" style="font-family: var(--font-mono); font-weight: 600;">${formatUsd(trade.realizedPnl, 4)}</span>`
      : '';
    const notionalUsd = (trade.notional || trade.price * trade.quantity).toFixed(2);

    return `
      <div class="card" style="padding: 12px; margin-bottom: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 700; font-size: 14px;">${trade.symbol.split('/')[0]}</span>
            <span class="badge badge-${trade.side === 'BUY' ? 'long' : 'short'}" style="font-size: 9px;">${trade.side}</span>
            <span style="font-size: 11px; color: ${actionColors[trade.action] || 'inherit'}; font-weight: 600;">${trade.action}</span>
          </div>
          ${pnlHtml}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
          <div><span style="opacity:0.6;">Price</span> <span style="color:var(--text-primary);">$${formatPrice(trade.price)}</span></div>
          <div><span style="opacity:0.6;">Qty</span> <span style="color:var(--text-primary);">${trade.quantity.toFixed(6)}</span></div>
          <div><span style="opacity:0.6;">Notional</span> <span style="color:var(--text-primary);">$${notionalUsd}</span></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted);">
          <span>Fee: $${(trade.fee || 0).toFixed(4)}</span>
          <span>${time}</span>
        </div>
        ${trade.exchangeOrderId ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-mono); opacity: 0.4;">Order: ${trade.exchangeOrderId}</div>` : ''}
      </div>`;
  }).join('');

  if (reset) { list.innerHTML = html; } else { list.insertAdjacentHTML('beforeend', html); }
}

async function exportCSV() {
  if (!state.currentAccount) return;
  try {
    const data = await api(`/trade/history/${state.currentAccount}?limit=10000`);
    const trades = data.trades || data;
    if (!trades.length) return;
    const headers = ['timestamp', 'symbol', 'side', 'action', 'type', 'price', 'quantity', 'notional', 'fee', 'realizedPnl', 'exchangeOrderId'];
    const rows = trades.map(t => headers.map(h => {
      const v = t[h]; if (v == null) return ''; if (h === 'timestamp') return new Date(v).toISOString(); return v;
    }).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { console.error('CSV export failed:', err); }
}

// ══════════════════════════════════════════════════
//  TCA EXPLORER TAB
// ══════════════════════════════════════════════════

function _tcaWindow() {
  return parseInt(document.getElementById('tca-hist-window')?.value) || 86400_000;
}

async function loadTcaAll() {
  await Promise.allSettled([
    loadTcaSummary(),
    loadTcaRestLatency(),
    loadTcaWsLatency(),
    loadTcaReconc(),
    loadTcaFills(),
  ]);
}

function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function _fmtMs(ms) { if (ms == null) return '—'; if (ms < 1000) return `${Math.round(ms)}ms`; if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`; return `${(ms / 60000).toFixed(1)}m`; }
function _latColor(ms) { if (ms == null) return ''; if (ms < 200) return 'color:var(--green);'; if (ms < 500) return 'color:var(--yellow);'; return 'color:var(--red);'; }
function _shortMethod(m) { return { createLimitOrder: 'Limit', createMarketOrder: 'Market', createBatchLimitOrders: 'Batch', cancelOrder: 'Cancel' }[m] || m; }

async function loadTcaSummary() {
  try {
    const d = await api(`/tca/summary?window=${_tcaWindow()}`);
    if (!d) return;
    _setText('th-fill-rate', d.chases?.fillRatePct != null ? `${d.chases.fillRatePct}%` : '—');
    _setText('th-avg-slip', d.slippage?.avgBps != null ? `${d.slippage.avgBps.toFixed(1)} bps` : '—');
    _setText('th-rest-p95', d.exchangeLatency?.p95 != null ? `${d.exchangeLatency.p95}ms` : '—');
    _setText('th-mismatches', d.reconciliation?.mismatches ?? '—');
    _setText('th-chases-total', d.chases?.total ?? '—');
    _setText('th-chases-filled', d.chases?.filled ?? '—');
    _setText('th-chases-cancelled', d.chases?.cancelled ?? '—');
    _setText('th-slip-p50', d.slippage?.p50Bps != null ? `${d.slippage.p50Bps.toFixed(1)} bps` : '—');
    _setText('th-slip-p95', d.slippage?.p95Bps != null ? `${d.slippage.p95Bps.toFixed(1)} bps` : '—');
    _setText('th-fill-p50', d.timeToFill?.p50 != null ? _fmtMs(d.timeToFill.p50) : '—');
    _setText('th-reprices', d.repricing?.totalReprices ?? '—');
    _setText('th-wasted', d.repricing?.wastedReprices ?? '—');
    _setText('th-efficiency', d.repricing?.efficiencyPct != null ? `${d.repricing.efficiencyPct}%` : '—');
  } catch (e) { console.warn('[TCA-Hist] Summary:', e.message); }
}

async function loadTcaRestLatency() {
  try {
    const d = await api(`/tca/latency?window=${_tcaWindow()}`);
    const c = document.getElementById('th-rest-table');
    if (!c || !d?.methods) return;
    const methods = Object.entries(d.methods);
    if (methods.length === 0) { c.innerHTML = _emptyRow('No exchange calls'); return; }
    c.innerHTML = _latencyTable(methods, 'durationMs');
  } catch (e) { console.warn('[TCA-Hist] REST:', e.message); }
}

async function loadTcaWsLatency() {
  try {
    const d = await api(`/tca/ws-latency?window=${_tcaWindow()}`);
    const c = document.getElementById('th-ws-table');
    if (!c || !d?.eventTypes) return;
    const types = Object.entries(d.eventTypes);
    if (types.length === 0) { c.innerHTML = _emptyRow('No WS events'); return; }
    c.innerHTML = `
      <table style="width:100%; font-size:11px; border-collapse:collapse;">
        <thead><tr style="color:var(--text-muted); text-transform:uppercase; font-size:9px; letter-spacing:0.5px;">
          <th style="text-align:left; padding:6px 4px;">Event</th>
          <th style="text-align:right; padding:6px 4px;">Count</th>
          <th style="text-align:right; padding:6px 4px;">Avg</th>
          <th style="text-align:right; padding:6px 4px;">p95</th>
          <th style="text-align:right; padding:6px 4px;">Max</th>
        </tr></thead>
        <tbody>${types.map(([t, s]) => `
          <tr style="border-top:1px solid var(--border);">
            <td style="padding:6px 4px; font-family:var(--font-mono); font-weight:600; color:var(--text-primary); font-size:10px;">${t}</td>
            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${s.count}</td>
            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${s.avg != null ? `${s.avg}ms` : '—'}</td>
            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${_latColor(s.p95)}">${s.p95 != null ? `${s.p95}ms` : '—'}</td>
            <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${_latColor(s.max)}">${s.max != null ? `${s.max}ms` : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) { console.warn('[TCA-Hist] WS:', e.message); }
}

async function loadTcaReconc() {
  try {
    const d = await api(`/tca/reconciliation?window=${_tcaWindow()}&limit=30`);
    const c = document.getElementById('th-reconc-log');
    if (!c) return;
    const all = [...(d?.events || []), ...(d?.mismatches || [])].sort((a, b) => b.ts - a.ts).slice(0, 30);
    if (all.length === 0) { c.innerHTML = _emptyRow('✓ No reconciliation events'); return; }
    c.innerHTML = all.map(evt => {
      const time = new Date(evt.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const isErr = evt.type?.includes('mismatch') || evt.type?.includes('orphan') || evt.pmsStatus;
      const lbl = evt.pmsStatus ? `${evt.pmsStatus} → ${evt.exchangeStatus}` : evt.type;
      const col = isErr ? 'var(--yellow)' : 'var(--text-muted)';
      const detail = evt.detail || evt.orderId || '';
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border); font-size:11px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="color:${col}; font-weight:600; font-size:10px; font-family:var(--font-mono);">${lbl}</span>
            ${evt.symbol ? `<span style="color:var(--text-primary); font-weight:600;">${evt.symbol.split('/')[0] || evt.symbol}</span>` : ''}
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="color:var(--text-muted); font-size:10px; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${detail}</span>
            <span style="color:var(--text-muted); font-size:9px; font-family:var(--font-mono);">${time}</span>
          </div>
        </div>`;
    }).join('');
  } catch (e) { console.warn('[TCA-Hist] Reconc:', e.message); }
}

async function loadTcaFills() {
  try {
    const d = await api(`/tca/fills?window=${_tcaWindow()}&limit=50`);
    const c = document.getElementById('th-fills-list');
    if (!c || !d?.fills) return;
    if (d.fills.length === 0) { c.innerHTML = _emptyRow('No fills in this window'); return; }
    c.innerHTML = d.fills.map(f => {
      const time = new Date(f.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const slip = f.slippageBps != null ? f.slippageBps.toFixed(1) : '—';
      const slipCol = f.slippageBps == null ? '' : (Math.abs(f.slippageBps) < 1 ? 'color:var(--green);' : (Math.abs(f.slippageBps) > 5 ? 'color:var(--red);' : 'color:var(--yellow);'));
      const sideClass = f.side === 'LONG' ? 'badge-long' : 'badge-short';
      const t2f = f.intentToFillMs != null ? _fmtMs(f.intentToFillMs) : '—';
      return `
        <div class="card" style="padding:8px 10px; margin-bottom:4px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-weight:700; font-size:12px;">${f.symbol?.split('/')[0] || '?'}</span>
              <span class="badge ${sideClass}" style="font-size:8px; padding:2px 6px;">${f.side}</span>
              ${f.reduceOnly ? '<span style="font-size:8px; color:var(--yellow); font-weight:600;">RO</span>' : ''}
            </div>
            <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-muted);">${time}</span>
          </div>
          <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; margin-top:4px; font-size:10px;">
            <div><span style="color:var(--text-muted);">Slip</span> <span style="font-family:var(--font-mono); font-weight:600; ${slipCol}">${slip} bps</span></div>
            <div><span style="color:var(--text-muted);">Reprices</span> <span style="font-family:var(--font-mono);">${f.repriceCount ?? 0}</span></div>
            <div><span style="color:var(--text-muted);">T2F</span> <span style="font-family:var(--font-mono);">${t2f}</span></div>
            <div><span style="color:var(--text-muted);">Price</span> <span style="font-family:var(--font-mono);">$${f.fillPrice?.toFixed(2) || '?'}</span></div>
          </div>
        </div>`;
    }).join('');
  } catch (e) { console.warn('[TCA-Hist] Fills:', e.message); }
}

// ── Reusable helpers ──────────────────────────────
function _emptyRow(text) {
  return `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:12px;">${text}</div>`;
}

function _latencyTable(methods) {
  return `
    <table style="width:100%; font-size:11px; border-collapse:collapse;">
      <thead><tr style="color:var(--text-muted); text-transform:uppercase; font-size:9px; letter-spacing:0.5px;">
        <th style="text-align:left; padding:6px 4px;">Method</th>
        <th style="text-align:right; padding:6px 4px;">Count</th>
        <th style="text-align:right; padding:6px 4px;">p50</th>
        <th style="text-align:right; padding:6px 4px;">p95</th>
        <th style="text-align:right; padding:6px 4px;">p99</th>
        <th style="text-align:right; padding:6px 4px;">Err%</th>
      </tr></thead>
      <tbody>${methods.map(([m, s]) => `
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:6px 4px; font-family:var(--font-mono); font-weight:600; color:var(--text-primary);">${_shortMethod(m)}</td>
          <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono);">${s.count}</td>
          <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${_latColor(s.p50)}">${s.p50 != null ? `${s.p50}ms` : '—'}</td>
          <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${_latColor(s.p95)}">${s.p95 != null ? `${s.p95}ms` : '—'}</td>
          <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${_latColor(s.p99)}">${s.p99 != null ? `${s.p99}ms` : '—'}</td>
          <td style="text-align:right; padding:6px 4px; font-family:var(--font-mono); ${s.errorRate > 5 ? 'color:var(--red);' : ''}">${s.errorRate}%</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}
