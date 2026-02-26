// ── Trading Page – Agent Controls ────────────────────────────
// Handles starting, stopping, and previewing agents.
import { state, api, showToast, formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Agent Type State ────────────────────────────
let _selectedAgentType = 'trend'; // 'trend' | 'grid' | 'deleverage'

export function setAgentType(type) {
    _selectedAgentType = type;

    // Toggle active button styling
    document.querySelectorAll('.agent-type-btn').forEach(btn => {
        const isActive = btn.dataset.agentType === type;
        btn.style.background = isActive ? 'var(--accent)' : 'var(--surface-2)';
        btn.style.color = isActive ? '#fff' : 'var(--text)';
        btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });

    // Show/hide type-specific config panels
    document.getElementById('agent-trend-config').style.display = type === 'trend' ? '' : 'none';
    document.getElementById('agent-grid-config').style.display = type === 'grid' ? '' : 'none';
    document.getElementById('agent-deleverage-config').style.display = type === 'deleverage' ? '' : 'none';

    updateAgentPreview();
}

export function getAgentType() {
    return _selectedAgentType;
}

// ── Preview ─────────────────────────────────────
export function updateAgentPreview() {
    const preview = document.getElementById('agent-preview');
    if (!preview) return;

    const sym = S.selectedSymbol?.split('/')[0] || '—';
    const lev = S.leverage || 1;

    if (_selectedAgentType === 'trend') {
        const fast = document.getElementById('agent-trend-fast')?.value || 10;
        const slow = document.getElementById('agent-trend-slow')?.value || 50;
        preview.textContent = `Trend ${sym} · EMA ${fast}/${slow} · ${lev}×`;
    } else if (_selectedAgentType === 'grid') {
        const offset = document.getElementById('agent-grid-offset')?.value || 0.2;
        const layers = document.getElementById('agent-grid-layers')?.value || 3;
        preview.textContent = `Grid ${sym} · ${offset}% offset · ${layers} layers · ${lev}×`;
    } else if (_selectedAgentType === 'deleverage') {
        const maxN = document.getElementById('agent-delev-max-notional')?.value || 500;
        const unwind = document.getElementById('agent-delev-unwind-pct')?.value || 30;
        preview.textContent = `Deleverage ${sym} · max $${maxN} · unwind ${unwind}%`;
    }
}

// ── Submit ──────────────────────────────────────
export async function submitAgent() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    if (!S.selectedSymbol) return showToast('Select a symbol first', 'error');

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const config = {
            type: _selectedAgentType,
            subAccountId: state.currentAccount,
            symbol: S.selectedSymbol,
            leverage: S.leverage,
        };

        if (_selectedAgentType === 'trend') {
            const sizeUsd = parseFloat(document.getElementById('trade-size')?.value) || 50;
            config.sizeUsd = sizeUsd;
            config.fastPeriod = parseInt(document.getElementById('agent-trend-fast')?.value) || 10;
            config.slowPeriod = parseInt(document.getElementById('agent-trend-slow')?.value) || 50;
            config.offsetPct = parseFloat(document.getElementById('agent-trend-offset')?.value) || 0.15;
            config.childCount = parseInt(document.getElementById('agent-trend-layers')?.value) || 2;
        } else if (_selectedAgentType === 'grid') {
            const sizeUsd = parseFloat(document.getElementById('trade-size')?.value) || 100;
            config.sizeUsd = sizeUsd;
            config.offsetPct = parseFloat(document.getElementById('agent-grid-offset')?.value) || 0.2;
            config.childCount = parseInt(document.getElementById('agent-grid-layers')?.value) || 3;
            config.maxDrawdownUsd = parseFloat(document.getElementById('agent-grid-max-dd')?.value) || 10;
            config.cooldownMs = parseInt(document.getElementById('agent-grid-cooldown')?.value) * 1000 || 60000;
        } else if (_selectedAgentType === 'deleverage') {
            config.maxNotional = parseFloat(document.getElementById('agent-delev-max-notional')?.value) || 500;
            config.unwindPct = parseFloat(document.getElementById('agent-delev-unwind-pct')?.value) || 30;
            config.maxLossBps = parseInt(document.getElementById('agent-delev-max-loss')?.value) || 200;
            config.offsetPct = parseFloat(document.getElementById('agent-delev-offset')?.value) || 0.2;
        }

        const result = await api('/trade/agents', {
            method: 'POST',
            body: config,
        });

        if (result.agentId) {
            showToast(`🤖 ${_selectedAgentType} agent started on ${S.selectedSymbol.split('/')[0]}`, 'success');
            scheduleTradingRefresh({ openOrders: true }, 200);
        }
    } catch (err) {
        showToast(`Agent failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🤖 Start Agent';
        }
    }
}

// ── Cancel ──────────────────────────────────────
export async function cancelAgent(agentId) {
    try {
        await api(`/trade/agents/${agentId}`, { method: 'DELETE' });
        showToast('🤖 Agent stopped', 'info');
        scheduleTradingRefresh({ openOrders: true }, 100);
    } catch (err) {
        showToast(`Stop agent failed: ${err.message}`, 'error');
    }
}
