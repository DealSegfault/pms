// ── Positions Page – Close/Save Actions ──
// User-initiated actions: market close, limit close, close all, save as index, babysitter toggle.

import { state, api, showToast, formatUsd, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';

const babysitterPositionBusy = new Set();

export async function marketClose(positionId, symbol, scheduleLoadPositions) {
    if (!(await cuteConfirm({ title: `Close ${symbol.split('/')[0]}?`, message: 'This will market close the position~', confirmText: 'Close', danger: true }))) return;

    try {
        const result = await api(`/trade/close/${positionId}`, { method: 'POST' });
        const pnl = result.trade?.realizedPnl || 0;
        showToast(`Closed ${symbol.split('/')[0]}. PnL: ${formatUsd(pnl)}`, pnl >= 0 ? 'success' : 'warning');
        scheduleLoadPositions(80);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

export async function submitLimitClose(positionId) {
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

export async function closeAllPositions(positionsData, scheduleLoadPositions) {
    if (!state.currentAccount) return;
    const count = positionsData.length;
    if (!(await cuteConfirm({ title: `Close All ${count} Position(s)?`, message: 'Every open position will be market closed~', confirmText: 'Close All', danger: true }))) return;

    showToast(`Closing ${count} position(s)...`, 'info');

    try {
        const result = await api(`/trade/close-all/${state.currentAccount}`, { method: 'POST' });
        const totalPnl = result.results?.reduce((s, r) => s + (r.pnl || 0), 0) || 0;
        showToast(`Closed ${result.closed}/${result.total}. Total PnL: ${formatUsd(totalPnl)}`, totalPnl >= 0 ? 'success' : 'warning');
        scheduleLoadPositions(80);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

export async function toggleBabysitterForPosition(positionId, currentlyExcluded) {
    if (!positionId) return;
    if (babysitterPositionBusy.has(positionId)) return;
    babysitterPositionBusy.add(positionId);

    const btn = document.querySelector(`[data-bbs-toggle-pos="${positionId}"]`);

    const newExcluded = !currentlyExcluded;
    const newOn = !newExcluded;
    if (btn) {
        btn.disabled = true;
        btn.textContent = newOn ? 'Babysitter On' : 'Babysitter Off';
        btn.className = `bbs-symbol-toggle ${newOn ? 'on' : 'off'}`;
        btn.dataset.bbsExcluded = newExcluded ? '1' : '0';
        btn.style.opacity = '0.5';
    }
    showToast(newOn ? 'Enabling babysitter…' : 'Disabling babysitter…', 'info');

    const route = currentlyExcluded
        ? `/bot/babysitter/position/${positionId}/include`
        : `/bot/babysitter/position/${positionId}/exclude`;
    try {
        await api(route, { method: 'POST' });
        showToast(newOn ? 'Babysitter enabled for position' : 'Babysitter disabled for position', 'success');
    } catch (err) {
        if (btn) {
            const revertOn = !newOn;
            btn.textContent = revertOn ? 'Babysitter On' : 'Babysitter Off';
            btn.className = `bbs-symbol-toggle ${revertOn ? 'on' : 'off'}`;
            btn.dataset.bbsExcluded = currentlyExcluded ? '1' : '0';
        }
        showToast(`${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
        }
        babysitterPositionBusy.delete(positionId);
    }
}

// ── Save as Index ──

const LS_INDEXES_KEY = 'pms_indexes';

export async function savePositionsAsIndex(positionsData) {
    if (!positionsData || positionsData.length === 0) {
        showToast('No open positions to save', 'error');
        return;
    }

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

    const bases = formula.map(l => l.symbol.split('/')[0]);
    const defaultName = bases.join('-') + ' basket';
    const name = prompt('Index name:', defaultName);
    if (!name || !name.trim()) return;

    let indexes = [];
    try {
        const raw = localStorage.getItem(LS_INDEXES_KEY);
        if (raw) indexes = JSON.parse(raw);
    } catch { indexes = []; }

    indexes.push({
        id: Date.now().toString(36),
        name: name.trim(),
        formula,
        createdAt: new Date().toISOString(),
    });

    localStorage.setItem(LS_INDEXES_KEY, JSON.stringify(indexes));
    showToast(`Saved "${name.trim()}" with ${formula.length} legs`, 'success');
}
