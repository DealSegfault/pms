// ── Trading Page – Order Form Logic ──────────────────────────
import { state, api, showToast, formatPrice, formatUsd } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { cuteKittenSearch, cuteWallet } from '../../lib/cute-empty.js';
import * as S from './state.js';
import { formatQty } from './orderbook.js';
import { initChart, fetchTickerData, fetchSymbolInfo } from './chart.js';
import { clearScalePreviewLines, removeScaleBoundaryLines, teardownScaleDragHandlers, updateTwapPreview } from './scale-orders.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { beginOrderLatency, markOrderSent, markOrderAck, markOrderPaint } from './perf-metrics.js';

// ── Side / Leverage / Size ──────────────────────

export function setSide(side) {
    S.set('selectedSide', side);
    localStorage.setItem('pms_trade_side', side);
    document.getElementById('btn-long').className = side === 'LONG' ? 'active-long' : '';
    document.getElementById('btn-neutral').className = side === 'NEUTRAL' ? 'active-neutral' : '';
    document.getElementById('btn-short').className = side === 'SHORT' ? 'active-short' : '';
    const btn = document.getElementById('submit-trade');
    if (btn) {
        if (S.orderType === 'TRAIL') {
            // Don't change trail button on side toggle
        } else if (S.orderType === 'CHASE') {
            // Don't change chase button on side toggle
        } else {
            btn.className = `btn-submit btn-submit-${side.toLowerCase()}`;
            btn.textContent = side === 'LONG' ? 'Buy / Long' : 'Sell / Short';
            btn.style.background = '';
            btn.style.color = '';
        }
    }
    // Update TWAP price limit label/hint for current side
    const plLabel = document.getElementById('twap-price-limit-label');
    if (plLabel) plLabel.textContent = side === 'SHORT' ? 'Min Sell Price' : 'Max Buy Price';
    const plHint = document.getElementById('twap-price-limit-hint');
    if (plHint) plHint.textContent = side === 'SHORT' ? 'TWAP will skip lots if price drops below this' : 'TWAP will skip lots if price rises above this';
    updatePreview();
}

