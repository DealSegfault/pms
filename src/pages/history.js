import { state, api, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { cuteSpinner, cuteKey, cuteBunnyHistory, cuteSadFace } from '../lib/cute-empty.js';

let historyOffset = 0;
let historyTotal = 0;
const HISTORY_LIMIT = 50;

let posHistoryOffset = 0;
let posHistoryTotal = 0;
const POS_HISTORY_LIMIT = 100;

let activeHistTab = 'trades'; // 'trades' | 'positions'
let posGroupMode = 'individual'; // 'individual' | 'symbol'

export function renderHistoryPage(container) {
  historyOffset = 0;
  posHistoryOffset = 0;
  container.innerHTML = `
    <div id="history-page">
      <div class="section-header" style="display:flex; align-items:center; gap:8px;">
        <h2 class="section-title">Trade History</h2>
        <div class="hist-view-toggle">
          <button class="hist-view-btn" id="hist-view-cards" data-view="cards">Cards</button>
          <button class="hist-view-btn active" id="hist-view-dense" data-view="dense">Dense</button>
        </div>
      </div>

      <!-- Primary Tab Bar -->
      <div class="hist-tab-bar">
        <button class="hist-tab active" id="hist-tab-trades" data-tab="trades">Trades</button>
        <button class="hist-tab" id="hist-tab-positions" data-tab="positions">Positions</button>
      </div>

      <!-- Collapsible Filters -->
      <div class="hist-filter-toggle" id="hist-filter-toggle">🔍 Filters</div>
      <div class="hist-filter-body" id="hist-filter-body">
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
      </div>

      <!-- Summary (shared container, content changes per tab) -->
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
          <div class="stat-item">
            <div class="stat-label" id="stat-label-count">Total Trades</div>
            <div class="stat-value" id="total-trades">0</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Avg PnL</div>
            <div class="stat-value" id="avg-pnl">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Total Fees</div>
            <div class="stat-value" id="total-fees">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Showing</div>
            <div class="stat-value" id="showing-count">0</div>
          </div>
        </div>
      </div>

      <!-- Position group toggle (only visible on positions tab) -->
      <div id="pos-group-bar" class="pos-group-bar" style="display:none;">
        <button class="pos-group-btn active" data-group="individual">Individual</button>
        <button class="pos-group-btn" data-group="symbol">By Symbol</button>
      </div>

      <div id="history-list">
        ${cuteSpinner()}
      </div>

      <div id="history-load-more" style="display:none; text-align:center; padding:12px;">
        <button class="btn btn-outline btn-block" id="load-more-btn">Load More</button>
      </div>
    </div>
  `;

  // Tab switching
  container.querySelectorAll('.hist-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeHistTab = tab.dataset.tab;
      container.querySelectorAll('.hist-tab').forEach(t => t.classList.toggle('active', t === tab));
      // Show/hide action filter (not relevant for positions)
      const actionSelect = document.getElementById('hist-action');
      if (actionSelect) actionSelect.style.display = activeHistTab === 'trades' ? '' : 'none';
      // Show/hide group toggle
      const groupBar = document.getElementById('pos-group-bar');
      if (groupBar) groupBar.style.display = activeHistTab === 'positions' ? '' : 'none';
      // Update count label
      const countLabel = document.getElementById('stat-label-count');
      if (countLabel) countLabel.textContent = activeHistTab === 'trades' ? 'Total Trades' : 'Positions';
      // Reload data
      if (activeHistTab === 'trades') {
        historyOffset = 0;
        loadHistory(true);
      } else {
        posHistoryOffset = 0;
        loadPositionHistory(true);
      }
    });
  });

  // Position group toggle
  container.querySelectorAll('.pos-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      posGroupMode = btn.dataset.group;
      container.querySelectorAll('.pos-group-btn').forEach(b => b.classList.toggle('active', b === btn));
      posHistoryOffset = 0;
      loadPositionHistory(true);
    });
  });

  // Event listeners (existing)
  const filterDelayed = debounce(() => {
    if (activeHistTab === 'trades') { historyOffset = 0; loadHistory(true); }
    else { posHistoryOffset = 0; loadPositionHistory(true); }
  }, 300);
  document.getElementById('hist-symbol-filter')?.addEventListener('input', filterDelayed);
  document.getElementById('hist-period')?.addEventListener('change', () => {
    if (activeHistTab === 'trades') { historyOffset = 0; loadHistory(true); }
    else { posHistoryOffset = 0; loadPositionHistory(true); }
  });
  document.getElementById('hist-action')?.addEventListener('change', () => { historyOffset = 0; loadHistory(true); });
  document.getElementById('load-more-btn')?.addEventListener('click', () => {
    if (activeHistTab === 'trades') { historyOffset += HISTORY_LIMIT; loadHistory(false); }
    else { posHistoryOffset += POS_HISTORY_LIMIT; loadPositionHistory(false); }
  });
  document.getElementById('hist-export')?.addEventListener('click', exportCSV);

  // History → TCA lifecycle navigation
  container.addEventListener('click', (e) => {
    const lcBtn = e.target.closest('[data-hist-lifecycle]');
    if (!lcBtn) return;
    const clientOrderId = lcBtn.dataset.histLifecycle;
    if (!clientOrderId) return;
    e.preventDefault();
    location.hash = '#/tca';
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('open_lifecycle_by_order', { detail: { clientOrderId } }));
    }, 350);
  });

  // Collapsible filter toggle
  document.getElementById('hist-filter-toggle')?.addEventListener('click', () => {
    document.getElementById('hist-filter-body')?.classList.toggle('open');
  });

  // View toggle
  let histViewMode = localStorage.getItem('pms_hist_view') || 'dense';
  document.querySelectorAll('.hist-view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === histViewMode);
    btn.addEventListener('click', () => {
      histViewMode = btn.dataset.view;
      document.querySelectorAll('.hist-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      try { localStorage.setItem('pms_hist_view', histViewMode); } catch { }
      if (activeHistTab === 'trades') { historyOffset = 0; loadHistory(true); }
      else { posHistoryOffset = 0; loadPositionHistory(true); }
    });
  });

  loadHistory(true);
}

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

