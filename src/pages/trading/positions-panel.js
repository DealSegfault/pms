// ── Trading Page – Positions Panel, Open Orders, Chart Annotations ──
import { state, api, showToast, formatPrice, formatUsd } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { streams } from '../../lib/binance-streams.js';
import * as S from './state.js';

import { _refreshEquityUpnl } from './order-form.js';
import { cancelTwap } from './twap.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Optimistic Open Order Helpers (WS-driven, no HTTP) ──

/**
 * Remove an open order row from the DOM by clientOrderId.
 * Called by WS order_filled / order_cancelled handlers.
 */
export function removeOpenOrderRow(clientOrderId) {
    if (!clientOrderId) return;
    const btn = document.querySelector(`[data-cancel-order="${clientOrderId}"]`);
    const row = btn?.closest('.oo-row');
    if (row) row.remove();
    _updateOpenOrderCount();
}

/**
 * Add a limit order row to the open orders DOM from WS event data.
 * Called by WS order_active handler for LIMIT orders.
 */
export function addLimitOrderRow(d) {
    const list = document.getElementById('open-orders-list');
    if (!list || !d.clientOrderId) return;

    // Skip algo-managed orders — they have dedicated rows
    if (['CHASE', 'SCALPER', 'TWAP', 'TWAP_SLICE'].includes(d.origin)) return;
    // Only add LIMIT orders (market orders don't persist in open orders)
    if (d.orderType !== 'LIMIT') return;

    // Don't add if already exists
    if (list.querySelector(`[data-cancel-order="${d.clientOrderId}"]`)) return;

    // Clear "No open orders" placeholder
    const noOrders = list.querySelector('div[style*="text-align:center"]');
    if (noOrders && list.children.length === 1) list.innerHTML = '';

    const notional = ((d.price || 0) * (d.quantity || 0)).toFixed(2);
    const isLong = d.side === 'BUY';
    const sym = d.symbol || '';
    const base = sym.split('/')[0] || sym;

    const tmp = document.createElement('div');
    tmp.innerHTML = `
      <div class="oo-row">
        <span class="oor-sym">
          <span class="oor-name" data-oo-symbol="${sym}">${base}</span>
          <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
        </span>
        <span class="oor-price">$${formatPrice(d.price)}</span>
        <span class="oor-qty">${(d.quantity || 0).toFixed(4)}</span>
        <span class="oor-notional">$${notional}</span>
        <span class="oor-age">0s</span>
        <span class="oor-cancel" data-cancel-order="${d.clientOrderId}" title="Cancel order">✕</span>
      </div>
    `;
    const newRow = tmp.firstElementChild;
    list.appendChild(newRow);

    // Attach cancel handler
    newRow.querySelector('[data-cancel-order]')?.addEventListener('click', () => {
        cancelOrder(d.clientOrderId);
    });

    // Attach symbol click handler
    newRow.querySelector('.oor-name')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sym && sym !== S.selectedSymbol) {
            import('./order-form.js').then(({ switchSymbol }) => switchSymbol(sym));
        }
    });

    _updateOpenOrderCount();
}

/**
 * Recount open order rows and update the badge.
 */
function _updateOpenOrderCount() {
    const list = document.getElementById('open-orders-list');
    const countEl = document.getElementById('open-orders-count');
    if (!list || !countEl) return;
    const count = list.querySelectorAll('.oo-row').length;
    countEl.textContent = count;

    if (count === 0) {
        list.innerHTML = '<div style="padding:8px; color:var(--text-muted); text-align:center;">No open orders</div>';
    }

    // Toggle cancel-all button visibility
    const cancelAllBtn = document.getElementById('cancel-all-orders');
    if (cancelAllBtn) {
        cancelAllBtn.style.display = count > 0 ? '' : 'none';
    }
}

// ── Helpers ─────────────────────────────────────

export function formatRelativeTime(dateStr) {
    let ts;
    if (typeof dateStr === 'number') {
        // Seconds float (< 1e12) vs milliseconds (>= 1e12)
        ts = dateStr < 1e12 ? dateStr * 1000 : dateStr;
    } else {
        ts = new Date(dateStr).getTime();
    }
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}

/**
 * Hide/show rows in both Open Orders and Positions panels
 * based on the "Current only" checkbox.
 */
export function applySymbolFilter() {
    const checked = document.getElementById('bp-filter-current-sym')?.checked;
    const sym = S.selectedSymbol;

    // Open orders rows
    document.querySelectorAll('#open-orders-list .oo-row').forEach(row => {
        const rowSym = row.querySelector('[data-oo-symbol]')?.dataset.ooSymbol;
        row.style.display = (checked && rowSym && rowSym !== sym) ? 'none' : '';
    });

    // Positions rows
    document.querySelectorAll('#compact-pos-list .compact-pos-row').forEach(row => {
        const rowSym = row.dataset.cpSymbol;
        row.style.display = (checked && rowSym && rowSym !== sym) ? 'none' : '';
    });
}

// ── Open Orders ─────────────────────────────────