export function setLeverage(val) {
    S.set('leverage', Math.max(1, Math.min(125, parseInt(val) || 1)));
    // update inline button label
    const levBtn = document.getElementById('lev-btn');
    if (levBtn) levBtn.textContent = `${S.leverage}×`;
    // highlight active preset in dropdown
    document.querySelectorAll('#lev-presets button').forEach(b => {
        const isActive = parseInt(b.dataset.lev) === S.leverage;
        b.style.background = isActive ? 'var(--accent)' : 'var(--surface-2)';
        b.style.color = isActive ? 'white' : 'var(--text)';
        b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
    // persist per-instrument
    S.leverageMap[S.selectedSymbol] = S.leverage;
    try { localStorage.setItem('pms_leverage_map', JSON.stringify(S.leverageMap)); } catch { }
    updatePreview();
    // re-sync slider notional
    setSizePercent(S.sizePercent);
}

export function setSizePercent(pct) {
    const availBal = S.cachedMarginInfo?.availableMargin;
    if (availBal != null && availBal < 0) {
        S.set('sizePercent', 0);
        return;
    }

    S.set('sizePercent', Math.max(0, Math.min(100, pct)));

    const fill = document.getElementById('size-slider-fill');
    if (fill) fill.style.width = `${S.sizePercent}%`;
    const label = document.getElementById('size-pct-label');
    if (label) label.textContent = `${S.sizePercent}%`;

    document.querySelectorAll('.slider-diamond').forEach(d => {
        d.classList.toggle('active', parseInt(d.dataset.pct) <= S.sizePercent);
    });

    if (!state.currentAccount) return;
    const available = S.cachedMarginInfo?.availableMargin || 0;
    const maxNotionalRule = S.cachedMarginInfo?.rules?.maxNotionalPerTrade || Infinity;
    const maxNotional = Math.min(available * S.leverage, maxNotionalRule);
    const notional = maxNotional * (S.sizePercent / 100);

    const input = document.getElementById('trade-size');
    if (input) input.value = notional.toFixed(2);

    const buyLabel = document.getElementById('size-buy-label');
    const sellLabel = document.getElementById('size-sell-label');
    if (buyLabel) buyLabel.textContent = `Buy ${notional.toFixed(2)} USDT`;
    if (sellLabel) sellLabel.textContent = `Sell ${notional.toFixed(2)} USDT`;

    updatePreview();
    if (S.orderType === 'SCALPER') {
        import('./scalper.js').then(m => m.updateScalperPreview());
    }
}

export function updatePreview() {
    const notional = parseFloat(document.getElementById('trade-size')?.value);
    const preview = document.getElementById('order-preview');
    if (!notional || notional <= 0 || !S.currentPrice) {
        if (preview) preview.style.display = 'none';
        return;
    }
    if (preview) preview.style.display = 'block';

    const margin = notional / S.leverage;
    const qty = notional / S.currentPrice;
    const el = (id) => document.getElementById(id);
    el('prev-notional').textContent = `$${notional.toFixed(2)}`;

    const minRow = document.getElementById('prev-min-row');
    if (S.symbolInfo?.minNotional && minRow) {
        minRow.style.display = '';
        el('prev-min').textContent = `$${S.symbolInfo.minNotional}`;
    }

    const account = state.accounts.find(a => a.id === state.currentAccount);
    const balance = account?.currentBalance || margin;
    const maintenanceRate = 0.005;
    const liqThreshold = 0.90;
    const mm = notional * maintenanceRate;
    const equityFloor = mm / liqThreshold;
    const maxLoss = balance - equityFloor;
    let liqPrice = S.selectedSide === 'LONG'
        ? S.currentPrice - (maxLoss / qty)
        : S.currentPrice + (maxLoss / qty);
    if (liqPrice < 0) liqPrice = 0;
    el('prev-liq').textContent = `$${formatPrice(liqPrice)}`;
}

// ── Error Handling ──────────────────────────────

export function showTradeError(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
        showToast('Trade rejected — unknown reason', 'error');
        return;
    }
    for (const err of errors) {
        const icon = S.ERROR_ICONS[err.code] || '❌';
        const msg = err.message || err;
        showToast(`${icon} ${msg}`, 'error');
    }
}

// ── Trade Submission ────────────────────────────

export async function submitTrade() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    if (S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }
    const sizeUsd = parseFloat(document.getElementById('trade-size')?.value);
    if (!sizeUsd || sizeUsd <= 0) return showToast('Enter a valid size', 'error');
    if (!S.currentPrice) return showToast('Waiting for price...', 'warning');

    const notional = sizeUsd;
    const quantity = notional / S.currentPrice;

    const minNotional = S.symbolInfo?.minNotional || 5;
    if (notional < minNotional) {
        showToast(`Min order is $${minNotional} notional. You entered $${notional.toFixed(2)}`, 'error');
        return;
    }

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
    const latencyId = beginOrderLatency('market');

    try {
        markOrderSent(latencyId);
        const reduceOnly = document.getElementById('reduce-only-toggle')?.checked ?? false;
        const result = await api('/trade', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side: S.selectedSide,
                quantity,
                leverage: S.leverage,
                fastExecution: true,
                fallbackPrice: S.currentPrice,
                ...(reduceOnly ? { reduceOnly: true } : {}),
            },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.success) {
            showToast(`${S.selectedSide} ${S.selectedSymbol.split('/')[0]} opened`, 'success');
            document.getElementById('trade-size').value = '';
            document.getElementById('order-preview').style.display = 'none';
            const slider = document.getElementById('size-slider');
            if (slider) slider.value = 0;
            setSizePercent(0);
        }
        refreshAccountsInBackground();
        scheduleTradingRefresh({
            positions: true,
            account: true,
            annotations: true,
            forceAnnotations: true,
        }, 40);
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Trade failed'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'; }
    }
}

