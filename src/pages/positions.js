// ── Positions Page (Orchestrator) ──
// HTML template, WS event wiring, mark-price streams, live PnL.
// Rendering and actions delegated to sub-modules:
//   positions/render.js  — renderPositionsList, renderSummary, handleBabysitterFeatures
//   positions/actions.js — market/limit close, close-all, babysitter toggle, save-as-index

import { state, api, showToast, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { streams } from '../lib/binance-streams.js';
import { cuteSpinner, cuteSleepyCat } from '../lib/cute-empty.js';

import { handleBabysitterFeatures, renderSummary as _renderSummary, renderPositionsList as _renderPositionsList, buildPositionCardHtml, getTimeHeld } from './positions/render.js';
import { marketClose, submitLimitClose, closeAllPositions, toggleBabysitterForPosition, savePositionsAsIndex } from './positions/actions.js';

let positionsData = [];

// --- Live update state ---
let markPriceUnsubs = {};
let latestMarkPrices = {};
let pollInterval = null;
let timeHeldInterval = null;
let cleanedUp = false;
let _lastWsPnlTs = 0;
let _cachedBalance = 0;
let _cachedMarginUsed = 0;
let _loadPositionsInFlight = false;
let _loadPositionsQueued = false;
let _loadPositionsTimer = null;
let _loadPositionsDueAt = 0;
let _upnlRefreshRaf = null;
let _positionsListClickBound = false;

const _listeners = {};

// ── Scheduling helpers ──────────────────────────────

function scheduleGlobalUpnlRefresh() {
  if (_upnlRefreshRaf != null) return;
  _upnlRefreshRaf = requestAnimationFrame(() => {
    _upnlRefreshRaf = null;
    updateGlobalUpnl();
  });
}

function scheduleLoadPositions(delayMs = 120) {
  if (cleanedUp) return;
  const waitMs = Math.max(0, delayMs);
  const dueAt = Date.now() + waitMs;

  if (_loadPositionsTimer) {
    if (dueAt >= _loadPositionsDueAt) return;
    clearTimeout(_loadPositionsTimer);
    _loadPositionsTimer = null;
  }

  _loadPositionsDueAt = dueAt;
  _loadPositionsTimer = setTimeout(() => {
    _loadPositionsTimer = null;
    _loadPositionsDueAt = 0;
    loadPositions();
  }, waitMs);
}

// ── Click delegation ────────────────────────────────

function handlePositionsListClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  const marketBtn = target.closest('[data-market-close]');
  if (marketBtn) {
    marketClose(marketBtn.dataset.marketClose, marketBtn.dataset.symbol, scheduleLoadPositions);
    return;
  }

  const toggleLimitBtn = target.closest('[data-toggle-limit]');
  if (toggleLimitBtn) {
    const form = document.getElementById(`limit-form-${toggleLimitBtn.dataset.toggleLimit}`);
    if (form) form.classList.toggle('active');
    return;
  }

  const submitLimitBtn = target.closest('[data-submit-limit]');
  if (submitLimitBtn) {
    submitLimitClose(submitLimitBtn.dataset.submitLimit);
    return;
  }

  const bbsBtn = target.closest('[data-bbs-toggle-pos]');
  if (bbsBtn) {
    e.stopPropagation();
    toggleBabysitterForPosition(bbsBtn.dataset.bbsTogglePos, bbsBtn.dataset.bbsExcluded === '1');
    return;
  }

  const symLink = target.closest('.pos-sym-link[data-nav-symbol]');
  if (symLink) {
    e.stopPropagation();
    const sym = symLink.dataset.navSymbol;
    if (sym) {
      localStorage.setItem('pms_last_symbol', sym);
      location.hash = '#/trade';
    }
  }
}

function bindPositionsListDelegates() {
  if (_positionsListClickBound) return;
  const list = document.getElementById('positions-list');
  if (!list) return;
  list.addEventListener('click', handlePositionsListClick);
  _positionsListClickBound = true;
}

