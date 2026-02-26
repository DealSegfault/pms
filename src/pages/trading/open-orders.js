// ── Trading Page – Open Orders Panel ──
// Renders all open order types (limit, TWAP, chase, scalper, trail, agent, smart)
// and handles cancel actions.
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { cancelTwap } from './twap.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { recordLatency } from './perf-metrics.js';
import { formatRelativeTime, applySymbolFilter } from './positions-panel.js';

// ── Snapshot caching ────────────────────────────────

const OPEN_ORDERS_BURST_CACHE_MS = 2500;

let _openOrdersSnapshotCache = null;    // { key, ts, data }
let _openOrdersSnapshotInflight = null; // { key, promise }

function _perfNow() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

export function invalidateOpenOrdersSnapshot() {
    _openOrdersSnapshotCache = null;
}

export async function fetchOpenOrdersSnapshot({ force = false } = {}) {
    const subAccountId = state.currentAccount;
    if (!subAccountId) return null;
    const key = subAccountId;
    const now = Date.now();

    if (_openOrdersSnapshotInflight && _openOrdersSnapshotInflight.key === key) {
        return _openOrdersSnapshotInflight.promise;
    }

    if (!force && _openOrdersSnapshotCache && _openOrdersSnapshotCache.key === key) {
        if ((now - _openOrdersSnapshotCache.ts) < OPEN_ORDERS_BURST_CACHE_MS) {
            return _openOrdersSnapshotCache.data;
        }
    }

    const promise = Promise.all([
        api(`/trade/orders/${subAccountId}`),
        api(`/trade/twap/active/${subAccountId}`).catch(() => []),
        api(`/trade/trail-stop/active/${subAccountId}`).catch(() => []),
        api(`/trade/chase-limit/active/${subAccountId}`).catch(() => []),
        api(`/trade/scalper/active/${subAccountId}`).catch(() => []),
        api(`/trade/agents/${subAccountId}`).catch(() => []),
        api(`/trade/smart-order/active/${subAccountId}`).catch(() => []),
    ]).then(([orders, twaps, trailStops, chaseOrders, scalpers, agents, smartOrders]) => {
        const data = { orders, twaps, trailStops, chaseOrders, scalpers, agents, smartOrders };
        _openOrdersSnapshotCache = { key, ts: Date.now(), data };
        return data;
    }).finally(() => {
        if (_openOrdersSnapshotInflight?.promise === promise) {
            _openOrdersSnapshotInflight = null;
        }
    });

    _openOrdersSnapshotInflight = { key, promise };
    return promise;
}

// ── Render open orders list ─────────────────────────