export async function submitLimitOrder() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    if (S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }
    const sizeUsd = parseFloat(document.getElementById('trade-size')?.value);
    if (!sizeUsd || sizeUsd <= 0) return showToast('Enter a valid size', 'error');

    const limitPrice = parseFloat(document.getElementById('limit-price')?.value);
    if (!limitPrice || limitPrice <= 0) return showToast('Enter a valid limit price', 'error');

    const notional = sizeUsd;
    const quantity = notional / limitPrice;

    const minNotional = S.symbolInfo?.minNotional || 5;
    if (notional < minNotional) {
        showToast(`Min order is $${minNotional} notional. You entered $${notional.toFixed(2)}`, 'error');
        return;
    }

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
    const latencyId = beginOrderLatency('limit');

    try {
        markOrderSent(latencyId);
        const reduceOnly = document.getElementById('reduce-only-toggle')?.checked ?? false;
        const result = await api('/trade/limit', {
            method: 'POST',
            body: { subAccountId: state.currentAccount, symbol: S.selectedSymbol, side: S.selectedSide, quantity, price: limitPrice, leverage: S.leverage, ...(reduceOnly ? { reduceOnly: true } : {}) },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.success) {
            showToast(`Limit ${S.selectedSide} ${S.selectedSymbol.split('/')[0]} @ $${formatPrice(limitPrice)}`, 'success');
            document.getElementById('trade-size').value = '';
            document.getElementById('limit-price').value = '';
            document.getElementById('order-preview').style.display = 'none';
            scheduleTradingRefresh({
                openOrders: true,
                annotations: true,
                forceAnnotations: true,
            }, 40);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Limit order failed'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'; }
    }
}

// ── Order Type ──────────────────────────────────

