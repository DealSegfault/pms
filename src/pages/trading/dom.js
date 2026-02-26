// ── Trading Page – DOM / HTML Template ───────────────────────
import { state } from '../../core/index.js';
import { cuteSpinner } from '../../lib/cute-empty.js';
import * as S from './state.js';

/**
 * Build the full trading page HTML string.
 * Pure function — no DOM mutation.
 */
export function buildTradingHTML() {
  const symBase = S.selectedSymbol.split('/')[0];
  const account = state.accounts.find(a => a.id === state.currentAccount);
  const accountName = account?.name || 'Select';

  return `
    <div class="trading-terminal">
      <!-- Symbol Bar -->
      <div class="symbol-bar" id="symbol-bar">
        <div class="symbol-bar-left" id="symbol-picker-trigger">
          <span class="symbol-bar-name" id="sym-name">${symBase}/USDT</span>
          <span class="symbol-bar-type">Perpetual</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="symbol-bar-right">
          <div class="symbol-bar-price" id="sym-price">—</div>
          <div class="symbol-bar-stats">
            <div class="sym-stat">
              <span class="sym-stat-label">Mark</span>
              <span class="sym-stat-value" id="sym-mark">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">24h Change</span>
              <span class="sym-stat-value" id="sym-24h">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">24h High</span>
              <span class="sym-stat-value" id="sym-high">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">24h Low</span>
              <span class="sym-stat-value" id="sym-low">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">24h Vol(USDT)</span>
              <span class="sym-stat-value" id="sym-vol">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">Funding</span>
              <span class="sym-stat-value" id="sym-funding">—</span>
            </div>
            <div class="sym-stat">
              <span class="sym-stat-label">Open Interest</span>
              <span class="sym-stat-value" id="sym-oi">—</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Trading Tabs (mobile only, hidden on desktop via CSS) -->
      <div class="trading-tabs">
        <button class="trading-tab active" data-tab="chart">📊 Chart</button>
        <button class="trading-tab" data-tab="trade">🔧 Trade</button>
      </div>

      <!-- Single Grid: all panels as direct children -->
      <div class="terminal-grid">
        <!-- Chart Area -->
        <div class="chart-area">
          <div class="chart-panel tab-chart-item">
            <div class="chart-toolbar">
              <div class="chart-timeframes">
                ${['1s', '1m', '5m', '15m', '1h', '4h', '1d'].map(tf =>
    `<button class="tf-btn${tf === '5m' ? ' active' : ''}" data-tf="${tf}">${tf}</button>`
  ).join('')}
                <button id="chart-reset" class="tf-btn" title="Reset chart" style="margin-left: auto; font-size:13px;">↻</button>
                <button id="chart-autoscale" class="tf-btn" title="Autoscale to fit screen" style="font-size:13px;">📐</button>
                <button id="chart-settings-btn" class="tf-btn" title="Chart settings" style="font-size:13px;">⚙</button>
              </div>
            </div>
            <div id="chart-settings-panel" style="display:none; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; padding:10px 12px; position:absolute; top:32px; right:4px; z-index:50; font-size:11px; min-width:220px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);">
              <div style="font-weight:600; margin-bottom:8px; color:var(--text);">Chart Settings</div>
              <div style="border-top:1px solid var(--border); margin-top:6px; padding-top:6px; font-weight:600; margin-bottom:4px; color:var(--text);">Overlays</div>
              <label class="cs-checkbox"><input type="checkbox" id="cs-show-positions" checked /> Positions</label>
              <label class="cs-checkbox"><input type="checkbox" id="cs-show-open-orders" checked /> Open Orders</label>
              <label class="cs-checkbox"><input type="checkbox" id="cs-show-past-orders" checked /> Past Orders</label>
            </div>
            <div class="chart-with-toolbar">
              <div class="chart-left-toolbar" id="chart-left-toolbar">
                <button id="measure-tool-btn" class="chart-ltb-btn" title="Measure range (ruler)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 22 L22 2" />
                    <path d="M6 18 L8 16" />
                    <path d="M10 14 L12 12" />
                    <path d="M14 10 L16 8" />
                    <path d="M18 6 L20 4" />
                  </svg>
                </button>
              </div>
              <div id="tv-chart" class="chart-container" style="position:relative; touch-action:manipulation;"></div>
            </div>
          </div>
        </div>

        <!-- Bottom Panels -->
        <div class="bottom-panels tab-chart-item">
          <div class="bottom-panels-tabs">
            <button class="bp-tab active" data-bp="orders">Open Orders <span id="open-orders-count" style="font-size:10px; color:var(--text-muted); margin-left:4px;">0</span></button>
            <button class="bp-tab" data-bp="positions">Positions <span id="compact-pos-count" style="font-size:10px; color:var(--text-muted); margin-left:4px;">0</span></button>
            <label id="bp-symbol-filter" style="margin-left:auto; display:flex; align-items:center; gap:4px; font-size:10px; color:var(--text-muted); cursor:pointer; user-select:none; padding:0 8px;">
              <input type="checkbox" id="bp-filter-current-sym" style="accent-color:var(--accent); cursor:pointer; width:12px; height:12px;" />
              Current only
            </label>
            <button id="cancel-all-orders" class="btn-cancel-all" style="display:none;" title="Cancel all open orders">Cancel All</button>
            <button id="cancel-all-scalpers" class="btn-cancel-all" style="display:none; background:#7c3aed; border-color:#7c3aed;" title="Stop all active scalpers">⚔ Kill Scalpers</button>
          </div>
          <div class="bp-content">
            <div class="open-orders-panel bp-pane active" id="bp-orders">
              <div class="oo-header">
                <span class="ooh-sym">Symbol</span>
                <span class="ooh-price">Price</span>
                <span class="ooh-qty">Qty</span>
                <span class="ooh-notional">Notional</span>
                <span class="ooh-age">Age</span>
                <span class="ooh-act"></span>
              </div>
              <div id="open-orders-list" style="max-height:160px; overflow-y:auto; font-size:11px;"></div>
            </div>
            <div class="compact-pos-panel bp-pane" id="bp-positions">
              <div class="compact-pos-header">
                <span class="cph-sym">Symbol</span>
                <span class="cph-size">Size</span>
                <span class="cph-entry">Entry</span>
                <span class="cph-mark">Mark</span>
                <span class="cph-liq">Liq</span>
                <span class="cph-pnl">PnL</span>
                <span class="cph-bbs">BBS</span>
                <span class="cph-act"></span>
              </div>
              <div id="compact-pos-list"></div>
            </div>
          </div>
        </div>

        <!-- Order Book -->
        <div class="orderbook-panel tab-trade-item mob-hidden">
          <div class="panel-header">
            <span>Order Book</span>
            <span class="spread-display" id="ob-spread">—</span>
          </div>
          <div class="ob-header-row">
            <span>Price(USDT)</span>
            <span>Qty</span>
            <span>Total</span>
          </div>
          <div class="ob-asks" id="ob-asks">${cuteSpinner({ mini: true })}</div>
          <div class="ob-mid" id="ob-mid-price">
            <span class="ob-mid-value">—</span>
            <span class="ob-mid-spread" id="ob-mid-spread"></span>
          </div>
          <div class="ob-bids" id="ob-bids">${cuteSpinner({ mini: true })}</div>
        </div>

        <!-- Order Form -->
        <div class="order-form-panel tab-chart-item">
          <div class="panel-header">
            <span>Place Order</span>
            <span id="form-account" class="form-account">${accountName}</span>
          </div>

          <div class="account-info-panel" id="account-info" style="padding: 6px 8px;">
            <div class="acct-info-row">
              <span>Avbl</span>
              <div style="display:flex; align-items:center; gap:6px;">
                <span id="acct-available" style="color: var(--green); font-weight: 600;">$0.00</span>
                <div style="position:relative;">
                  <button id="lev-btn" style="font-size:10px; padding:1px 6px; background:var(--surface-2); border:1px solid var(--border); border-radius:3px; color:var(--accent); cursor:pointer; font-family:var(--font-mono); font-weight:600; white-space:nowrap;">${S.leverage}×</button>
                  <div id="lev-dropdown" style="display:none; position:absolute; top:100%; right:0; margin-top:4px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,0.5); z-index:60; padding:4px; min-width:120px;">
                    <div id="lev-presets" style="display:grid; grid-template-columns:repeat(4,1fr); gap:3px;">
                      ${[1, 2, 3, 5, 10, 20, 50, 100].map(v => `<button data-lev="${v}" style="font-size:11px; padding:4px 2px; background:${S.leverage === v ? 'var(--accent)' : 'var(--surface-2)'}; color:${S.leverage === v ? 'white' : 'var(--text)'}; border:1px solid ${S.leverage === v ? 'var(--accent)' : 'var(--border)'}; border-radius:4px; cursor:pointer; font-family:var(--font-mono); font-weight:600;">${v}×</button>`).join('')}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>


          <div class="ot-dropdown" id="ot-dropdown" style="margin: 8px 10px 4px; position:relative; user-select:none;">
            <button id="ot-trigger" class="ot-trigger">
              <span class="ot-selected-icon" id="ot-selected-icon">${{ 'MARKET': '⚡', 'LIMIT': '📌', 'SCALE': '📊', 'TWAP': '⏱️', 'TRAIL': '🛡️', 'CHASE': '🎯', 'SCALPER': '⚔️', 'AGENT': '🤖', 'SMART': '🧠' }[S.orderType] || '⚡'}</span>
              <span class="ot-selected-label" id="ot-selected-label">${{ 'MARKET': 'Market', 'LIMIT': 'Limit', 'SCALE': 'Scale', 'TWAP': 'TWAP', 'TRAIL': 'Trail Stop', 'CHASE': 'Chase', 'SCALPER': 'Scalper', 'AGENT': 'Agent', 'SMART': 'SmartOrder' }[S.orderType] || 'Market'}</span>
              <svg class="ot-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="ot-menu" id="ot-menu">
              <div class="ot-option${S.orderType === 'MARKET' ? ' active' : ''}" data-type="MARKET">
                <span class="ot-opt-icon">⚡</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Market</span><span class="ot-opt-desc">Instant fill at best price</span></div>
              </div>
              <div class="ot-option${S.orderType === 'LIMIT' ? ' active' : ''}" data-type="LIMIT">
                <span class="ot-opt-icon">📌</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Limit</span><span class="ot-opt-desc">Set your entry price</span></div>
              </div>
              <div class="ot-divider"></div>
              <div class="ot-option${S.orderType === 'SCALE' ? ' active' : ''}" data-type="SCALE">
                <span class="ot-opt-icon">📊</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Scale</span><span class="ot-opt-desc">Ladder orders across a range</span></div>
              </div>
              <div class="ot-option${S.orderType === 'TWAP' ? ' active' : ''}" data-type="TWAP">
                <span class="ot-opt-icon">⏱️</span>
                <div class="ot-opt-text"><span class="ot-opt-name">TWAP</span><span class="ot-opt-desc">Split order over time</span></div>
              </div>
              <div class="ot-option${S.orderType === 'CHASE' ? ' active' : ''}" data-type="CHASE">
                <span class="ot-opt-icon">🎯</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Chase</span><span class="ot-opt-desc">Stalk the best quote</span></div>
              </div>

              <div class="ot-option${S.orderType === 'SCALPER' ? ' active' : ''}" data-type="SCALPER">
                <span class="ot-opt-icon">⚔️</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Scalper</span><span class="ot-opt-desc">Dual chase — long &amp; short layers</span></div>
              </div>
              <div class="ot-option${S.orderType === 'SMART' ? ' active' : ''}" data-type="SMART">
                <span class="ot-opt-icon">🧠</span>
                <div class="ot-opt-text"><span class="ot-opt-name">SmartOrder</span><span class="ot-opt-desc">Adaptive TCA-driven scalper</span></div>
              </div>
              <div class="ot-option${S.orderType === 'AGENT' ? ' active' : ''}" data-type="AGENT">
                <span class="ot-opt-icon">🤖</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Agent</span><span class="ot-opt-desc">Auto-trading strategies</span></div>
              </div>
              <div class="ot-divider"></div>
              <div class="ot-option${S.orderType === 'TRAIL' ? ' active' : ''}" data-type="TRAIL">
                <span class="ot-opt-icon">🛡️</span>
                <div class="ot-opt-text"><span class="ot-opt-name">Trail Stop</span><span class="ot-opt-desc">Trailing stop-loss on position</span></div>
              </div>
            </div>
          </div>
          <div class="side-toggle-mini">
            <button id="btn-long" class="${S.selectedSide === 'LONG' ? 'active-long' : ''}">Long</button>
            <button id="btn-short" class="${S.selectedSide === 'SHORT' ? 'active-short' : ''}">Short</button>
            <button id="btn-neutral" style="display:none;">🧲 Neutral</button>
          </div>

          <div class="input-group-mini" id="limit-price-group" style="display:${S.orderType === 'LIMIT' ? '' : 'none'};">
            <label>Limit Price (USDT)</label>
            <input type="number" id="limit-price" placeholder="0.00" step="0.01" inputmode="decimal" />
          </div>

          <!-- Scale Order Controls -->
          <div id="scale-controls" style="display:${S.orderType === 'SCALE' ? '' : 'none'}; padding:0 10px;">
            <div class="scale-order-count" style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Orders</label>
                <span id="scale-count-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">10</span>
              </div>
              <input type="range" id="scale-count" min="5" max="30" value="10" step="1" style="width:100%;" />
            </div>
            <div class="scale-dist-toggle" style="display:flex; gap:4px; margin-bottom:8px;">
              <button id="scale-linear" class="btn btn-outline btn-sm" style="flex:1; font-size:10px; padding:4px; background:var(--accent); color:white; border-color:var(--accent);">Linear</button>
              <button id="scale-geometric" class="btn btn-outline btn-sm" style="flex:1; font-size:10px; padding:4px;">Geometric</button>
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Skew</label>
                <span id="scale-skew-val" style="font-size:11px; font-weight:600; color:var(--text); font-family:var(--font-mono);">0</span>
              </div>
              <input type="range" id="scale-skew" min="-100" max="100" value="0" step="5" style="width:100%;" />
              <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:2px;">
                <span>◀ Heavy lower</span>
                <span>Equal</span>
                <span>Heavy upper ▶</span>
              </div>
            </div>
            <div class="scale-price-range" style="display:flex; gap:8px; margin-bottom:8px; font-size:11px;">
              <div style="flex:1;">
                <label style="color:var(--text-muted); font-size:9px; text-transform:uppercase; margin-bottom:2px; display:block;">Upper</label>
                <input type="number" id="scale-upper" step="0.01" placeholder="—" inputmode="decimal" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-weight:600; font-family:var(--font-mono); color:var(--text); font-size:12px;" />
              </div>
              <div style="flex:1;">
                <label style="color:var(--text-muted); font-size:9px; text-transform:uppercase; margin-bottom:2px; display:block;">Lower</label>
                <input type="number" id="scale-lower" step="0.01" placeholder="—" inputmode="decimal" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-weight:600; font-family:var(--font-mono); color:var(--text); font-size:12px;" />
              </div>
            </div>
            <button id="scale-pick-range" class="btn btn-outline btn-sm" style="width:100%; font-size:11px; padding:6px; margin-bottom:8px; border-color:var(--accent); color:var(--accent);">📍 Select Range on Chart</button>
            <div id="scale-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px;"></div>
          </div>

          <!-- TWAP Controls -->
          <div id="twap-controls" style="display:${S.orderType === 'TWAP' ? '' : 'none'}; padding:0 10px;">
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Lots</label>
                <span id="twap-lots-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">10</span>
              </div>
              <input type="range" id="twap-lots" min="2" max="50" value="10" step="1" style="width:100%;" />
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Duration (min)</label>
                <span id="twap-dur-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">30</span>
              </div>
              <input type="range" id="twap-duration" min="1" max="720" value="30" step="1" style="width:100%;" />
            </div>
            <div style="display:flex; gap:12px; margin-bottom:8px;">
              <label style="font-size:11px; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" id="twap-jitter" /> Jitter ±20%
              </label>
              <label style="font-size:11px; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" id="twap-irregular" /> Irregular lots
              </label>
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label id="twap-price-limit-label" style="font-size:11px; color:var(--text-muted); margin:0;">${S.selectedSide === 'SHORT' ? 'Min Sell Price' : 'Max Buy Price'}</label>
                <span style="font-size:9px; color:var(--text-muted); opacity:0.7;">optional</span>
              </div>
              <input type="number" id="twap-price-limit" placeholder="No limit" step="0.01" inputmode="decimal" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-weight:600; font-family:var(--font-mono); color:var(--text); font-size:12px;" />
              <div id="twap-price-limit-hint" style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">${S.selectedSide === 'SHORT' ? 'TWAP will skip lots if price drops below this' : 'TWAP will skip lots if price rises above this'}</div>
            </div>
            <div id="twap-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px; margin-bottom:4px;"></div>
          </div>

          <!-- Trail Stop Controls -->
          <div id="trail-stop-controls" style="display:${S.orderType === 'TRAIL' ? '' : 'none'}; padding:0 10px;">
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Callback %</label>
                <span id="trail-callback-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">1.0%</span>
              </div>
              <input type="range" id="trail-callback" min="0.1" max="5" value="1" step="0.1" style="width:100%;" />
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Activation Price</label>
                <span style="font-size:9px; color:var(--text-muted); opacity:0.7;">optional</span>
              </div>
              <input type="number" id="trail-activation" placeholder="Immediate" step="0.01" inputmode="decimal" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-weight:600; font-family:var(--font-mono); color:var(--text); font-size:12px;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">Only start trailing after price reaches this level</div>
            </div>
            <div style="margin-bottom:8px;">
              <label style="font-size:11px; color:var(--text-muted); margin:0; display:block; margin-bottom:4px;">Position</label>
              <select id="trail-position" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-family:var(--font-mono); color:var(--text); font-size:12px;">
                <option value="">— Select position —</option>
              </select>
            </div>
            <div id="trail-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px; margin-bottom:4px;"></div>
          </div>

          <!-- Chase Limit Controls -->
          <div id="chase-controls" style="display:${S.orderType === 'CHASE' ? '' : 'none'}; padding:0 10px;">
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Stalk Offset %</label>
                <span id="chase-offset-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">0.00%</span>
              </div>
              <input type="range" id="chase-offset" min="0" max="5" value="0" step="0.01" style="width:100%;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">0 = chase at best bid/ask. Higher = place order further away.</div>
            </div>
            <div style="margin-bottom:8px;">
              <label style="font-size:11px; color:var(--text-muted); margin:0; display:block; margin-bottom:4px;">Stalk Mode</label>
              <div style="display:flex; gap:8px; font-size:11px;">
                <label style="display:flex; align-items:center; gap:3px; color:var(--text-muted); cursor:pointer;">
                  <input type="radio" name="chase-stalk-mode" value="none" checked style="accent-color:var(--accent);"> None
                </label>
                <label style="display:flex; align-items:center; gap:3px; color:var(--text-muted); cursor:pointer;">
                  <input type="radio" name="chase-stalk-mode" value="maintain" style="accent-color:var(--accent);"> Maintain
                </label>
                <label style="display:flex; align-items:center; gap:3px; color:var(--text-muted); cursor:pointer;">
                  <input type="radio" name="chase-stalk-mode" value="trail" style="accent-color:var(--accent);"> Trail
                </label>
              </div>
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">Maintain = follow both ways. Trail = only move toward market.</div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Max Distance %</label>
                <span style="font-size:9px; color:var(--text-muted); opacity:0.7;">0 = infinite</span>
              </div>
              <input type="number" id="chase-distance" placeholder="0 (infinite)" step="0.1" min="0" max="50" inputmode="decimal" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-weight:600; font-family:var(--font-mono); color:var(--text); font-size:12px;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">Auto-cancel if price moves beyond this % from start</div>
            </div>
            <div id="chase-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px; margin-bottom:4px;"></div>
          </div>

          <!-- Scalper Controls -->
          <div id="scalper-controls" style="display:${S.orderType === 'SCALPER' ? '' : 'none'}; padding:0 10px;">
            <div style="margin-bottom:8px;">

              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--cyan,#06b6d4); margin:0;">Long Offset %</label>
                <span id="scalper-long-off-val" style="font-size:13px; font-weight:600; color:var(--cyan,#06b6d4); font-family:var(--font-mono);">0.300%</span>
              </div>
              <input type="range" id="scalper-long-offset" min="0" max="3" value="0.3" step="0.01" style="width:100%;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">BUY chase placed this far below best bid</div>
            </div>
            <!-- Short offset -->
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--orange,#f97316); margin:0;">Short Offset %</label>
                <span id="scalper-short-off-val" style="font-size:13px; font-weight:600; color:var(--orange,#f97316); font-family:var(--font-mono);">0.300%</span>
              </div>
              <input type="range" id="scalper-short-offset" min="0" max="3" value="0.3" step="0.01" style="width:100%;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">SELL chase placed this far above best ask</div>
            </div>
            <!-- Child count -->
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Layers / side</label>
                <span id="scalper-count-val" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">1</span>
              </div>
              <input type="range" id="scalper-child-count" min="1" max="10" value="1" step="1" style="width:100%;" />
              <div style="font-size:9px; color:var(--text-muted); margin-top:3px; opacity:0.7;">Split each side into N exponentially-spaced chases</div>
            </div>
            <!-- Skew -->
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:11px; color:var(--text-muted); margin:0;">Skew</label>
                <span id="scalper-skew-val" style="font-size:11px; font-weight:600; color:var(--text); font-family:var(--font-mono);">0</span>
              </div>
              <input type="range" id="scalper-skew" min="-100" max="100" value="0" step="5" style="width:100%;" />
              <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:2px;">
                <span>◀ Heavy close</span>
                <span>Equal</span>
                <span>Heavy far ▶</span>
              </div>
            </div>
            <!-- Price Filter -->
            <div style="margin-bottom:8px;">
              <div style="font-size:10px; color:var(--text-muted); margin-bottom:6px; letter-spacing:0.03em;">Price Filters <span style="opacity:0.5; font-style:italic;">(optional)</span></div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                <div>
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                    <label style="font-size:9px; color:var(--cyan,#06b6d4);">LONG max price</label>
                    <label style="display:flex; align-items:center; gap:3px; cursor:pointer; font-size:8px; color:var(--text-muted);">
                      <input type="checkbox" id="scalper-pin-long-max" style="accent-color:var(--cyan,#06b6d4); cursor:pointer; width:11px; height:11px;" />
                      pin entry
                    </label>
                  </div>
                  <input type="number" id="scalper-long-max-price" placeholder="no limit" min="0" step="any" inputmode="decimal"
                    style="width:100%; box-sizing:border-box; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-weight:600; font-family:var(--font-mono); color:var(--cyan,#06b6d4); font-size:11px; text-align:right;" />
                </div>
                <div>
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                    <label style="font-size:9px; color:var(--orange,#f97316);">SHORT min price</label>
                    <label style="display:flex; align-items:center; gap:3px; cursor:pointer; font-size:8px; color:var(--text-muted);">
                      <input type="checkbox" id="scalper-pin-short-min" style="accent-color:var(--orange,#f97316); cursor:pointer; width:11px; height:11px;" />
                      pin entry
                    </label>
                  </div>
                  <input type="number" id="scalper-short-min-price" placeholder="no limit" min="0" step="any" inputmode="decimal"
                    style="width:100%; box-sizing:border-box; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-weight:600; font-family:var(--font-mono); color:var(--orange,#f97316); font-size:11px; text-align:right;" />
                </div>
              </div>
            </div>
            <!-- Anti-overtrading / advanced scalper settings (always visible) -->
            <div id="scalper-neutral-settings">
              <div style="border-top:1px solid rgba(255,255,255,0.07); padding-top:8px; margin-bottom:8px;">
                <div style="font-size:10px; color:#a855f7; font-weight:600; margin-bottom:6px;">⚙️ Advanced Scalper Settings</div>
                <!-- Min fill spread -->
                <div style="margin-bottom:8px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                    <label style="font-size:10px; color:var(--text-muted); margin:0;">Min fill spread %</label>
                    <span id="scalper-fill-spread-val" style="font-size:11px; font-weight:600; color:var(--text); font-family:var(--font-mono);">0.00%</span>
                  </div>
                  <input type="range" id="scalper-min-fill-spread" min="0" max="3" value="0" step="0.01" style="width:100%;" />
                  <div style="font-size:8px; color:var(--text-muted); opacity:0.7; margin-top:2px;">Min price gap before re-placing on the same side after a fill</div>
                </div>
                <!-- Decay half-life -->
                <div style="margin-bottom:8px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                    <label style="font-size:10px; color:var(--text-muted); margin:0;">Spread decay (s)</label>
                    <span id="scalper-fill-decay-val" style="font-size:11px; font-weight:600; color:var(--text); font-family:var(--font-mono);">30s</span>
                  </div>
                  <input type="range" id="scalper-fill-decay-halflife" min="5" max="300" value="30" step="5" style="width:100%;" />
                  <div style="font-size:8px; color:var(--text-muted); opacity:0.7; margin-top:2px;">Half-life: spread cooldown halves every this many seconds</div>
                </div>
                <!-- Min refill delay -->
                <div style="margin-bottom:8px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                    <label style="font-size:10px; color:var(--text-muted); margin:0;">Refill delay (s)</label>
                    <span id="scalper-refill-delay-val" style="font-size:11px; font-weight:600; color:var(--text); font-family:var(--font-mono);">0s</span>
                  </div>
                  <input type="range" id="scalper-min-refill-delay" min="0" max="120" value="0" step="1" style="width:100%;" />
                  <div style="font-size:8px; color:var(--text-muted); opacity:0.7; margin-top:2px;">Min wait after a fill before re-placing (doubles each fill)</div>
                </div>
                <!-- Allow loss -->
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; font-size:10px; color:var(--text-muted);">
                  <input type="checkbox" id="scalper-allow-loss" style="accent-color:#f43f5e; cursor:pointer;" />
                  Allow trading at loss <span style="opacity:0.6;">(by default, short min &amp; long max are pinned to entry)</span>
                </label>
                <!-- Risk guards + PnL feedback — compact 3-col row -->
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.06);">
                  <!-- Max loss bps -->
                  <div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                      <label style="font-size:8px; color:var(--text-muted);">Max loss</label>
                      <span id="scalper-max-loss-close-val" style="font-size:9px; font-weight:700; color:#f43f5e; font-family:var(--font-mono);">off</span>
                    </div>
                    <input type="range" id="scalper-max-loss-close" min="0" max="500" value="0" step="10" style="width:100%;" />
                    <div style="font-size:7px; color:var(--text-muted); opacity:0.6; margin-top:1px;">bps drawdown</div>
                  </div>
                  <!-- Max fills/min -->
                  <div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                      <label style="font-size:8px; color:var(--text-muted);">Max fills</label>
                      <span id="scalper-max-fills-pm-val" style="font-size:9px; font-weight:700; color:var(--text); font-family:var(--font-mono);">off</span>
                    </div>
                    <input type="range" id="scalper-max-fills-pm" min="0" max="20" value="0" step="1" style="width:100%;" />
                    <div style="font-size:7px; color:var(--text-muted); opacity:0.6; margin-top:1px;">per min / side</div>
                  </div>
                  <!-- PnL feedback -->
                  <div>
                    <label style="font-size:8px; color:var(--text-muted); display:block; margin-bottom:3px;">🧠 Feedback</label>
                    <div style="display:flex; gap:2px;">
                      <button id="scalper-feedback-off" data-feedback="off"
                        style="flex:1; padding:3px 0; border-radius:3px; font-size:9px; font-weight:700; cursor:pointer; border:1px solid var(--accent); background:var(--accent); color:white;">Off</button>
                      <button id="scalper-feedback-soft" data-feedback="soft"
                        style="flex:1; padding:3px 0; border-radius:3px; font-size:9px; font-weight:700; cursor:pointer; border:1px solid rgba(255,255,255,0.1); background:transparent; color:var(--text-muted);">Soft</button>
                      <button id="scalper-feedback-full" data-feedback="full"
                        style="flex:1; padding:3px 0; border-radius:3px; font-size:9px; font-weight:700; cursor:pointer; border:1px solid rgba(255,255,255,0.1); background:transparent; color:var(--text-muted);">Full</button>
                    </div>
                    <div style="font-size:7px; color:var(--text-muted); opacity:0.6; margin-top:2px;">offset adapt</div>
                    <input type="hidden" id="scalper-feedback-mode" value="off" />
                  </div>
                </div>

              </div>
            </div>
            <div id="scalper-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px; margin-bottom:4px;"></div>
          </div>

          <!-- Agent Controls -->
          <div id="agent-controls" style="display:${S.orderType === 'AGENT' ? '' : 'none'}; padding:0 10px;">
            <div style="margin-bottom:8px;">
              <label style="font-size:11px; color:var(--text-muted); margin:0 0 4px; display:block;">Strategy Type</label>
              <div style="display:flex; gap:4px;">
                <button class="agent-type-btn" data-agent-type="trend" style="flex:1; padding:5px 0; border-radius:5px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:11px; font-weight:600; cursor:pointer;">📈 Trend</button>
                <button class="agent-type-btn" data-agent-type="grid" style="flex:1; padding:5px 0; border-radius:5px; border:1px solid var(--border); background:var(--surface-2); color:var(--text); font-size:11px; font-weight:600; cursor:pointer;">📊 Grid</button>
                <button class="agent-type-btn" data-agent-type="deleverage" style="flex:1; padding:5px 0; border-radius:5px; border:1px solid var(--border); background:var(--surface-2); color:var(--text); font-size:11px; font-weight:600; cursor:pointer;">🔻 Delev</button>
              </div>
            </div>

            <!-- Trend Agent Config -->
            <div id="agent-trend-config">
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Fast EMA</label>
                  <input type="number" id="agent-trend-fast" value="10" min="2" max="100" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Slow EMA</label>
                  <input type="number" id="agent-trend-slow" value="50" min="5" max="500" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Offset %</label>
                  <input type="number" id="agent-trend-offset" value="0.15" min="0.01" max="5" step="0.01" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Layers</label>
                  <input type="number" id="agent-trend-layers" value="2" min="1" max="10" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="font-size:9px; color:var(--text-muted); margin-bottom:4px; opacity:0.7;">Spawns directional scalpers on EMA crossover</div>
            </div>

            <!-- Grid Agent Config -->
            <div id="agent-grid-config" style="display:none;">
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Offset %</label>
                  <input type="number" id="agent-grid-offset" value="0.2" min="0.01" max="5" step="0.01" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Layers</label>
                  <input type="number" id="agent-grid-layers" value="3" min="1" max="10" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Max DD ($)</label>
                  <input type="number" id="agent-grid-max-dd" value="10" min="1" max="1000" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Cooldown (s)</label>
                  <input type="number" id="agent-grid-cooldown" value="60" min="5" max="600" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="font-size:9px; color:var(--text-muted); margin-bottom:4px; opacity:0.7;">Neutral market-making scalper with auto-pause on drawdown</div>
            </div>

            <!-- Deleverage Agent Config -->
            <div id="agent-deleverage-config" style="display:none;">
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Max Notional ($)</label>
                  <input type="number" id="agent-delev-max-notional" value="500" min="10" max="50000" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Unwind %</label>
                  <input type="number" id="agent-delev-unwind-pct" value="30" min="5" max="100" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Max Loss (bps)</label>
                  <input type="number" id="agent-delev-max-loss" value="200" min="0" max="10000" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
                <div style="flex:1;">
                  <label style="font-size:10px; color:var(--text-muted);">Offset %</label>
                  <input type="number" id="agent-delev-offset" value="0.2" min="0.01" max="5" step="0.01" style="width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; color:var(--text); font-family:var(--font-mono);" />
                </div>
              </div>
              <div style="font-size:9px; color:var(--text-muted); margin-bottom:4px; opacity:0.7;">Unwinds position when notional exceeds cap</div>
            </div>

            <div id="agent-preview" style="font-size:10px; color:var(--text-muted); text-align:center; min-height:20px; margin-bottom:4px;"></div>
          </div>



          <!-- Size -->
          <div style="margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <label style="font-size: 12px; color: var(--text-muted); margin:0;">Size</label>
              <div style="display: flex; align-items: center; gap: 4px;">
                <span id="size-pct-label" style="font-size: 13px; font-weight: 600; color: var(--text); font-family: var(--font-mono);">0%</span>
                <span style="font-size: 11px; color: var(--text-muted);">USDT</span>
              </div>
            </div>
            <div class="size-slider-track" id="size-slider-track">
              <div class="size-slider-fill" id="size-slider-fill"></div>
              <input type="range" id="size-slider" min="0" max="100" value="0" step="1" class="size-slider-input" />
              <div class="size-slider-markers">
                <span class="slider-diamond" data-pct="0"></span>
                <span class="slider-diamond" data-pct="25"></span>
                <span class="slider-diamond" data-pct="50"></span>
                <span class="slider-diamond" data-pct="75"></span>
                <span class="slider-diamond" data-pct="100"></span>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
              <span id="size-buy-label">Buy 0 USDT</span>
              <span id="size-sell-label">Sell 0 USDT</span>
            </div>
          </div>

          <div class="input-group-mini">
            <label style="font-size: 11px; color: var(--text-muted);">Size (USDT)</label>
            <input type="number" id="trade-size" value="" placeholder="0.00" step="1" inputmode="decimal" style="background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:4px; font-size:13px; font-weight:600; padding:6px 8px; width:100%; font-family:var(--font-mono);" />
          </div>

          <div class="order-preview" id="order-preview" style="display:none;">
            <div class="prev-row"><span>Notional</span><span id="prev-notional">—</span></div>
            <div class="prev-row"><span>Liq. Price</span><span id="prev-liq">—</span></div>
            <div class="prev-row" id="prev-min-row" style="display:none;"><span>Min Order</span><span id="prev-min">—</span></div>
          </div>

          <label id="babysitter-toggle-group" style="display:flex; align-items:center; gap:6px; padding:4px 10px; font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;">
            <input type="checkbox" id="babysitter-toggle" style="accent-color:var(--accent); cursor:pointer;" />
            Babysitter
          </label>
          <label id="reduce-only-toggle-group" style="display:flex; align-items:center; gap:6px; padding:4px 10px; font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;">
            <input type="checkbox" id="reduce-only-toggle" style="accent-color:var(--accent); cursor:pointer;" />
            Reduce Only
          </label>

          <button id="submit-trade" class="btn-submit btn-submit-${S.selectedSide.toLowerCase()}">${S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'}</button>

          <div class="form-balance">
            <span>Avbl</span>
            <span id="form-available">$0.00</span>
          </div>

          <div class="equity-upnl-panel" style="margin-top:6px; padding:8px 10px; background:var(--surface-2); border-radius:6px; border:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:11px; color:var(--text-muted);">Equity</span>
              <span id="equity-value" style="font-size:13px; font-weight:600; color:var(--text); font-family:var(--font-mono);">$0.00</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:11px; color:var(--text-muted);">UPNL</span>
              <span id="upnl-value" style="font-size:13px; font-weight:600; color:var(--text-muted); font-family:var(--font-mono);">$0.00</span>
            </div>
          </div>
        </div>

        <!-- Trade Tape -->
        <div class="tape-panel tab-trade-item mob-hidden">
          <div class="panel-header"><span>Recent Trades</span></div>
          <div class="tape-header-row">
            <span>Price(USDT)</span>
            <span>Qty</span>
            <span>Time</span>
          </div>
          <div class="tape-list" id="trade-tape">${cuteSpinner({ mini: true })}</div>
        </div>
      </div>
    </div>
  `;
}
