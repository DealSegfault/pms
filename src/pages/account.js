// ── Account Page (Shell) ──
// HTML template + init wiring. All logic delegated to sub-modules:
//   account/api-keys.js   — API key generate/copy/regen
//   account/webauthn.js   — Biometric login
//   account/stats.js      — PnL stats & equity chart
//   account/scanner-bot.js — Scanner grid, V7 engines, bot config

import { state, api, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { THEMES, getTheme, applyTheme } from '../css/theme-manager.js';
import { initApiKeySection } from './account/api-keys.js';
import { initWebAuthnSection } from './account/webauthn.js';
import { loadAccountStats, updatePnlPeriod } from './account/stats.js';
import { initScannerTab, initBotSection, clearBotStatusInterval } from './account/scanner-bot.js';

let _botStatusListenerRef = { fn: null };
let _botEventListenerRef = { fn: null };
let _babysitterStatusListener = null;

export function renderAccountPage(container) {
  // Clear previous listeners
  clearBotStatusInterval();
  if (_botStatusListenerRef.fn) { window.removeEventListener('bot_status', _botStatusListenerRef.fn); _botStatusListenerRef.fn = null; }
  if (_botEventListenerRef.fn) { window.removeEventListener('bot_event', _botEventListenerRef.fn); _botEventListenerRef.fn = null; }
  if (_babysitterStatusListener) { window.removeEventListener('bot_status', _babysitterStatusListener); _babysitterStatusListener = null; }

  const currentTheme = getTheme();

  container.innerHTML = `
    <div id="account-page">
      <div class="section-header">
        <h2 class="section-title">My Account</h2>
      </div>

      <!-- ═══════════════════════════════════ -->
      <!-- THEME SELECTOR                     -->
      <!-- ═══════════════════════════════════ -->
      <div class="glass-card" style="margin-bottom:16px;">
        <div class="card-title" style="margin-bottom:12px;">🎨 Theme</div>
        <div id="theme-picker" style="display:flex; gap:10px; flex-wrap:wrap;">
          ${THEMES.map(t => `
            <button
              class="theme-swatch${t.id === currentTheme ? ' theme-swatch-active' : ''}"
              data-theme-id="${t.id}"
              style="
                flex:1; min-width:100px; padding:14px 12px;
                background: linear-gradient(135deg, ${t.bg[0]}, ${t.bg[1]});
                border: 2px solid ${t.id === currentTheme ? t.color : 'var(--border)'};
                border-radius: var(--radius);
                cursor: pointer;
                transition: all 0.2s;
                display:flex; flex-direction:column; align-items:center; gap:6px;
                position:relative; overflow:hidden;
              "
            >
              <span style="font-size:24px;">${t.emoji}</span>
              <span style="font-size:13px; font-weight:700; color:${t.color};">${t.label}</span>
              <div style="display:flex; gap:4px; margin-top:2px;">
                <span style="width:12px;height:12px;border-radius:50%;background:${t.color};"></span>
                <span style="width:12px;height:12px;border-radius:50%;background:${t.green};"></span>
                <span style="width:12px;height:12px;border-radius:50%;background:${t.red};"></span>
              </div>
              ${t.id === currentTheme ? '<div style="position:absolute;top:6px;right:8px;font-size:12px;">✓</div>' : ''}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- ═══════════════════════════════════ -->
      <!-- API KEY SECTION                    -->
      <!-- ═══════════════════════════════════ -->
      <div class="glass-card" style="margin-bottom:16px;">
        <div class="card-title" style="margin-bottom:12px;">🔑 API Key</div>
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:10px;">Use this key to authenticate bot/API requests via the <code>X-PMS-Key</code> header.</div>
        <div id="api-key-display" style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
          <input id="api-key-value" type="text" readonly
            style="flex:1; padding:8px 12px; background:var(--card-bg); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; font-family:var(--font-mono); font-size:12px; cursor:default;"
            value="Loading…" />
          <button id="api-key-copy-btn" class="btn" style="padding:6px 12px; font-size:12px; white-space:nowrap;" disabled>📋 Copy</button>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="api-key-generate-btn" class="btn btn-primary" style="padding:6px 14px; font-size:12px;">Generate Key</button>
          <button id="api-key-regenerate-btn" class="btn" style="padding:6px 14px; font-size:12px; display:none;">🔄 Regenerate</button>
        </div>
        <div id="api-key-status" style="font-size:10px; margin-top:6px;"></div>
      </div>


      <!-- ═══════════════════════════════════ -->
      <!-- BIOMETRIC LOGIN SECTION            -->
      <!-- ═══════════════════════════════════ -->
      <div class="glass-card" style="margin-bottom:16px;">
        <div class="card-title" style="margin-bottom:12px;">🔐 Biometric Login</div>
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:12px;">
          Register your fingerprint, face, or security key for passwordless login.
        </div>
        <div id="webauthn-credentials-list" style="margin-bottom:12px;"></div>
        <button id="webauthn-register-btn" class="btn btn-primary" style="padding:8px 16px; font-size:12px; display:flex; align-items:center; gap:6px;">
          <span style="font-size:18px;">👆</span> Register Biometric
        </button>
        <div id="webauthn-status" style="font-size:11px; margin-top:8px;"></div>
      </div>


      <!-- ═══════════════════════════════════ -->
      <!-- STATS TAB                          -->
      <!-- ═══════════════════════════════════ -->
      <div id="tab-stats">
        <!-- Balance Card -->
        <div class="glass-card" id="acct-balance-card">
          <div style="text-align:center;">
            <div class="price-label">Account Balance</div>
            <div id="acct-balance" class="price-big" style="font-size:28px;">—</div>
          </div>
        </div>

        <!-- PnL Period Tabs -->
        <div class="tab-bar" id="pnl-period-bar" style="margin-bottom:12px;">
          <button class="active" data-period="today">Today</button>
          <button data-period="week">7d</button>
          <button data-period="month">30d</button>
          <button data-period="all">All</button>
        </div>

        <!-- PnL Summary -->
        <div class="glass-card" id="acct-pnl-card">
          <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
            <div>
              <div class="price-label">Realized PnL</div>
              <div id="acct-rpnl" class="price-big" style="font-size:22px;">—</div>
            </div>
            <div style="text-align:right;">
              <div class="price-label">Win Rate</div>
              <div id="acct-winrate" class="price-big" style="font-size:22px;">—</div>
            </div>
          </div>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Trades</div>
              <div class="stat-value" id="acct-trade-count">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Wins</div>
              <div class="stat-value" id="acct-wins" style="color:var(--green);">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Losses</div>
              <div class="stat-value" id="acct-losses" style="color:var(--red);">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Fees</div>
              <div class="stat-value" id="acct-fees">$0</div>
            </div>
          </div>
        </div>

        <!-- Activity Stats -->
        <div class="glass-card">
          <div class="card-title" style="margin-bottom:10px;">Activity</div>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Total Trades</div>
              <div class="stat-value" id="acct-total-trades">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Avg PnL</div>
              <div class="stat-value" id="acct-avg-pnl">$0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Best Trade</div>
              <div class="stat-value" id="acct-best" style="color:var(--green);">$0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Worst Trade</div>
              <div class="stat-value" id="acct-worst" style="color:var(--red);">$0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Profit Factor</div>
              <div class="stat-value" id="acct-pf">—</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Total Fees</div>
              <div class="stat-value" id="acct-total-fees">$0</div>
            </div>
          </div>
        </div>

        <!-- Equity Curve -->
        <div class="glass-card">
          <div class="card-title" style="margin-bottom:10px;">Equity Curve</div>
          <div id="equity-chart" style="height:200px; width:100%;"></div>
        </div>
      </div>



      <!-- ═══════════════════════════════════ -->
      <!-- V7 BABYSITTER SECTION              -->
      <!-- ═══════════════════════════════════ -->
      <div class="glass-card bot-section" id="babysitter-section">
        <div class="bot-header">
          <div class="bot-header-left">
            <div class="bot-icon">🐍</div>
            <div>
              <div class="card-title" style="margin:0;">V7 Babysitter</div>
              <div class="bot-subtitle" id="babysitter-status-text">Per-position control from Trade/Positions list. TP mode below is saved per account.</div>
            </div>
          </div>
        </div>

        <!-- TP Mode Selector (always visible) -->
        <div class="bot-settings-group" style="margin-top:12px;">
          <div class="bot-settings-group-title" style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">TP Strategy</div>
          <select id="babysitter-tp-mode" style="width:100%; padding:8px 12px; background:var(--card-bg); color:var(--text-primary); border:1px solid var(--border); border-radius:8px; font-size:13px; cursor:pointer;">
            <option value="auto">Auto (vol mode &gt; $50)</option>
            <option value="fast">Fast TP (aggressive exits)</option>
            <option value="vol">Vol TP (wider targets)</option>
            <option value="long_short">Long/Short TP (signal-biased exits)</option>
          </select>
          <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">This setting is saved per account and applied to new and active babysitter-managed positions.</div>
          <div id="tp-mode-save-status" style="font-size:10px; margin-top:4px;"></div>
        </div>

        <!-- Babysitter Info (visible when active) -->
        <div id="babysitter-info-panel" style="display:none; margin-top:12px;">
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Active Grids</div>
              <div class="stat-value" id="babysitter-active-grids">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Total PnL</div>
              <div class="stat-value" id="babysitter-total-pnl">$0.00</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Trades</div>
              <div class="stat-value" id="babysitter-trade-count">0</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Exposure</div>
              <div class="stat-value" id="babysitter-exposure">$0</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ── Init all sub-sections ──
  loadAccountStats();
  initBabysitterSection();
  initApiKeySection();
  initWebAuthnSection();

  // Theme picker
  document.querySelectorAll('#theme-picker .theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.dataset.themeId;
      applyTheme(themeId);
      renderAccountPage(container);
    });
  });

  // Period tab clicks
  document.querySelectorAll('#pnl-period-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pnl-period-bar button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (window._acctStats) {
        updatePnlPeriod(window._acctStats.periods, btn.dataset.period);
      }
    });
  });
}