export function setOrderType(type) {
    // If user manually changes order type, clear any pending edit mode
    if (S._editState && S._editState.type !== type) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.()).catch(() => { });
    }

    S.set('orderType', type);
    localStorage.setItem('pms_trade_order_type', type);

    // Sync the custom dropdown trigger
    const LABELS = { MARKET: 'Market', LIMIT: 'Limit', SCALE: 'Scale', TWAP: 'TWAP', TRAIL: 'Trail Stop', CHASE: 'Chase', SCALPER: 'Scalper' };
    const ICONS = { MARKET: '⚡', LIMIT: '📌', SCALE: '📊', TWAP: '⏱️', TRAIL: '🛡️', CHASE: '🎯', SCALPER: '⚔️' };
    const labelEl = document.getElementById('ot-selected-label');
    const iconEl = document.getElementById('ot-selected-icon');
    if (labelEl) labelEl.textContent = LABELS[type] || type;
    if (iconEl) iconEl.textContent = ICONS[type] || '⚡';
    document.querySelectorAll('#ot-menu .ot-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.type === type);
    });

    const priceGroup = document.getElementById('limit-price-group');
    const scaleControls = document.getElementById('scale-controls');
    const twapControls = document.getElementById('twap-controls');
    const trailControls = document.getElementById('trail-stop-controls');
    const chaseControls = document.getElementById('chase-controls');
    const scalperControls = document.getElementById('scalper-controls');

    if (priceGroup) priceGroup.style.display = type === 'LIMIT' ? '' : 'none';
    if (type === 'LIMIT') {
        const priceInput = document.getElementById('limit-price');
        if (priceInput && S.currentPrice) priceInput.value = formatPrice(S.currentPrice);
    }

    // Show/hide Neutral button — only for SCALPER
    const btnNeutral = document.getElementById('btn-neutral');
    if (btnNeutral) btnNeutral.style.display = type === 'SCALPER' ? '' : 'none';
    // If entering SCALPER, fire event so index.js can sync mode button state
    if (type === 'SCALPER') document.dispatchEvent(new CustomEvent('scalper-active'));
    // If we're leaving SCALPER and current side is NEUTRAL, snap back to LONG
    if (type !== 'SCALPER' && S.selectedSide === 'NEUTRAL') setSide('LONG');

    if (scaleControls) scaleControls.style.display = type === 'SCALE' ? '' : 'none';

    if (twapControls) twapControls.style.display = type === 'TWAP' ? '' : 'none';
    if (type === 'TWAP') updateTwapPreview();

    if (trailControls) trailControls.style.display = type === 'TRAIL' ? '' : 'none';
    if (chaseControls) chaseControls.style.display = type === 'CHASE' ? '' : 'none';
    if (scalperControls) scalperControls.style.display = type === 'SCALPER' ? '' : 'none';

    // TRAIL hides everything.
    const hideControls = type === 'TRAIL';
    const hideSizeOnly = false;
    const sideToggle = document.querySelector('.side-toggle-mini');
    const sizeGroup = document.getElementById('size-slider-track')?.parentElement;
    const tradeSizeInput = document.getElementById('trade-size')?.parentElement;
    const orderPreview = document.getElementById('order-preview');
    const submitBtn = document.getElementById('submit-trade');
    const reduceOnlyGroup = document.getElementById('reduce-only-toggle-group');
    if (reduceOnlyGroup) reduceOnlyGroup.style.display = (hideControls || hideSizeOnly || type === 'SCALPER') ? 'none' : '';
    if (sideToggle) sideToggle.style.display = hideControls ? 'none' : '';
    if (sizeGroup) sizeGroup.style.display = (hideControls || hideSizeOnly) ? 'none' : '';
    if (tradeSizeInput) tradeSizeInput.style.display = (hideControls || hideSizeOnly) ? 'none' : '';
    if (orderPreview && (hideControls || hideSizeOnly)) orderPreview.style.display = 'none';
    if (submitBtn) {
        if (type === 'TRAIL') {
            submitBtn.textContent = '⚡ Set Trail Stop';
            submitBtn.className = 'btn-submit';
            submitBtn.style.background = '#f59e0b';
            submitBtn.style.color = '#000';
        } else if (type === 'CHASE') {
            submitBtn.textContent = '🎯 Start Chase';
            submitBtn.className = 'btn-submit';
            submitBtn.style.background = '#06b6d4';
            submitBtn.style.color = '#000';
        } else if (type === 'SCALPER') {
            submitBtn.textContent = '⚔️ Start Scalper';
            submitBtn.className = 'btn-submit';
            submitBtn.style.background = 'linear-gradient(90deg, #06b6d4 0%, #f97316 100%)';
            submitBtn.style.color = '#000';
        } else {
            submitBtn.textContent = S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short';
            submitBtn.className = `btn-submit btn-submit-${S.selectedSide.toLowerCase()}`;
            submitBtn.style.background = '';
            submitBtn.style.color = '';
        }
    }

    if (type === 'TRAIL') {
        import('./trail-stop.js').then(m => {
            m.refreshTrailPositionDropdown();
            m.updateTrailPreview();
        });
    }

    if (type === 'CHASE') {
        import('./chase-limit.js').then(m => {
            m.updateChasePreview();
        });
    }


    if (type === 'SCALPER') {
        import('./scalper.js').then(m => {
            m.updateScalperPreview();
        });
    }

    if (type !== 'SCALE') {
        clearScalePreviewLines();
        removeScaleBoundaryLines();
        teardownScaleDragHandlers();
        if (S.scaleMode && S.chart && S._scaleClickHandler) {
            S.chart.unsubscribeClick(S._scaleClickHandler);
            S.set('_scaleClickHandler', null);
        }
        if (S.chart) S.chart.applyOptions({ handleScroll: true, handleScale: true });
        S.set('scaleMode', false);
    }

    if (type !== 'TRAIL') {
        // Clear trail stop preview lines when leaving Trail tab
        import('./trail-stop.js').then(m => m.clearAllTrailStopLines()).catch(() => { });
    }

    if (type !== 'CHASE') {
        import('./chase-limit.js').then(m => m.clearAllChaseLines()).catch(() => { });
    }

}

// ── Symbol Picker ───────────────────────────────

