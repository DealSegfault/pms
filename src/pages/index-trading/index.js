// ── Index Trading Page – Orchestrator ─────────────
// Thin module that wires together all sub-modules.
// Public API: { renderIndexPage, cleanup }
import { state } from '../../core/index.js';
import { cuteBlocks, cutePointer } from '../../lib/cute-empty.js';

import { st, loadIndexes, loadPairSelections } from './state.js';
import { cleanupCompositeStreams, loadCompositeChart } from './chart.js';
import { renderIndexList, updateAllocation, selectIndex } from './index-list.js';
import { openEditor } from './editor.js';
import {
  renderPairBuilderSummary, renderPairMatrix, openPairBuilder, closePairBuilder,
  switchPairBuilderTab, refreshPairMatrixFromControls, clearPairSelections,
  selectAllPairsLong, selectAllPairsShort, addCustomPairFromInputs, savePairBuilderIndex,
  onPairMatrixAction, loadTopIndexPicks, onTopPickAction, mergePairRowsWithCustom,
  loadAllSymbols, clampInt,
  onSymbolTableAction, selectAllSymbolsLong, selectAllSymbolsShort, clearSymbolSelections,
  loadAllTickers, saveSymbolTabIndex, renderSymbolTable,
} from './pair-builder.js';
import { cleanupBasketWs, renderActiveBaskets } from './active-baskets.js';
import { executeBasket, executeTwapBasket, setIdxExecMode, updateIdxTwapPreview, renderActiveTwapBasket } from './basket-execution.js';
import { showAccountPicker } from './account-picker.js';

// ── Public API ───────────────────────────────────

export function renderIndexPage(container) {
  cleanup();
  loadIndexes();
  loadPairSelections();
  st.pairMatrix = mergePairRowsWithCustom([]);

  container.innerHTML = buildTemplate();
  attachEventListeners();
  renderIndexList();
  renderPairBuilderSummary();
  loadAllSymbols();
  // Restore active TWAP basket UI from backend (survives page navigation)
  renderActiveTwapBasket();

  // Restore last selected index
  try {
    const lastId = localStorage.getItem('pms_last_selected_index');
    if (lastId && st.indexes.some(idx => idx.id === lastId)) {
      selectIndex(lastId);
    }
  } catch { }
}

export function cleanup() {
  st.cleanupFns.forEach(fn => { try { fn(); } catch { } });
  st.cleanupFns = [];
  if (st.chart) { try { st.chart.remove(); } catch { } st.chart = null; }
  st.chartReady = false;
  st.compositeSeries = null;
  st.volumeSeries = null;
  cleanupCompositeStreams();
  st.compositeContext = null;
  cleanupBasketWs();
  st.pairBuilderVisible = false;
  st.pairBuilderLoading = false;
}

// ── Template ─────────────────────────────────────