function getPosFilters() {
  const symbol = document.getElementById('hist-symbol-filter')?.value?.trim() || '';
  const period = document.getElementById('hist-period')?.value || '';

  const params = new URLSearchParams();
  params.set('limit', POS_HISTORY_LIMIT);
  params.set('offset', posHistoryOffset);
  if (symbol) params.set('symbol', symbol.toUpperCase().includes('/') ? symbol : `${symbol.toUpperCase()}/USDT:USDT`);
  if (period) params.set('period', period);

  return params.toString();
}

// ── Trades Tab (existing logic) ─────────────────────────────────

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
    const { trades, total } = data;
    historyTotal = total;

    if (reset) {
      renderHistoryStats(trades, total);
      renderTradesList(trades, true);
    } else {
      renderTradesList(trades, false);
    }

    // Show/hide load more
    const loadMore = document.getElementById('history-load-more');
    if (loadMore) loadMore.style.display = (historyOffset + HISTORY_LIMIT < total) ? '' : 'none';
    const showEl = document.getElementById('showing-count');
    if (showEl) showEl.textContent = `${Math.min(historyOffset + HISTORY_LIMIT, total)}/${total}`;
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
  if (apEl) {
    apEl.textContent = formatUsd(avgPnl, 4);
    apEl.className = `stat-value ${formatPnlClass(avgPnl)}`;
  }

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

  const viewMode = localStorage.getItem('pms_hist_view') || 'dense';

  if (viewMode === 'dense') {
    const headerHtml = reset ? `<div class="hist-dense-header">
      <span>Symbol</span><span style="text-align:right;">Price</span>
      <span style="text-align:right;">PnL</span><span style="text-align:right;">Time</span>
    </div>` : '';

    const rowsHtml = trades.map(trade => {
      const time = new Date(trade.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const pnlHtml = trade.realizedPnl != null
        ? `<span class="${formatPnlClass(trade.realizedPnl)}" style="font-family:var(--font-mono); font-weight:600;">${formatUsd(trade.realizedPnl, 4)}</span>`
        : '<span style="color:var(--text-muted);">\u2014</span>';
      return `<div class="hist-dense-row">
        <span style="font-weight:600; display:flex; align-items:center; gap:4px;">
          ${trade.symbol.split('/')[0]}
          <span class="badge badge-${trade.side === 'BUY' ? 'long' : 'short'}" style="font-size:8px;">${trade.side}</span>
          <span style="font-size:9px; color:var(--text-muted);">${trade.action}</span>
        </span>
        <span style="text-align:right; font-family:var(--font-mono); font-size:11px;">$${formatPrice(trade.price)}</span>
        <span style="text-align:right;">${pnlHtml}</span>
        <span style="text-align:right; display:flex; align-items:center; justify-content:flex-end; gap:4px;">
          <span style="font-size:10px; color:var(--text-muted);">${time}</span>
          ${trade.clientOrderId ? `<button class="hist-lifecycle-btn" data-hist-lifecycle="${trade.clientOrderId}" title="View in TCA">🔍</button>` : ''}
        </span>
      </div>`;
    }).join('');

    if (reset) list.innerHTML = headerHtml + rowsHtml;
    else list.insertAdjacentHTML('beforeend', rowsHtml);
    return;
  }

  // Original card layout
  const html = trades.map(trade => {
    const time = new Date(trade.timestamp).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const actionColors = {
      OPEN: 'var(--accent)', CLOSE: 'var(--text-secondary)',
      LIQUIDATE: 'var(--red)', ADD: 'var(--yellow)', ADL: 'var(--orange)',
    };

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
          <span style="display:flex; align-items:center; gap:4px;">
            ${time}
            ${trade.clientOrderId ? `<button class="hist-lifecycle-btn" data-hist-lifecycle="${trade.clientOrderId}" title="View in TCA">🔍</button>` : ''}
          </span>
        </div>
        ${trade.exchangeOrderId ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-mono); opacity: 0.4;">Order: ${trade.exchangeOrderId}</div>` : ''}
      </div>`;
  }).join('');

  if (reset) list.innerHTML = html;
  else list.insertAdjacentHTML('beforeend', html);
}

// ── Positions Tab ─────────────────────────────────────────────

async function loadPositionHistory(reset) {
  if (!state.currentAccount) {
    document.getElementById('history-list').innerHTML = cuteKey({ title: 'No Account Selected ✨', subtitle: 'Go to the Trade tab first~' });
    return;
  }

  if (reset) {
    document.getElementById('history-list').innerHTML = cuteSpinner();
  }

  try {
    const data = await api(`/trade/position-history/${state.currentAccount}?${getPosFilters()}`);
    const { positions, symbolRollups, total, closedTotal, openTotal } = data;
    posHistoryTotal = total;

    if (reset) {
      renderPositionStats(positions, symbolRollups, total, closedTotal, openTotal);
    }

    if (posGroupMode === 'symbol') {
      renderSymbolRollup(symbolRollups, reset, positions);
    } else {
      renderPositionsList(positions, reset);
    }

    // Show/hide load more
    const loadMore = document.getElementById('history-load-more');
    if (loadMore) {
      if (posGroupMode === 'symbol') {
        loadMore.style.display = 'none';
      } else {
        loadMore.style.display = (posHistoryOffset + POS_HISTORY_LIMIT < total) ? '' : 'none';
      }
    }
    const showEl = document.getElementById('showing-count');
    if (showEl) showEl.textContent = `${Math.min(posHistoryOffset + POS_HISTORY_LIMIT, total)}/${total}`;
  } catch (err) {
    document.getElementById('history-list').innerHTML = cuteSadFace({ subtitle: err.message });
  }
}

function renderPositionStats(positions, symbolRollups, total, closedTotal, openTotal) {
  const closedPositions = positions.filter(p => p.status !== 'OPEN');
  const totalRpnl = closedPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const openUpnl = positions.filter(p => p.status === 'OPEN').reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const wins = closedPositions.filter(p => (p.realizedPnl || 0) > 0).length;
  const winRate = closedPositions.length > 0 ? ((wins / closedPositions.length) * 100).toFixed(1) : '—';
  const avgPnl = closedPositions.length > 0 ? totalRpnl / closedPositions.length : 0;
  const totalFees = positions.reduce((s, p) => s + (p.totalFees || 0), 0);

  const rpnlEl = document.getElementById('total-rpnl');
  if (rpnlEl) {
    const displayPnl = totalRpnl + openUpnl;
    rpnlEl.textContent = formatUsd(displayPnl, 4);
    rpnlEl.className = `price-big ${formatPnlClass(displayPnl)}`;
    rpnlEl.style.fontSize = '22px';
  }

  const wrEl = document.getElementById('win-rate');
  if (wrEl) wrEl.textContent = winRate !== '—' ? `${winRate}%` : '—';

  const ttEl = document.getElementById('total-trades');
  if (ttEl) ttEl.textContent = `${closedTotal}${openTotal > 0 ? ` + ${openTotal} open` : ''}`;

  const apEl = document.getElementById('avg-pnl');
  if (apEl) {
    apEl.textContent = formatUsd(avgPnl, 4);
    apEl.className = `stat-value ${formatPnlClass(avgPnl)}`;
  }

  const feesEl = document.getElementById('total-fees');
  if (feesEl) feesEl.textContent = `$${totalFees.toFixed(4)}`;
}

function formatDuration(ms) {
  if (ms == null) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  if (hr < 24) return `${hr}h ${rm}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

function statusBadgeHtml(status) {
  const cls = status === 'OPEN' ? 'pos-status-open' : status === 'LIQUIDATED' ? 'pos-status-liq' : 'pos-status-closed';
  return `<span class="pos-status-badge ${cls}">${status}</span>`;
}

function renderPositionsList(positions, reset) {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (reset && (!positions || positions.length === 0)) {
    list.innerHTML = cuteBunnyHistory({ title: 'No Positions Yet~', subtitle: 'Closed positions will appear here ✨' });
    return;
  }

  const viewMode = localStorage.getItem('pms_hist_view') || 'dense';

  if (viewMode === 'dense') {
    const headerHtml = reset ? `<div class="pos-hist-header">
      <span>Symbol</span><span style="text-align:right;">Entry</span>
      <span style="text-align:right;">Exit / Mark</span><span style="text-align:right;">PnL</span>
      <span style="text-align:right;">Duration</span><span style="text-align:center;">Status</span>
    </div>` : '';

    const rowsHtml = positions.map(p => {
      const base = (p.symbol || '').split('/')[0];
      const exitPrice = p.status === 'OPEN'
        ? (p.markPrice ? `$${formatPrice(p.markPrice)}` : '—')
        : (p.realizedPnl != null && p.entryPrice && p.quantity
          ? `$${formatPrice(p.entryPrice + (p.realizedPnl / p.quantity) * (p.side === 'LONG' ? 1 : -1))}`
          : '—');
      const pnlVal = p.status === 'OPEN' ? (p.unrealizedPnl || 0) : (p.realizedPnl || 0);
      const pnlHtml = `<span class="${formatPnlClass(pnlVal)}" style="font-family:var(--font-mono); font-weight:600;">${formatUsd(pnlVal, 4)}</span>`;
      const dur = formatDuration(p.durationMs);

      return `<div class="pos-hist-row">
        <span style="font-weight:600; display:flex; align-items:center; gap:4px;">
          ${base}
          <span class="badge badge-${p.side === 'LONG' ? 'long' : 'short'}" style="font-size:8px;">${p.side}</span>
        </span>
        <span style="text-align:right; font-family:var(--font-mono); font-size:11px;">$${formatPrice(p.entryPrice)}</span>
        <span style="text-align:right; font-family:var(--font-mono); font-size:11px;">${exitPrice}</span>
        <span style="text-align:right;">${pnlHtml}</span>
        <span style="text-align:right; font-size:10px; color:var(--text-muted);">${dur}</span>
        <span style="text-align:center;">${statusBadgeHtml(p.status)}</span>
      </div>`;
    }).join('');

    if (reset) list.innerHTML = headerHtml + rowsHtml;
    else list.insertAdjacentHTML('beforeend', rowsHtml);
    return;
  }

  // Card layout
  const html = positions.map(p => {
    const base = (p.symbol || '').split('/')[0];
    const pnlVal = p.status === 'OPEN' ? (p.unrealizedPnl || 0) : (p.realizedPnl || 0);
    const pnlLabel = p.status === 'OPEN' ? 'uPnL' : 'PnL';
    const dur = formatDuration(p.durationMs);
    const openTime = p.openedAt ? new Date(p.openedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const closeTime = p.closedAt ? new Date(p.closedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    return `
      <div class="card" style="padding: 12px; margin-bottom: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 700; font-size: 14px;">${base}</span>
            <span class="badge badge-${p.side === 'LONG' ? 'long' : 'short'}" style="font-size: 9px;">${p.side}</span>
            ${statusBadgeHtml(p.status)}
          </div>
          <span class="${formatPnlClass(pnlVal)}" style="font-family:var(--font-mono); font-weight:700; font-size:14px;">${formatUsd(pnlVal, 4)}</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; font-size: 11px; color: var(--text-muted);">
          <div><span style="opacity:0.6;">Entry</span> <span style="color:var(--text-primary); font-family:var(--font-mono);">$${formatPrice(p.entryPrice)}</span></div>
          <div><span style="opacity:0.6;">Qty</span> <span style="color:var(--text-primary);">${p.quantity?.toFixed(6) || '—'}</span></div>
          <div><span style="opacity:0.6;">Duration</span> <span style="color:var(--text-primary);">${dur}</span></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-top: 4px;">
          <span>Fees: $${(p.totalFees || 0).toFixed(4)} · Net: <span class="${formatPnlClass(p.netPnl || 0)}">${formatUsd(p.netPnl || 0, 4)}</span></span>
          <span>${openTime} → ${p.status === 'OPEN' ? 'now' : closeTime}</span>
        </div>
      </div>`;
  }).join('');

  if (reset) list.innerHTML = html;
  else list.insertAdjacentHTML('beforeend', html);
}

function renderSymbolRollup(rollups, reset, allPositions) {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!rollups || rollups.length === 0) {
    list.innerHTML = cuteBunnyHistory({ title: 'No Position Data~', subtitle: 'Trade some symbols and they\'ll appear here ✨' });
    return;
  }

  // Group positions by symbol for the drawer
  const posBySymbol = {};
  for (const p of (allPositions || [])) {
    const sym = p.symbol;
    if (!posBySymbol[sym]) posBySymbol[sym] = [];
    posBySymbol[sym].push(p);
  }

  const html = rollups.map(r => {
    const base = (r.symbol || '').split('/')[0];
    const winRatePct = (r.winRate * 100).toFixed(1);
    const avgDur = formatDuration(r.avgDurationMs);
    const sparkId = `spark-${base.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const drawerId = `drawer-${base.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const childPositions = posBySymbol[r.symbol] || [];

    // Build child position rows
    const childRows = childPositions.map(p => {
      const pBase = (p.symbol || '').split('/')[0];
      const exitPrice = p.status === 'OPEN'
        ? (p.markPrice ? `$${formatPrice(p.markPrice)}` : '—')
        : (p.realizedPnl != null && p.entryPrice && p.quantity
          ? `$${formatPrice(p.entryPrice + (p.realizedPnl / p.quantity) * (p.side === 'LONG' ? 1 : -1))}`
          : '—');
      const pnlVal = p.status === 'OPEN' ? (p.unrealizedPnl || 0) : (p.realizedPnl || 0);
      const dur = formatDuration(p.durationMs);
      const time = p.closedAt
        ? new Date(p.closedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : (p.openedAt ? new Date(p.openedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

      return `<div class="pos-drawer-row">
        <span style="display:flex; align-items:center; gap:4px;">
          <span class="badge badge-${p.side === 'LONG' ? 'long' : 'short'}" style="font-size:8px;">${p.side}</span>
          ${statusBadgeHtml(p.status)}
        </span>
        <span style="font-family:var(--font-mono); font-size:10px;">$${formatPrice(p.entryPrice)}</span>
        <span style="font-family:var(--font-mono); font-size:10px;">${exitPrice}</span>
        <span class="${formatPnlClass(pnlVal)}" style="font-family:var(--font-mono); font-weight:600; font-size:10px;">${formatUsd(pnlVal, 4)}</span>
        <span style="font-size:10px; color:var(--text-muted);">${dur}</span>
        <span style="font-size:9px; color:var(--text-muted);">${time}</span>
      </div>`;
    }).join('');

    return `
      <div class="pos-symbol-card" data-symbol-toggle="${drawerId}" style="cursor:pointer;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; font-size:16px;">${base}</span>
            <span style="font-size:11px; color:var(--text-muted);">${r.closedCount} closed${r.openCount > 0 ? ` · ${r.openCount} open` : ''}</span>
            <span class="pos-drawer-chevron" style="font-size:10px; color:var(--text-muted); transition:transform 0.2s;">▶</span>
          </div>
          <span class="${formatPnlClass(r.cumulativePnl)}" style="font-family:var(--font-mono); font-weight:700; font-size:16px;">${formatUsd(r.cumulativePnl, 2)}</span>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:8px; font-size:11px; margin-top:8px;">
          <div>
            <div style="color:var(--text-muted); font-size:9px; text-transform:uppercase;">Win Rate</div>
            <div style="font-weight:600;">${winRatePct}%</div>
          </div>
          <div>
            <div style="color:var(--text-muted); font-size:9px; text-transform:uppercase;">Avg Duration</div>
            <div style="font-weight:600;">${avgDur}</div>
          </div>
          <div>
            <div style="color:var(--text-muted); font-size:9px; text-transform:uppercase;">Total Fees</div>
            <div style="font-weight:600;">$${r.totalFees.toFixed(4)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted); font-size:9px; text-transform:uppercase;">Net PnL</div>
            <div class="${formatPnlClass(r.netPnl)}" style="font-weight:600;">${formatUsd(r.netPnl, 2)}</div>
          </div>
        </div>
        ${r.sparklineData.length > 1 ? `<div class="pos-sparkline-wrap"><svg id="${sparkId}" class="pos-sparkline ${r.cumulativePnl >= 0 ? '' : 'negative'}"></svg></div>` : ''}
        <div class="pos-drawer" id="${drawerId}">
          <div class="pos-drawer-header">
            <span>Side</span><span>Entry</span><span>Exit</span><span>PnL</span><span>Duration</span><span>Time</span>
          </div>
          ${childRows}
        </div>
      </div>`;
  }).join('');

  list.innerHTML = html;

  // Wire click-to-expand drawers
  list.querySelectorAll('[data-symbol-toggle]').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't toggle if clicking inside the drawer itself
      if (e.target.closest('.pos-drawer')) return;
      const drawerId = card.dataset.symbolToggle;
      const drawer = document.getElementById(drawerId);
      const chevron = card.querySelector('.pos-drawer-chevron');
      if (drawer) {
        drawer.classList.toggle('open');
        if (chevron) chevron.style.transform = drawer.classList.contains('open') ? 'rotate(90deg)' : '';
      }
    });
  });

  // Draw sparklines after DOM insertion
  requestAnimationFrame(() => {
    for (const r of rollups) {
      if (r.sparklineData.length <= 1) continue;
      const base = (r.symbol || '').split('/')[0];
      const sparkId = `spark-${base.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const svgEl = document.getElementById(sparkId);
      if (svgEl) drawSparkline(svgEl, r.sparklineData);
    }
  });
}

function drawSparkline(svgEl, values) {
  if (!values || values.length < 2) return;

  const w = svgEl.clientWidth || 280;
  const h = svgEl.clientHeight || 80;
  const pad = 2;
  const drawW = w - pad * 2;
  const drawH = h - pad * 2;

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * drawW;
    const y = pad + drawH - ((v - min) / range) * drawH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  // Zero line
  const zeroY = pad + drawH - ((0 - min) / range) * drawH;

  const color = values[values.length - 1] >= 0 ? '#22c55e' : '#f97316';
  const fadeColor = values[values.length - 1] >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(249,115,22,0.15)';

  // Area fill
  const areaPoints = `${pad.toFixed(1)},${zeroY.toFixed(1)} ${points.join(' ')} ${(pad + drawW).toFixed(1)},${zeroY.toFixed(1)}`;

  svgEl.innerHTML = `
    <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${(pad + drawW).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="rgba(148,163,184,0.2)" stroke-width="1" stroke-dasharray="3,3"/>
    <polygon points="${areaPoints}" fill="${fadeColor}"/>
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// ── CSV Export ─────────────────────────────────────────────────

async function exportCSV() {
  if (!state.currentAccount) return;
  try {
    if (activeHistTab === 'positions') {
      const data = await api(`/trade/position-history/${state.currentAccount}?limit=10000`);
      const positions = data.positions || [];
      if (!positions.length) return;

      const headers = ['openedAt', 'closedAt', 'symbol', 'side', 'status', 'entryPrice', 'quantity', 'realizedPnl', 'totalFees', 'netPnl', 'durationMs'];
      const rows = positions.map(p => headers.map(h => {
        const v = p[h];
        if (v == null) return '';
        if (h === 'openedAt' || h === 'closedAt') return v ? new Date(v).toISOString() : '';
        return v;
      }).join(','));

      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `positions_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // Trades CSV (existing)
    const data = await api(`/trade/history/${state.currentAccount}?limit=10000`);
    const trades = data.trades || data;
    if (!trades.length) return;

    const headers = ['timestamp', 'symbol', 'side', 'action', 'type', 'price', 'quantity', 'notional', 'fee', 'realizedPnl', 'exchangeOrderId'];
    const rows = trades.map(t => headers.map(h => {
      const v = t[h];
      if (v == null) return '';
      if (h === 'timestamp') return new Date(v).toISOString();
      return v;
    }).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('CSV export failed:', err);
  }
}