export async function prefetchSymbolsList() {
    const cached = S.getCachedSymbols();
    if (cached) return;
    try {
        const symbols = await api('/trade/symbols/all');
        if (Array.isArray(symbols) && symbols.length > 0) {
            S.setCachedSymbols(symbols);
        }
    } catch { }
}

export function showSymbolPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.alignItems = 'flex-start';
    overlay.style.paddingTop = '40px';
    overlay.innerHTML = `
    <div class="modal-content" style="max-height: 80vh; display: flex; flex-direction: column;">
      <div class="modal-header">
        <span class="modal-title">Select Symbol</span>
        <button class="modal-close">×</button>
      </div>
      <input class="search-input" id="symbol-search" placeholder="Search symbol..." autofocus />
      <div class="symbol-list-header" style="display:flex; justify-content:space-between; padding:6px 12px; font-size:11px; color:var(--text-muted); border-bottom:1px solid var(--border); cursor:pointer; user-select:none;">
        <span data-sort="name" style="flex:2;">Name ↕</span>
        <span data-sort="price" style="flex:1.5; text-align:right;">Price ↕</span>
        <span data-sort="change24h" style="flex:1; text-align:right;">24h% ↕</span>
        <span data-sort="volume24h" style="flex:1; text-align:right;">Volume ↕</span>
        <span data-sort="fundingRate" style="flex:1; text-align:right;">Funding ↕</span>
      </div>
      <div class="symbol-list" id="symbol-results" style="overflow-y:auto; flex:1; max-height:60vh;"></div>
    </div>
  `;

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);

    let allTickers = [];
    let currentSort = { key: 'change24h', dir: -1 };

    overlay.querySelectorAll('[data-sort]').forEach(el => {
        el.addEventListener('click', () => {
            const key = el.dataset.sort;
            if (currentSort.key === key) currentSort.dir *= -1;
            else currentSort = { key, dir: key === 'name' ? 1 : -1 };
            const q = document.getElementById('symbol-search')?.value?.trim() || '';
            renderTickerResults(filterSymbols(allTickers, q), q);
        });
    });

    loadTickerResults();

    async function loadTickerResults() {
        try {
            allTickers = await api('/trade/symbols/tickers');
            sortTickers(allTickers);
            renderTickerResults(allTickers, '');
        } catch (err) {
            try {
                const basics = await api('/trade/symbols/all');
                allTickers = basics.map(s => ({ ...s, price: 0, change24h: 0, volume24h: 0, fundingRate: 0 }));
                sortTickers(allTickers);
                renderTickerResults(allTickers, '');
            } catch {
                const list = document.getElementById('symbol-results');
                if (list) list.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">Failed to load symbols</div>';
            }
        }
    }

    function filterSymbols(list, q) {
        if (!q) return [...list];
        const lower = q.toLowerCase();
        return list.filter(s =>
            s.base.toLowerCase().includes(lower) || s.symbol.toLowerCase().includes(lower)
        );
    }

    function sortTickers(list) {
        list.sort((a, b) => {
            if (currentSort.key === 'name') return currentSort.dir * a.base.localeCompare(b.base);
            return currentSort.dir * ((a[currentSort.key] || 0) - (b[currentSort.key] || 0));
        });
    }

    function renderTickerResults(results, query) {
        const list = document.getElementById('symbol-results');
        if (!list) return;
        sortTickers(results);

        // Build a map of symbols with active positions → side
        const tradedMap = new Map();
        for (const [, pos] of S._positionMap) {
            tradedMap.set(pos.symbol, pos.side);
        }

        // TradFi asset classification
        const EQUITIES = new Set(['TSLA', 'AMZN', 'COIN', 'CRCL', 'HOOD', 'INTC', 'MSTR', 'PLTR']);
        const COMMODITIES = new Set(['XAU', 'XAG', 'XPD', 'XPT']);

        list.innerHTML = results.map(s => {
            const chgColor = s.change24h >= 0 ? 'var(--green)' : 'var(--red)';
            const fundColor = s.fundingRate >= 0 ? 'var(--green)' : 'var(--red)';
            const vol = s.volume24h || 0;
            const volStr = vol >= 1e9 ? `${(vol / 1e9).toFixed(1)}B` : vol >= 1e6 ? `${(vol / 1e6).toFixed(1)}M` : vol >= 1e3 ? `${(vol / 1e3).toFixed(0)}K` : vol > 0 ? vol.toFixed(0) : '—';

            const side = tradedMap.get(s.symbol);
            const tradedIndicator = side
                ? `<span class="symbol-traded-dot ${side === 'LONG' ? 'dot-long' : 'dot-short'}"></span><span class="symbol-traded-badge ${side === 'LONG' ? 'badge-long' : 'badge-short'}">${side === 'LONG' ? 'L' : 'S'}</span>`
                : '';

            // TradFi type badge
            const base = s.base?.toUpperCase();
            const typeBadge = EQUITIES.has(base)
                ? '<span class="symbol-type-badge type-equity">📈 Equity</span>'
                : COMMODITIES.has(base)
                    ? '<span class="symbol-type-badge type-commodity">🪙 Metal</span>'
                    : '';

            return `
        <div class="symbol-item" data-symbol="${s.symbol}" style="display:flex; justify-content:space-between; align-items:center;">
          <span style="flex:2; font-weight:600; display:flex; align-items:center; gap:6px;">${tradedIndicator}${s.base}/USDT${typeBadge}</span>
          <span style="flex:1.5; text-align:right; font-family:var(--font-mono); font-size:12px;">${s.price ? '$' + formatPrice(s.price) : '—'}</span>
          <span style="flex:1; text-align:right; font-family:var(--font-mono); font-size:12px; color:${chgColor};">${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}%</span>
          <span style="flex:1; text-align:right; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${volStr}</span>
          <span style="flex:1; text-align:right; font-family:var(--font-mono); font-size:11px; color:${fundColor};">${(s.fundingRate * 100).toFixed(4)}%</span>
        </div>
      `;
        }).join('') || '<div style="padding:20px; text-align:center; color:var(--text-muted);">No symbols found</div>';

        list.querySelectorAll('.symbol-item').forEach(item => {
            item.addEventListener('click', () => switchSymbol(item.dataset.symbol));
        });
    }

    let searchTimeout;
    document.getElementById('symbol-search')?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const q = e.target.value.trim();
        searchTimeout = setTimeout(() => {
            renderTickerResults(filterSymbols(allTickers, q), q);
        }, 100);
    });
}