function buildTemplate() {
  return `
    <div class="idx-terminal">
      <div class="idx-header">
        <div class="idx-header-left">
          <span class="idx-title" id="idx-title">📊 Index Trading</span>
          <span class="idx-subtitle" id="idx-subtitle">Select or create an index</span>
        </div>
        <div class="idx-header-right">
          <span class="idx-composite-price" id="idx-price">—</span>
        </div>
      </div>
      <div class="idx-tabs">
        <button class="idx-tab active" data-tab="indexes">📋 Indexes</button>
        <button class="idx-tab" data-tab="chart">📈 Chart</button>
        <button class="idx-tab" data-tab="trade">⚡ Trade</button>
      </div>
      <div class="idx-grid">
        <div class="idx-list-panel idx-tab-indexes">
          <div class="panel-header">
            <span id="idx-list-header-title">My Indexes</span>
            <div id="idx-list-header-btns" style="display:flex; gap:6px;">
              <button class="btn btn-sm btn-outline" id="idx-beta-builder-btn">β Builder</button>
              <button class="btn btn-sm btn-primary" id="idx-create-btn">+ Create</button>
            </div>
          </div>
          <div class="idx-list" id="idx-list">
            <div id="idx-empty">
              ${cuteBlocks({ title: 'No Indexes Yet ✨', subtitle: 'Create your first basket index~' })}
            </div>
          </div>
        </div>
        <div class="idx-chart-panel idx-tab-chart idx-mob-hidden">
          <div class="chart-toolbar">
            <div class="chart-timeframes">
              ${['1m', '5m', '15m', '1h', '4h', '1d'].map(tf =>
    `<button class="tf-btn${tf === '5m' ? ' active' : ''}" data-tf="${tf}">${tf}</button>`
  ).join('')}
            </div>
          </div>
          <div id="idx-chart" class="chart-container" style="position:relative;"></div>
          <div id="idx-chart-empty" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;">
            ${cutePointer({ title: 'Select an Index ✨', subtitle: 'Pick one to view its chart~' })}
          </div>
        </div>
        <div class="idx-trade-panel idx-tab-trade idx-mob-hidden">
          <div class="panel-header">
            <span>Execute Basket</span>
            <span id="idx-account" class="form-account">
              ${state.accounts.find(a => a.id === state.currentAccount)?.name || 'Select'}
            </span>
          </div>
          <div class="idx-trade-body" id="idx-trade-body">
            <div class="idx-no-selection" id="idx-no-selection">
              <p style="color:var(--text-muted); font-size:12px; text-align:center; padding:20px;">Select an index to trade</p>
            </div>
            <div id="idx-trade-form" style="display:none;">
              <div class="idx-selected-info" id="idx-selected-info"></div>
              <div style="margin: 8px 0;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                  <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Trade Size (USDT)</label>
                  <span id="idx-leverage-display" style="font-size:11px; color:var(--accent); font-family:var(--font-mono); font-weight:600;">${st.leverage}x</span>
                </div>
                <input type="number" id="idx-size" value="${st.tradeSize}" min="10" step="10"
                  style="width:100%; padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); font-family:var(--font-mono); font-size:14px; outline:none;" />
              </div>
              <div style="display:flex; gap:4px; margin:6px 0;">
                ${[50, 100, 250, 500, 1000].map(s =>
    `<button class="idx-size-btn" data-size="${s}" style="flex:1; padding:5px 2px; background:var(--bg-input); border:1px solid var(--border); border-radius:4px; color:var(--text-secondary); font-family:var(--font-mono); font-size:10px; font-weight:600; cursor:pointer;">$${s}</button>`
  ).join('')}
              </div>
              <div style="margin: 8px 0;">
                <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Leverage</label>
                <div style="display:flex; gap:4px;">
                  ${[5, 10, 20, 50, 100].map(l =>
    `<button class="idx-lev-btn" data-lev="${l}" style="flex:1; padding:5px 2px; background:${l === st.leverage ? 'rgba(99,102,241,0.15)' : 'var(--bg-input)'}; border:1px solid ${l === st.leverage ? 'var(--accent)' : 'var(--border)'}; border-radius:4px; color:${l === st.leverage ? 'var(--accent)' : 'var(--text-secondary)'}; font-family:var(--font-mono); font-size:10px; font-weight:600; cursor:pointer;">${l}x</button>`
  ).join('')}
                </div>
              </div>
              <div style="margin: 8px 0;">
                <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Execution</label>
                <div style="display:flex; gap:4px;">
                  <button id="idx-mode-instant" class="idx-mode-btn" data-mode="instant" style="flex:1; padding:5px 2px; background:rgba(99,102,241,0.15); border:1px solid var(--accent); border-radius:4px; color:var(--accent); font-family:var(--font-mono); font-size:10px; font-weight:600; cursor:pointer;">⚡ Instant</button>
                  <button id="idx-mode-twap" class="idx-mode-btn" data-mode="twap" style="flex:1; padding:5px 2px; background:var(--bg-input); border:1px solid var(--border); border-radius:4px; color:var(--text-secondary); font-family:var(--font-mono); font-size:10px; font-weight:600; cursor:pointer;">⏱ TWAP</button>
                </div>
              </div>
              <div id="idx-twap-controls" style="display:none; margin:8px 0; padding:8px 10px; background:rgba(99,102,241,0.05); border:1px solid rgba(99,102,241,0.15); border-radius:6px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                  <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Lots</span>
                  <span id="idx-twap-lots-val" style="font-size:12px; font-weight:600; color:var(--text-primary); font-family:var(--font-mono);">10</span>
                </div>
                <input type="range" id="idx-twap-lots" min="2" max="50" value="10" step="1" style="width:100%; margin-bottom:8px;" />
                <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                  <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Duration (min)</span>
                  <span id="idx-twap-dur-val" style="font-size:12px; font-weight:600; color:var(--text-primary); font-family:var(--font-mono);">30</span>
                </div>
                <input type="range" id="idx-twap-duration" min="1" max="720" value="30" step="1" style="width:100%; margin-bottom:8px;" />
                <div style="display:flex; gap:12px; font-size:10px; color:var(--text-secondary);">
                  <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <input type="checkbox" id="idx-twap-jitter" /> Jitter ±20%
                  </label>
                  <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <input type="checkbox" id="idx-twap-irregular" /> Irregular lots
                  </label>
                </div>
                <div id="idx-twap-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:16px; margin-top:6px;"></div>
              </div>
              <div id="idx-allocation" class="idx-allocation"></div>
              <div style="display:flex; gap:6px; margin-top:10px;">
                <button id="idx-buy-btn" class="btn-submit btn-submit-long" style="flex:1;" disabled>Buy Index</button>
                <button id="idx-sell-btn" class="btn-submit btn-submit-short" style="flex:1;" disabled>Sell Index</button>
              </div>
              <div id="idx-active-twap-basket" style="margin-top:8px;"></div>
              <div id="idx-active-baskets" style="margin-top:12px;"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-overlay" id="idx-pair-overlay" style="display:none;">
        <div class="modal-content idx-pair-modal" style="max-width:980px; width:min(980px, 96vw); max-height:min(92vh, 980px); overflow:auto;">
          <div class="modal-header">
            <span class="modal-title">Beta Correlation Builder</span>
            <button class="modal-close" id="idx-pair-close">×</button>
          </div>
          <div class="idx-builder-tabs">
            <button class="idx-builder-tab ${st.pairBuilderTab === 'matrix' ? 'active' : ''}" data-builder-tab="matrix">🧪 Pair Lab</button>
            <button class="idx-builder-tab ${st.pairBuilderTab === 'picks' ? 'active' : ''}" data-builder-tab="picks">👑 Top Picks</button>
            <button class="idx-builder-tab ${st.pairBuilderTab === 'symbols' ? 'active' : ''}" data-builder-tab="symbols">📋 All Symbols</button>
          </div>
          <div id="idx-pair-panel-matrix" style="display:${st.pairBuilderTab === 'matrix' ? '' : 'none'};">
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; margin-bottom:10px;">
              <label style="font-size:11px; color:var(--text-muted);">Timeframe
                <select id="idx-pair-timeframe" style="margin-top:4px; width:100%; padding:6px 8px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);">
                  ${['5m', '15m', '1h', '4h', '1d'].map(tf => `<option value="${tf}" ${tf === st.pairBuilderTimeframe ? 'selected' : ''}>${tf}</option>`).join('')}
                </select>
              </label>
              <label style="font-size:11px; color:var(--text-muted);">Top Winners
                <input type="number" id="idx-pair-top" min="5" max="50" step="1" value="${st.pairBuilderTopCount}" style="margin-top:4px; width:100%; padding:6px 8px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              </label>
              <label style="font-size:11px; color:var(--text-muted);">Bottom Losers
                <input type="number" id="idx-pair-bottom" min="5" max="50" step="1" value="${st.pairBuilderBottomCount}" style="margin-top:4px; width:100%; padding:6px 8px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              </label>
              <label style="font-size:11px; color:var(--text-muted);">Pair Limit
                <input type="number" id="idx-pair-limit" min="20" max="500" step="10" value="${st.pairBuilderLimit}" style="margin-top:4px; width:100%; padding:6px 8px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              </label>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin-bottom:10px;">
              <input id="idx-pair-base" type="text" placeholder="Base (e.g. BTC)" value="BTC" style="padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <input id="idx-pair-quote" type="text" placeholder="Quote (e.g. ETH)" value="ETH" style="padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <input id="idx-pair-search" type="text" placeholder="Search pair..." style="padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <button class="btn btn-outline" id="idx-pair-add-custom">+ Add Pair</button>
            </div>
            <div id="idx-pair-status" style="font-size:11px; color:var(--text-muted); margin-bottom:8px;"></div>
            <div id="idx-pair-summary" style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;"></div>
            <div id="idx-pair-matrix" style="border:1px solid var(--border); border-radius:8px; overflow:hidden;"></div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin-top:12px;">
              <input id="idx-pair-name" type="text" placeholder="Index name (e.g. Beta Winners vs Losers)" style="padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <button class="btn btn-outline" id="idx-pair-all-long" style="border-color:var(--green); color:var(--green);">All Long</button>
              <button class="btn btn-outline" id="idx-pair-all-short" style="border-color:var(--red); color:var(--red);">All Short</button>
              <button class="btn btn-outline" id="idx-pair-clear">Clear</button>
              <button class="btn btn-outline" id="idx-pair-refresh">Refresh Matrix</button>
              <button class="btn btn-primary" id="idx-pair-save-index">Save As Index</button>
            </div>
          </div>
          <div id="idx-pair-panel-picks" style="display:${st.pairBuilderTab === 'picks' ? '' : 'none'};">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px;">
              <div style="font-size:12px; color:var(--text-secondary);">Precomputed top indexes from vine-copula decision engine.</div>
              <button class="btn btn-outline btn-sm" id="idx-picks-refresh">Refresh Picks</button>
            </div>
            <div id="idx-picks-status" style="font-size:11px; color:var(--text-muted); margin-bottom:8px;"></div>
            <div id="idx-top-picks" class="idx-top-picks"></div>
          </div>
          <div id="idx-pair-panel-symbols" style="display:${st.pairBuilderTab === 'symbols' ? '' : 'none'};">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
              <input id="idx-sym-search" type="text" placeholder="Search symbol..." style="flex:1; min-width:140px; padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <button class="btn btn-outline btn-sm" id="idx-sym-all-long" style="border-color:var(--green); color:var(--green);">All Long</button>
              <button class="btn btn-outline btn-sm" id="idx-sym-all-short" style="border-color:var(--red); color:var(--red);">All Short</button>
              <button class="btn btn-outline btn-sm" id="idx-sym-clear">Clear</button>
              <button class="btn btn-outline btn-sm" id="idx-sym-refresh">Refresh</button>
            </div>
            <div id="idx-sym-status" style="font-size:11px; color:var(--text-muted); margin-bottom:6px;"></div>
            <div id="idx-sym-summary" style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;"></div>
            <div id="idx-sym-table" style="border:1px solid var(--border); border-radius:8px; overflow:hidden;"></div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin-top:12px;">
              <input id="idx-sym-name" type="text" placeholder="Index name (e.g. My Full Basket)" style="padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text-primary);" />
              <button class="btn btn-primary" id="idx-sym-save-index">Save As Index</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// ── Event wiring ─────────────────────────────────

function attachEventListeners() {
  // Mobile tabs
  document.querySelectorAll('.idx-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.idx-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll('.idx-tab-indexes, .idx-tab-chart, .idx-tab-trade').forEach(el => el.classList.add('idx-mob-hidden'));
      const activeEl = document.querySelector(`.idx-tab-${target}`);
      if (activeEl) activeEl.classList.remove('idx-mob-hidden');
      if (target === 'chart' && st.chart) {
        const c = document.getElementById('idx-chart');
        if (c && c.clientWidth > 0) st.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
      }
    });
  });

  // Create + beta builder
  document.getElementById('idx-create-btn')?.addEventListener('click', () => openEditor());
  document.getElementById('idx-beta-builder-btn')?.addEventListener('click', openPairBuilder);

  // Pair builder modal
  document.getElementById('idx-pair-close')?.addEventListener('click', closePairBuilder);
  document.getElementById('idx-pair-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'idx-pair-overlay') closePairBuilder(); });
  document.querySelectorAll('[data-builder-tab]').forEach(btn => btn.addEventListener('click', () => switchPairBuilderTab(btn.dataset.builderTab)));
  document.getElementById('idx-pair-search')?.addEventListener('input', (e) => { st.pairBuilderSearch = (e.target?.value || '').toUpperCase(); renderPairMatrix(); });
  document.getElementById('idx-pair-timeframe')?.addEventListener('change', (e) => { st.pairBuilderTimeframe = e.target?.value || st.pairBuilderTimeframe; });
  document.getElementById('idx-pair-top')?.addEventListener('change', (e) => { st.pairBuilderTopCount = clampInt(e.target?.value, 5, 50, 20); e.target.value = st.pairBuilderTopCount; });
  document.getElementById('idx-pair-bottom')?.addEventListener('change', (e) => { st.pairBuilderBottomCount = clampInt(e.target?.value, 5, 50, 20); e.target.value = st.pairBuilderBottomCount; });
  document.getElementById('idx-pair-limit')?.addEventListener('change', (e) => { st.pairBuilderLimit = clampInt(e.target?.value, 20, 500, 200); e.target.value = st.pairBuilderLimit; });
  document.getElementById('idx-pair-refresh')?.addEventListener('click', refreshPairMatrixFromControls);
  document.getElementById('idx-pair-clear')?.addEventListener('click', clearPairSelections);
  document.getElementById('idx-pair-all-long')?.addEventListener('click', selectAllPairsLong);
  document.getElementById('idx-pair-all-short')?.addEventListener('click', selectAllPairsShort);
  document.getElementById('idx-pair-add-custom')?.addEventListener('click', addCustomPairFromInputs);
  document.getElementById('idx-pair-save-index')?.addEventListener('click', savePairBuilderIndex);
  document.getElementById('idx-pair-matrix')?.addEventListener('click', onPairMatrixAction);
  document.getElementById('idx-picks-refresh')?.addEventListener('click', () => loadTopIndexPicks(true));
  document.getElementById('idx-top-picks')?.addEventListener('click', onTopPickAction);

  // Symbols tab
  document.getElementById('idx-sym-search')?.addEventListener('input', (e) => { st.allTickerSearch = (e.target?.value || '').toUpperCase(); renderSymbolTable(); });
  document.getElementById('idx-sym-all-long')?.addEventListener('click', selectAllSymbolsLong);
  document.getElementById('idx-sym-all-short')?.addEventListener('click', selectAllSymbolsShort);
  document.getElementById('idx-sym-clear')?.addEventListener('click', clearSymbolSelections);
  document.getElementById('idx-sym-refresh')?.addEventListener('click', () => loadAllTickers(true));
  document.getElementById('idx-sym-save-index')?.addEventListener('click', saveSymbolTabIndex);
  document.getElementById('idx-sym-table')?.addEventListener('click', onSymbolTableAction);

  // Editor events are now attached dynamically inside editor.js openEditor()

  // Size
  document.getElementById('idx-size')?.addEventListener('input', (e) => { st.tradeSize = parseFloat(e.target.value) || 0; updateAllocation(); renderPairBuilderSummary(); });
  document.querySelectorAll('.idx-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      st.tradeSize = parseInt(btn.dataset.size);
      const inp = document.getElementById('idx-size');
      if (inp) inp.value = st.tradeSize;
      updateAllocation(); renderPairBuilderSummary();
    });
  });

  // Leverage
  document.querySelectorAll('.idx-lev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      st.leverage = parseInt(btn.dataset.lev);
      document.querySelectorAll('.idx-lev-btn').forEach(b => {
        const isActive = parseInt(b.dataset.lev) === st.leverage;
        b.style.background = isActive ? 'rgba(99,102,241,0.15)' : 'var(--bg-input)';
        b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
        b.style.color = isActive ? 'var(--accent)' : 'var(--text-secondary)';
      });
      const disp = document.getElementById('idx-leverage-display');
      if (disp) disp.textContent = `${st.leverage}x`;
      updateAllocation();
    });
  });

  // Timeframes
  document.querySelector('.idx-chart-panel .chart-timeframes')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-btn');
    if (!btn) return;
    st.currentTimeframe = btn.dataset.tf;
    document.querySelectorAll('.idx-chart-panel .tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === st.currentTimeframe));
    if (st.selectedIndex) loadCompositeChart();
  });

  // Execution mode
  document.querySelectorAll('.idx-mode-btn').forEach(btn => btn.addEventListener('click', () => setIdxExecMode(btn.dataset.mode)));

  // TWAP controls
  document.getElementById('idx-twap-lots')?.addEventListener('input', (e) => { st.idxTwapLots = parseInt(e.target.value) || 10; const el = document.getElementById('idx-twap-lots-val'); if (el) el.textContent = st.idxTwapLots; updateIdxTwapPreview(); });
  document.getElementById('idx-twap-duration')?.addEventListener('input', (e) => { st.idxTwapDuration = parseInt(e.target.value) || 30; const el = document.getElementById('idx-twap-dur-val'); if (el) el.textContent = st.idxTwapDuration; updateIdxTwapPreview(); });
  document.getElementById('idx-twap-jitter')?.addEventListener('change', (e) => { st.idxTwapJitter = e.target.checked; updateIdxTwapPreview(); });
  document.getElementById('idx-twap-irregular')?.addEventListener('change', (e) => { st.idxTwapIrregular = e.target.checked; updateIdxTwapPreview(); });

  // Execute
  document.getElementById('idx-buy-btn')?.addEventListener('click', () => { if (st.idxExecMode === 'twap') executeTwapBasket('LONG'); else executeBasket('LONG'); });
  document.getElementById('idx-sell-btn')?.addEventListener('click', () => { if (st.idxExecMode === 'twap') executeTwapBasket('SHORT'); else executeBasket('SHORT'); });

  // TWAP WS events
  const _twapProgress = (e) => { const d = e.detail; if (d?.subAccountId !== state.currentAccount) return; showToast(`TWAP ${d.basketName}: lot ${d.filledLots}/${d.totalLots}`, 'info'); renderActiveTwapBasket(); };
  const _twapCompleted = (e) => { const d = e.detail; if (d?.subAccountId !== state.currentAccount) return; showToast(`TWAP ${d.basketName} completed ✓`, 'success'); st.activeTwapBasketIds = st.activeTwapBasketIds.filter(x => x !== d.twapBasketId); renderActiveTwapBasket(); };
  const _twapCancelled = (e) => { const d = e.detail; if (d?.subAccountId !== state.currentAccount) return; showToast(`TWAP ${d.basketName} cancelled`, 'warn'); st.activeTwapBasketIds = st.activeTwapBasketIds.filter(x => x !== d.twapBasketId); renderActiveTwapBasket(); };
  window.addEventListener('twap_basket_progress', _twapProgress);
  window.addEventListener('twap_basket_completed', _twapCompleted);
  window.addEventListener('twap_basket_cancelled', _twapCancelled);
  st.cleanupFns.push(() => {
    window.removeEventListener('twap_basket_progress', _twapProgress);
    window.removeEventListener('twap_basket_completed', _twapCompleted);
    window.removeEventListener('twap_basket_cancelled', _twapCancelled);
  });

  // Account picker
  document.getElementById('idx-account')?.addEventListener('click', showAccountPicker);

  // Render active baskets
  renderActiveBaskets();
}
