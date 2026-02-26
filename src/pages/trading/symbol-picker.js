// ── Trading Page – Symbol & Account Pickers ──
// Modal UIs for selecting trading symbol and sub-account.

import { state, api, formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { setSizePercent, setLeverage } from './order-form.js';
import { initChart, fetchTickerData, fetchSymbolInfo } from './chart.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Symbol prefetch ─────────────────────────────

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

// ── Symbol Picker Modal ─────────────────────────

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

    const resultsList = document.getElementById('symbol-results');
    if (resultsList) resultsList.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);"><div class="spinner" style="width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 8px;"></div>Loading symbols...</div>';
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

        const tradedMap = new Map();
        for (const [, pos] of S._positionMap) {
            tradedMap.set(pos.symbol, pos.side);
        }

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
          <span style="flex:1; text-align:right; font-family:var(--font-mono); font-size:11px; color:${fundColor};">${s.fundingRate != null ? (s.fundingRate * 100).toFixed(4) : '—'}%</span>
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

// ── Switch Symbol ───────────────────────────────

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

    document.querySelectorAll('.chase-price-tag').forEach(tag => tag.remove());
    S.set('sizePercent', 0);
    const slider = document.getElementById('size-slider');
    if (slider) slider.value = 0;
    setSizePercent(0);

    setLeverage(S.leverageMap[symbol] || 1);

    import('./positions-panel.js').then(m => m.applySymbolFilter());

    import('./ws-handlers.js').then(m => {
        if (m.ws && m.ws.readyState === 1) {
            m.ws.send(JSON.stringify({ type: 'warm_symbol', symbol }));
        }
    });

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

// ── Account Picker Modal ────────────────────────

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
