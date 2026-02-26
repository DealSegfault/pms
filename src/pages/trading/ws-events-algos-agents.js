// Trading WS algo + agent event handlers.
// Owns TWAP/trail/chase/scalper/agent live UI updates.

import { formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { scheduleChartRiskRefresh } from './chart-annotations.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { playFillSound } from './fill-sounds.js';
import { drawLiveTrailStop, clearAllTrailStopLines } from './trail-stop.js';
import { drawLiveChase, removeChase } from './chase-limit.js';
import {
    removeCompactPositionFromUi,
    resetChartPositionOverlays,
} from './ws-position-updates.js';

export function registerAlgoAndAgentEventHandlers({ mkHandler }) {
    mkHandler('twap_progress', (e) => {
        if (!S._tradingMounted) return;

        const d = e.detail || {};
        if (d.twapId) {
            const row = document.querySelector(`[data-twap-id="${d.twapId}"]`);
            if (row) {
                const progEl = row.querySelector('.oor-qty span');
                if (progEl) progEl.textContent = `${d.progressPct || 0}%`;

                const priceEl = row.querySelector('.oor-price span:last-child');
                if (priceEl && d.avgFillPrice > 0) {
                    priceEl.textContent = `$${formatPrice(d.avgFillPrice)}`;
                }
            } else {
                scheduleTradingRefresh({ openOrders: true, account: true }, 500);
            }
        }

        if (d.symbol === S.selectedSymbol) scheduleChartRiskRefresh();
    });

    mkHandler('twap_completed', (e) => {
        if (!S._tradingMounted) return;

        const d = e.detail || {};
        if (d.twapId) {
            const row = document.querySelector(`[data-twap-id="${d.twapId}"]`);
            if (row) row.remove();
        }

        scheduleTradingRefresh({ annotations: true, account: true }, 500);
    });

    mkHandler('twap_cancelled', (e) => {
        if (!S._tradingMounted) return;

        const d = e.detail || {};
        if (d.twapId) {
            const row = document.querySelector(`[data-twap-id="${d.twapId}"]`);
            if (row) row.remove();
        }

        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('trail_stop_progress', (e) => {
        if (!S._tradingMounted) return;

        const d = e.detail;
        if (d?.symbol === S.selectedSymbol) {
            drawLiveTrailStop(d);
        }

        if (d?.trailStopId) {
            const row = document.querySelector(`[data-trail-id="${d.trailStopId}"]`);
            if (row) {
                const isLong = d.side === 'LONG';

                const extremeEl = row.querySelector('.trail-extreme');
                if (extremeEl && d.extremePrice) {
                    extremeEl.textContent = `${isLong ? 'HWM' : 'LWM'}: $${formatPrice(d.extremePrice)}`;
                }

                const triggerEl = row.querySelector('.trail-trigger');
                if (triggerEl && d.triggerPrice) {
                    triggerEl.innerHTML = `⚡$${formatPrice(d.triggerPrice)}`;
                }

                const statusEl = row.querySelector('.trail-status');
                if (statusEl) {
                    statusEl.textContent = d.activated ? 'tracking' : 'waiting';
                }
            } else {
                scheduleTradingRefresh({ positions: true, openOrders: true, account: true }, 30);
            }
        }
    });

    mkHandler('trail_stop_triggered', (e) => {
        if (!S._tradingMounted) return;

        const d = e.detail || {};

        const sym = d.symbol ? d.symbol.split('/')[0] : '';
        const priceStr = d.triggeredPrice ? `@ $${formatPrice(d.triggeredPrice)}` : '';
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`⚡ Trail stop filled: ${sym} ${d.side || ''} ${priceStr}`, 'success');
        });

        removeCompactPositionFromUi(d.positionId);
        resetChartPositionOverlays({ clearTrail: true });

        import('./order-form.js').then(m => m._refreshEquityUpnl());
        scheduleTradingRefresh({
            openOrders: true,
            positions: true,
            account: true,
            annotations: true,
            forceAnnotations: true,
        }, 50);
    });

    mkHandler('trail_stop_cancelled', (e) => {
        if (!S._tradingMounted) return;

        clearAllTrailStopLines();
        const d = e.detail || {};
        if (d.trailStopId) {
            const row = document.querySelector(`[data-trail-id="${d.trailStopId}"]`);
            if (row) row.remove();
        }

        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('chase_progress', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        drawLiveChase(data);

        if (data?.chaseId) {
            const row = document.querySelector(`[data-chase-id="${data.chaseId}"]`);
            if (row) {
                const priceEl = row.querySelector('.chase-live-price');
                if (priceEl && data.currentOrderPrice) {
                    priceEl.textContent = `$${formatPrice(data.currentOrderPrice)}`;
                }

                const repEl = row.querySelector('.chase-live-reprices');
                if (repEl) repEl.textContent = `${data.repriceCount || 0} reprices`;
            } else {
                scheduleTradingRefresh({ positions: true, openOrders: true, account: true }, 30);
            }
        }

        if (data?.symbol && data.currentOrderPrice) {
            const posRow = document.querySelector(`.compact-pos-row[data-cp-symbol="${data.symbol}"]`);
            if (posRow) {
                let chaseTag = posRow.querySelector('.chase-price-tag');
                if (!chaseTag) {
                    chaseTag = document.createElement('span');
                    chaseTag.className = 'chase-price-tag';
                    chaseTag.style.cssText = 'font-size:9px; color:#06b6d4; font-weight:600; margin-left:3px;';
                    const symSpan = posRow.querySelector('.cpr-sym');
                    if (symSpan) symSpan.appendChild(chaseTag);
                }
                chaseTag.textContent = `🎯${formatPrice(data.currentOrderPrice)}`;
            }
        }
    });

    mkHandler('chase_filled', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (data?.side) playFillSound(data.side);
        if (data?.chaseId) removeChase(data.chaseId);

        if (data?.symbol) {
            const tag = document.querySelector(`.compact-pos-row[data-cp-symbol="${data.symbol}"] .chase-price-tag`);
            if (tag) tag.remove();
        }

        const oor = document.querySelector(`[data-chase-id="${data?.chaseId}"]`);
        if (oor) oor.remove();

        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('chase_cancelled', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (data?.chaseId) removeChase(data.chaseId);

        if (data?.reason) {
            import('../../core/index.js').then(({ showToast }) => {
                const rawReason = String(data.reason || '').trim();
                const lower = rawReason.toLowerCase();
                let msg = `Chase cancelled: ${data.symbol?.split('/')[0] || ''}`;

                if (lower.includes('distance_breached')) {
                    msg = `Chase max distance reached: ${data.symbol?.split('/')[0] || ''}`;
                } else if (
                    lower.includes('notional') ||
                    lower.includes('minimum quantity') ||
                    lower.includes('min_notional_breached') ||
                    lower.includes('-4164')
                ) {
                    msg = `Chase stopped: ${rawReason}`;
                } else if (rawReason && rawReason !== 'cancelled') {
                    msg = `Chase stopped: ${rawReason}`;
                }

                showToast(msg, 'warning');
            }).catch(() => { });
        }

        if (data?.symbol) {
            const tag = document.querySelector(`.compact-pos-row[data-cp-symbol="${data.symbol}"] .chase-price-tag`);
            if (tag) tag.remove();
        }

        const oor = document.querySelector(`[data-chase-id="${data?.chaseId}"]`);
        if (oor) oor.remove();

        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('scalper_progress', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (!data?.scalperId) return;

        const row = document.querySelector(`[data-scalper-id="${data.scalperId}"]`);
        if (row) {
            const fillEl = row.querySelector('.oor-price span:last-child');
            if (fillEl) fillEl.textContent = `${data.fillCount || 0} fills`;
        }

        const drawer = document.querySelector(`[data-scalper-drawer="${data.scalperId}"]`);
        if (!drawer) return;

        const allSlots = [
            ...(data.longSlots || []).map(slot => ({ ...slot, side: 'LONG' })),
            ...(data.shortSlots || []).map(slot => ({ ...slot, side: 'SHORT' })),
        ];
        const slotsWithRetry = allSlots.filter(s => s.retryAt && !s.active);

        const prevTimer = drawer._scalperCountdownTimer;
        if (prevTimer) clearInterval(prevTimer);

        function updateSlotBadges() {
            const now = Date.now();
            for (const slot of allSlots) {
                const key = `${slot.side || 'UNK'}:${slot.layerIdx}`;
                const badge = drawer.querySelector(`[data-slot-badge="${key}"]`);
                if (!badge) continue;

                if (slot.active) {
                    badge.textContent = '●';
                    badge.style.color = '#22c55e';
                    badge.title = 'Active';
                } else if (slot.paused) {
                    badge.textContent = '⏸ paused';
                    badge.style.color = '#f59e0b';
                    badge.title = 'Price filter active — waiting for price to re-enter range';
                } else if (slot.retryAt) {
                    const secsLeft = Math.max(0, Math.ceil((slot.retryAt - now) / 1000));
                    badge.textContent = secsLeft > 0 ? `⟳ ${secsLeft}s` : '⟳ soon';
                    badge.style.color = '#f43f5e';
                    badge.title = `Retry #${slot.retryCount} — retrying in ${secsLeft}s`;
                } else {
                    badge.textContent = '●';
                    badge.style.color = '#6b7280';
                    badge.title = 'Idle';
                }
            }
        }

        updateSlotBadges();

        if (slotsWithRetry.length > 0) {
            const timer = setInterval(() => {
                const allDone = slotsWithRetry.every(s => !s.retryAt || Date.now() >= s.retryAt);
                updateSlotBadges();
                if (allDone) clearInterval(timer);
            }, 1000);
            drawer._scalperCountdownTimer = timer;
        }
    });

    mkHandler('scalper_filled', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (data?.side) playFillSound(data.side);

        const sym = data?.symbol ? data.symbol.split('/')[0] : '';
        import('../../core/index.js').then(({ showToast, formatPrice: coreFormatPrice }) => {
            showToast(`⚔️ Scalper ${data?.side} L${data?.layerIdx} filled @ $${coreFormatPrice(data?.fillPrice || 0)} (${sym})`, 'info');
        }).catch(() => { });

        scheduleChartRiskRefresh();
        scheduleTradingRefresh({ openOrders: true, account: true }, 500);
    });

    mkHandler('scalper_cancelled', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (data?.scalperId) {
            import('./scalper.js').then(m => m.clearScalperById(data.scalperId)).catch(() => { });
            const row = document.querySelector(`[data-scalper-id="${data.scalperId}"]`);
            if (row) row.remove();
        }

        const sym = data?.symbol ? data.symbol.split('/')[0] : '';
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`⚔️ Scalper stopped: ${sym}`, 'info');
        }).catch(() => { });

        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('agent_started', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        const sym = data?.symbol ? data.symbol.split('/')[0] : '';
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`🤖 ${data?.type || 'Agent'} started: ${sym}`, 'success');
        }).catch(() => { });

        scheduleTradingRefresh({ openOrders: true }, 300);
    });

    mkHandler('agent_stopped', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`🤖 Agent stopped: ${data?.reason || 'manual'}`, 'info');
        }).catch(() => { });

        scheduleTradingRefresh({ openOrders: true }, 100);
    });

    mkHandler('agent_status', (e) => {
        if (!S._tradingMounted) return;

        const data = e.detail;
        if (!data?.agentId) return;

        const row = document.querySelector(`[data-agent-id="${data.agentId}"]`);
        if (!row) return;

        const statusEl = row.querySelector('.oor-price span:first-child');
        if (statusEl) {
            const pausedText = data.paused ? ' ⏸' : '';
            const deleveragingText = data.deleveraging ? ' 🔻' : '';
            statusEl.textContent = `${data.status || 'active'}${pausedText}${deleveragingText}`;
        }

        const detailEl = row.querySelector('.oor-price span:last-child');
        if (detailEl) {
            const managedCount = data.managedScalpers ? Object.keys(data.managedScalpers).length : 0;
            const signalText = data.signal ? `• ${data.signal}` : '';
            detailEl.textContent = `${managedCount} scalper${managedCount !== 1 ? 's' : ''} ${signalText}`;
        }

        const tickEl = row.querySelector('.oor-qty span');
        if (tickEl) tickEl.textContent = `${data.tickCount || 0} ticks`;
    });
}
