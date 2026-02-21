import { state, api, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { THEMES, getTheme, applyTheme } from '../css/theme-manager.js';
import { cuteSeedling, cuteCrystalBall } from '../lib/cute-empty.js';

let _botStatusInterval = null;
let _botStatusListener = null;
let _botEventListener = null;
let _babysitterStatusListener = null;

export function renderAccountPage(container) {
  // Clear any previous bot polling & WS listeners
  if (_botStatusInterval) { clearInterval(_botStatusInterval); _botStatusInterval = null; }
  if (_botStatusListener) { window.removeEventListener('bot_status', _botStatusListener); _botStatusListener = null; }
  if (_botEventListener) { window.removeEventListener('bot_event', _botEventListener); _botEventListener = null; }
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

  loadAccountStats();
  initBabysitterSection();
  initApiKeySection();
  initWebAuthnSection();

  // Theme picker
  document.querySelectorAll('#theme-picker .theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.dataset.themeId;
      applyTheme(themeId);
      // Re-render the page to update swatch states
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

// ═══════════════════════════════════════════════════════
// API KEY SECTION — Generate, copy, regenerate
// ═══════════════════════════════════════════════════════

let _currentApiKey = null; // full key, kept in memory for copy

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 12) return key;
  return key.slice(0, 8) + '••••••••' + key.slice(-4);
}

async function initApiKeySection() {
  const input = document.getElementById('api-key-value');
  const copyBtn = document.getElementById('api-key-copy-btn');
  const genBtn = document.getElementById('api-key-generate-btn');
  const regenBtn = document.getElementById('api-key-regenerate-btn');
  const statusEl = document.getElementById('api-key-status');
  if (!input) return;

  // Load current key from /me
  try {
    const me = await api('/auth/me');
    if (me.apiKey) {
      _currentApiKey = me.apiKey;
      input.value = maskApiKey(me.apiKey);
      copyBtn.disabled = false;
      genBtn.style.display = 'none';
      regenBtn.style.display = '';
    } else {
      input.value = 'No API key yet';
      copyBtn.disabled = true;
      genBtn.style.display = '';
      regenBtn.style.display = 'none';
    }
  } catch {
    input.value = 'Failed to load';
  }

  // Copy handler
  copyBtn.addEventListener('click', async () => {
    if (!_currentApiKey) return;
    try {
      await navigator.clipboard.writeText(_currentApiKey);
      statusEl.textContent = '✅ Copied to clipboard';
      statusEl.style.color = 'var(--green)';
      setTimeout(() => { statusEl.textContent = ''; }, 2500);
    } catch {
      // Fallback for non-secure contexts
      input.value = _currentApiKey;
      input.select();
      document.execCommand('copy');
      input.value = maskApiKey(_currentApiKey);
      statusEl.textContent = '✅ Copied';
      statusEl.style.color = 'var(--green)';
      setTimeout(() => { statusEl.textContent = ''; }, 2500);
    }
  });

  // Generate handler
  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    try {
      const res = await api('/auth/api-key', { method: 'POST' });
      _currentApiKey = res.apiKey;
      input.value = res.apiKey; // show full key briefly
      copyBtn.disabled = false;
      genBtn.style.display = 'none';
      regenBtn.style.display = '';
      statusEl.textContent = '🔑 Key generated — copy it now! It will be masked on reload.';
      statusEl.style.color = 'var(--green)';
      // Mask after 15s
      setTimeout(() => { input.value = maskApiKey(_currentApiKey); }, 15000);
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
      statusEl.style.color = 'var(--red)';
    }
    genBtn.disabled = false;
  });

  // Regenerate handler (with confirmation)
  regenBtn.addEventListener('click', async () => {
    const ok = confirm('Regenerate API key? The old key will stop working immediately.');
    if (!ok) return;
    regenBtn.disabled = true;
    try {
      const res = await api('/auth/api-key', { method: 'POST' });
      _currentApiKey = res.apiKey;
      input.value = res.apiKey;
      statusEl.textContent = '🔄 New key generated — copy it now!';
      statusEl.style.color = 'var(--green)';
      setTimeout(() => { input.value = maskApiKey(_currentApiKey); }, 15000);
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
      statusEl.style.color = 'var(--red)';
    }
    regenBtn.disabled = false;
  });
}

