// ── Trading Page – Compact Positions Panel ──
// Renders position rows, connects Binance mark price streams,
// recalculates live PnL, and handles position close actions.
import { state, api, showToast, formatPrice, formatUsd } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { streams } from '../../lib/binance-streams.js';
import * as S from './state.js';
import { _refreshEquityUpnl } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { applySymbolFilter } from './positions-panel.js';
import { _positionLineRegistry, _clearLeftLabels, _renderLeftPriceLabels, _cachedLeftLabelSpecs } from './chart-annotations.js';
import { invalidateOpenOrdersSnapshot } from './open-orders.js';

// ── Load and render compact positions ───────────────

export async function loadTradingPositions() {
    if (!state.currentAccount) return;
    const list = document.getElementById('compact-pos-list');
    const countEl = document.getElementById('compact-pos-count');
    if (!list) return;

    try {
        const data = await api(`/trade/positions/${state.currentAccount}`);
        const positions = data.positions || [];
        if (countEl) countEl.textContent = positions.length;

        S._positionMap.clear();
        for (const p of positions) {
            S._positionMap.set(p.id, {
                symbol: p.symbol, side: p.side,
                entryPrice: p.entryPrice, quantity: p.quantity,
                markPrice: S._compactMarkPrices[p.symbol] || p.markPrice || p.entryPrice,
                liquidationPrice: p.liquidationPrice || 0,
            });
        }
        if (data.summary) {
            S.set('_cachedBalance', data.summary.balance || 0);
        }
        _refreshEquityUpnl();

        // ── Clear chart position lines for selected symbol if no positions remain ──
        const selectedSym = S.selectedSymbol;
        const hasPositionOnSymbol = positions.some(p => p.symbol === selectedSym);
        if (!hasPositionOnSymbol && selectedSym) {
            for (const [key, line] of _positionLineRegistry) {
                const [lineSym] = key.split('|');
                if (lineSym === selectedSym) {
                    try { S.candleSeries?.removePriceLine(line); } catch { }
                    const idx = S.chartPriceLines.indexOf(line);
                    if (idx !== -1) S.chartPriceLines.splice(idx, 1);
                    _positionLineRegistry.delete(key);
                }
            }
            _clearLeftLabels();
            const filtered = _cachedLeftLabelSpecs.filter(
                s => s.tone !== 'long' && s.tone !== 'short' && s.tone !== 'liq'
            );
            _renderLeftPriceLabels(filtered);
        }

        if (positions.length === 0) {
            list.innerHTML = '<div style="padding:6px 8px; color:var(--text-muted); text-align:center; font-size:10px;">No positions</div>';
            connectCompactMarkStreams([]);
            return;
        }

        list.innerHTML = positions.map(pos => {
            const liveMP = S._compactMarkPrices[pos.symbol];
            let pnl, mark;
            if (liveMP) {
                mark = liveMP;
                pnl = pos.side === 'LONG'
                    ? (liveMP - pos.entryPrice) * pos.quantity
                    : (pos.entryPrice - liveMP) * pos.quantity;
            } else {
                mark = pos.markPrice;
                pnl = pos.unrealizedPnl;
            }
            const pnlPct = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
            const isLong = pos.side === 'LONG';
            const babysitterOn = !pos.babysitterExcluded;

            return `
        <div class="compact-pos-row" data-cp-symbol="${pos.symbol}" data-cp-side="${pos.side}"
             data-cp-id="${pos.id}" data-cp-entry="${pos.entryPrice}" data-cp-qty="${pos.quantity}" data-cp-margin="${pos.margin}" data-cp-notional="${pos.notional}">
          <span class="cpr-sym">
            <span class="cpr-name">${pos.symbol.split('/')[0]}</span>
            <span class="cpr-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
            <span class="cpr-lev">${pos.leverage}x</span>
          </span>
          <span class="cpr-size" data-cpsize-id="${pos.id}">$${(pos.notional || (pos.quantity * (mark || pos.entryPrice))).toFixed(2)}</span>
          <span class="cpr-entry">${formatPrice(pos.entryPrice)}</span>
          <span class="cpr-mark" data-cpmark-id="${pos.id}">${formatPrice(mark)}</span>
          <span class="cpr-liq" data-cpliq-id="${pos.id}">${pos.liquidationPrice > 0 ? formatPrice(pos.liquidationPrice) : '—'}</span>
          <span class="cpr-pnl ${pnl >= 0 ? 'pnl-up' : 'pnl-down'}" data-cppnl-id="${pos.id}" data-cp-prev-pnl="${pnl}">
            ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} <small>(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</small>
          </span>
          <button class="cpr-bbs ${babysitterOn ? 'on' : 'off'}"
                  data-cp-bbs="${pos.id}"
                  data-cp-bbs-excluded="${pos.babysitterExcluded ? '1' : '0'}"
                  title="Toggle babysitter for this position">
            ${babysitterOn ? 'On' : 'Off'}
          </button>
          <span class="cpr-close" data-cp-close="${pos.id}" data-cp-close-sym="${pos.symbol}" title="Market Close">✕</span>
        </div>
      `;
        }).join('');
        applySymbolFilter();

        // Attach close handlers
        list.querySelectorAll('[data-cp-close]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                marketClosePosition(btn.dataset.cpClose, btn.dataset.cpCloseSym);
            });
        });

        // Babysitter toggle handlers
        list.querySelectorAll('[data-cp-bbs]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const positionId = btn.dataset.cpBbs;
                const currentlyExcluded = btn.dataset.cpBbsExcluded === '1';
                if (!positionId || S._compactBabysitterBusy.has(positionId)) return;
                S._compactBabysitterBusy.add(positionId);

                // Optimistic UI: flip button immediately and disable
                const newExcluded = !currentlyExcluded;
                const newOn = !newExcluded;
                btn.disabled = true;
                btn.textContent = newOn ? 'On' : 'Off';
                btn.className = `cpr-bbs ${newOn ? 'on' : 'off'}`;
                btn.dataset.cpBbsExcluded = newExcluded ? '1' : '0';
                btn.style.opacity = '0.5';
                showToast(newOn ? 'Enabling babysitter…' : 'Disabling babysitter…', 'info');

                try {
                    const route = currentlyExcluded
                        ? `/bot/babysitter/position/${positionId}/include`
                        : `/bot/babysitter/position/${positionId}/exclude`;
                    await api(route, { method: 'POST' });
                    showToast(newOn ? 'Babysitter enabled for position' : 'Babysitter disabled for position', 'success');
                } catch (err) {
                    // Revert on error
                    const revertOn = !newOn;
                    btn.textContent = revertOn ? 'On' : 'Off';
                    btn.className = `cpr-bbs ${revertOn ? 'on' : 'off'}`;
                    btn.dataset.cpBbsExcluded = currentlyExcluded ? '1' : '0';
                    showToast(`${err.message}`, 'error');
                } finally {
                    btn.disabled = false;
                    btn.style.opacity = '';
                    S._compactBabysitterBusy.delete(positionId);
                }
            });
        });

        // Click symbol name → switch trading symbol
        list.querySelectorAll('.cpr-name').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const row = el.closest('.compact-pos-row');
                const sym = row?.dataset.cpSymbol;
                if (sym && sym !== S.selectedSymbol) {
                    import('./order-form.js').then(({ switchSymbol }) => {
                        switchSymbol(sym);
                        scheduleTradingRefresh({ positions: true }, 500);
                    });
                }
            });
        });

        connectCompactMarkStreams(positions);
    } catch (err) {
        console.debug('[CompactPos] Failed to load:', err.message);
    }
}