export async function loadOpenOrders() {
    if (!state.currentAccount) return;
    const list = document.getElementById('open-orders-list');
    const countEl = document.getElementById('open-orders-count');
    const cancelAllBtn = document.getElementById('cancel-all-orders');
    if (!list) return;

    try {
        const fetchStarted = _perfNow();
        const snapshot = await fetchOpenOrdersSnapshot();
        recordLatency('refresh_open_orders_fetch_ms', _perfNow() - fetchStarted);
        if (!snapshot) return;
        const { orders, twaps, trailStops, chaseOrders, scalpers, agents, smartOrders } = snapshot;
        const renderStarted = _perfNow();

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

        const totalCount = orders.length + twaps.length + trailStops.length + standaloneChases.length + scalpers.length + agents.length + (smartOrders ? smartOrders.length : 0);
        if (countEl) countEl.textContent = totalCount;
        if (cancelAllBtn) {
            cancelAllBtn.dataset.hasOrders = orders.length > 0 ? '1' : '0';
            const ordersTabActive = document.getElementById('bp-orders')?.classList.contains('active');
            cancelAllBtn.style.display = (orders.length > 0 && ordersTabActive !== false) ? '' : 'none';
        }
        const killScalpersBtn = document.getElementById('cancel-all-scalpers');
        if (killScalpersBtn) {
            killScalpersBtn.style.display = scalpers.length > 0 ? '' : 'none';
        }

        if (totalCount === 0) {
            list.innerHTML = '<div style="padding:8px; color:var(--text-muted); text-align:center;">No open orders</div>';
            recordLatency('refresh_open_orders_render_ms', _perfNow() - renderStarted);
            return;
        }

        let html = '';

        // ── TWAP rows
        for (const t of twaps) {
            const isLong = t.side === 'LONG';
            const pct = t.totalLots > 0 ? Math.round((t.filledLots / t.totalLots) * 100) : 0;
            const eta = new Date(t.estimatedEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const priceLimitStr = t.priceLimit ? `<span style="font-size:9px; color:var(--accent); opacity:0.85;">${isLong ? 'Max' : 'Min'}: $${formatPrice(t.priceLimit)}</span>` : '';
            const twapEdit = JSON.stringify({ type: 'TWAP', orderId: t.twapId, symbol: t.symbol, side: t.side, totalSize: t.totalSize, lots: t.totalLots, durationMinutes: t.durationMinutes, jitter: t.jitter || false, irregular: t.irregular || false, priceLimit: t.priceLimit || null });
            html += `
        <div class="oo-row" style="border-left:3px solid var(--accent); background:rgba(99,102,241,0.05);">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${t.symbol}">${t.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
            <span data-edit-type="TWAP" data-edit='${twapEdit.replace(/'/g, "&#39;")}' style="font-size:9px; color:var(--accent); font-weight:600; margin-left:2px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px;" title="Click to edit">TWAP</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span style="font-size:10px; font-weight:600;">${t.filledLots}/${t.totalLots} lots</span>
            <span style="font-size:9px; color:var(--text-muted);">ETA ${eta}</span>
            ${priceLimitStr}
          </span>
          <span class="oor-qty" style="min-width:60px;">
            <div style="background:var(--surface-2); border-radius:3px; height:6px; overflow:hidden; width:100%;">
              <div style="width:${pct}%; height:100%; background:var(--accent); border-radius:3px; transition:width 0.3s;"></div>
            </div>
            <span style="font-size:9px; color:var(--text-muted);">${pct}%</span>
          </span>
          <span class="oor-notional">$${t.filledSize.toFixed(0)}/$${t.totalSize.toFixed(0)}</span>
          <span class="oor-age">${t.durationMinutes}m</span>
          <span class="oor-cancel" data-cancel-twap="${t.twapId}" title="Cancel TWAP">✕</span>
        </div>
      `;
        }

        // ── Trail Stop rows
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
            const fillCount = sp.fillCount || 0;
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
                const slotKey = `${ch.side || 'UNK'}:${ch.layerIdx ?? ''}`;
                const slotStatus = ch.paused
                    ? `<span style="font-size:9px; color:#f59e0b;" title="Price filter — paused">⏸</span>`
                    : ch.retryAt && !ch.chaseId
                        ? `<span style="font-size:9px; color:#f43f5e;" title="Retrying">⟳</span>`
                        : `<span style="font-size:9px; color:#22c55e;" title="Active">●</span>`;
                html += `
          <div class="oo-row" data-chase-id="${ch.chaseId}" style="margin:1px 0; background:${isLong ? 'rgba(6,182,212,0.04)' : 'rgba(249,115,22,0.04)'}; border:none; padding:3px 8px;">
            <span class="oor-sym">
              <span data-slot-badge="${slotKey}">${slotStatus}</span>
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

            if (children.length === 0) {
                html += `<div style="padding:4px 8px; font-size:9px; color:var(--text-muted);">Starting layers...</div>`;
            }

            html += `</div>`; // close drawer
        }

        // ── Standalone chase rows
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

        // ── Plain limit orders
        for (const o of orders) {
            if (['TWAP', 'TWAP_SLICE', 'CHASE_LIMIT', 'SCALPER_LIMIT'].includes(o.type)) continue;

            const notional = (o.price * o.quantity).toFixed(2);
            const isLong = o.side === 'LONG';
            const age = formatRelativeTime(o.createdAt);
            html += `
        <div class="oo-row" data-order-id="${o.id}">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${o.symbol}">${o.symbol.split('/')[0]}</span>
            <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
          </span>
          <span class="oor-price">$${formatPrice(o.price)}</span>
          <span class="oor-qty">${o.quantity.toFixed(4)}</span>
          <span class="oor-notional">$${notional}</span>
          <span class="oor-age">${age}</span>
          <span class="oor-cancel" data-cancel-order="${o.id}" title="Cancel order">✕</span>
        </div>
      `;
        }

        // ── Agent rows
        for (const ag of agents) {
            const sym = (ag.symbol || '').split('/')[0];
            const AGENT_ICONS = { trend: '📈', grid: '📊', deleverage: '🔻' };
            const AGENT_COLORS = { trend: '#8b5cf6', grid: '#06b6d4', deleverage: '#f43f5e' };
            const icon = AGENT_ICONS[ag.type] || '🤖';
            const color = AGENT_COLORS[ag.type] || '#8b5cf6';
            const managedCount = ag.managedScalpers ? Object.keys(ag.managedScalpers).length : 0;
            const tickCount = ag.tickCount || 0;
            const signalText = ag.signal ? `• ${ag.signal}` : '';
            const pausedText = ag.paused ? ' ⏸' : '';
            const deleveragingText = ag.deleveraging ? ' 🔻' : '';
            const age = ag.startedAt ? formatRelativeTime(new Date(ag.startedAt).toISOString()) : '—';
            html += `
        <div class="oo-row" data-agent-id="${ag.agentId}" style="border-left:3px solid ${color}; background:${color}15;">
          <span class="oor-sym">
            <span class="oor-name" data-oo-symbol="${ag.symbol}">${sym}</span>
            <span style="font-size:9px; color:${color}; font-weight:700; margin-left:4px;">${icon} ${ag.type.toUpperCase()}</span>
          </span>
          <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
            <span style="font-size:10px; font-weight:600;">${ag.status}${pausedText}${deleveragingText}</span>
            <span style="font-size:9px; color:var(--text-muted);">${managedCount} scalper${managedCount !== 1 ? 's' : ''} ${signalText}</span>
          </span>
          <span class="oor-qty" style="min-width:60px; font-size:10px;">
            <span style="font-size:9px; color:var(--text-muted);">${tickCount} ticks</span>
          </span>
          <span class="oor-notional" style="font-size:9px; color:${color}; font-weight:600;">🤖 Agent</span>
          <span class="oor-age">${age}</span>
          <span class="oor-cancel" data-cancel-agent="${ag.agentId}" title="Stop Agent">✕</span>
        </div>
      `;
        }

        // ── SmartOrder rows
        if (smartOrders) {
            for (const so of smartOrders) {
                const isLong = so.side === 'LONG';
                const isShort = so.side === 'SHORT';
                const badgeClass = isLong ? 'cpr-long' : (isShort ? 'cpr-short' : '');
                const badgeText = isLong ? 'L' : (isShort ? 'S' : 'N');
                const age = formatRelativeTime(so.createdAt);
                html += `
            <div class="oo-row" data-smart-id="${so.id}" style="border-left:3px solid #0ea5e9; background:rgba(14,165,233,0.06);">
              <span class="oor-sym">
                <span class="oor-name" data-oo-symbol="${so.symbol}">${so.symbol.split('/')[0]}</span>
                <span class="oor-badge ${badgeClass}">${badgeText}</span>
                <span style="font-size:9px; color:#0ea5e9; font-weight:700; margin-left:4px;" title="SmartOrder">🧠 SMART</span>
              </span>
              <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
                <span style="font-size:10px; font-weight:600;">${so.status}</span>
                <span style="font-size:9px; color:var(--text-muted);">${so.details || ''}</span>
              </span>
              <span class="oor-qty" style="min-width:60px; font-size:10px;">
                <span style="font-size:9px; color:var(--text-muted);">$${formatPrice(so.amountInvestedUsd || 0)}</span>
              </span>
              <span class="oor-notional" style="font-size:9px; color:#0ea5e9; font-weight:600;">TCA</span>
              <span class="oor-age">${age}</span>
              <span class="oor-cancel" data-cancel-smart="${so.id}" title="Stop SmartOrder">✕</span>
            </div>
          `;
            }
        }

        list.innerHTML = html;
        applySymbolFilter();

        // ── Bind cancel event handlers ──
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
        list.querySelectorAll('[data-cancel-agent]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                import('./agents.js').then(m => m.cancelAgent(btn.dataset.cancelAgent));
            });
        });
        list.querySelectorAll('[data-cancel-smart]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                cancelSmartOrder(btn.dataset.cancelSmart);
            });
        });

        // Click order type badge → prefill form for editing
        list.querySelectorAll('[data-edit-type]').forEach(badge => {
            badge.addEventListener('click', e => {
                e.stopPropagation();
                try {
                    const params = JSON.parse(badge.dataset.edit);
                    import('./positions-panel.js').then(m => m.prefillOrderForm(params));
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
        recordLatency('refresh_open_orders_render_ms', _perfNow() - renderStarted);
    } catch (err) {
        console.debug('[Orders] Failed to load:', err.message);
    }
}

// ── Cancel actions ──────────────────────────────────

export async function cancelOrder(orderId) {
    showToast('⏳ Cancelling order...', 'info');
    try {
        await api(`/trade/orders/${orderId}`, { method: 'DELETE' });
        invalidateOpenOrdersSnapshot();
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
        invalidateOpenOrdersSnapshot();
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

export async function cancelSmartOrder(smartOrderId) {
    if (!state.currentAccount) return;
    showToast(`⏳ Stopping SmartOrder...`, 'info');
    try {
        await api(`/trade/smart-order/${smartOrderId}?subAccountId=${state.currentAccount}`, { method: 'DELETE' });
        invalidateOpenOrdersSnapshot();
        showToast(`✅ SmartOrder stop initiated`, 'success');
        scheduleTradingRefresh({
            openOrders: true
        }, 40);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}