// ═══════════════════════════════════════════════════════
// WEBAUTHN BIOMETRIC SECTION — Register, List, Remove
// ═══════════════════════════════════════════════════════

async function initWebAuthnSection() {
  const listEl = document.getElementById('webauthn-credentials-list');
  const registerBtn = document.getElementById('webauthn-register-btn');
  const statusEl = document.getElementById('webauthn-status');
  if (!listEl || !registerBtn) return;

  // Check WebAuthn support (requires HTTPS / secure context)
  const isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const hasWebAuthn = isSecureContext && typeof PublicKeyCredential !== 'undefined';

  if (!hasWebAuthn) {
    registerBtn.disabled = true;
    registerBtn.style.opacity = '0.4';
    if (!isSecureContext) {
      listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">🔒 Biometric login requires HTTPS. Access via <code>https://</code> or <code>localhost</code> to register credentials.</div>';
    } else {
      listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">Your browser does not support WebAuthn.</div>';
    }
    return;
  }

  // Load existing credentials
  await loadWebAuthnCredentials(listEl, statusEl);

  // Register new credential
  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    statusEl.textContent = '';

    try {
      // Step 1: Get registration options from server
      const options = await api('/auth/webauthn/register/options', { method: 'POST' });

      // Step 2: Trigger browser biometric prompt
      if (typeof SimpleWebAuthnBrowser === 'undefined') {
        throw new Error('WebAuthn library not loaded. Please refresh the page.');
      }
      const attResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

      // Step 3: Send attestation to server for verification
      const result = await api('/auth/webauthn/register/verify', {
        method: 'POST',
        body: attResp,
      });

      statusEl.textContent = '✅ ' + result.message;
      statusEl.style.color = 'var(--green)';

      // Refresh list
      await loadWebAuthnCredentials(listEl, statusEl);
    } catch (err) {
      const msg = err.name === 'NotAllowedError' ? 'Registration cancelled' : err.message;
      statusEl.textContent = '❌ ' + msg;
      statusEl.style.color = 'var(--red)';
    }

    registerBtn.disabled = false;
  });
}