// ── Mark price streams ──────────────────────────────

export function connectCompactMarkStreams(positions) {
    const needed = new Set(positions.map(p => p.symbol));

    for (const sym of Object.keys(S._compactMarkUnsubs)) {
        if (!needed.has(sym)) {
            try { S._compactMarkUnsubs[sym](); } catch { }
            delete S._compactMarkUnsubs[sym];
        }
    }

    for (const sym of needed) {
        if (S._compactMarkUnsubs[sym]) continue;
        const raw = sym.replace('/', '').replace(':USDT', '').toLowerCase();
        const wsSymbol = raw.endsWith('usdt') ? raw : raw + 'usdt';

        S._compactMarkUnsubs[sym] = streams.subscribe(`${wsSymbol}@markPrice@1s`, (data) => {
            try {
                const mp = parseFloat(data.p);
                if (!mp || isNaN(mp)) return;
                S._compactMarkPrices[sym] = mp;
                recalcCompactPnl(sym, mp);
            } catch { }
        });
    }
}

// ── Live PnL recalculation ──────────────────────────

export function recalcCompactPnl(symbol, markPrice) {
    const rows = document.querySelectorAll(`.compact-pos-row[data-cp-symbol="${symbol}"]`);
    rows.forEach(row => {
        const positionId = row.dataset.cpId;
        const side = row.dataset.cpSide;
        const entry = parseFloat(row.dataset.cpEntry);
        const qty = parseFloat(row.dataset.cpQty);
        const margin = parseFloat(row.dataset.cpMargin);
        if (!entry || !qty) return;

        const pnl = side === 'LONG'
            ? (markPrice - entry) * qty
            : (entry - markPrice) * qty;
        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;

        const markEl = row.querySelector(`[data-cpmark-id="${positionId}"]`);
        if (markEl) markEl.textContent = formatPrice(markPrice);

        const sizeEl = row.querySelector(`[data-cpsize-id="${positionId}"]`);
        if (sizeEl) {
            const liveNotional = markPrice * qty;
            sizeEl.textContent = `$${liveNotional.toFixed(2)}`;
        }

        const pnlEl = row.querySelector(`[data-cppnl-id="${positionId}"]`);
        if (pnlEl) {
            pnlEl.className = `cpr-pnl ${pnl >= 0 ? 'pnl-up' : 'pnl-down'}`;
            pnlEl.dataset.cpPrevPnl = pnl;
            pnlEl.innerHTML = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} <small>(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</small>`;
        }
    });

    for (const [, pos] of S._positionMap) {
        if (pos.symbol === symbol) pos.markPrice = markPrice;
    }
    _refreshEquityUpnl();

    // ── Live chart position line update ──
    for (const [key, line] of _positionLineRegistry) {
        const [lineSym, lineSide] = key.split('|');
        if (lineSym !== symbol) continue;
        let totalQty = 0, weightedEntry = 0, totalPnl = 0, totalMargin = 0;
        for (const [, pos] of S._positionMap) {
            if (pos.symbol !== symbol || pos.side !== lineSide) continue;
            totalQty += pos.quantity || 0;
            weightedEntry += (pos.entryPrice || 0) * (pos.quantity || 0);
            totalMargin += pos.margin || 0;
        }
        if (totalQty === 0) {
            const rows = document.querySelectorAll(`.compact-pos-row[data-cp-symbol="${symbol}"][data-cp-side="${lineSide}"]`);
            rows.forEach(row => {
                const qty = parseFloat(row.dataset.cpQty) || 0;
                const entry = parseFloat(row.dataset.cpEntry) || 0;
                const margin = parseFloat(row.dataset.cpMargin) || 0;
                totalQty += qty;
                weightedEntry += entry * qty;
                totalMargin += margin;
            });
        }
        if (totalQty === 0) continue;
        const avgEntry = weightedEntry / totalQty;
        const isLong = lineSide === 'LONG';
        const pnl = isLong ? (markPrice - avgEntry) * totalQty : (avgEntry - markPrice) * totalQty;
        const pnlPct = totalMargin > 0 ? (pnl / totalMargin) * 100 : 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const sideLabel = isLong ? 'Long' : 'Short';
        try {
            line.applyOptions({
                price: avgEntry,
                title: `${sideLabel} ${pnlSign}$${Math.abs(pnl).toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
            });
        } catch { /* line may have been removed */ }
    }
}