export async function loadOpenOrders() {
    if (!state.currentAccount) return;
    const list = document.getElementById('open-orders-list');
    const countEl = document.getElementById('open-orders-count');
    const cancelAllBtn = document.getElementById('cancel-all-orders');
    if (!list) return;

    try {
        const [orders, twaps, trailStops, chaseOrders, scalpers] = await Promise.all([
            api(`/trade/orders/${state.currentAccount}`),
            api(`/trade/twap/active/${state.currentAccount}`).catch(() => []),
            api(`/trade/trail-stop/active/${state.currentAccount}`).catch(() => []),
            api(`/trade/chase-limit/active/${state.currentAccount}`).catch(() => []),
            api(`/trade/scalper/active/${state.currentAccount}`).catch(() => []),
        ]);

        // Group child chases by parentScalperId for the drawer
        const scalperChildMap = new Map(); // scalperId → chase[]
        const standaloneChases = [];
        for (const ch of chaseOrders) {
            if (ch.parentScalperId) {
                if (!scalperChildMap.has(ch.parentScalperId)) scalperChildMap.set(ch.parentScalperId, []);
                scalperChildMap.get(ch.parentScalperId).push(ch);
            } else {
                standaloneChases.push(ch);
            }
        }

        const totalCount = orders.length + twaps.length + trailStops.length + standaloneChases.length + scalpers.length;
        if (countEl) countEl.textContent = totalCount;
        if (cancelAllBtn) {
            cancelAllBtn.dataset.hasOrders = orders.length > 0 ? '1' : '0';
            const ordersTabActive = document.getElementById('bp-orders')?.classList.contains('active');
            cancelAllBtn.style.display = (orders.length > 0 && ordersTabActive !== false) ? '' : 'none';
        }

        if (totalCount === 0) {
            list.innerHTML = '<div style="padding:8px; color:var(--text-muted); text-align:center;">No open orders</div>';
            return;
        }

        let html = '';

        for (const t of twaps) {
            const isLong = t.side === 'LONG';
            const totalLots = t.numLots || 0;
            const filledLots = t.filledLots || 0;
            const pct = totalLots > 0 ? Math.round((filledLots / totalLots) * 100) : 0;
            const durationMinutes = Math.round(((t.intervalSeconds || 60) * totalLots) / 60);
            const estimatedEnd = Date.now() + ((totalLots - filledLots) * (t.intervalSeconds || 60) * 1000);
            const eta = new Date(estimatedEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const priceLimitStr = t.priceLimit ? `<span style="font-size:9px; color:var(--accent); opacity:0.85;">${isLong ? 'Max' : 'Min'}: $${formatPrice(t.priceLimit)}</span>` : '';
            const twapEdit = JSON.stringify({ type: 'TWAP', orderId: t.twapId, symbol: t.symbol, side: t.side, totalSize: t.totalQuantity, lots: totalLots, durationMinutes: durationMinutes, jitter: t.jitter || false, irregular: t.irregular || false, priceLimit: t.priceLimit || null });
            html += `
        <div class="oo-row" style="border-left:3px solid var(--accent); background:rgba(99,102,241,0.05);">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${t.symbol}">${t.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
            <span data-edit-type="TWAP" data-edit='${twapEdit.replace(/'/g, "&#39;")}' style="font-size:9px; color:var(--accent); font-weight:600; margin-left:2px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px;" title="Click to edit">TWAP</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span style="font-size:10px; font-weight:600;">${filledLots}/${totalLots} lots</span>
            <span style="font-size:9px; color:var(--text-muted);">ETA ${eta}</span>
            ${priceLimitStr}
          </span>
          <span class="oor-qty" style="min-width:60px;">
            <div style="background:var(--surface-2); border-radius:3px; height:6px; overflow:hidden; width:100%;">
              <div style="width:${pct}%; height:100%; background:var(--accent); border-radius:3px; transition:width 0.3s;"></div>
            </div>
            <span style="font-size:9px; color:var(--text-muted);">${pct}%</span>
          </span>
          <span class="oor-notional">$${(t.filledQuantity || 0).toFixed(0)}/$${(t.totalQuantity || 0).toFixed(0)}</span>
          <span class="oor-age">${durationMinutes}m</span>
          <span class="oor-cancel" data-cancel-twap="${t.twapId}" title="Cancel TWAP">✕</span>
        </div>
      `;
        }

        for (const ts of trailStops) {
            const isLong = ts.side === 'LONG';
            const trailEdit = JSON.stringify({ type: 'TRAIL', orderId: ts.trailStopId, symbol: ts.symbol, side: ts.side, callbackPct: ts.callbackPct, activationPrice: ts.activationPrice || null, positionId: ts.positionId || null });
            html += `
        <div class="oo-row" data-trail-id="${ts.trailStopId}" style="border-left:3px solid #f59e0b; background:rgba(245,158,11,0.05);">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${ts.symbol}">${ts.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
            <span data-edit-type="TRAIL" data-edit='${trailEdit.replace(/'/g, "&#39;")}' style="font-size:9px; color:#f59e0b; font-weight:600; margin-left:2px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px;" title="Click to edit">TRAIL</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span style="font-size:10px; font-weight:600;">${ts.callbackPct}%</span>
            <span class="trail-status" style="font-size:9px; color:var(--text-muted);">${ts.activated ? 'tracking' : 'waiting'}</span>
          </span>
          <span class="oor-qty trail-extreme" style="min-width:60px; font-size:10px;">
            ${ts.extremePrice ? `${isLong ? 'HWM' : 'LWM'}: $${formatPrice(ts.extremePrice)}` : '—'}
          </span>
          <span class="oor-notional trail-trigger" style="font-size:10px; color:#f59e0b;">
            ${ts.triggerPrice ? `⚡$${formatPrice(ts.triggerPrice)}` : '—'}
          </span>
          <span class="oor-age">${formatRelativeTime(ts.startedAt)}</span>
          <span class="oor-cancel" data-cancel-trail="${ts.trailStopId}" title="Cancel Trail Stop">✕</span>
        </div>
      `;
        }

        // ── Scalper groups
        for (const sp of scalpers) {
            const sym = sp.symbol.split('/')[0];
            const children = scalperChildMap.get(sp.scalperId) || [];
            const fillCount = sp.totalFillCount || 0;
            const longChildren = children.filter(c => c.side === 'LONG');
            const shortChildren = children.filter(c => c.side === 'SHORT');
            const totalLayers = sp.childCount * 2;
            const activeCount = children.length;
            const age = sp.startedAt ? formatRelativeTime(new Date(sp.startedAt).toISOString()) : '—';
            const scalperEdit = JSON.stringify({ type: 'SCALPER', orderId: sp.scalperId, symbol: sp.symbol, side: sp.startSide || 'LONG', longOffsetPct: sp.longOffsetPct || 0.3, shortOffsetPct: sp.shortOffsetPct || 0.3, childCount: sp.childCount || 1, skew: sp.skew || 0, totalSizeUsd: (sp.longSizeUsd || 0) * 2, longMaxPrice: sp.longMaxPrice || null, shortMinPrice: sp.shortMinPrice || null, neutralMode: sp.neutralMode || false, minFillSpreadPct: sp.minFillSpreadPct || 0, fillDecayHalfLifeMs: sp.fillDecayHalfLifeMs || 30000, minRefillDelayMs: sp.minRefillDelayMs || 0, allowLoss: sp.allowLoss ?? true });

            // Parent row
            html += `
        <div class="oo-row" data-scalper-id="${sp.scalperId}" style="border-left:3px solid #a855f7; background:rgba(168,85,247,0.06); cursor:pointer; user-select:none;" onclick="(function(row){const drawer=row.nextElementSibling; const open=drawer.style.display==='none'; drawer.style.display=open?'':'none'; const arrow=row.querySelector('.sc-arrow'); if(arrow) arrow.style.transform=open?'rotate(90deg)':'rotate(0deg)';})(this)">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${sp.symbol}">${sym}</span>
            <span data-edit-type="SCALPER" data-edit='${scalperEdit.replace(/'/g, "&#39;")}' style="font-size:9px; color:#a855f7; font-weight:700; margin-left:4px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px;" title="Click to edit" onclick="event.stopPropagation()">⚔ SCALPER</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span style="font-size:10px; font-weight:600;">${activeCount}/${totalLayers} layers</span>
            <span style="font-size:9px; color:var(--text-muted);">${fillCount} fills</span>
          </span>
          <span class="oor-qty" style="min-width:60px; font-size:10px; display:flex; flex-direction:column; gap:1px;">
            <span><span style="color:#06b6d4;">L ${sp.longOffsetPct?.toFixed(2) ?? '?'}%</span> &middot; <span style="color:#f97316;">S ${sp.shortOffsetPct?.toFixed(2) ?? '?'}%</span></span>
            ${sp.longMaxPrice || sp.shortMinPrice ? `<span style="font-size:8px; color:var(--text-muted); opacity:0.8;">${sp.longMaxPrice ? `<span style="color:#06b6d4;" title="LONG won't restart above this price">↑$${formatPrice(sp.longMaxPrice)}</span>` : ''}${sp.longMaxPrice && sp.shortMinPrice ? ' · ' : ''}${sp.shortMinPrice ? `<span style="color:#f97316;" title="SHORT won't restart below this price">↓$${formatPrice(sp.shortMinPrice)}</span>` : ''}</span>` : ''}
          </span>
          <span class="oor-notional" style="font-size:9px; color:#a855f7;"><span class="sc-arrow" style="display:inline-block; transition:transform 0.15s;">▸</span> ${sp.childCount}L</span>
          <span class="oor-age">${age}</span>
          <span class="oor-cancel" data-cancel-scalper="${sp.scalperId}" title="Stop Scalper" onclick="event.stopPropagation()">✕</span>
        </div>
        <div data-scalper-drawer="${sp.scalperId}" style="display:none; background:rgba(168,85,247,0.03); border-left:3px solid rgba(168,85,247,0.25); padding-left:8px;">
      `;

            // Child chase rows (inside drawer)
            for (const ch of [...longChildren, ...shortChildren]) {
                const isLong = ch.side === 'LONG';
                const layerColor = isLong ? '#06b6d4' : '#f97316';
                const roLabel = ch.reduceOnly ? ' <span style="font-size:8px;opacity:0.6;">RO</span>' : '';
                // Per-slot status badge (updated live by scalper_progress WS handler)
                const slotStatus = ch.paused
                    ? `<span style="font-size:9px; color:#f59e0b;" title="Price filter — paused">⏸</span>`
                    : ch.retryAt && !ch.chaseId
                        ? `<span style="font-size:9px; color:#f43f5e;" title="Retrying">⟳</span>`
                        : `<span style="font-size:9px; color:#22c55e;" title="Active">●</span>`;
                html += `
          <div class="oo-row" data-chase-id="${ch.chaseId}" style="margin:1px 0; background:${isLong ? 'rgba(6,182,212,0.04)' : 'rgba(249,115,22,0.04)'}; border:none; padding:3px 8px;">
            <span class="oor-sym">
              <span data-slot-badge="${ch.layerIdx ?? ''}">${slotStatus}</span>
              <span style="font-size:9px; color:${layerColor}; font-weight:700; margin-left:3px;">${isLong ? 'L' : 'S'} L${ch.layerIdx ?? ''}${roLabel}</span>
            </span>
            <span class="oor-price">
              <span class="chase-live-price" style="font-size:10px; font-weight:600;">$${ch.currentOrderPrice ? formatPrice(ch.currentOrderPrice) : '\u2014'}</span>
            </span>
            <span class="oor-qty" style="min-width:60px; font-size:9px; color:var(--text-muted);">${ch.stalkOffsetPct}% off</span>
            <span class="oor-notional" style="font-size:9px; color:${layerColor};">🎯 ${ch.repriceCount || 0} rp</span>
            <span class="oor-age">${formatRelativeTime(ch.startedAt)}</span>
            <span class="oor-cancel" data-cancel-chase="${ch.chaseId}" title="Cancel layer">✕</span>
          </div>
        `;
            }

            // If no children loaded yet, show placeholder
            if (children.length === 0) {
                html += `<div style="padding:4px 8px; font-size:9px; color:var(--text-muted);">Starting layers...</div>`;
            }

            html += `</div>`; // close drawer
        }

        for (const ch of standaloneChases) {
            const isLong = ch.side === 'LONG';
            const chaseEdit = JSON.stringify({ type: 'CHASE', orderId: ch.chaseId, symbol: ch.symbol, side: ch.side, sizeUsd: ch.sizeUsd || 0, stalkOffsetPct: ch.stalkOffsetPct || 0, stalkMode: ch.stalkMode || 'none', maxDistancePct: ch.maxDistancePct || 0 });
            html += `
        <div class="oo-row" data-chase-id="${ch.chaseId}" style="border-left:3px solid #06b6d4; background:rgba(6,182,212,0.05);">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${ch.symbol}">${ch.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
            <span data-edit-type="CHASE" data-edit='${chaseEdit.replace(/'/g, "&#39;")}' style="font-size:9px; color:#06b6d4; font-weight:600; margin-left:2px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px;" title="Click to edit">CHASE</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span class="chase-live-price" style="font-size:10px; font-weight:600;">$${ch.currentOrderPrice ? formatPrice(ch.currentOrderPrice) : '\u2014'}</span>
            <span style="font-size:9px; color:var(--text-muted);">${ch.stalkOffsetPct > 0 ? `${ch.stalkOffsetPct}% ${ch.stalkMode}` : 'best quote'}</span>
          </span>
          <span class="oor-qty chase-live-reprices" style="min-width:60px; font-size:10px;">
            ${ch.repriceCount || 0} reprices
          </span>
          <span class="oor-notional" style="font-size:10px; color:#06b6d4;">
            \ud83c\udfaf chasing
          </span>
          <span class="oor-age">${formatRelativeTime(ch.startedAt)}</span>
          <span class="oor-cancel" data-cancel-chase="${ch.chaseId}" title="Cancel Chase">\u2715</span>
        </div>
      `;
        }


        for (const o of orders) {
            if (['TWAP', 'TWAP_SLICE', 'CHASE_LIMIT', 'SCALPER_LIMIT'].includes(o.orderType)) continue;
            // Skip orders owned by algo engines — they have dedicated rows above
            if (['CHASE', 'SCALPER', 'TWAP', 'TWAP_SLICE'].includes(o.origin)) continue;

            const notional = ((o.price || 0) * (o.quantity || 0)).toFixed(2);
            const isLong = o.side === 'BUY';
            const age = formatRelativeTime(o.createdAt);
            html += `
        <div class="oo-row">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${o.symbol}">${o.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
          </span>
          <span class="oor-price">$${formatPrice(o.price)}</span>
          <span class="oor-qty">${(o.quantity || 0).toFixed(4)}</span>
          <span class="oor-notional">$${notional}</span>
          <span class="oor-age">${age}</span>
          <span class="oor-cancel" data-cancel-order="${o.clientOrderId}" title="Cancel order">✕</span>
        </div>
      `;
        }

        list.innerHTML = html;
        applySymbolFilter();

        // Seed chart lines for active chases so they appear immediately on refresh
        if (standaloneChases.length > 0) {
            import('./chase-limit.js').then(m => {
                for (const ch of standaloneChases) {
                    m.drawLiveChase(ch);
                }
            }).catch(() => { });
        }

        list.querySelectorAll('[data-cancel-order]').forEach(btn => {
            btn.addEventListener('click', () => cancelOrder(btn.dataset.cancelOrder));
        });
        list.querySelectorAll('[data-cancel-twap]').forEach(btn => {
            btn.addEventListener('click', () => cancelTwap(btn.dataset.cancelTwap));
        });
        list.querySelectorAll('[data-cancel-trail]').forEach(btn => {
            btn.addEventListener('click', () => {
                import('./trail-stop.js').then(m => m.cancelTrailStop(btn.dataset.cancelTrail));
            });
        });
        list.querySelectorAll('[data-cancel-chase]').forEach(btn => {
            btn.addEventListener('click', () => {
                import('./chase-limit.js').then(m => m.cancelChase(btn.dataset.cancelChase));
            });
        });
        list.querySelectorAll('[data-cancel-scalper]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                import('./scalper.js').then(m => m.cancelScalper(btn.dataset.cancelScalper));
            });
        });

        // Click order type badge → prefill form for editing
        list.querySelectorAll('[data-edit-type]').forEach(badge => {
            badge.addEventListener('click', e => {
                e.stopPropagation();
                try {
                    const params = JSON.parse(badge.dataset.edit);
                    prefillOrderForm(params);
                } catch (err) {
                    console.warn('[Orders] Failed to parse edit params', err);
                }
            });
        });

        // Click symbol name → switch trading symbol
        list.querySelectorAll('.oor-name[data-oo-symbol]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const sym = el.dataset.ooSymbol;
                if (sym && sym !== S.selectedSymbol) {
                    import('./order-form.js').then(({ switchSymbol }) => {
                        switchSymbol(sym);
                    });
                }
            });
        });
    } catch (err) {
        console.debug('[Orders] Failed to load:', err.message);
    }
}

