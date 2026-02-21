import { state, api, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { cuteSpinner, cuteKey, cuteBunnyHistory, cuteSadFace } from '../lib/cute-empty.js';

let historyOffset = 0;
let historyTotal = 0;
const HISTORY_LIMIT = 50;

export function renderHistoryPage(container) {
  historyOffset = 0;
  container.innerHTML = `
    <div id="history-page">
      <div class="section-header">
        <h2 class="section-title">Trade History</h2>
      </div>

      <!-- Filters -->
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

      <!-- Summary -->
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
            <div class="stat-label">Total Trades</div>
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

      <div id="history-list">
        ${cuteSpinner()}
      </div>

      <div id="history-load-more" style="display:none; text-align:center; padding:12px;">
        <button class="btn btn-outline btn-block" id="load-more-btn">Load More</button>
      </div>
    </div>
  `;

  // Event listeners
  const filterDelayed = debounce(() => { historyOffset = 0; loadHistory(true); }, 300);
  document.getElementById('hist-symbol-filter')?.addEventListener('input', filterDelayed);
  document.getElementById('hist-period')?.addEventListener('change', () => { historyOffset = 0; loadHistory(true); });
  document.getElementById('hist-action')?.addEventListener('change', () => { historyOffset = 0; loadHistory(true); });
  document.getElementById('load-more-btn')?.addEventListener('click', () => { historyOffset += HISTORY_LIMIT; loadHistory(false); });
  document.getElementById('hist-export')?.addEventListener('click', exportCSV);

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

  const html = trades.map(trade => {
    const time = new Date(trade.timestamp).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const actionColors = {
      OPEN: 'var(--accent)', CLOSE: 'var(--text-secondary)',
      LIQUIDATE: 'var(--red)', ADD: 'var(--yellow)',
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
          <span>${time}</span>
        </div>
        ${trade.exchangeOrderId ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-mono); opacity: 0.4;">Order: ${trade.exchangeOrderId}</div>` : ''}
      </div>`;
  }).join('');

  if (reset) {
    list.innerHTML = html;
  } else {
    list.insertAdjacentHTML('beforeend', html);
  }
}

async function exportCSV() {
  if (!state.currentAccount) return;
  try {
    // Fetch all trades (no limit)
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
