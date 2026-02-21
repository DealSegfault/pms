// ── Basket execution (instant + TWAP) ────────────
import { state, api, showToast } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { st } from './state.js';
import { computeWeights } from './index-list.js';
import { storeActiveBasket, renderActiveBaskets } from './active-baskets.js';
import { updateEntryMarkers } from './chart.js';

// ── Instant execution ────────────────────────────

export async function executeBasket(direction) {
    if (!st.selectedIndex || st.isExecuting || st.tradeSize < 10) return;
    if (!state.currentAccount) {
        showToast('Select an account first', 'error');
        return;
    }

    const weights = computeWeights(st.selectedIndex.formula, st.tradeSize);
    if (!weights) return;

    st.isExecuting = true;
    const buyBtn = document.getElementById('idx-buy-btn');
    const sellBtn = document.getElementById('idx-sell-btn');
    if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = '⏳ Executing...'; }
    if (sellBtn) { sellBtn.disabled = true; sellBtn.textContent = '⏳ Executing...'; }

    try {
        const weightedSymbols = Object.entries(weights);
        const pricedLegInputs = await Promise.all(
            weightedSymbols.map(async ([symbol, w]) => {
                try {
                    const ticker = await api(`/trade/price/${encodeURIComponent(symbol)}`);
                    const price = ticker.last || ticker.mark || ticker.price;
                    return { symbol, w, price };
                } catch {
                    return { symbol, w, price: null };
                }
            }),
        );

        const legs = [];
        for (const { symbol, w, price } of pricedLegInputs) {
            if (!price || price <= 0) {
                showToast(`Could not get price for ${symbol.split('/')[0]}`, 'error');
                continue;
            }

            let finalSide = w.side;
            if (direction === 'SHORT') {
                finalSide = w.side === 'LONG' ? 'SHORT' : 'LONG';
            }

            legs.push({
                symbol,
                side: finalSide,
                quantity: w.sizeUsd / price,
                leverage: st.leverage,
                price,
            });
        }

        if (legs.length === 0) {
            showToast('No valid legs to execute', 'error');
            return;
        }

        const result = await api('/trade/basket', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                legs,
                basketName: st.selectedIndex.name,
            },
        });

        if (result.succeeded > 0) {
            showToast(`Basket executed: ${result.succeeded}/${result.total} legs filled`, 'success');
            storeActiveBasket(st.selectedIndex, direction, result);
            renderActiveBaskets();
            updateEntryMarkers();
        }

        if (result.failed > 0) {
            const failures = result.results.filter(r => !r.success);
            failures.forEach(f => {
                const msg = f.errors?.[0]?.message || 'Order failed';
                showToast(`${f.symbol.split('/')[0]}: ${msg}`, 'error');
            });
        }
    } catch (err) {
        showToast(`Basket execution failed: ${err.message}`, 'error');
        console.error('[Index] Execution error:', err);
    } finally {
        st.isExecuting = false;
        if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Buy Index'; }
        if (sellBtn) { sellBtn.disabled = false; sellBtn.textContent = 'Sell Index'; }
    }
}

// ── Execution mode toggle ────────────────────────

export function setIdxExecMode(mode) {
    st.idxExecMode = mode === 'twap' ? 'twap' : 'instant';
    document.querySelectorAll('.idx-mode-btn').forEach(btn => {
        const isActive = btn.dataset.mode === st.idxExecMode;
        btn.style.background = isActive ? 'rgba(99,102,241,0.15)' : 'var(--bg-input)';
        btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
        btn.style.color = isActive ? 'var(--accent)' : 'var(--text-secondary)';
    });
    const twapControls = document.getElementById('idx-twap-controls');
    if (twapControls) twapControls.style.display = st.idxExecMode === 'twap' ? '' : 'none';
    if (st.idxExecMode === 'twap') updateIdxTwapPreview();
    const buyBtn = document.getElementById('idx-buy-btn');
    const sellBtn = document.getElementById('idx-sell-btn');
    if (buyBtn) buyBtn.textContent = st.idxExecMode === 'twap' ? '⏱ TWAP Buy' : 'Buy Index';
    if (sellBtn) sellBtn.textContent = st.idxExecMode === 'twap' ? '⏱ TWAP Sell' : 'Sell Index';
}