async function loadWebAuthnCredentials(listEl, statusEl) {
  try {
    const credentials = await api('/auth/webauthn/credentials');

    if (!credentials || credentials.length === 0) {
      listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">No biometric credentials registered yet.</div>';
      return;
    }

    listEl.innerHTML = credentials.map(cred => {
      const deviceIcon = cred.deviceType === 'singleDevice' ? '📱' :
        cred.deviceType === 'multiDevice' ? '☁️' : '🔑';
      const date = new Date(cred.createdAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      const backedUp = cred.backedUp ? ' · Synced' : '';

      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:var(--card-bg); border:1px solid var(--border); border-radius:8px; margin-bottom:6px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:18px;">${deviceIcon}</span>
            <div>
              <div style="font-size:12px; font-weight:600; color:var(--text-primary);">Passkey</div>
              <div style="font-size:10px; color:var(--text-muted);">${date}${backedUp}</div>
            </div>
          </div>
          <button class="btn webauthn-remove-btn" data-cred-id="${cred.id}" style="padding:4px 10px; font-size:10px; color:var(--red); border-color:var(--red);">Remove</button>
        </div>
      `;
    }).join('');

    // Attach remove handlers
    listEl.querySelectorAll('.webauthn-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const credId = btn.dataset.credId;
        const ok = confirm('Remove this biometric credential? You won\'t be able to use it for login anymore.');
        if (!ok) return;

        btn.disabled = true;
        try {
          await api(`/auth/webauthn/credentials/${credId}`, { method: 'DELETE' });
          statusEl.textContent = '✅ Credential removed';
          statusEl.style.color = 'var(--green)';
          await loadWebAuthnCredentials(listEl, statusEl);
        } catch (err) {
          statusEl.textContent = '❌ ' + err.message;
          statusEl.style.color = 'var(--red)';
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div style="font-size:11px; color:var(--red);">Failed to load credentials: ${err.message}</div>`;
  }
}

async function loadAccountStats() {
  if (!state.currentAccount) return;

  try {
    const stats = await api(`/trade/stats/${state.currentAccount}`);
    window._acctStats = stats;

    // Balance
    const balEl = document.getElementById('acct-balance');
    if (balEl) balEl.textContent = `$${stats.account.balance.toFixed(2)}`;

    // Default period: today
    updatePnlPeriod(stats.periods, 'today');

    // Activity
    const act = stats.activity;
    setEl('acct-total-trades', act.totalTrades);
    setEl('acct-avg-pnl', formatUsd(act.avgPnl, 4), formatPnlClass(act.avgPnl));
    setEl('acct-best', formatUsd(act.bestTrade, 4));
    setEl('acct-worst', formatUsd(act.worstTrade, 4));
    setEl('acct-pf', act.profitFactor === Infinity ? '∞' : act.profitFactor.toFixed(2));
    setEl('acct-total-fees', `$${act.totalFees.toFixed(4)}`);

    // Equity chart
    renderEquityChart(stats.equityCurve);
  } catch (err) {
    console.error('Failed to load account stats:', err);
  }
}

function updatePnlPeriod(periods, period) {
  const p = periods[period];
  if (!p) return;

  const rpnlEl = document.getElementById('acct-rpnl');
  if (rpnlEl) {
    rpnlEl.textContent = formatUsd(p.rpnl, 4);
    rpnlEl.className = `price-big ${formatPnlClass(p.rpnl)}`;
    rpnlEl.style.fontSize = '22px';
  }

  const wr = p.count > 0 ? (p.wins / p.count * 100).toFixed(1) : '—';
  setEl('acct-winrate', wr !== '—' ? `${wr}%` : '—');
  setEl('acct-trade-count', p.count);
  setEl('acct-wins', p.wins);
  setEl('acct-losses', p.losses);
  setEl('acct-fees', `$${p.totalFees.toFixed(4)}`);
}

function setEl(id, text, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (className) el.className = `stat-value ${className}`;
}

function renderEquityChart(data) {
  const container = document.getElementById('equity-chart');
  if (!container || typeof LightweightCharts === 'undefined' || data.length === 0) {
    if (container) container.innerHTML = cuteSeedling({ title: 'No Equity Data Yet ✨', subtitle: 'Start trading to see your growth~ 🌱' });
    return;
  }

  const chart = LightweightCharts.createChart(container, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b95a8', fontSize: 10 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true },
    handleScroll: { vertTouchDrag: false },
    width: container.clientWidth,
    height: 200,
  });

  const series = chart.addAreaSeries({
    lineColor: '#6366f1',
    topColor: 'rgba(99,102,241,0.3)',
    bottomColor: 'rgba(99,102,241,0.02)',
    lineWidth: 2,
  });

  const chartData = data.map(d => ({
    time: Math.floor(new Date(d.time).getTime() / 1000),
    value: d.value,
  }));

  // Dedupe by time
  const seen = new Set();
  const deduped = chartData.filter(d => {
    if (seen.has(d.time)) return false;
    seen.add(d.time);
    return true;
  }).sort((a, b) => a.time - b.time);

  if (deduped.length > 0) series.setData(deduped);
  chart.timeScale().fitContent();

  const ro = new ResizeObserver(() => {
    if (container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);
}

// ═══════════════════════════════════════════════════════
// SCANNER TAB — Hot pairs grid + engine overlay + event log
// ═══════════════════════════════════════════════════════

function initScannerTab() {
  // Listen for WS bot_status updates (may come with or without subAccountId)
  _botStatusListener = (e) => {
    const data = e.detail;
    // V7 bridge sends its own bot_status with source='v7'
    if (data.source === 'v7') {
      updateV7EnginesUI(data);
      return;
    }
    // Accept broadcasts for current account OR scanner-only (subAccountId=null)
    if (data.subAccountId && data.subAccountId !== state.currentAccount) return;
    updateScannerUI(data);
  };
  window.addEventListener('bot_status', _botStatusListener);

  // Listen for individual bot events (from JS engine OR v7 bridge)
  _botEventListener = (e) => {
    const data = e.detail;
    // Accept v7 events (subAccountId=null) or events for current account
    if (data.subAccountId && data.subAccountId !== state.currentAccount) return;
    addScannerEvent(data.event);
  };
  window.addEventListener('bot_event', _botEventListener);
}

function updateScannerUI(status) {
  const hotPairs = status.hotPairs || [];
  const engines = status.engines || [];

  // Build engine lookup by symbol
  const engineMap = new Map();
  for (const eng of engines) {
    engineMap.set(eng.symbol, eng);
  }

  // Update summary bar
  const badge = document.getElementById('scanner-badge');
  if (badge) {
    if (hotPairs.length > 0) {
      badge.textContent = '🔍 SCANNING';
      badge.className = 'scanner-badge active';
    } else {
      badge.textContent = '⏳ LOADING';
      badge.className = 'scanner-badge';
    }
  }

  setEl('scanner-hot-count', hotPairs.length);
  setEl('scanner-active-count', engines.filter(e => e.layers > 0).length);

  const pnlEl = document.getElementById('scanner-pnl');
  if (pnlEl) {
    const pnl = status.totalPnl || 0;
    pnlEl.textContent = formatUsd(pnl, 4);
    pnlEl.className = `scanner-stat-value ${formatPnlClass(pnl)}`;
  }
  setEl('scanner-trades', status.totalTrades || 0);

  // Show V7 connection badge if v7 data is merged
  const v7Wrap = document.getElementById('v7-badge-wrap');
  const v7Badge = document.getElementById('v7-conn-badge');
  if (v7Wrap && v7Badge) {
    const v7 = status.v7 || {};
    if (v7.connected) {
      v7Wrap.style.display = '';
      v7Badge.style.color = 'var(--green)';
      v7Badge.title = `V7 ${v7.live ? 'LIVE' : 'PAPER'} | ${v7.activeGrids} grids | $${(v7.portfolioNotional || 0).toFixed(0)}`;
    } else {
      v7Wrap.style.display = '';
      v7Badge.style.color = 'var(--text-muted)';
      v7Badge.title = 'V7 bot not connected';
    }
  }

  // Render hot pairs grid
  const grid = document.getElementById('hot-pairs-grid');
  if (!grid) return;

  if (!hotPairs.length) {
    grid.innerHTML = cuteCrystalBall({ title: 'Scanning Market~ 🔮', subtitle: 'Looking for hot pairs…' });
    return;
  }

  grid.innerHTML = hotPairs.map(pair => {
    const engine = engineMap.get(pair.symbol);
    return renderHotPairCard(pair, engine);
  }).join('');

  // Seed event log from status if we have no events yet
  if (_scannerEvents.length === 0 && status.events && status.events.length > 0) {
    _scannerEvents = status.events.slice(-50);
    renderEventLog();
  }
}

/** Handle V7 bridge bot_status messages — render the v7 engines grid */
function updateV7EnginesUI(data) {
  const section = document.getElementById('v7-engines-section');
  const grid = document.getElementById('v7-engines-grid');
  if (!section || !grid) return;

  const engines = data.engines || [];
  if (engines.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  // Update summary counts with v7 data
  const activeCount = engines.filter(e => e.gridDepth > 0).length;
  const v7ActiveEl = document.getElementById('scanner-active-count');
  if (v7ActiveEl) {
    const existing = parseInt(v7ActiveEl.textContent) || 0;
    v7ActiveEl.textContent = existing + activeCount;
  }

  grid.innerHTML = engines.map(e => renderV7EngineCard(e)).join('');
}

function renderV7EngineCard(e) {
  const sym = e.symbol?.replace('USDT', '') || '???';
  const isActive = e.gridDepth > 0;
  const stateClass = isActive ? 'active' : '';

  // Spread regime indicator
  const spreadColor = (e.spreadBps >= 5 && e.spreadBps <= 40) ? 'var(--green)' : 'var(--text-muted)';

  // Recovery mode icon
  const recoveryIcon = e.recoveryMode === 'active' ? '🟢' : e.recoveryMode === 'passive' ? '⏳' : '';

  let gridHtml = '';
  if (isActive) {
    const upnlClass = e.unrealizedPnlBps >= 0 ? 'pnl-positive' : 'pnl-negative';
    gridHtml = `
      <div class="engine-row">
        <span class="engine-dim">Grid</span>
        <span>L${e.gridDepth}/${e.maxLayers} $${(e.totalExposure || 0).toFixed(0)}</span>
      </div>
      <div class="engine-row">
        <span class="engine-dim">UPNL</span>
        <span class="${upnlClass}">${(e.unrealizedPnlBps || 0).toFixed(1)}bp $${(e.unrealizedPnlUsd || 0).toFixed(4)}</span>
      </div>
      <div class="engine-row">
        <span class="engine-dim">Avg Entry</span>
        <span style="font-family:var(--font-mono);">${(e.avgEntry || 0).toFixed(6)}</span>
      </div>`;
  }

  const rpnlClass = (e.totalPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';

  return `
    <div class="engine-card ${stateClass}">
      <div class="engine-card-header">
        <span class="engine-sym">${sym} <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(139,92,246,0.2);color:#a78bfa;">V7</span></span>
        <span class="${rpnlClass}" style="font-family:var(--font-mono); font-size:12px;">
          ${(e.totalPnlBps || 0).toFixed(1)}bp
        </span>
      </div>
      <div class="engine-card-body">
        <div class="engine-row">
          <span class="engine-dim">Spread</span>
          <span style="color:${spreadColor};">${(e.spreadBps || 0).toFixed(1)} <span class="engine-dim">med ${(e.medianSpreadBps || 0).toFixed(1)}</span></span>
        </div>
        <div class="engine-row">
          <span class="engine-dim">Vol Drift</span>
          <span>${(e.volDrift || 0).toFixed(2)}× <span class="engine-dim">${(e.volBaselineBps || 0).toFixed(0)}bp base</span></span>
        </div>
        <div class="engine-row">
          <span class="engine-dim">Edge</span>
          <span>${(e.edgeLcbBps || 0).toFixed(1)} / ${(e.edgeRequiredBps || 0).toFixed(1)} bp</span>
        </div>
        <div class="engine-row">
          <span class="engine-dim">TP Target</span>
          <span>${(e.tpTargetBps || 0).toFixed(1)}bp</span>
        </div>
        ${gridHtml}
        <div class="engine-row">
          <span class="engine-dim">rPnL</span>
          <span class="${rpnlClass}">$${(e.totalPnl || 0).toFixed(4)} (${e.totalTrades || 0}T ${(e.winRate || 0).toFixed(0)}%)</span>
        </div>
        ${e.recoveryDebt > 0 ? `
        <div class="engine-row">
          <span class="engine-dim">Recovery ${recoveryIcon}</span>
          <span>$${(e.recoveryDebt || 0).toFixed(2)} debt | ${(e.recoveryExitHurdleBps || 0).toFixed(1)}bp hurdle</span>
        </div>` : ''}
        ${e.circuitBreaker ? '<div class="engine-row" style="color:var(--red);">🛑 CIRCUIT BREAKER</div>' : ''}
        ${!e.entryEnabled ? '<div class="engine-row" style="color:var(--text-muted);">⏸ Entry paused</div>' : ''}
      </div>
    </div>
  `;
}

function renderHotPairCard(pair, engine) {
  const sym = pair.base || pair.symbol?.split('/')[0] || pair.symbol;
  const changePct = pair.changePct || 0;
  const isUp = changePct >= 0;
  const changeClass = isUp ? 'pnl-positive' : 'pnl-negative';
  const changeArrow = isUp ? '▲' : '▼';

  const spread = pair.spreadBps != null ? pair.spreadBps.toFixed(1) : '—';
  const vol = pair.quoteVolume ? `$${(pair.quoteVolume / 1e6).toFixed(0)}M` : '—';
  const funding = pair.fundingRate != null ? `${(pair.fundingRate * 100).toFixed(4)}%` : '—';

  // Determine card state from engine
  let stateClass = '';
  let engineHtml = '';

  if (engine) {
    stateClass = engine.state === 'ACTIVE' ? 'active' :
      engine.state === 'COOLDOWN' ? 'cooldown' : '';

    if (engine.layers > 0) {
      const upnlBps = engine.unrealizedPnlBps || 0;
      const gridStr = `L${engine.layers}/${engine.maxLayers || 8} $${(engine.totalNotional || 0).toFixed(0)}`;
      engineHtml = `
        <div class="engine-overlay">
          <div class="engine-row">
            <span class="engine-dim">Grid</span>
            <span class="engine-grid-state">${gridStr}</span>
          </div>
          <div class="engine-row">
            <span class="engine-dim">UPNL</span>
            <span class="${formatPnlClass(upnlBps)}">${upnlBps.toFixed(1)}bp</span>
          </div>
        </div>`;
    }

    // Show signals if engine has them
    const signals = engine.signals || {};
    const parts = [];
    if (signals.pumpScore != null) parts.push(`🚀${signals.pumpScore.toFixed(1)}`);
    if (signals.exhaustScore != null) parts.push(`💨${signals.exhaustScore.toFixed(1)}`);
    if (signals.ti2s != null) parts.push(`⚡${signals.ti2s.toFixed(1)}`);
    if (parts.length) {
      engineHtml += `<div class="engine-signals">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
    }
  }

  return `
    <div class="engine-card ${stateClass}">
      <div class="engine-card-header">
        <span class="engine-sym">${sym}</span>
        <span class="${changeClass}" style="font-family:var(--font-mono); font-size:12px; font-weight:700;">
          ${changeArrow} ${Math.abs(changePct).toFixed(1)}%
        </span>
      </div>
      <div class="engine-card-body">
        <div class="engine-row">
          <span class="engine-dim">Spread</span>
          <span>${spread} <span class="engine-dim">bp</span></span>
        </div>
        <div class="engine-row">
          <span class="engine-dim">Volume</span>
          <span>${vol}</span>
        </div>
        <div class="engine-row">
          <span class="engine-dim">Funding</span>
          <span style="color:${pair.fundingRate > 0 ? 'var(--green)' : pair.fundingRate < 0 ? 'var(--red)' : 'var(--text-secondary)'}">${funding}</span>
        </div>
        ${engineHtml}
      </div>
    </div>
  `;
}

function addScannerEvent(event) {
  _scannerEvents.push(event);
  if (_scannerEvents.length > 50) _scannerEvents.shift();
  renderEventLog();
}

function renderEventLog() {
  const container = document.getElementById('event-log');
  if (!container) return;

  if (_scannerEvents.length === 0) {
    container.innerHTML = '<div class="event-empty">No events yet</div>';
    return;
  }

  // Show newest first
  const events = [..._scannerEvents].reverse().slice(0, 30);
  container.innerHTML = events.map(ev => {
    const sym = ev.symbol?.split('/')[0] || '???';
    const time = formatEventTime(ev.ts);
    const { icon, text } = formatEvent(ev);
    return `<div class="event-item"><span class="event-time">${time}</span><span class="event-icon">${icon}</span><span class="event-sym">${sym}</span><span class="event-text">${text}</span></div>`;
  }).join('');
}

function formatEventTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatEvent(ev) {
  const d = ev.detail || {};
  const evType = ev.type || ev.action || '';

  switch (evType) {
    case 'entry':
    case 'sell':
      return { icon: '📥', text: `ENTRY L${d.layer ?? ev.layerIdx ?? 0} @ ${formatPrice(d.price ?? ev.price)} $${(d.notional ?? ev.notional ?? 0).toFixed(0)} sig=${(d.signal ?? 0).toFixed(2)}` };
    case 'averaging':
    case 'average':
      return { icon: '📊', text: `AVG L${d.layer ?? ev.layerIdx ?? 0} @ ${formatPrice(d.price ?? ev.price)} $${(d.notional ?? ev.notional ?? 0).toFixed(0)} [${d.totalLayers ?? ev.layers ?? 0}L]` };
    case 'close':
    case 'buy':
    case 'tp':
    case 'fast_tp':
      return { icon: (d.isWin || (ev.pnlBps || 0) > 0) ? '✅' : '❌', text: `CLOSE ${d.reason ?? ev.reason ?? evType} ${(d.pnlBps ?? ev.pnlBps ?? 0).toFixed(1)}bp $${(ev.pnlUsd ?? 0).toFixed(4)} ${d.layers ?? ev.layers ?? 0}L` };
    case 'inverse_tp':
      return { icon: '🎯', text: `INV TP z${d.zone ?? ev.layerIdx ?? 0} @ ${formatPrice(d.price ?? ev.price)} ${(d.pnlBps ?? ev.pnlBps ?? 0).toFixed(1)}bp → ${d.remainingLayers ?? ev.layers ?? 0}L` };
    case 'scaled_exit':
      return { icon: '📏', text: `SCALED L${d.layer ?? ev.layerIdx ?? 0} @ ${formatPrice(d.price ?? ev.price)} ${(d.pnlBps ?? ev.pnlBps ?? 0).toFixed(1)}bp → ${d.remainingLayers ?? ev.layers ?? 0}L` };
    case 'error':
      return { icon: '⚠️', text: `ERR ${d.action}: ${d.message}` };
    default:
      return { icon: '•', text: evType || 'unknown' };
  }
}

// ═══════════════════════════════════════════════════════
// BOT SECTION — Init, Load, Save, Toggle, Status
// ═══════════════════════════════════════════════════════

const BOT_FIELDS = [
  'maxNotional', 'maxLayers', 'maxExposure',
  'volFilterEnabled', 'minSpreadBps', 'maxSpreadBps',
  'minHoldSec', 'minProfitBps', 'tpDecayEnabled', 'tpDecayHalfLife',
  'trailingStopEnabled', 'trailingStopBps',
  'inverseTPEnabled', 'inverseTPMinLayers', 'scaledExitEnabled',
  'maxLossBps', 'lossCooldownSec',
  'symbols', 'blacklist',
];

const BOT_CHECKBOXES = new Set([
  'volFilterEnabled', 'tpDecayEnabled', 'trailingStopEnabled',
  'inverseTPEnabled', 'scaledExitEnabled',
]);

async function initBotSection() {
  if (!state.currentAccount) return;

  const toggle = document.getElementById('bot-toggle-checkbox');
  const settingsToggle = document.getElementById('bot-settings-toggle');
  const settingsPanel = document.getElementById('bot-settings-panel');
  const saveBtn = document.getElementById('bot-save-settings');

  // Load config from API
  try {
    const config = await api(`/bot/config/${state.currentAccount}`);
    if (config) {
      populateBotForm(config);
      toggle.checked = config.enabled;
      updateBotStatusUI(config.enabled);
    }
  } catch (err) {
    console.error('Failed to load bot config:', err);
    setBotStatusText('Error loading config', false);
  }

  // Toggle handler
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const result = await api(`/bot/toggle/${state.currentAccount}`, {
        method: 'POST',
      });
      toggle.checked = result.enabled;
      updateBotStatusUI(result.enabled);
    } catch (err) {
      console.error('Toggle failed:', err);
      toggle.checked = !toggle.checked; // revert
    }
    toggle.disabled = false;
  });

  // Settings expand/collapse
  settingsToggle.addEventListener('click', () => {
    const isOpen = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = isOpen ? 'none' : 'block';
    settingsToggle.textContent = isOpen ? '⚙️ Configure Settings' : '⚙️ Hide Settings';
  });

  // Save handler
  saveBtn.addEventListener('click', saveBotSettings);

  // Start polling status if bot is active
  startBotStatusPolling();
}

function populateBotForm(config) {
  for (const field of BOT_FIELDS) {
    const el = document.getElementById(`bot-${field}`);
    if (!el) continue;

    if (BOT_CHECKBOXES.has(field)) {
      el.checked = Boolean(config[field]);
    } else {
      el.value = config[field] ?? '';
    }
  }
}

function gatherBotForm() {
  const data = {};
  for (const field of BOT_FIELDS) {
    const el = document.getElementById(`bot-${field}`);
    if (!el) continue;

    if (BOT_CHECKBOXES.has(field)) {
      data[field] = el.checked;
    } else if (el.type === 'number') {
      const val = parseFloat(el.value);
      if (!isNaN(val)) data[field] = val;
    } else {
      data[field] = el.value;
    }
  }
  return data;
}

async function saveBotSettings() {
  if (!state.currentAccount) return;
  const statusEl = document.getElementById('bot-save-status');
  const saveBtn = document.getElementById('bot-save-settings');

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.className = 'bot-save-status';

  try {
    const data = gatherBotForm();
    await api(`/bot/config/${state.currentAccount}`, {
      method: 'PUT',
      body: data,
    });
    statusEl.textContent = '✅ Settings saved';
    statusEl.className = 'bot-save-status bot-save-ok';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = `❌ ${err.message || 'Save failed'}`;
    statusEl.className = 'bot-save-status bot-save-err';
  }

  saveBtn.disabled = false;
}

function updateBotStatusUI(active) {
  const statsPanel = document.getElementById('bot-stats-panel');
  if (statsPanel) statsPanel.style.display = active ? 'block' : 'none';
  setBotStatusText(active ? 'Active' : 'Inactive', active);

  // Start/stop polling
  if (active) {
    startBotStatusPolling();
  } else {
    if (_botStatusInterval) { clearInterval(_botStatusInterval); _botStatusInterval = null; }
  }
}

function setBotStatusText(text, active) {
  const el = document.getElementById('bot-status-text');
  if (!el) return;
  el.textContent = text;
  el.className = `bot-subtitle ${active ? 'bot-active' : 'bot-inactive'}`;
}

function startBotStatusPolling() {
  if (_botStatusInterval) return;
  // Single REST fetch on init — WS bot_status handles live updates
  pollBotStatus();
}

async function pollBotStatus() {
  if (!state.currentAccount) return;
  try {
    const status = await api(`/bot/status/${state.currentAccount}`);
    if (!status) return;

    const pairsEl = document.getElementById('bot-active-pairs');
    const pnlEl = document.getElementById('bot-session-pnl');
    const tradesEl = document.getElementById('bot-trade-count');
    const wrEl = document.getElementById('bot-win-rate');

    if (pairsEl) pairsEl.textContent = status.pairs || 0;
    if (pnlEl) {
      pnlEl.textContent = formatUsd(status.totalPnl || 0, 4);
      pnlEl.className = `stat-value ${formatPnlClass(status.totalPnl || 0)}`;
    }
    if (tradesEl) tradesEl.textContent = status.totalTrades || 0;
    if (wrEl) {
      const total = (status.engines || []).reduce((s, e) => s + e.wins + e.losses, 0);
      const wins = (status.engines || []).reduce((s, e) => s + e.wins, 0);
      wrEl.textContent = total > 0 ? `${(wins / total * 100).toFixed(1)}%` : '—';
    }
  } catch (err) {
    // Silent fail — status polling is best-effort
  }
}

// ═══════════════════════════════════════════════════════
// BABYSITTER SECTION — TP mode + live status (per-position control lives in Trade/Positions)
// ═══════════════════════════════════════════════════════

async function initBabysitterSection() {
  if (!state.currentAccount) return;

  const infoPanel = document.getElementById('babysitter-info-panel');
  const statusText = document.getElementById('babysitter-status-text');

  // Load account config for TP mode persistence.
  try {
    const config = await api(`/bot/config/${state.currentAccount}`);

    // Load TP mode from config
    const tpSelect = document.getElementById('babysitter-tp-mode');
    if (tpSelect && config?.tpMode) {
      tpSelect.value = config.tpMode;
    }
    // Auto-save on change
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

  // Listen for babysitter status in bot_status WS events
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

    // Show resting stealth TP orders
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