// ── Babysitter TP mode + live status ────────────────

async function initBabysitterSection() {
  if (!state.currentAccount) return;

  const infoPanel = document.getElementById('babysitter-info-panel');
  const statusText = document.getElementById('babysitter-status-text');

  try {
    const config = await api(`/bot/config/${state.currentAccount}`);
    const tpSelect = document.getElementById('babysitter-tp-mode');
    if (tpSelect && config?.tpMode) {
      tpSelect.value = config.tpMode;
    }
    if (tpSelect) {
      tpSelect.addEventListener('change', async () => {
        try {
          const statusEl = document.getElementById('tp-mode-save-status');
          await api(`/bot/config/${state.currentAccount}`, {
            method: 'PUT',
            body: { tpMode: tpSelect.value },
          });
          console.log(`[Babysitter] TP mode saved: ${tpSelect.value}`);
          if (statusEl) {
            statusEl.textContent = '✅ Saved';
            statusEl.style.color = 'var(--green)';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
          }
        } catch (err) {
          console.error('Failed to save TP mode:', err);
        }
      });
    }
  } catch (err) {
    console.warn('Babysitter init error:', err);
  }

  _babysitterStatusListener = (e) => {
    const data = e.detail;
    if (data?.source !== 'v7' || data?.subAccountId !== state.currentAccount) return;

    const v7 = data.v7 || {};
    const engines = data.engines || [];
    const gridsEl = document.getElementById('babysitter-active-grids');
    const pnlEl = document.getElementById('babysitter-total-pnl');
    const tradesEl = document.getElementById('babysitter-trade-count');
    const exposureEl = document.getElementById('babysitter-exposure');

    if (gridsEl) gridsEl.textContent = v7.activeGrids || 0;
    if (pnlEl) {
      pnlEl.textContent = formatUsd(v7.totalPnlUsd || 0, 4);
      pnlEl.className = `stat-value ${formatPnlClass(v7.totalPnlUsd || 0)}`;
    }
    if (tradesEl) tradesEl.textContent = v7.totalTrades || 0;
    if (exposureEl) exposureEl.textContent = `$${(v7.portfolioNotional || 0).toFixed(0)}`;
    if (statusText) statusText.textContent = 'Active — managed per position (adjust per-position in Trade/Positions)';
    if (infoPanel) infoPanel.style.display = '';

    let tpContainer = document.getElementById('babysitter-tp-orders');
    if (!tpContainer) {
      const infoPanel = document.getElementById('babysitter-info-panel');
      if (infoPanel) {
        const div = document.createElement('div');
        div.id = 'babysitter-tp-orders';
        div.style.marginTop = '10px';
        infoPanel.appendChild(div);
        tpContainer = div;
      }
    }
    if (tpContainer) {
      const tpEngines = engines.filter(eng => eng.restingTpPrice > 0);
      if (tpEngines.length > 0) {
        tpContainer.innerHTML = `
          <div class="card-title" style="font-size:12px; margin-bottom:6px;">🎯 Resting TP Orders</div>
          ${tpEngines.map(eng => {
          const sym = (eng.symbol || '').replace('USDT', '').replace('/USDT:USDT', '');
          const slices = eng.restingTpSlices > 1 ? ` (${eng.restingTpSlices} slices)` : '';
          return `<div style="display:flex; justify-content:space-between; font-size:11px; padding:3px 0; color:var(--text-secondary);">
              <span style="color:var(--green); font-weight:600;">BUY ${sym}</span>
              <span style="font-family:var(--font-mono);">${formatPrice(eng.restingTpPrice)} × ${eng.restingTpQty.toFixed(2)}${slices}</span>
            </div>`;
        }).join('')}
        `;
      } else {
        tpContainer.innerHTML = '';
      }
    }
  };
  window.addEventListener('bot_status', _babysitterStatusListener);
}