export function updateIdxTwapPreview() {
    const el = document.getElementById('idx-twap-preview');
    if (!el) return;
    if (!st.selectedIndex || st.tradeSize <= 0) { el.textContent = ''; return; }
    const legCount = st.selectedIndex.formula?.length || 0;
    const intervalSec = (st.idxTwapDuration * 60) / st.idxTwapLots;
    const perLot = st.tradeSize / st.idxTwapLots;
    const perLotPerLeg = legCount > 0 ? perLot / legCount : perLot;
    const intervalStr = intervalSec >= 60 ? `${(intervalSec / 60).toFixed(1)}min` : `${intervalSec.toFixed(0)}s`;
    el.textContent = `${st.idxTwapLots} lots · ~$${perLot.toFixed(1)}/lot · $${perLotPerLeg.toFixed(1)}/leg · every ${intervalStr}${st.idxTwapJitter ? ' · jitter' : ''}${st.idxTwapIrregular ? ' · irregular' : ''}`;
}

// ── TWAP execution ───────────────────────────────

export async function executeTwapBasket(direction) {
    if (!st.selectedIndex || st.isExecuting || st.tradeSize < 10) return;
    if (!state.currentAccount) {
        showToast('Select an account first', 'error');
        return;
    }

    const weights = computeWeights(st.selectedIndex.formula, st.tradeSize);
    if (!weights) return;

    const legs = [];
    for (const [symbol, w] of Object.entries(weights)) {
        let finalSide = w.side;
        if (direction === 'SHORT') {
            finalSide = w.side === 'LONG' ? 'SHORT' : 'LONG';
        }
        legs.push({
            symbol,
            side: finalSide,
            sizeUsdt: w.sizeUsd,
            leverage: st.leverage,
        });
    }

    if (legs.length === 0) {
        showToast('No valid legs', 'error');
        return;
    }

    const minPerLot = Math.min(...legs.map(l => l.sizeUsdt / st.idxTwapLots));
    if (minPerLot < 6) {
        const maxLots = Math.floor(Math.min(...legs.map(l => l.sizeUsdt)) / 6);
        showToast(`Smallest leg per-lot $${minPerLot.toFixed(2)} < $6 min. Reduce lots to ${Math.max(2, maxLots)} or increase size.`, 'error');
        return;
    }

    const intervalSec = (st.idxTwapDuration * 60) / st.idxTwapLots;
    const confirmed = await cuteConfirm({
        title: `TWAP ${direction} ${st.selectedIndex.name}`,
        message: `${legs.length} legs · ${st.idxTwapLots} lots · ~$${(st.tradeSize / st.idxTwapLots).toFixed(1)}/lot · every ${intervalSec >= 60 ? (intervalSec / 60).toFixed(1) + 'min' : intervalSec.toFixed(0) + 's'}\nTotal: $${st.tradeSize.toFixed(2)} · ${st.leverage}x · ${st.idxTwapDuration}min${st.idxTwapJitter ? ' · Jitter' : ''}${st.idxTwapIrregular ? ' · Irregular' : ''}`,
        confirmText: 'Start TWAP',
        danger: direction === 'SHORT',
    });
    if (!confirmed) return;

    st.isExecuting = true;
    const buyBtn = document.getElementById('idx-buy-btn');
    const sellBtn = document.getElementById('idx-sell-btn');
    if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = '⏳ Starting...'; }
    if (sellBtn) { sellBtn.disabled = true; sellBtn.textContent = '⏳ Starting...'; }

    try {
        const result = await api('/trade/twap-basket', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                legs,
                basketName: st.selectedIndex.name,
                lots: st.idxTwapLots,
                durationMinutes: st.idxTwapDuration,
                jitter: st.idxTwapJitter,
                irregular: st.idxTwapIrregular,
            },
        });
        if (result.success) {
            if (!st.activeTwapBasketIds.includes(result.twapBasketId)) {
                st.activeTwapBasketIds.push(result.twapBasketId);
            }
            showToast(`TWAP started: ${legs.length} legs · ${st.idxTwapLots} lots over ${st.idxTwapDuration}min`, 'success');
            renderActiveTwapBasket();
        }
    } catch (err) {
        showToast(`TWAP failed: ${err.message}`, 'error');
        console.error('[Index] TWAP start error:', err);
    } finally {
        st.isExecuting = false;
        if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = st.idxExecMode === 'twap' ? '⏱ TWAP Buy' : 'Buy Index'; }
        if (sellBtn) { sellBtn.disabled = false; sellBtn.textContent = st.idxExecMode === 'twap' ? '⏱ TWAP Sell' : 'Sell Index'; }
    }
}

