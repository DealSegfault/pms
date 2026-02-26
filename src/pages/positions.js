import { state, api, showToast, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { streams } from '../lib/binance-streams.js';
import { cuteSleepyCat, cuteSpinner } from '../lib/cute-empty.js';
import { cuteConfirm } from '../lib/cute-confirm.js';

let positionsData = []; // cached for WS updates

// --- Live update state ---
let markPriceUnsubs = {};     // { symbol: unsubFn }
let latestMarkPrices = {};    // { symbol: number }
let pollInterval = null;      // REST fallback
let timeHeldInterval = null;  // live time ticker
let cleanedUp = false;
let _lastWsPnlTs = 0;         // last time WS delivered pnl_update
let _cachedBalance = 0;       // cached balance for live equity calc
let _cachedMarginUsed = 0;    // cached margin used for live available calc

// Stored listener references for cleanup
const _listeners = {};


export function renderPositionsPage(container) {

  container.innerHTML = `
    <div id="positions-page">
      <div id="equity-card" class="glass-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div class="price-label">Total Equity</div>
            <div id="total-equity" class="price-big">$0.00</div>
          </div>
          <div style="text-align: right;">
            <div class="price-label">Unrealized PnL</div>
            <div id="total-upnl" class="price-big" style="font-size: 20px;">$0.00</div>
          </div>
        </div>
        <div class="stat-grid" style="margin-top: 14px;">
          <div class="stat-item">
            <div class="stat-label">Balance</div>
            <div class="stat-value" id="stat-balance">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Margin Used</div>
            <div class="stat-value" id="stat-margin">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Available</div>
            <div class="stat-value" id="stat-available">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Exposure</div>
            <div class="stat-value" id="stat-exposure">$0.00</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Margin Ratio</div>
            <div class="stat-value" id="stat-margin-ratio" style="font-size: 13px;">0.0%</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Liq. Price</div>
            <div class="stat-value" id="stat-liq-price" style="font-size: 13px; color: var(--red);">—</div>
          </div>
        </div>

      </div>
      
      <div class="section-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h2 class="section-title">Open Positions</h2>
          <span id="position-count" class="badge badge-active">0</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="save-as-index-btn" class="btn btn-outline btn-sm" style="font-size: 11px; padding: 4px 12px; display: none; border-color: var(--accent); color: var(--accent);">
            📊 Save as Index
          </button>
          <button id="close-all-btn" class="btn btn-danger btn-sm" style="font-size: 11px; padding: 4px 12px; display: none;">
            Close All
          </button>
        </div>
      </div>

      <div id="positions-list">
        ${cuteSpinner()}
      </div>

    </div>

    <style>

      .pos-pnl-value { transition: color 0.15s; font-family: var(--font-mono); font-weight: 700; }
      .pos-mark-price { font-family: var(--font-mono); transition: color 0.15s; }
      .limit-close-form { display: none; margin-top: 6px; gap: 6px; align-items: center; }
      .limit-close-form.active { display: flex; }
      .limit-close-form input { flex: 1; padding: 5px 8px; font-size: 12px; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); }
      .limit-close-form button { white-space: nowrap; }
      .pos-action-row { display: flex; gap: 6px; margin-top: 8px; }
      .pos-action-row .btn { flex: 1; font-size: 11px; padding: 6px 0; }
    </style>
  `;

  // Close All handler
  document.getElementById('close-all-btn')?.addEventListener('click', closeAllPositions);

  // Save as Index handler
  document.getElementById('save-as-index-btn')?.addEventListener('click', savePositionsAsIndex);

  // Reset cleanup flag
  cleanedUp = false;

  // Remove any stale listeners from previous renders
  cleanupListeners();

  loadPositions();

  // Register WS event listeners with stored refs for cleanup
  _listeners.pnl = handlePnlUpdate;
  _listeners.margin = handleMarginUpdate;
  _listeners.closed = (e) => {
    // Optimistic instant removal before full refresh
    const d = e?.detail || {};
    if (d.positionId) {
      const card = document.querySelector(`.position-card[data-id="${d.positionId}"]`);
      if (card) card.remove();
      positionsData = positionsData.filter(p => p.id !== d.positionId);
      const countEl = document.getElementById('position-count');
      if (countEl) countEl.textContent = positionsData.length;
      if (positionsData.length === 0) {
        const list = document.getElementById('positions-list');
        if (list) list.innerHTML = cuteSleepyCat({ title: 'No More Positions ✨', subtitle: 'All cozy with no open trades~ 💤' });
      }
      updateGlobalUpnl();
    }
    loadPositions();
  };
  _listeners.liquidation = (e) => {
    const d = e?.detail || {};
    if (d.positionId) {
      const card = document.querySelector(`.position-card[data-id="${d.positionId}"]`);
      if (card) card.remove();
      positionsData = positionsData.filter(p => p.id !== d.positionId);
      const countEl = document.getElementById('position-count');
      if (countEl) countEl.textContent = positionsData.length;
      if (positionsData.length === 0) {
        const list = document.getElementById('positions-list');
        if (list) list.innerHTML = cuteSleepyCat({ title: 'No More Positions ✨', subtitle: 'All cozy with no open trades~ 💤' });
      }
      updateGlobalUpnl();
    }
    loadPositions();
  };
  _listeners.reduced = () => loadPositions();
  _listeners.filled = () => setTimeout(loadPositions, 2000);
  _listeners.positionUpdated = handlePositionUpdated;

  window.addEventListener('pnl_update', _listeners.pnl);
  window.addEventListener('margin_update', _listeners.margin);
  window.addEventListener('position_closed', _listeners.closed);
  window.addEventListener('liquidation', _listeners.liquidation);
  window.addEventListener('position_reduced', _listeners.reduced);
  window.addEventListener('order_filled', _listeners.filled);
  window.addEventListener('position_updated', _listeners.positionUpdated);

  // REST polling fallback — only if WS hasn't delivered data in 15s
  pollInterval = setInterval(() => {
    if (!cleanedUp && Date.now() - _lastWsPnlTs > 15000) loadPositions();
  }, 10000);

  // Live time-held ticker — every 30s
  timeHeldInterval = setInterval(() => {
    if (cleanedUp) return;
    document.querySelectorAll('[data-opened-at]').forEach(el => {
      el.textContent = `⏱ ${getTimeHeld(el.dataset.openedAt)}`;
    });
  }, 30000);
}


async function loadPositions() {
  if (!state.currentAccount) {
    document.getElementById('positions-list').innerHTML = `
      <div class="empty-state">
        <h3>No Account Selected</h3>
        <p>Go to Trade tab to select an account</p>
      </div>
    `;
    return;
  }

  try {
    const data = await api(`/trade/positions/${state.currentAccount}`);
    positionsData = data.positions || [];
    renderSummary(data.summary);
    renderPositionsList(positionsData);

    // Show/hide action buttons
    const closeAllBtn = document.getElementById('close-all-btn');
    if (closeAllBtn) closeAllBtn.style.display = positionsData.length > 0 ? '' : 'none';
    const saveIdxBtn = document.getElementById('save-as-index-btn');
    if (saveIdxBtn) saveIdxBtn.style.display = positionsData.length > 0 ? '' : 'none';
  } catch (err) {
    console.error('Failed to load positions:', err);
  }
}

function renderSummary(summary) {
  if (!summary) return;

  // Cache balance for live equity recalc
  _cachedBalance = summary.balance || 0;
  _cachedMarginUsed = summary.marginUsed || 0;

  const equityEl = document.getElementById('total-equity');
  const upnlEl = document.getElementById('total-upnl');

  if (equityEl) equityEl.textContent = `$${summary.equity.toFixed(2)}`;
  // Only update total uPnL from REST if we don't have live WS prices yet
  const hasLivePrices = Object.keys(latestMarkPrices).length > 0;
  if (upnlEl && !hasLivePrices) {
    upnlEl.textContent = formatUsd(summary.unrealizedPnl);
    upnlEl.className = `price-big ${formatPnlClass(summary.unrealizedPnl)}`;
    upnlEl.style.fontSize = '20px';
  }

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `$${val.toFixed(2)}`;
  };
  setVal('stat-balance', summary.balance);
  setVal('stat-margin', summary.marginUsed);
  setVal('stat-available', summary.availableMargin);
  setVal('stat-exposure', summary.totalExposure);

  const mrEl = document.getElementById('stat-margin-ratio');
  if (mrEl) {
    const pct = ((summary.marginRatio || 0) * 100).toFixed(1);
    mrEl.textContent = `${pct}%`;
    mrEl.style.color = summary.marginRatio >= 0.8 ? 'var(--red)' : summary.marginRatio >= 0.5 ? 'orange' : 'var(--text)';
  }

  const lpEl = document.getElementById('stat-liq-price');
  if (lpEl) lpEl.textContent = summary.accountLiqPrice ? `$${formatPrice(summary.accountLiqPrice)}` : '—';



  const countEl = document.getElementById('position-count');
  if (countEl) countEl.textContent = summary.positionCount;
}

