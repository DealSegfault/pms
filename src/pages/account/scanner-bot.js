// ── Account Page – Scanner & Bot Configuration ──
import { state, api, formatUsd, formatPrice, formatPnlClass } from '../../core/index.js';
import { cuteCrystalBall } from '../../lib/cute-empty.js';
import { setEl } from './stats.js';

// ── Scanner state ───────────────────────────────────

let _scannerEvents = [];
let _botStatusInterval = null;

export function getListeners() {
    return { _botStatusInterval };
}

export function clearBotStatusInterval() {
    if (_botStatusInterval) { clearInterval(_botStatusInterval); _botStatusInterval = null; }
}

// ── Scanner tab init ────────────────────────────────

export function initScannerTab(botStatusListenerRef, botEventListenerRef) {
    botStatusListenerRef.fn = (e) => {
        const data = e.detail;
        if (data.source === 'v7') {
            updateV7EnginesUI(data);
            return;
        }
        if (data.subAccountId && data.subAccountId !== state.currentAccount) return;
        updateScannerUI(data);
    };
    window.addEventListener('bot_status', botStatusListenerRef.fn);

    botEventListenerRef.fn = (e) => {
        const data = e.detail;
        if (data.subAccountId && data.subAccountId !== state.currentAccount) return;
        addScannerEvent(data.event);
    };
    window.addEventListener('bot_event', botEventListenerRef.fn);
}

// ── Scanner UI update ───────────────────────────────

function updateScannerUI(status) {
    const hotPairs = status.hotPairs || [];
    const engines = status.engines || [];
    const engineMap = new Map();
    for (const eng of engines) engineMap.set(eng.symbol, eng);

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

    if (_scannerEvents.length === 0 && status.events && status.events.length > 0) {
        _scannerEvents = status.events.slice(-50);
        renderEventLog();
    }
}

// ── V7 engines UI ───────────────────────────────────