export async function cancelOrder(orderId) {
    showToast('⏳ Cancelling order...', 'info');
    try {
        await api(`/trade/orders/${orderId}`, { method: 'DELETE' });
        showToast('✅ Order cancelled', 'success');
        scheduleTradingRefresh({
            openOrders: true,
            annotations: true,
            forceAnnotations: true,
        }, 40);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

export async function cancelAllOrders() {
    if (!state.currentAccount) return;
    const countEl = document.getElementById('open-orders-count');
    const count = parseInt(countEl?.textContent || '0');
    if (count === 0) return showToast('No open orders to cancel', 'info');
    if (!(await cuteConfirm({ title: `Cancel ${count} Order${count > 1 ? 's' : ''}?`, message: 'All open orders will be cancelled~', confirmText: 'Cancel All', danger: true }))) return;

    const btn = document.getElementById('cancel-all-orders');
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }
    showToast(`Cancelling ${count} order${count > 1 ? 's' : ''}...`, 'info');

    try {
        const result = await api(`/trade/orders/all/${state.currentAccount}`, { method: 'DELETE' });
        showToast(`${result.cancelled} order${result.cancelled > 1 ? 's' : ''} cancelled`, 'success');
        if (result.failed > 0) showToast(`${result.failed} failed to cancel`, 'warning');
        scheduleTradingRefresh({
            openOrders: true,
            annotations: true,
            forceAnnotations: true,
        }, 40);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Cancel All'; }
    }
}

// ── Order Form Prefill ───────────────────────────
// Called when user clicks a complex order type badge in the open orders list.
// Switches the order form to the matching type and populates inputs with current params.
// Sets _editState so each submit function knows to cancel-then-restart.

export function clearEditMode() {
    S.set('_editState', null);
    const banner = document.getElementById('edit-mode-banner');
    if (banner) banner.remove();
    const btn = document.getElementById('submit-trade');
    // Reset the button label to whatever setOrderType would set it to
    // (we just remove the override — the next setOrderType call will fix the label)
    if (btn && btn.dataset.editModeLabel) {
        btn.textContent = btn.dataset.origLabel || btn.textContent;
        delete btn.dataset.editModeLabel;
        delete btn.dataset.origLabel;
    }
}

export async function prefillOrderForm(params) {
    const { type, symbol, side } = params;

    const [{ setOrderType, setSide, switchSymbol }] = await Promise.all([
        import('./order-form.js'),
    ]);

    // Clear any previous edit mode first
    clearEditMode();

    // Switch symbol if different
    if (symbol && symbol !== (await import('./state.js').then(m => m.selectedSymbol))) {
        await switchSymbol(symbol);
    }

    // Switch side where applicable
    if (side && type !== 'TRAIL') {
        setSide(side);
    }

    // Switch order type (shows the right controls section)
    setOrderType(type);

    // Helper: set input value and fire 'input' event so display labels update
    const setInput = (id, value) => {
        const el = document.getElementById(id);
        if (!el || value == null) return;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
    };

    // Short pause so the DOM has rendered the newly visible controls
    await new Promise(r => requestAnimationFrame(r));

    if (type === 'TWAP') {
        if (params.totalSize || params.totalQuantity) setInput('trade-size', params.totalQuantity || params.totalSize);
        setInput('twap-lots', params.lots ?? 10);
        setInput('twap-duration', params.durationMinutes ?? 30);
        setChecked('twap-jitter', params.jitter);
        setChecked('twap-irregular', params.irregular);
        setInput('twap-price-limit', params.priceLimit || '');
        import('./scale-orders.js').then(m => m.updateTwapPreview?.());
    } else if (type === 'TRAIL') {
        setInput('trail-callback', params.callbackPct ?? 1);
        setInput('trail-activation', params.activationPrice || '');
        // Pre-select the position in the dropdown if positionId is known
        if (params.positionId) {
            const sel = document.getElementById('trail-position');
            if (sel) sel.value = params.positionId;
        }
        import('./trail-stop.js').then(m => m.updateTrailPreview?.());
    } else if (type === 'CHASE') {
        if (params.sizeUsd) setInput('trade-size', params.sizeUsd);
        setInput('chase-offset', params.stalkOffsetPct ?? 0);
        setInput('chase-distance', params.maxDistancePct || '');
        // Set stalk mode radio
        if (params.stalkMode) {
            const radio = document.querySelector(`input[name="chase-stalk-mode"][value="${params.stalkMode}"]`);
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        import('./chase-limit.js').then(m => m.updateChasePreview?.());
    } else if (type === 'SCALPER') {
        if (params.totalSizeUsd) setInput('trade-size', params.totalSizeUsd);
        setInput('scalper-long-offset', params.longOffsetPct ?? 0.3);
        setInput('scalper-short-offset', params.shortOffsetPct ?? 0.3);
        setInput('scalper-child-count', params.childCount ?? 1);
        setInput('scalper-skew', params.skew ?? 0);
        setInput('scalper-long-max-price', params.longMaxPrice || '');
        setInput('scalper-short-min-price', params.shortMinPrice || '');
        // Restore start mode (LONG / SHORT / NEUTRAL 3-way button)
        const mode = params.neutralMode ? 'NEUTRAL' : (params.side === 'SHORT' ? 'SHORT' : 'LONG');
        const modeBtn = document.getElementById(`scalper-mode-${mode.toLowerCase()}`);
        if (modeBtn) {
            modeBtn.click(); // triggers _setScalperMode which also shows/hides neutral settings
        } else {
            // fallback: set data attribute directly
            const ctrl = document.getElementById('scalper-controls');
            if (ctrl) ctrl.dataset.scalperMode = mode;
            const settings = document.getElementById('scalper-neutral-settings');
            if (settings) settings.style.display = mode === 'NEUTRAL' ? 'block' : 'none';
        }
        setInput('scalper-min-fill-spread', (params.minFillSpreadPct || 0).toFixed(2));
        setInput('scalper-fill-decay-halflife', Math.round((params.fillDecayHalfLifeMs || 30000) / 1000));
        setInput('scalper-min-refill-delay', Math.round((params.minRefillDelayMs || 0) / 1000));
        setChecked('scalper-allow-loss', params.allowLoss ?? false);
        import('./scalper.js').then(m => m.updateScalperPreview?.());
    }

    // ── Set edit mode ──────────────────────────────────────────────
    if (params.orderId) {
        S.set('_editState', { type, orderId: params.orderId });

        // Update submit button label
        const btn = document.getElementById('submit-trade');
        if (btn) {
            btn.dataset.origLabel = btn.textContent;
            btn.dataset.editModeLabel = '1';
            const labels = { TWAP: 'Update TWAP', TRAIL: 'Update Trail', CHASE: 'Update Chase', SCALPER: 'Update Scalper' };
            btn.textContent = `✏️ ${labels[type] || 'Update'}`;
        }

        // Show edit-mode banner above submit button
        const existing = document.getElementById('edit-mode-banner');
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = 'edit-mode-banner';
        banner.style.cssText = 'background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); border-radius:5px; padding:5px 10px; font-size:10px; color:#f59e0b; display:flex; align-items:center; justify-content:space-between; margin:4px 10px 4px;';
        banner.innerHTML = `<span>✏️ Editing ${type} — submit will cancel & restart</span><span id="edit-mode-clear" style="cursor:pointer; opacity:0.7; font-size:12px; padding:0 4px;" title="Cancel edit">✕</span>`;
        const submitBtn = document.getElementById('submit-trade');
        submitBtn?.parentNode?.insertBefore(banner, submitBtn);
        banner.querySelector('#edit-mode-clear')?.addEventListener('click', () => clearEditMode());
    }
}

// ── Compact Positions Panel ─────────────────────

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

        // Update live USD notional
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

    // ── Live chart position line update ──────────────────────────────
    // Directly update the entry line title via applyOptions() — no REST,
    // no debounce, immediate. Works for ALL positions on this symbol.
    for (const [key, line] of _positionLineRegistry) {
        const [lineSym, lineSide] = key.split('|');
        if (lineSym !== symbol) continue;
        // Find position data for this side
        let totalQty = 0, weightedEntry = 0, totalPnl = 0, totalMargin = 0;
        for (const [, pos] of S._positionMap) {
            if (pos.symbol !== symbol || pos.side !== lineSide) continue;
            totalQty += pos.quantity || 0;
            weightedEntry += (pos.entryPrice || 0) * (pos.quantity || 0);
            totalMargin += pos.margin || 0;
        }
        // Fall back to DOM data if _positionMap margin not populated yet
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

export async function marketClosePosition(positionId, symbol) {
    if (!(await cuteConfirm({ title: `Close ${symbol.split('/')[0]}?`, message: 'This will market close the position~', confirmText: 'Close', danger: true }))) return;
    showToast(`Closing ${symbol.split('/')[0]}...`, 'info');
    try {
        const result = await api(`/trade/close/${positionId}`, { method: 'POST' });
        const pnl = result.trade?.realizedPnl || 0;
        const label = result.staleCleanup ? 'Removed stale position' : `Closed ${symbol.split('/')[0]}. PnL: ${formatUsd(pnl)}`;
        showToast(label, result.staleCleanup ? 'info' : (pnl >= 0 ? 'success' : 'warning'));
        _removePositionRow(positionId);
        scheduleTradingRefresh({
            openOrders: true,
            annotations: true,
            forceAnnotations: true,
        }, 30);
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('already closed')) {
            // Position is gone — remove the ghost row from UI
            _removePositionRow(positionId);
            showToast('Position already closed — removed from list', 'info');
        } else {
            showToast(`${err.message}`, 'error');
        }
    }
}

/** Remove a position row from the DOM, update the count badge, and clean _positionMap. */
function _removePositionRow(positionId) {
    const row = document.querySelector(`.compact-pos-row[data-cp-id="${positionId}"]`);
    if (row) row.remove();
    S._positionMap.delete(positionId);
    const countEl = document.getElementById('compact-pos-count');
    if (countEl) countEl.textContent = document.querySelectorAll('#compact-pos-list .compact-pos-row').length;
}

export function updateCompactLiqForPosition(positionId, liqPrice = null) {
    if (!positionId) return;
    const liq = liqPrice ?? S._positionMap.get(positionId)?.liquidationPrice ?? 0;
    const row = document.querySelector(`.compact-pos-row[data-cp-id="${positionId}"]`);
    if (!row) return;
    const el = row.querySelector(`[data-cpliq-id="${positionId}"]`);
    if (el) el.textContent = liq > 0 ? formatPrice(liq) : '—';
}

export function scheduleChartRiskRefresh() {
    if (!S._tradingMounted || !state.currentAccount) return;
    if (S._chartRiskRefreshTimer) return;
    S.set('_chartRiskRefreshTimer', setTimeout(() => {
        S.set('_chartRiskRefreshTimer', null);
        loadChartAnnotations();
    }, 1200));
}

// ── Chart Annotations ───────────────────────────

const LEFT_LABEL_LAYER_ID = 'chart-left-annotation-layer';
const LEFT_LABEL_MIN_GAP_PX = 18;
let _cachedLeftLabelSpecs = [];

// Live position price-line registry — keyed by `${symbol}|${side}`
// Populated by _drawChartAnnotations, read by recalcCompactPnl.
export const _positionLineRegistry = new Map(); // key → IPriceLine
export const _orderLineRegistry = new Map(); // key (orderId) → IPriceLine

function _ensureLeftLabelLayer() {
    const container = document.getElementById('tv-chart');
    if (!container) return null;
    let layer = document.getElementById(LEFT_LABEL_LAYER_ID);
    if (!layer) {
        layer = document.createElement('div');
        layer.id = LEFT_LABEL_LAYER_ID;
        layer.className = 'chart-left-annotation-layer';
        container.appendChild(layer);
    }
    return layer;
}

function _clearLeftLabels() {
    const layer = document.getElementById(LEFT_LABEL_LAYER_ID);
    if (!layer) return;
    layer.innerHTML = '';
}

function _renderLeftPriceLabels(specs = []) {
    _clearLeftLabels();
    if (!specs.length || !S.candleSeries) return;

    const container = document.getElementById('tv-chart');
    if (!container) return;

    const layer = _ensureLeftLabelLayer();
    if (!layer) return;

    const maxTop = Math.max(0, container.clientHeight - 16);
    const positioned = [];

    for (const spec of specs) {
        const price = Number(spec.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const y = S.candleSeries.priceToCoordinate(price);
        if (!Number.isFinite(y)) continue;
        const top = Math.min(maxTop, Math.max(0, Math.round(y - 8)));
        positioned.push({ ...spec, top });
    }

    if (positioned.length === 0) return;

    positioned.sort((a, b) => a.top - b.top);
    for (let i = 1; i < positioned.length; i++) {
        const prev = positioned[i - 1];
        if (positioned[i].top < prev.top + LEFT_LABEL_MIN_GAP_PX) {
            positioned[i].top = Math.min(maxTop, prev.top + LEFT_LABEL_MIN_GAP_PX);
        }
    }

    for (const item of positioned) {
        const el = document.createElement('div');
        el.className = `chart-left-annotation-label ${item.tone || 'neutral'}`;
        el.style.top = `${item.top}px`;
        el.innerHTML = item.html || item.text;
        layer.appendChild(el);
    }
}

export function refreshChartLeftAnnotationLabels() {
    _renderLeftPriceLabels(_cachedLeftLabelSpecs);
}

export function loadChartAnnotations(force = false) {
    if (force) {
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationLastFetch', 0);
        S.set('_chartAnnotationFingerprint', null);
    }
    S.set('_chartAnnotationForceNext', S._chartAnnotationForceNext || force);
    if (S._chartAnnotationTimer) clearTimeout(S._chartAnnotationTimer);
    S.set('_chartAnnotationTimer', setTimeout(_loadChartAnnotationsImpl, 300));
}

function _chartAnnotationDataFingerprint(data, showPositions, showOpenOrders, showPastOrders) {
    const posKey = (data.positions || [])
        .map(p => `${p.id}|${p.side}|${p.entryPrice}|${p.quantity}|${p.liquidationPrice}`)
        .sort()
        .join(';');
    const ordKey = (data.openOrders || [])
        .map(o => `${o.clientOrderId}|${o.side}|${o.price}|${o.quantity}`)
        .sort()
        .join(';');
    const tradeKey = (data.trades || [])
        .map(t => `${t.id}`)
        .sort()
        .join(';');
    return `${showPositions}|${showOpenOrders}|${showPastOrders}||${posKey}||${ordKey}||${tradeKey}`;
}

async function _loadChartAnnotationsImpl() {
    S.set('_chartAnnotationTimer', null);
    const force = S._chartAnnotationForceNext;
    S.set('_chartAnnotationForceNext', false);
    if (!S.candleSeries || !S.chartReady || !state.currentAccount) return;

    const generation = S._chartAnnotationGeneration + 1;
    S.set('_chartAnnotationGeneration', generation);

    const showPositions = document.getElementById('cs-show-positions')?.checked ?? true;
    const showOpenOrders = document.getElementById('cs-show-open-orders')?.checked ?? true;
    const showPastOrders = document.getElementById('cs-show-past-orders')?.checked ?? true;

    try {
        let data;
        const now = Date.now();

        if (S._chartAnnotationCache && (now - S._chartAnnotationLastFetch) < S.CHART_ANNOTATION_MIN_INTERVAL) {
            data = S._chartAnnotationCache;
        } else {
            data = await api(`/trade/chart-data/${state.currentAccount}?symbol=${encodeURIComponent(S.selectedSymbol)}`);

            if (generation !== S._chartAnnotationGeneration) return;

            S.set('_chartAnnotationCache', data);
            S.set('_chartAnnotationLastFetch', Date.now());
        }

        if (generation !== S._chartAnnotationGeneration) return;

        const fp = _chartAnnotationDataFingerprint(data, showPositions, showOpenOrders, showPastOrders);
        if (!force && fp === S._chartAnnotationFingerprint) {
            _renderLeftPriceLabels(_cachedLeftLabelSpecs);
            return;
        }
        S.set('_chartAnnotationFingerprint', fp);

        for (const line of S.chartPriceLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
        S.set('chartPriceLines', []);
        S.candleSeries.setMarkers([]);
        _clearLeftLabels();
        _positionLineRegistry.clear();
        _orderLineRegistry.clear();

        _cachedLeftLabelSpecs = _drawChartAnnotations(data, showPositions, showOpenOrders, showPastOrders);
    } catch (err) {
        console.debug('[Chart] Annotations unavailable:', err.message);
    }
}

function _drawChartAnnotations(data, showPositions, showOpenOrders, showPastOrders) {
    if (!S.candleSeries) return [];
    const leftLabelSpecs = [];

    if (showPositions) {
        const grouped = {};
        for (const pos of data.positions) {
            const key = `${pos.symbol}|${pos.side}`;
            if (!grouped[key]) grouped[key] = { side: pos.side, totalQty: 0, weightedEntry: 0, liqPrice: 0, totalPnl: 0, totalMargin: 0, totalNotional: 0 };
            grouped[key].totalQty += pos.quantity;
            grouped[key].weightedEntry += pos.entryPrice * pos.quantity;
            grouped[key].totalPnl += pos.unrealizedPnl || 0;
            grouped[key].totalMargin += pos.margin || 0;
            grouped[key].totalNotional += pos.notional || 0;
            if (pos.side === 'LONG') {
                grouped[key].liqPrice = Math.max(grouped[key].liqPrice, pos.liquidationPrice || 0);
            } else {
                grouped[key].liqPrice = grouped[key].liqPrice > 0
                    ? Math.min(grouped[key].liqPrice, pos.liquidationPrice || Infinity)
                    : pos.liquidationPrice || 0;
            }
        }

        for (const [groupKey, g] of Object.entries(grouped)) {
            const avgEntry = g.totalQty > 0 ? g.weightedEntry / g.totalQty : 0;
            const isLong = g.side === 'LONG';
            const pnl = g.totalPnl;
            const pnlPct = g.totalMargin > 0 ? (pnl / g.totalMargin) * 100 : 0;
            const pnlSign = pnl >= 0 ? '+' : '';
            const sideLabel = isLong ? 'Long' : 'Short';

            const entryLine = S.candleSeries.createPriceLine({
                price: avgEntry,
                color: isLong ? '#22c55e' : '#ef4444',
                lineWidth: 2,
                lineStyle: 0,
                axisLabelVisible: true,
                title: '',
            });
            S.chartPriceLines.push(entryLine);
            // Register for live label updates via recalcCompactPnl (key = 'BTC/USDT:USDT|LONG')
            _positionLineRegistry.set(groupKey, entryLine);
            leftLabelSpecs.push({
                price: avgEntry,
                html: `<span style="opacity:0.85">${sideLabel}</span> ${pnlSign}$${Math.abs(pnl).toFixed(2)} <span style="opacity:0.75">(${pnlSign}${pnlPct.toFixed(1)}%)</span>`,
                text: `${sideLabel} ${pnlSign}$${Math.abs(pnl).toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
                tone: isLong ? 'long' : 'short',
            });

            if (g.liqPrice > 0) {
                const liqLine = S.candleSeries.createPriceLine({
                    price: g.liqPrice,
                    color: '#f97316',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: false,
                    title: '',
                });
                S.chartPriceLines.push(liqLine);
                leftLabelSpecs.push({
                    price: g.liqPrice,
                    text: 'Liq Price',
                    tone: 'liq',
                });
            }
        }
    }

    if (showOpenOrders && data.openOrders) {
        for (const order of data.openOrders) {
            const isLong = order.side === 'BUY';
            const orderLine = S.candleSeries.createPriceLine({
                price: order.price,
                color: isLong ? '#4ade80' : '#f87171',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: false,
                title: '',
            });
            S.chartPriceLines.push(orderLine);
            _orderLineRegistry.set(order.clientOrderId, orderLine);
            leftLabelSpecs.push({
                price: order.price,
                text: `${order.side} Limit`,
                tone: isLong ? 'long' : 'short',
            });
        }
    }

    if (showPastOrders && data.trades && data.trades.length > 0) {
        // Convert timeframe string (e.g. '1m','5m','1h','1d') to seconds
        const tfMap = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
        const tfStr = S.currentTimeframe || '5m';
        const tfUnit = tfStr.slice(-1);
        const tfNum = parseInt(tfStr) || 1;
        const candleSeconds = tfNum * (tfMap[tfUnit] || 60);

        const markers = data.trades
            .filter(t => t.timestamp)
            .map(t => {
                const isBuy = t.side === 'BUY';
                const isClose = t.action === 'CLOSE' || t.action === 'LIQUIDATE';
                const rawTime = Math.floor(new Date(t.timestamp).getTime() / 1000);
                // Snap to candle boundary so all trades in the same candle share the same time
                const snappedTime = Math.floor(rawTime / candleSeconds) * candleSeconds;
                return {
                    time: snappedTime,
                    position: isBuy ? 'belowBar' : 'aboveBar',
                    color: isClose ? (t.realizedPnl >= 0 ? '#22c55e' : '#ef4444') : (isBuy ? '#22c55e' : '#ef4444'),
                    shape: isBuy ? 'arrowUp' : 'arrowDown',
                    text: '',
                };
            })
            .sort((a, b) => a.time - b.time);

        // Keep only one marker per candle per side (belowBar / aboveBar)
        const seen = new Set();
        const uniqueMarkers = markers.filter(m => {
            const key = `${m.time}_${m.position}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (uniqueMarkers.length > 0) {
            S.candleSeries.setMarkers(uniqueMarkers);
        }
    }

    _renderLeftPriceLabels(leftLabelSpecs);
    return leftLabelSpecs;
}