export function renderActiveTwapBasket() {
    const container = document.getElementById('idx-active-twap-basket');
    if (!container || !state.currentAccount) return;

    // Always query backend — discovers running baskets even after page navigation
    api(`/trade/twap-basket/active/${state.currentAccount}`).then(baskets => {
        if (!Array.isArray(baskets) || baskets.length === 0) {
            st.activeTwapBasketIds = [];
            container.innerHTML = '';
            return;
        }

        // Sync local IDs with what the backend reports
        st.activeTwapBasketIds = baskets.map(b => b.twapBasketId);

        container.innerHTML = baskets.map(b => {
            const pct = b.totalLots > 0 ? Math.round((b.filledLots / b.totalLots) * 100) : 0;
            const legsHtml = (b.legs || []).map(l => {
                const sym = l.symbol.split('/')[0];
                const sideColor = l.side === 'LONG' ? 'var(--green)' : 'var(--red)';
                const filled = `$${l.filledSize?.toFixed(1) || '0'}`;
                const total = `$${l.totalSize?.toFixed(1) || '0'}`;
                return `<div style="display:flex; justify-content:space-between; font-size:10px; padding:1px 0;">
                  <span><span style="color:${sideColor}; font-weight:600;">${l.side === 'LONG' ? '▲' : '▼'}</span> ${sym}</span>
                  <span style="font-family:var(--font-mono); color:var(--text-secondary);">${filled} / ${total}</span>
                </div>`;
            }).join('');

            return `
            <div style="background:rgba(99,102,241,0.06); border:1px solid rgba(99,102,241,0.2); border-radius:8px; padding:8px 10px; font-size:11px; margin-bottom:6px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span style="font-weight:600;">⏱ TWAP: ${b.basketName}</span>
                <span style="font-family:var(--font-mono); color:var(--accent); font-weight:600;">${b.filledLots}/${b.totalLots} lots (${pct}%)</span>
              </div>
              <div style="background:var(--bg-input); border-radius:4px; height:4px; overflow:hidden; margin-bottom:6px;">
                <div style="background:var(--accent); height:100%; width:${pct}%; transition:width 0.3s ease;"></div>
              </div>
              ${legsHtml}
              <div style="text-align:right; margin-top:4px;">
                <button class="idx-cancel-twap-basket-btn" data-twap-basket-id="${b.twapBasketId}" style="background:none; border:1px solid var(--red); color:var(--red); padding:2px 10px; border-radius:4px; font-size:10px; cursor:pointer; font-weight:600;">Cancel TWAP</button>
              </div>
            </div>`;
        }).join('');

        // Attach cancel handlers for each basket
        container.querySelectorAll('.idx-cancel-twap-basket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.twapBasketId;
                try {
                    await api(`/trade/twap-basket/${id}`, { method: 'DELETE' });
                    showToast('TWAP basket cancelled', 'warn');
                    st.activeTwapBasketIds = st.activeTwapBasketIds.filter(x => x !== id);
                    renderActiveTwapBasket();
                } catch (err) {
                    showToast(`Cancel failed: ${err.message}`, 'error');
                }
            });
        });
    }).catch(() => {
        st.activeTwapBasketIds = [];
        container.innerHTML = '';
    });
}