function updateV7EnginesUI(data) {
    const section = document.getElementById('v7-engines-section');
    const grid = document.getElementById('v7-engines-grid');
    if (!section || !grid) return;

    const engines = data.engines || [];
    if (engines.length === 0) { section.style.display = 'none'; return; }

    section.style.display = '';
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
    const spreadColor = (e.spreadBps >= 5 && e.spreadBps <= 40) ? 'var(--green)' : 'var(--text-muted)';
    const recoveryIcon = e.recoveryMode === 'active' ? '🟢' : e.recoveryMode === 'passive' ? '⏳' : '';

    let gridHtml = '';
    if (isActive) {
        const upnlClass = e.unrealizedPnlBps >= 0 ? 'pnl-positive' : 'pnl-negative';
        gridHtml = `
      <div class="engine-row"><span class="engine-dim">Grid</span><span>L${e.gridDepth}/${e.maxLayers} $${(e.totalExposure || 0).toFixed(0)}</span></div>
      <div class="engine-row"><span class="engine-dim">UPNL</span><span class="${upnlClass}">${(e.unrealizedPnlBps || 0).toFixed(1)}bp $${(e.unrealizedPnlUsd || 0).toFixed(4)}</span></div>
      <div class="engine-row"><span class="engine-dim">Avg Entry</span><span style="font-family:var(--font-mono);">${(e.avgEntry || 0).toFixed(6)}</span></div>`;
    }

    const rpnlClass = (e.totalPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
    return `
    <div class="engine-card ${stateClass}">
      <div class="engine-card-header">
        <span class="engine-sym">${sym} <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(139,92,246,0.2);color:#a78bfa;">V7</span></span>
        <span class="${rpnlClass}" style="font-family:var(--font-mono); font-size:12px;">${(e.totalPnlBps || 0).toFixed(1)}bp</span>
      </div>
      <div class="engine-card-body">
        <div class="engine-row"><span class="engine-dim">Spread</span><span style="color:${spreadColor};">${(e.spreadBps || 0).toFixed(1)} <span class="engine-dim">med ${(e.medianSpreadBps || 0).toFixed(1)}</span></span></div>
        <div class="engine-row"><span class="engine-dim">Vol Drift</span><span>${(e.volDrift || 0).toFixed(2)}× <span class="engine-dim">${(e.volBaselineBps || 0).toFixed(0)}bp base</span></span></div>
        <div class="engine-row"><span class="engine-dim">Edge</span><span>${(e.edgeLcbBps || 0).toFixed(1)} / ${(e.edgeRequiredBps || 0).toFixed(1)} bp</span></div>
        <div class="engine-row"><span class="engine-dim">TP Target</span><span>${(e.tpTargetBps || 0).toFixed(1)}bp</span></div>
        ${gridHtml}
        <div class="engine-row"><span class="engine-dim">rPnL</span><span class="${rpnlClass}">$${(e.totalPnl || 0).toFixed(4)} (${e.totalTrades || 0}T ${(e.winRate || 0).toFixed(0)}%)</span></div>
        ${e.recoveryDebt > 0 ? `<div class="engine-row"><span class="engine-dim">Recovery ${recoveryIcon}</span><span>$${(e.recoveryDebt || 0).toFixed(2)} debt | ${(e.recoveryExitHurdleBps || 0).toFixed(1)}bp hurdle</span></div>` : ''}
        ${e.circuitBreaker ? '<div class="engine-row" style="color:var(--red);">🛑 CIRCUIT BREAKER</div>' : ''}
        ${!e.entryEnabled ? '<div class="engine-row" style="color:var(--text-muted);">⏸ Entry paused</div>' : ''}
      </div>
    </div>
  `;
}

// ── Hot pair cards ───────────────────────────────────

function renderHotPairCard(pair, engine) {
    const sym = pair.base || pair.symbol?.split('/')[0] || pair.symbol;
    const changePct = pair.changePct || 0;
    const isUp = changePct >= 0;
    const changeClass = isUp ? 'pnl-positive' : 'pnl-negative';
    const changeArrow = isUp ? '▲' : '▼';
    const spread = pair.spreadBps != null ? pair.spreadBps.toFixed(1) : '—';
    const vol = pair.quoteVolume ? `$${(pair.quoteVolume / 1e6).toFixed(0)}M` : '—';
    const funding = pair.fundingRate != null ? `${(pair.fundingRate * 100).toFixed(4)}%` : '—';

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
          <div class="engine-row"><span class="engine-dim">Grid</span><span class="engine-grid-state">${gridStr}</span></div>
          <div class="engine-row"><span class="engine-dim">UPNL</span><span class="${formatPnlClass(upnlBps)}">${upnlBps.toFixed(1)}bp</span></div>
        </div>`;
        }

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
        <span class="${changeClass}" style="font-family:var(--font-mono); font-size:12px; font-weight:700;">${changeArrow} ${Math.abs(changePct).toFixed(1)}%</span>
      </div>
      <div class="engine-card-body">
        <div class="engine-row"><span class="engine-dim">Spread</span><span>${spread} <span class="engine-dim">bp</span></span></div>
        <div class="engine-row"><span class="engine-dim">Volume</span><span>${vol}</span></div>
        <div class="engine-row"><span class="engine-dim">Funding</span><span style="color:${pair.fundingRate > 0 ? 'var(--green)' : pair.fundingRate < 0 ? 'var(--red)' : 'var(--text-secondary)'}">${funding}</span></div>
        ${engineHtml}
      </div>
    </div>
  `;
}

// ── Event log ───────────────────────────────────────

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

// ── Bot configuration ───────────────────────────────

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

export async function initBotSection() {
    if (!state.currentAccount) return;

    const toggle = document.getElementById('bot-toggle-checkbox');
    const settingsToggle = document.getElementById('bot-settings-toggle');
    const settingsPanel = document.getElementById('bot-settings-panel');
    const saveBtn = document.getElementById('bot-save-settings');

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

    toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        try {
            const result = await api(`/bot/toggle/${state.currentAccount}`, { method: 'POST' });
            toggle.checked = result.enabled;
            updateBotStatusUI(result.enabled);
        } catch (err) {
            console.error('Toggle failed:', err);
            toggle.checked = !toggle.checked;
        }
        toggle.disabled = false;
    });

    settingsToggle.addEventListener('click', () => {
        const isOpen = settingsPanel.style.display !== 'none';
        settingsPanel.style.display = isOpen ? 'none' : 'block';
        settingsToggle.textContent = isOpen ? '⚙️ Configure Settings' : '⚙️ Hide Settings';
    });

    saveBtn.addEventListener('click', saveBotSettings);
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
        await api(`/bot/config/${state.currentAccount}`, { method: 'PUT', body: data });
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

    if (active) {
        startBotStatusPolling();
    } else {
        clearBotStatusInterval();
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