export function switchSymbol(symbol) {
    S.set('selectedSymbol', symbol);
    localStorage.setItem('pms_last_symbol', symbol);
    let raw = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
    if (!raw.endsWith('usdt')) raw += 'usdt';
    S.set('rawSymbol', raw);

    document.getElementById('sym-name').textContent = `${symbol.split('/')[0]}/USDT`;
    document.querySelector('.modal-overlay')?.remove();

    S.set('currentPrice', null);
    S.set('recentTrades', []);
    S.set('orderBookBids', []);
    S.set('orderBookAsks', []);
    S.set('sizePercent', 0);
    const slider = document.getElementById('size-slider');
    if (slider) slider.value = 0;
    setSizePercent(0);

    // restore per-instrument leverage
    setLeverage(S.leverageMap[symbol] || 1);

    // Re-apply bottom panel filter for the new symbol
    import('./positions-panel.js').then(m => m.applySymbolFilter());



    // Use the orchestrator's lightweight re-init (teardown streams + chart only)
    import('./ws-handlers.js').then(({ teardownStreams, initWebSockets }) => {
        teardownStreams();
        if (S.chartResizeObserver) {
            try { S.chartResizeObserver.disconnect(); } catch { }
            S.set('chartResizeObserver', null);
        }
        if (S.chart) { try { S.chart.remove(); } catch { } S.set('chart', null); }
        S.set('chartReady', false);
        S.set('candleSeries', null);
        S.set('volumeSeries', null);
        S.set('chartPriceLines', []);
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationLastFetch', 0);
        S.set('_chartAnnotationFingerprint', null);
        S.set('_chartAnnotationForceNext', false);

        requestAnimationFrame(() => {
            initChart();
            initWebSockets();
            scheduleTradingRefresh({ annotations: true, forceAnnotations: true }, 20);
        });
        fetchTickerData();
        fetchSymbolInfo(symbol);
    });
}