// ── Position actions ────────────────────────────────

export async function marketClosePosition(positionId, symbol) {
    if (!(await cuteConfirm({ title: `Close ${symbol.split('/')[0]}?`, message: 'This will market close the position~', confirmText: 'Close', danger: true }))) return;
    showToast(`Closing ${symbol.split('/')[0]}...`, 'info');
    try {
        const result = await api(`/trade/close/${positionId}`, { method: 'POST' });
        invalidateOpenOrdersSnapshot();
        const pnl = result.trade?.realizedPnl || 0;
        showToast(`Closed ${symbol.split('/')[0]}. PnL: ${formatUsd(pnl)}`, pnl >= 0 ? 'success' : 'warning');
        scheduleTradingRefresh({
            positions: true,
            openOrders: true,
            annotations: true,
            forceAnnotations: true,
            account: true,
        }, 30);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

export function updateCompactLiqForPosition(positionId, liqPrice = null) {
    if (!positionId) return;
    const liq = liqPrice ?? S._positionMap.get(positionId)?.liquidationPrice ?? 0;
    const row = document.querySelector(`.compact-pos-row[data-cp-id="${positionId}"]`);
    if (!row) return;
    const el = row.querySelector(`[data-cpliq-id="${positionId}"]`);
    if (el) el.textContent = liq > 0 ? formatPrice(liq) : '—';
}