// ── Main page render ────────────────────────────────

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

      <div class="bbs-log-console" id="bbs-log-console" style="display:none;">
        <div class="bbs-log-header" id="bbs-log-toggle">
          <span>🤖 Babysitter Log</span>
          <span id="bbs-log-arrow">▸</span>
        </div>
        <div class="bbs-log-body" id="bbs-log-body"></div>
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
      .bbs-symbol-toggle { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-secondary); border-radius: 999px; font-size: 10px; font-weight: 600; padding: 2px 8px; cursor: pointer; margin-left: 2px; }
      .bbs-symbol-toggle.on { border-color: rgba(34, 197, 94, 0.45); color: var(--green); background: rgba(34, 197, 94, 0.10); }
      .bbs-symbol-toggle.off { border-color: rgba(239, 68, 68, 0.45); color: var(--red); background: rgba(239, 68, 68, 0.08); }
      .bbs-symbol-toggle:disabled { opacity: 0.45; cursor: not-allowed; }
      .bbs-features-row { display: none; margin-top: 6px; padding: 6px 8px; background: rgba(139, 92, 246, 0.06); border: 1px solid rgba(139, 92, 246, 0.15); border-radius: 8px; font-size: 11px; gap: 6px; flex-wrap: wrap; align-items: center; }
      .bbs-features-row.active { display: flex; }
      .bbs-feat-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 999px; background: var(--surface-2); color: var(--text-secondary); font-size: 10px; font-weight: 600; white-space: nowrap; }
      .bbs-feat-chip.gate-ready { background: rgba(34,197,94,0.12); color: var(--green); }
      .bbs-feat-chip.gate-below_target { background: rgba(250,204,21,0.12); color: #eab308; }
      .bbs-feat-chip.gate-cooldown { background: rgba(59,130,246,0.12); color: #3b82f6; }
      .bbs-feat-chip.gate-pending_close { background: rgba(168,85,247,0.12); color: #a855f7; }
      .bbs-feat-chip.gate-excluded { background: rgba(239,68,68,0.08); color: var(--red); }
      .bbs-feat-chip.gate-no_mark_price { background: rgba(107,114,128,0.12); color: #6b7280; }
      .bbs-progress-bar { width: 60px; height: 5px; background: var(--surface-3); border-radius: 3px; overflow: hidden; display: inline-block; vertical-align: middle; }
      .bbs-progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; background: var(--accent); }
      .bbs-log-console { margin-top: 16px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .bbs-log-header { padding: 8px 12px; background: var(--surface-1); font-size: 12px; font-weight: 700; color: var(--text-secondary); cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
      .bbs-log-body { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; background: var(--surface-0); }
      .bbs-log-body.open { max-height: 250px; overflow-y: auto; }
      .bbs-log-line { padding: 3px 12px; font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bbs-log-line .gate-tag { font-weight: 700; }
    </style>
  `;

  document.getElementById('close-all-btn')?.addEventListener('click', () => closeAllPositions(positionsData, scheduleLoadPositions));
  document.getElementById('save-as-index-btn')?.addEventListener('click', () => savePositionsAsIndex(positionsData));

  cleanedUp = false;
  cleanupListeners();
  bindPositionsListDelegates();
  loadPositions();

  // Register WS event listeners
  _listeners.pnl = handlePnlUpdate;
  _listeners.margin = handleMarginUpdate;
  _listeners.closed = (e) => {
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
      scheduleGlobalUpnlRefresh();
    }
    scheduleLoadPositions(120);
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
      scheduleGlobalUpnlRefresh();
    }
    scheduleLoadPositions(120);
  };
  _listeners.reduced = () => scheduleLoadPositions(120);
  _listeners.filled = () => scheduleLoadPositions(2000);
  _listeners.positionUpdated = handlePositionUpdated;
  _listeners.babysitterFeatures = handleBabysitterFeatures;
  _listeners.positionsResync = () => scheduleLoadPositions(50);
  _listeners.tradeExecution = () => scheduleLoadPositions(1500);

  window.addEventListener('pnl_update', _listeners.pnl);
  window.addEventListener('margin_update', _listeners.margin);
  window.addEventListener('position_closed', _listeners.closed);
  window.addEventListener('liquidation', _listeners.liquidation);
  window.addEventListener('position_reduced', _listeners.reduced);
  window.addEventListener('order_filled', _listeners.filled);
  window.addEventListener('position_updated', _listeners.positionUpdated);
  window.addEventListener('babysitter_features', _listeners.babysitterFeatures);
  window.addEventListener('positions_resync', _listeners.positionsResync);
  window.addEventListener('trade_execution', _listeners.tradeExecution);

  // Babysitter log toggle
  document.getElementById('bbs-log-toggle')?.addEventListener('click', () => {
    const body = document.getElementById('bbs-log-body');
    const arrow = document.getElementById('bbs-log-arrow');
    if (body) body.classList.toggle('open');
    if (arrow) arrow.textContent = body?.classList.contains('open') ? '▾' : '▸';
  });

  // REST polling fallback
  pollInterval = setInterval(() => {
    if (!cleanedUp && Date.now() - _lastWsPnlTs > 15000) scheduleLoadPositions(0);
  }, 10000);

  // Live time-held ticker
  timeHeldInterval = setInterval(() => {
    if (cleanedUp) return;
    document.querySelectorAll('[data-opened-at]').forEach(el => {
      el.textContent = `⏱ ${getTimeHeld(el.dataset.openedAt)}`;
    });
  }, 30000);
}

// ── Data loading ────────────────────────────────────

async function loadPositions() {
  if (cleanedUp) return;
  if (_loadPositionsInFlight) {
    _loadPositionsQueued = true;
    return;
  }

  const accountId = state.currentAccount;
  if (!accountId) {
    const list = document.getElementById('positions-list');
    if (list) list.innerHTML = `
      <div class="empty-state">
        <h3>No Account Selected</h3>
        <p>Go to Trade tab to select an account</p>
      </div>
    `;
    return;
  }

  _loadPositionsInFlight = true;
  try {
    const data = await api(`/trade/positions/${accountId}`);
    if (cleanedUp || accountId !== state.currentAccount) return;

    positionsData = data.positions || [];
    _renderSummary(data.summary, {
      cachedBalance: _cachedBalance,
      cachedMarginUsed: _cachedMarginUsed,
      latestMarkPrices,
      setCachedBalance: v => { _cachedBalance = v; },
      setCachedMarginUsed: v => { _cachedMarginUsed = v; },
    });
    _renderPositionsList(positionsData, latestMarkPrices);

    const closeAllBtn = document.getElementById('close-all-btn');
    if (closeAllBtn) closeAllBtn.style.display = positionsData.length > 0 ? '' : 'none';
    const saveIdxBtn = document.getElementById('save-as-index-btn');
    if (saveIdxBtn) saveIdxBtn.style.display = positionsData.length > 0 ? '' : 'none';

    // Connect mark streams after rendering
    connectMarkPriceStreams(positionsData);
  } catch (err) {
    if (!cleanedUp) console.error('Failed to load positions:', err);
  } finally {
    _loadPositionsInFlight = false;
    if (_loadPositionsQueued && !cleanedUp) {
      _loadPositionsQueued = false;
      loadPositions();
    }
  }
}

// ── WS PnL handler ──────────────────────────────────

function handlePnlUpdate(event) {
  const data = event.detail;
  if (!data) return;
  _lastWsPnlTs = Date.now();

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

  const markEl = card.querySelector('.pos-mark-price');
  if (markEl) {
    markEl.textContent = `$${formatPrice(data.markPrice)}`;
    markEl.style.color = (data.unrealizedPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const liqEl = card.querySelector(`[data-liq-id="${data.positionId}"]`);
  if (liqEl) {
    liqEl.textContent = data.liquidationPrice > 0 ? `$${formatPrice(data.liquidationPrice)}` : '—';
  }

  scheduleGlobalUpnlRefresh();
}

// ── Position updated handler ────────────────────────

function handlePositionUpdated(event) {
  const d = event.detail;
  if (!d || !d.positionId) return;

  let cached = positionsData.find(p => p.id === d.positionId);
  if (cached) {
    if (d.entryPrice != null) cached.entryPrice = d.entryPrice;
    if (d.quantity != null) cached.quantity = d.quantity;
    if (d.margin != null) cached.margin = d.margin;
    if (d.notional != null) cached.notional = d.notional;
    if (d.leverage != null) cached.leverage = d.leverage;
    if (d.liquidationPrice != null) cached.liquidationPrice = d.liquidationPrice;
  }

  let card = document.querySelector(`.position-card[data-id="${d.positionId}"]`);

  // Optimistic creation for new positions
  if (!card && d.symbol && d.side && d.entryPrice != null) {
    if (!cached) {
      cached = {
        id: d.positionId, symbol: d.symbol, side: d.side,
        entryPrice: d.entryPrice, quantity: d.quantity || 0,
        margin: d.margin || 0, notional: d.notional || 0,
        leverage: d.leverage || 1, liquidationPrice: d.liquidationPrice || 0,
        markPrice: d.entryPrice, unrealizedPnl: 0, pnlPercent: 0,
        openedAt: new Date().toISOString(), babysitterExcluded: d.babysitterExcluded ?? false,
      };
      positionsData.push(cached);
    }

    const list = document.getElementById('positions-list');
    if (!list) return;
    if (list.querySelector('.empty-state-container, .cute-empty')) list.innerHTML = '';

    const tmp = document.createElement('div');
    tmp.innerHTML = buildPositionCardHtml(cached);
    const newCard = tmp.firstElementChild;
    list.prepend(newCard);

    const countEl = document.getElementById('position-count');
    if (countEl) countEl.textContent = positionsData.length;
    const closeAllBtn = document.getElementById('close-all-btn');
    if (closeAllBtn) closeAllBtn.style.display = '';
    const saveIdxBtn = document.getElementById('save-as-index-btn');
    if (saveIdxBtn) saveIdxBtn.style.display = '';

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

// ── Margin handler ──────────────────────────────────

function handleMarginUpdate(event) {
  const data = event.detail;
  if (!data) return;
  if (state.currentAccount && data.subAccountId !== state.currentAccount) return;
  _cachedBalance = data.balance || 0;
  _cachedMarginUsed = data.marginUsed || 0;
  _renderSummary(data, {
    cachedBalance: _cachedBalance,
    cachedMarginUsed: _cachedMarginUsed,
    latestMarkPrices,
    setCachedBalance: v => { _cachedBalance = v; },
    setCachedMarginUsed: v => { _cachedMarginUsed = v; },
  });
}

// ── Global UPNL aggregation ─────────────────────────

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

  const equityEl = document.getElementById('total-equity');
  if (equityEl && _cachedBalance != null) {
    const liveEquity = _cachedBalance + totalUpnl;
    equityEl.textContent = `$${liveEquity.toFixed(2)}`;

    const availEl = document.getElementById('stat-available');
    if (availEl) {
      const liveAvail = liveEquity - _cachedMarginUsed;
      availEl.textContent = `$${liveAvail.toFixed(2)}`;
    }
  }
}

// ── Client-Side Binance Mark Price Streams ──────────

function connectMarkPriceStreams(positions) {
  const neededSymbols = new Set(positions.map(p => p.symbol));
  for (const sym of Object.keys(markPriceUnsubs)) {
    if (!neededSymbols.has(sym)) {
      try { markPriceUnsubs[sym](); } catch { }
      delete markPriceUnsubs[sym];
    }
  }

  for (const sym of neededSymbols) {
    if (markPriceUnsubs[sym]) continue;
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

    const pnlEl = card.querySelector(`[data-pnl-id="${posId}"]`);
    if (pnlEl) {
      pnlEl.textContent = formatUsd(upnl, 3);
      pnlEl.dataset.prevPnl = upnl;

      const pnlContainer = pnlEl.closest('.position-pnl');
      if (pnlContainer) {
        pnlContainer.className = `position-pnl ${formatPnlClass(upnl)}`;
        const pctSpan = pnlContainer.querySelector('span:last-child');
        if (pctSpan) pctSpan.textContent = `(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
      }
    }

    const markEl = card.querySelector(`[data-mark-id="${posId}"]`);
    if (markEl) {
      markEl.textContent = `$${formatPrice(markPrice)}`;
      markEl.style.color = upnl >= 0 ? 'var(--green)' : 'var(--red)';
    }
  });

  scheduleGlobalUpnlRefresh();
}

// ── Cleanup ─────────────────────────────────────────

function cleanupListeners() {
  if (_listeners.pnl) window.removeEventListener('pnl_update', _listeners.pnl);
  if (_listeners.margin) window.removeEventListener('margin_update', _listeners.margin);
  if (_listeners.closed) window.removeEventListener('position_closed', _listeners.closed);
  if (_listeners.liquidation) window.removeEventListener('liquidation', _listeners.liquidation);
  if (_listeners.reduced) window.removeEventListener('position_reduced', _listeners.reduced);
  if (_listeners.filled) window.removeEventListener('order_filled', _listeners.filled);
  if (_listeners.positionUpdated) window.removeEventListener('position_updated', _listeners.positionUpdated);
  if (_listeners.babysitterFeatures) window.removeEventListener('babysitter_features', _listeners.babysitterFeatures);
  if (_listeners.positionsResync) window.removeEventListener('positions_resync', _listeners.positionsResync);
  if (_listeners.tradeExecution) window.removeEventListener('trade_execution', _listeners.tradeExecution);
}

export function cleanup() {
  cleanedUp = true;
  cleanupListeners();

  for (const sym of Object.keys(markPriceUnsubs)) {
    try { markPriceUnsubs[sym](); } catch { }
  }
  markPriceUnsubs = {};
  latestMarkPrices = {};

  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (timeHeldInterval) { clearInterval(timeHeldInterval); timeHeldInterval = null; }
  if (_loadPositionsTimer) { clearTimeout(_loadPositionsTimer); _loadPositionsTimer = null; }
  const list = document.getElementById('positions-list');
  if (list && _positionsListClickBound) list.removeEventListener('click', handlePositionsListClick);
  _positionsListClickBound = false;
  if (_upnlRefreshRaf != null) { cancelAnimationFrame(_upnlRefreshRaf); _upnlRefreshRaf = null; }
  _loadPositionsDueAt = 0;
  _loadPositionsInFlight = false;
  _loadPositionsQueued = false;
}