function renderPositionsList(positions) {
  const list = document.getElementById('positions-list');
  if (!list) return;

  if (!positions || positions.length === 0) {
    list.innerHTML = cuteSleepyCat({ title: 'No More Positions ✨', subtitle: 'All cozy with no open trades~ 💤' });
    return;
  }

  list.innerHTML = positions.map(pos => {
    // Use live WS mark price if available, otherwise fall back to REST data
    const liveMarkPrice = latestMarkPrices[pos.symbol];
    let pnl, pnlPct;
    if (liveMarkPrice) {
      pnl = pos.side === 'LONG'
        ? (liveMarkPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - liveMarkPrice) * pos.quantity;
      pnlPct = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
    } else {
      pnl = pos.unrealizedPnl || 0;
      pnlPct = pos.pnlPercent || 0;
    }
    const pnlClass = formatPnlClass(pnl);

    // Time held
    const elapsed = pos.openedAt ? getTimeHeld(pos.openedAt) : '—';

    // Mark price to display
    const displayMarkPrice = liveMarkPrice || pos.markPrice || pos.entryPrice;

    return `
      <div class="position-card" data-id="${pos.id}"
           data-symbol="${pos.symbol}" data-side="${pos.side}"
           data-entry="${pos.entryPrice}" data-qty="${pos.quantity}"
            data-margin="${pos.margin}">
        <div class="position-header">
          <div class="position-symbol">
            <span class="pos-sym-link" data-nav-symbol="${pos.symbol}" style="cursor:pointer;">${pos.symbol.split('/')[0]}</span>
            <span class="badge badge-${pos.side.toLowerCase()}">${pos.side}</span>
            <span style="font-size: 11px; color: var(--text-muted);">${pos.leverage}x</span>
            <span data-opened-at="${pos.openedAt || ''}" style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">⏱ ${elapsed}</span>
          </div>
          <div class="position-pnl ${pnlClass}">
            <span class="pos-pnl-value" data-pnl-id="${pos.id}" data-prev-pnl="${pnl}">${formatUsd(pnl, 3)}</span>
            <span style="font-size: 11px; margin-left: 4px;">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="position-details">
          <div>
            <div class="position-detail-label">Entry</div>
            <div class="position-detail-value">$${formatPrice(pos.entryPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Mark</div>
            <div class="position-detail-value pos-mark-price" data-mark-id="${pos.id}" style="color: ${pnl >= 0 ? 'var(--green)' : 'var(--red)'}">$${formatPrice(displayMarkPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Liquidation</div>
            <div class="position-detail-value" data-liq-id="${pos.id}" style="color: var(--red);">$${formatPrice(pos.liquidationPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Margin</div>
            <div class="position-detail-value">$${pos.margin.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Notional</div>
            <div class="position-detail-value">$${pos.notional.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Quantity</div>
            <div class="position-detail-value">${pos.quantity.toFixed(6)}</div>
          </div>
        </div>
        <div class="pos-action-row">
          <button class="btn btn-danger btn-sm" data-market-close="${pos.id}" data-symbol="${pos.symbol}">⬇ Market Close</button>
          <button class="btn btn-outline btn-sm" data-toggle-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">📊 Limit Close</button>
        </div>
        <div class="limit-close-form" id="limit-form-${pos.id}">
          <input type="number" id="limit-price-${pos.id}" placeholder="Limit price" step="0.01" value="${formatPrice(pos.markPrice || pos.entryPrice)}" />
          <button class="btn btn-outline btn-sm" data-submit-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">Set</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach event handlers
  list.querySelectorAll('[data-market-close]').forEach(btn => {
    btn.addEventListener('click', () => marketClose(btn.dataset.marketClose, btn.dataset.symbol));
  });

  list.querySelectorAll('[data-toggle-limit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById(`limit-form-${btn.dataset.toggleLimit}`);
      if (form) form.classList.toggle('active');
    });
  });

  list.querySelectorAll('[data-submit-limit]').forEach(btn => {
    btn.addEventListener('click', () => submitLimitClose(btn.dataset.submitLimit));
  });


  // Click symbol name → navigate to trade page with that symbol
  list.querySelectorAll('.pos-sym-link[data-nav-symbol]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sym = el.dataset.navSymbol;
      if (sym) {
        localStorage.setItem('pms_last_symbol', sym);
        location.hash = '#/trade';
      }
    });
  });

  // Connect Binance markPrice WS for each unique position symbol
  connectMarkPriceStreams(positions);
}

function getTimeHeld(openedAt) {
  const ms = Date.now() - new Date(openedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// ── Close Actions ──────────────────────────────────

async function marketClose(positionId, symbol) {
  if (!(await cuteConfirm({ title: `Close ${symbol.split('/')[0]}?`, message: 'This will market close the position~', confirmText: 'Close', danger: true }))) return;

  try {
    const result = await api(`/trade/close/${positionId}`, { method: 'POST' });
    const pnl = result.trade?.realizedPnl || 0;
    showToast(`Closed ${symbol.split('/')[0]}. PnL: ${formatUsd(pnl)}`, pnl >= 0 ? 'success' : 'warning');
    loadPositions();
  } catch (err) {
    showToast(`${err.message}`, 'error');
  }
}

async function submitLimitClose(positionId) {
  const priceInput = document.getElementById(`limit-price-${positionId}`);
  const price = parseFloat(priceInput?.value);
  if (!price || price <= 0) return showToast('Enter a valid limit price', 'error');

  try {
    const result = await api(`/trade/limit-close/${positionId}`, {
      method: 'POST',
      body: { price },
    });
    if (result.success) {
      showToast(`Limit close set @ $${formatPrice(price)}`, 'success');
      const form = document.getElementById(`limit-form-${positionId}`);
      if (form) form.classList.remove('active');
    }
  } catch (err) {
    showToast(`${err.message}`, 'error');
  }
}

async function closeAllPositions() {
  if (!state.currentAccount) return;
  const count = positionsData.length;
  if (!(await cuteConfirm({ title: `Close All ${count} Position(s)?`, message: 'Every open position will be market closed~', confirmText: 'Close All', danger: true }))) return;

  showToast(`Closing ${count} position(s)...`, 'info');

  try {
    const result = await api(`/trade/close-all/${state.currentAccount}`, { method: 'POST' });
    const totalPnl = result.results?.reduce((s, r) => s + (r.pnl || 0), 0) || 0;
    showToast(`Closed ${result.closed}/${result.total}. Total PnL: ${formatUsd(totalPnl)}`, totalPnl >= 0 ? 'success' : 'warning');
    loadPositions();
  } catch (err) {
    showToast(`${err.message}`, 'error');
  }
}

// ── Save as Index ──────────────────────────────────

const LS_INDEXES_KEY = 'pms_indexes';

async function savePositionsAsIndex() {
  if (!positionsData || positionsData.length === 0) {
    showToast('No open positions to save', 'error');
    return;
  }

  // Build formula from current positions
  const merged = new Map();
  for (const p of positionsData) {
    const symbol = p.symbol;
    const factor = p.side === 'LONG' ? 1 : -1;
    const notional = p.notional || 0;
    const existing = merged.get(symbol);
    if (existing) {
      existing.notional += notional;
      existing.factor += factor;
    } else {
      merged.set(symbol, { symbol, factor, notional });
    }
  }

  // Normalize factors: largest |factor| = 1
  const legs = Array.from(merged.values()).filter(l => l.factor !== 0);
  if (legs.length === 0) {
    showToast('Positions cancel out — no net exposure to save', 'error');
    return;
  }

  const maxFactor = Math.max(...legs.map(l => Math.abs(l.factor)));
  const formula = legs.map(l => ({
    symbol: l.symbol,
    factor: parseFloat((l.factor / maxFactor).toFixed(4)),
  }));

  // Generate a default name from position symbols
  const bases = formula.map(l => l.symbol.split('/')[0]);
  const defaultName = bases.join('-') + ' basket';

  // Prompt for name
  const name = prompt('Index name:', defaultName);
  if (!name || !name.trim()) return;

  // Load existing indexes, add new one, save
  let indexes = [];
  try {
    const raw = localStorage.getItem(LS_INDEXES_KEY);
    if (raw) indexes = JSON.parse(raw);
  } catch { indexes = []; }

  const newIndex = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name.trim(),
    formula,
  };

  indexes.push(newIndex);

  try {
    localStorage.setItem(LS_INDEXES_KEY, JSON.stringify(indexes));
  } catch {
    showToast('Failed to save index to storage', 'error');
    return;
  }

  const legsDesc = formula.map(l => {
    const sign = l.factor >= 0 ? '+' : '';
    return `${sign}${l.factor}×${l.symbol.split('/')[0]}`;
  }).join(' ');

  showToast(`Index "${name.trim()}" saved! ${legsDesc}`, 'success');
}

// ── Live WebSocket PnL Updates ─────────────────────

function handlePnlUpdate(event) {
  const data = event.detail;
  if (!data) return;
  _lastWsPnlTs = Date.now();

  // Always update from server WS — it fires ~5/sec (bookTicker-driven)
  // Client-side Binance markPrice@1s will also update, whichever is newer wins

  // Keep local position cache in sync so aggregated cards can render accurate
  // pair-level liquidation and PnL in cross-margin mode.
  const cached = positionsData.find(p => p.id === data.positionId);
  if (cached) {
    cached.markPrice = data.markPrice;
    cached.unrealizedPnl = data.unrealizedPnl;
    cached.pnlPercent = data.pnlPercent;
    if (data.entryPrice != null) cached.entryPrice = data.entryPrice;
    if (data.quantity != null) cached.quantity = data.quantity;
    if (data.margin != null) cached.margin = data.margin;
    if (data.liquidationPrice != null) cached.liquidationPrice = data.liquidationPrice;
  }

  const card = document.querySelector(`.position-card[data-id="${data.positionId}"]`);
  if (!card) return;
  if (data.entryPrice != null) card.dataset.entry = data.entryPrice;
  if (data.quantity != null) card.dataset.qty = data.quantity;
  if (data.margin != null) card.dataset.margin = data.margin;

  const pnlEl = card.querySelector('.pos-pnl-value');
  if (pnlEl) {
    pnlEl.textContent = formatUsd(data.unrealizedPnl, 3);
    pnlEl.dataset.prevPnl = data.unrealizedPnl;

    const pnlContainer = pnlEl.closest('.position-pnl');
    if (pnlContainer) {
      pnlContainer.className = `position-pnl ${formatPnlClass(data.unrealizedPnl)}`;
      const pctSpan = pnlContainer.querySelector('span:last-child');
      if (pctSpan) pctSpan.textContent = `(${data.pnlPercent >= 0 ? '+' : ''}${Number(data.pnlPercent || 0).toFixed(2)}%)`;
    }
  }

  // Update mark price
  const markEl = card.querySelector('.pos-mark-price');
  if (markEl) {
    markEl.textContent = `$${formatPrice(data.markPrice)}`;
    markEl.style.color = (data.unrealizedPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const liqEl = card.querySelector(`[data-liq-id="${data.positionId}"]`);
  if (liqEl) {
    liqEl.textContent = data.liquidationPrice > 0 ? `$${formatPrice(data.liquidationPrice)}` : '—';
  }

  // Update global uPnL — aggregate all visible positions
  updateGlobalUpnl();
}

function handlePositionUpdated(event) {
  const d = event.detail;
  if (!d || !d.positionId) return;

  // Update cached position data
  let cached = positionsData.find(p => p.id === d.positionId);
  if (cached) {
    if (d.entryPrice != null) cached.entryPrice = d.entryPrice;
    if (d.quantity != null) cached.quantity = d.quantity;
    if (d.margin != null) cached.margin = d.margin;
    if (d.notional != null) cached.notional = d.notional;
    if (d.leverage != null) cached.leverage = d.leverage;
    if (d.liquidationPrice != null) cached.liquidationPrice = d.liquidationPrice;
  }

  // Update DOM in-place if card exists
  let card = document.querySelector(`.position-card[data-id="${d.positionId}"]`);

  // ── Optimistic creation: new position not yet in DOM ──
  if (!card && d.symbol && d.side && d.entryPrice != null) {
    if (!cached) {
      cached = {
        id: d.positionId, symbol: d.symbol, side: d.side,
        entryPrice: d.entryPrice, quantity: d.quantity || 0,
        margin: d.margin || 0, notional: d.notional || 0,
        leverage: d.leverage || 1, liquidationPrice: d.liquidationPrice || 0,
        markPrice: d.entryPrice, unrealizedPnl: 0, pnlPercent: 0,
        openedAt: new Date().toISOString(),
      };
      positionsData.push(cached);
    }

    const list = document.getElementById('positions-list');
    if (!list) return;
    // Clear empty-state if present
    if (list.querySelector('.empty-state-container, .cute-empty')) list.innerHTML = '';

    const pos = cached;
    const pnl = 0;
    const pnlPct = 0;
    const pnlClass = formatPnlClass(pnl);
    const elapsed = pos.openedAt ? getTimeHeld(pos.openedAt) : '—';
    const displayMarkPrice = pos.markPrice || pos.entryPrice;


    const tmp = document.createElement('div');
    tmp.innerHTML = `
      <div class="position-card" data-id="${pos.id}"
           data-symbol="${pos.symbol}" data-side="${pos.side}"
           data-entry="${pos.entryPrice}" data-qty="${pos.quantity}"
            data-margin="${pos.margin}">
        <div class="position-header">
          <div class="position-symbol">
            <span class="pos-sym-link" data-nav-symbol="${pos.symbol}" style="cursor:pointer;">${pos.symbol.split('/')[0]}</span>
            <span class="badge badge-${pos.side.toLowerCase()}">${pos.side}</span>
            <span style="font-size: 11px; color: var(--text-muted);">${pos.leverage}x</span>
            <span data-opened-at="${pos.openedAt || ''}" style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">⏱ ${elapsed}</span>
          </div>
          <div class="position-pnl ${pnlClass}">
            <span class="pos-pnl-value" data-pnl-id="${pos.id}" data-prev-pnl="${pnl}">${formatUsd(pnl, 3)}</span>
            <span style="font-size: 11px; margin-left: 4px;">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="position-details">
          <div>
            <div class="position-detail-label">Entry</div>
            <div class="position-detail-value">$${formatPrice(pos.entryPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Mark</div>
            <div class="position-detail-value pos-mark-price" data-mark-id="${pos.id}" style="color: var(--text-muted)">$${formatPrice(displayMarkPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Liquidation</div>
            <div class="position-detail-value" data-liq-id="${pos.id}" style="color: var(--red);">$${formatPrice(pos.liquidationPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Margin</div>
            <div class="position-detail-value">$${pos.margin.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Notional</div>
            <div class="position-detail-value">$${pos.notional.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Quantity</div>
            <div class="position-detail-value">${pos.quantity.toFixed(6)}</div>
          </div>
        </div>
        <div class="pos-action-row">
          <button class="btn btn-danger btn-sm" data-market-close="${pos.id}" data-symbol="${pos.symbol}">⬇ Market Close</button>
          <button class="btn btn-outline btn-sm" data-toggle-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">📊 Limit Close</button>
        </div>
        <div class="limit-close-form" id="limit-form-${pos.id}">
          <input type="number" id="limit-price-${pos.id}" placeholder="Limit price" step="0.01" value="${formatPrice(pos.entryPrice)}" />
          <button class="btn btn-outline btn-sm" data-submit-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">Set</button>
        </div>
      </div>
    `;

    const newCard = tmp.firstElementChild;
    list.prepend(newCard);

    // Attach event handlers to the new card
    newCard.querySelector('[data-market-close]')?.addEventListener('click', () =>
      marketClose(pos.id, pos.symbol));
    newCard.querySelector('[data-toggle-limit]')?.addEventListener('click', () => {
      const form = document.getElementById(`limit-form-${pos.id}`);
      if (form) form.classList.toggle('active');
    });
    newCard.querySelector('[data-submit-limit]')?.addEventListener('click', () =>
      submitLimitClose(pos.id));

    newCard.querySelector('.pos-sym-link[data-nav-symbol]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.setItem('pms_last_symbol', pos.symbol);
      location.hash = '#/trade';
    });

    // Update count & show action buttons
    const countEl = document.getElementById('position-count');
    if (countEl) countEl.textContent = positionsData.length;
    const closeAllBtn = document.getElementById('close-all-btn');
    if (closeAllBtn) closeAllBtn.style.display = '';
    const saveIdxBtn = document.getElementById('save-as-index-btn');
    if (saveIdxBtn) saveIdxBtn.style.display = '';

    // Connect mark price stream for new symbol
    connectMarkPriceStreams(positionsData);
    return;
  }

  if (!card) return;

  if (d.entryPrice != null) {
    card.dataset.entry = d.entryPrice;
    const entryEls = card.querySelectorAll('.position-detail-value');
    if (entryEls[0]) entryEls[0].textContent = `$${formatPrice(d.entryPrice)}`;
  }
  if (d.quantity != null) {
    card.dataset.qty = d.quantity;
    const qtyEls = card.querySelectorAll('.position-detail-value');
    if (qtyEls[5]) qtyEls[5].textContent = d.quantity.toFixed(6);
  }
  if (d.margin != null) {
    card.dataset.margin = d.margin;
    const marginEls = card.querySelectorAll('.position-detail-value');
    if (marginEls[3]) marginEls[3].textContent = `$${d.margin.toFixed(2)}`;
  }
  if (d.notional != null) {
    const notionalEls = card.querySelectorAll('.position-detail-value');
    if (notionalEls[4]) notionalEls[4].textContent = `$${d.notional.toFixed(2)}`;
  }
  if (d.liquidationPrice != null) {
    const liqEl = card.querySelector(`[data-liq-id="${d.positionId}"]`);
    if (liqEl) liqEl.textContent = d.liquidationPrice > 0 ? `$${formatPrice(d.liquidationPrice)}` : '—';
  }
}

function handleMarginUpdate(event) {
  const data = event.detail;
  if (!data) return;
  // Only update if it matches the current account
  if (state.currentAccount && data.subAccountId !== state.currentAccount) return;
  // Cache balance for live equity calculations
  _cachedBalance = data.balance || 0;
  _cachedMarginUsed = data.marginUsed || 0;
  renderSummary(data);
}

function updateGlobalUpnl() {
  const allPnlEls = document.querySelectorAll('[data-pnl-id]');
  let totalUpnl = 0;
  allPnlEls.forEach(el => {
    totalUpnl += parseFloat(el.dataset.prevPnl || '0');
  });

  const upnlEl = document.getElementById('total-upnl');
  if (upnlEl) {
    upnlEl.textContent = formatUsd(totalUpnl);
    upnlEl.className = `price-big ${formatPnlClass(totalUpnl)}`;
    upnlEl.style.fontSize = '20px';
  }

  // Live equity = cached balance + live total UPNL
  const equityEl = document.getElementById('total-equity');
  if (equityEl && _cachedBalance != null) {
    const liveEquity = _cachedBalance + totalUpnl;
    equityEl.textContent = `$${liveEquity.toFixed(2)}`;

    // Live available = equity - margin used
    const availEl = document.getElementById('stat-available');
    if (availEl) {
      const liveAvail = liveEquity - _cachedMarginUsed;
      availEl.textContent = `$${liveAvail.toFixed(2)}`;
    }
  }
}

// ── Client-Side Binance Mark Price Streams ─────────

function connectMarkPriceStreams(positions) {
  // Close any existing subscriptions for symbols no longer needed
  const neededSymbols = new Set(positions.map(p => p.symbol));
  for (const sym of Object.keys(markPriceUnsubs)) {
    if (!neededSymbols.has(sym)) {
      try { markPriceUnsubs[sym](); } catch { }
      delete markPriceUnsubs[sym];
    }
  }

  // Open new subscriptions for symbols we don't have yet
  for (const sym of neededSymbols) {
    if (markPriceUnsubs[sym]) continue; // already subscribed
    const raw = sym.replace('/', '').replace(':USDT', '').toLowerCase();
    const wsSymbol = raw.endsWith('usdt') ? raw : raw + 'usdt';

    markPriceUnsubs[sym] = streams.subscribe(`${wsSymbol}@markPrice@1s`, (data) => {
      if (cleanedUp) return;
      try {
        const markPrice = parseFloat(data.p);
        if (!markPrice || isNaN(markPrice)) return;
        latestMarkPrices[sym] = markPrice;
        recalcUpnlForSymbol(sym, markPrice);
      } catch { }
    });
  }
}

function recalcUpnlForSymbol(symbol, markPrice) {
  // Find all position cards for this symbol
  const cards = document.querySelectorAll(`.position-card[data-symbol="${symbol}"]`);
  cards.forEach(card => {
    const posId = card.dataset.id;
    const side = card.dataset.side;
    const entry = parseFloat(card.dataset.entry);
    const qty = parseFloat(card.dataset.qty);
    const margin = parseFloat(card.dataset.margin);
    if (!entry || !qty || !margin) return;

    const upnl = side === 'LONG'
      ? (markPrice - entry) * qty
      : (entry - markPrice) * qty;
    const pnlPct = margin > 0 ? (upnl / margin) * 100 : 0;

    // Update PnL value
    const pnlEl = card.querySelector(`[data-pnl-id="${posId}"]`);
    if (pnlEl) {
      const prev = parseFloat(pnlEl.dataset.prevPnl || '0');
      pnlEl.textContent = formatUsd(upnl, 3);
      pnlEl.dataset.prevPnl = upnl;



      // Update PnL container class + percent
      const pnlContainer = pnlEl.closest('.position-pnl');
      if (pnlContainer) {
        pnlContainer.className = `position-pnl ${formatPnlClass(upnl)}`;
        const pctSpan = pnlContainer.querySelector('span:last-child');
        if (pctSpan) pctSpan.textContent = `(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
      }
    }

    // Update mark price
    const markEl = card.querySelector(`[data-mark-id="${posId}"]`);
    if (markEl) {
      markEl.textContent = `$${formatPrice(markPrice)}`;
      markEl.style.color = upnl >= 0 ? 'var(--green)' : 'var(--red)';
    }
  });

  // Update global uPnL total
  updateGlobalUpnl();
}

// ── Cleanup ──────────────────────────────────────────

function cleanupListeners() {
  if (_listeners.pnl) window.removeEventListener('pnl_update', _listeners.pnl);
  if (_listeners.margin) window.removeEventListener('margin_update', _listeners.margin);
  if (_listeners.closed) window.removeEventListener('position_closed', _listeners.closed);
  if (_listeners.liquidation) window.removeEventListener('liquidation', _listeners.liquidation);
  if (_listeners.reduced) window.removeEventListener('position_reduced', _listeners.reduced);
  if (_listeners.filled) window.removeEventListener('order_filled', _listeners.filled);
  if (_listeners.positionUpdated) window.removeEventListener('position_updated', _listeners.positionUpdated);

}

export function cleanup() {
  cleanedUp = true;

  // Remove window event listeners
  cleanupListeners();

  // Unsubscribe all Binance stream subscriptions
  for (const sym of Object.keys(markPriceUnsubs)) {
    try { markPriceUnsubs[sym](); } catch { }
  }
  markPriceUnsubs = {};
  latestMarkPrices = {};

  // Clear intervals
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (timeHeldInterval) { clearInterval(timeHeldInterval); timeHeldInterval = null; }
}