export function showAccountPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const accts = state.accounts.map(a => `
    <div class="symbol-item" data-id="${a.id}" style="${a.id === state.currentAccount ? 'background:var(--bg-card-hover);' : ''}">
      <div>
        <span class="symbol-name">${a.name}</span>
        <span class="badge badge-${a.status.toLowerCase()}" style="margin-left:8px;">${a.status}</span>
      </div>
      <span class="symbol-price">$${a.currentBalance.toFixed(2)}</span>
    </div>
  `).join('');

    overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <span class="modal-title">Select Account</span>
        <button class="modal-close">×</button>
      </div>
      <div class="symbol-list">${accts || '<div style="padding:20px; text-align:center; color:var(--text-muted);">No Accounts</div>'}</div>
    </div>
  `;

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.symbol-item').forEach(item => {
        item.addEventListener('click', () => {
            state.currentAccount = item.dataset.id;
            localStorage.setItem('pms_currentAccount', state.currentAccount);
            scheduleTradingRefresh({
                account: true,
                positions: true,
                openOrders: true,
                annotations: true,
                forceAnnotations: true,
            }, 0);
            overlay.remove();
            if (state.ws?.readyState === 1) {
                state.ws.send(JSON.stringify({
                    type: 'subscribe',
                    subAccountId: state.currentAccount,
                    token: localStorage.getItem('pms_token') || null,
                }));
            }
        });
    });

    document.body.appendChild(overlay);
}

// ── Helpers ─────────────────────────────────────

export function refreshAccountsInBackground() {
    api('/sub-accounts')
        .then((accounts) => {
            if (!Array.isArray(accounts)) return;
            state.accounts = accounts;
            if (S._tradingMounted) updateAccountDisplay();
        })
        .catch(() => { });
}

export async function updateAccountDisplay() {
    const account = state.accounts.find(a => a.id === state.currentAccount);
    const nameEl = document.getElementById('form-account');
    const availEl = document.getElementById('form-available');
    if (nameEl) nameEl.textContent = account?.name || 'Select';

    const accountId = state.currentAccount;
    if (accountId) {
        try {
            const [margin, posData] = await Promise.all([
                api(`/trade/margin/${accountId}`),
                api(`/trade/positions/${accountId}`).catch(() => null),
            ]);
            S.set('cachedMarginInfo', margin);

            const avEl = document.getElementById('acct-available');
            const avail = margin.availableMargin ?? 0;
            if (avEl) avEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
            if (availEl) availEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
            _applyNegativeBalanceLock(avail, { force: true });

            S.set('_cachedBalance', margin.balance || 0);
            S.set('_cachedMarginUsed', margin.marginUsed || 0);

            if (posData?.positions) {
                S._positionMap.clear();
                for (const p of posData.positions) {
                    S._positionMap.set(p.id, {
                        symbol: p.symbol,
                        side: p.side,
                        entryPrice: p.entryPrice,
                        quantity: p.quantity,
                        markPrice: p.markPrice || p.entryPrice,
                    });
                }
            }

            _refreshEquityUpnl();
        } catch { }
    } else {
        if (availEl) availEl.textContent = '$0.00';
        _applyNegativeBalanceLock(0, { force: true });
    }
}

// ── Negative Balance Lock ───────────────────────

export function _applyNegativeBalanceLock(availableMargin, opts = {}) {
    const force = !!opts.force;
    const isNegative = availableMargin != null && availableMargin < 0;
    if (!force && S._negativeLockState === isNegative) return;
    S.set('_negativeLockState', isNegative);

    const slider = document.getElementById('size-slider');
    const sizeInput = document.getElementById('trade-size');
    const submitBtn = document.getElementById('submit-trade');
    const avEl = document.getElementById('acct-available');
    const availEl = document.getElementById('form-available');

    if (slider) slider.disabled = isNegative;
    if (sizeInput) sizeInput.disabled = isNegative;
    if (submitBtn) {
        submitBtn.disabled = isNegative;
        if (isNegative) submitBtn.style.opacity = '0.4';
        else submitBtn.style.opacity = '';
    }

    document.querySelectorAll('.slider-diamond').forEach(d => {
        d.style.pointerEvents = isNegative ? 'none' : '';
        d.style.opacity = isNegative ? '0.3' : '';
    });

    const sliderTrack = document.getElementById('size-slider-track');
    if (sliderTrack) sliderTrack.style.opacity = isNegative ? '0.3' : '';

    const balColor = isNegative ? 'var(--red, #ef4444)' : 'var(--green)';
    if (avEl) avEl.style.color = balColor;
    if (availEl) availEl.style.color = balColor;

    if (isNegative) {
        if (slider) slider.value = 0;
        const fill = document.getElementById('size-slider-fill');
        if (fill) fill.style.width = '0%';
        const label = document.getElementById('size-pct-label');
        if (label) label.textContent = '0%';
        if (sizeInput) sizeInput.value = '';
        document.querySelectorAll('.slider-diamond').forEach(d => d.classList.remove('active'));
        const preview = document.getElementById('order-preview');
        if (preview) preview.style.display = 'none';
    }
}

// ── Equity / UPNL ──────────────────────────────

export function _refreshEquityUpnl() {
    if (!S._cachedBalance && S._positionMap.size === 0) return;

    let totalUpnl = 0;
    for (const [, pos] of S._positionMap) {
        const mark = (pos.symbol === S.selectedSymbol && S.currentPrice)
            ? S.currentPrice
            : (S._compactMarkPrices[pos.symbol] || pos.markPrice);
        if (!mark) continue;
        totalUpnl += pos.side === 'LONG'
            ? (mark - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - mark) * pos.quantity;
    }
    const equity = S._cachedBalance + totalUpnl;
    const eqEl = document.getElementById('equity-value');
    const upnlEl = document.getElementById('upnl-value');
    if (eqEl) eqEl.textContent = `$${equity.toFixed(2)}`;
    if (upnlEl) {
        upnlEl.textContent = `${totalUpnl >= 0 ? '+' : ''}$${totalUpnl.toFixed(2)}`;
        upnlEl.style.color = totalUpnl > 0 ? 'var(--green)' : totalUpnl < 0 ? 'var(--red, #ef4444)' : 'var(--text-muted)';
    }

    const liveAvail = equity - S._cachedMarginUsed;
    const avEl = document.getElementById('acct-available');
    const availEl = document.getElementById('form-available');
    if (avEl) avEl.textContent = `${liveAvail < 0 ? '-' : ''}$${Math.abs(liveAvail).toFixed(2)}`;
    if (availEl) availEl.textContent = `${liveAvail < 0 ? '-' : ''}$${Math.abs(liveAvail).toFixed(2)}`;
    if (S.cachedMarginInfo) S.cachedMarginInfo.availableMargin = liveAvail;

    const isNegative = liveAvail < 0;
    if (S._negativeLockState == null || S._negativeLockState !== isNegative) {
        _applyNegativeBalanceLock(liveAvail);
    }
}

// ── Bottom-panel tab switching ──────────────────
export function _switchBottomTab(target) {
    document.querySelectorAll('.bp-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.bp === target);
    });
    document.querySelectorAll('.bp-pane').forEach(p => {
        p.classList.toggle('active', p.id === `bp-${target}`);
    });
    const cancelBtn = document.getElementById('cancel-all-orders');
    if (cancelBtn) {
        cancelBtn.style.display = (target === 'orders' && cancelBtn.dataset.hasOrders === '1') ? '' : 'none';
    }
    localStorage.setItem('pms_bottom_panel_tab', target);
}
