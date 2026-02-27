// ── Trading Page – WebSocket Handlers ────────────────────────
import { formatPrice } from '../../core/index.js';
import { streams } from '../../lib/binance-streams.js';
import * as S from './state.js';
import { scheduleOrderBookRender, scheduleTradeTapeRender } from './orderbook.js';
import { _refreshEquityUpnl, _applyNegativeBalanceLock } from './order-form.js';
import { scheduleChartRiskRefresh, updateCompactLiqForPosition, connectCompactMarkStreams, loadChartAnnotations, removeOpenOrderRow, addLimitOrderRow } from './positions-panel.js';
import { saveToStorage } from './candle-storage.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { playFillSound } from './fill-sounds.js';
import { _orderLineRegistry } from './positions-panel.js';

let pnlUiRafId = null;
let lastPnlUiTs = 0;
let lastFallbackPositionSyncTs = 0;

// ── Stream Teardown ─────────────────────────────

export function teardownStreams() {
    if (S._klineUnsub) { S._klineUnsub(); S.set('_klineUnsub', null); }
    if (S._depthUnsub) { S._depthUnsub(); S.set('_depthUnsub', null); }
    if (S._tradeUnsub) { S._tradeUnsub(); S.set('_tradeUnsub', null); }

    // Flush any pending candle storage write
    if (S._candleStorageTimer) {
        clearTimeout(S._candleStorageTimer);
        S.set('_candleStorageTimer', null);
        const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
        const cc = S.candleCache[cacheKey];
        if (cc) saveToStorage(S.selectedSymbol, S.currentTimeframe, cc.data, cc.lastTime);
    }
}

function _schedulePnlUiRefresh() {
    if (pnlUiRafId != null) return;
    pnlUiRafId = requestAnimationFrame(() => {
        pnlUiRafId = null;
        _refreshEquityUpnl();
    });
}

// ── Stream Init ─────────────────────────────────

export function initWebSockets() {
    teardownStreams();
    if (!S._tradingMounted) return;

    const symbol = S.rawSymbol;

    // ── Kline / 1s stream ─────────────────────────────────────────────
    // Binance Futures does NOT provide @kline_1s on the combined stream.
    // For 1s we build OHLCV candles ourselves from the @aggTrade stream.
    if (S.currentTimeframe === '1s') {
        // 1s candle builder state
        let _bar1s = null; // { time, open, high, low, close, volume }

        const unsub1s = streams.subscribe(`${symbol}@aggTrade`, (data) => {
            if (!S.chartReady || !S.candleSeries || S.currentTimeframe !== '1s') return;

            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const ts = Math.floor(data.T / 1000); // second-boundary timestamp

            if (!_bar1s || ts > _bar1s.time) {
                // Emit the completed bar first (if any)
                if (_bar1s) {
                    S.candleSeries.update(_bar1s);
                    if (S.volumeSeries) {
                        S.volumeSeries.update({
                            time: _bar1s.time,
                            value: _bar1s.volume,
                            color: _bar1s.close >= _bar1s.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                        });
                    }
                }
                // Start a new bar
                _bar1s = { time: ts, open: price, high: price, low: price, close: price, volume: qty };
            } else {
                // Update current bar
                _bar1s.high = Math.max(_bar1s.high, price);
                _bar1s.low = Math.min(_bar1s.low, price);
                _bar1s.close = price;
                _bar1s.volume += qty;
                // Push a live update so the current candle follows price in real-time
                S.candleSeries.update({ time: _bar1s.time, open: _bar1s.open, high: _bar1s.high, low: _bar1s.low, close: _bar1s.close });
            }

            // Update current price display & side-effects
            S.set('currentPrice', price);
            const priceEl = document.getElementById('sym-price');
            if (priceEl) priceEl.textContent = formatPrice(price);

            for (const [, pos] of S._positionMap) {
                if (pos.symbol === S.selectedSymbol) pos.markPrice = price;
            }
            _schedulePnlUiRefresh();
            import('./trail-stop.js').then(m => m.onTrailPriceTick(price)).catch(() => { });
        });
        S.set('_klineUnsub', unsub1s);

    } else {
        // Standard kline stream for all other timeframes
        S.set('_klineUnsub', streams.subscribe(`${symbol}@kline_${S.currentTimeframe}`, (data) => {
            if (!S.chartReady || !S.candleSeries) return;
            const k = data.k;
            if (!k) return;

            const candle = {
                time: k.t / 1000,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
            };
            S.candleSeries.update(candle);

            if (S.volumeSeries) {
                S.volumeSeries.update({
                    time: candle.time,
                    value: parseFloat(k.v),
                    color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                });
            }

            // Update cache
            const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
            if (S.candleCache[cacheKey]) {
                const arr = S.candleCache[cacheKey].data;
                const existing = arr.findIndex(c => c.time === candle.time);
                const fullCandle = { ...candle, volume: parseFloat(k.v) };
                if (existing >= 0) arr[existing] = fullCandle;
                else arr.push(fullCandle);
                S.candleCache[cacheKey].lastTime = candle.time * 1000;

                // Debounced write-through to localStorage (every 30s)
                if (!S._candleStorageTimer) {
                    S.set('_candleStorageTimer', setTimeout(() => {
                        S.set('_candleStorageTimer', null);
                        const cc = S.candleCache[cacheKey];
                        if (cc) saveToStorage(S.selectedSymbol, S.currentTimeframe, cc.data, cc.lastTime);
                    }, 30000));
                }
            }

            // Update current price display
            S.set('currentPrice', candle.close);
            const priceEl = document.getElementById('sym-price');
            if (priceEl) priceEl.textContent = formatPrice(candle.close);

            for (const [, pos] of S._positionMap) {
                if (pos.symbol === S.selectedSymbol) pos.markPrice = candle.close;
            }
            _schedulePnlUiRefresh();
            import('./trail-stop.js').then(m => m.onTrailPriceTick(candle.close)).catch(() => { });
        }));
    }

    // Depth stream
    S.set('_depthUnsub', streams.subscribe(`${symbol}@depth10@100ms`, (data) => {
        if (!S._tradingMounted) return;
        S.set('orderBookAsks', (data.a || data.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]));
        S.set('orderBookBids', (data.b || data.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]));
        scheduleOrderBookRender(data.E || Date.now());

        // Live-update chase line from frontend orderbook feed
        import('./chase-limit.js').then(m => m.onChaseDepthTick()).catch(() => { });
    }));

    // Trade stream
    S.set('_tradeUnsub', streams.subscribe(`${symbol}@trade`, (data) => {
        if (!S._tradingMounted) return;
        S.recentTrades.unshift({
            price: parseFloat(data.p),
            qty: parseFloat(data.q),
            time: data.T,
            isBuyerMaker: data.m,
        });
        if (S.recentTrades.length > 50) S.recentTrades.length = 50;
        scheduleTradeTapeRender(data.T || Date.now());
    }));
}

// ── App-Level Event Handlers ────────────────────

export function setupAppEventListeners() {
    // margin_update
    const marginHandler = (e) => {
        if (!S._tradingMounted || !e.detail) return;

        const payload = e.detail || {};
        const update = payload.update || payload;
        const subAccountId = payload.subAccountId || update.subAccountId;

        if (subAccountId !== (window.__pmsState || {}).currentAccount) return;

        S.set('cachedMarginInfo', update);

        // Treat margin_update as proof WS is alive (pnl_update only fires with positions)
        S.set('_lastTradingWsPnlTs', Date.now());

        const avail = update.availableMargin ?? 0;
        const avEl = document.getElementById('acct-available');
        const availEl = document.getElementById('form-available');
        if (avEl) avEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
        if (availEl) availEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;

        S.set('_cachedBalance', update.balance || 0);
        S.set('_cachedMarginUsed', update.marginUsed || 0);

        _applyNegativeBalanceLock(avail);
        _schedulePnlUiRefresh();
    };
    S.set('_marginUpdateHandler', marginHandler);
    window.addEventListener('margin_update', marginHandler);

    // pnl_update
    const pnlHandler = (e) => {
        if (!S._tradingMounted || !e.detail) return;

        const d = e.detail;
        if (d.subAccountId && d.subAccountId !== (window.__pmsState || {}).currentAccount) return;

        const now = Date.now();
        S.set('_lastTradingWsPnlTs', now);

        if (d.positionId) {
            const existing = S._positionMap.get(d.positionId) || {};
            S._positionMap.set(d.positionId, {
                symbol: d.symbol || existing.symbol,
                side: d.side || existing.side,
                entryPrice: d.entryPrice ?? existing.entryPrice,
                quantity: d.quantity || existing.quantity || 0,
                markPrice: d.markPrice ?? existing.markPrice,
                liquidationPrice: d.liquidationPrice ?? existing.liquidationPrice ?? 0,
            });
            updateCompactLiqForPosition(d.positionId, d.liquidationPrice);
        }

        if (now - lastPnlUiTs < 30) {
            _schedulePnlUiRefresh();
            return;
        }

        lastPnlUiTs = now;
        _schedulePnlUiRefresh();
    };
    S.set('_pnlUpdateHandler', pnlHandler);
    window.addEventListener('pnl_update', pnlHandler);

    // doc click → close chart settings panel
    const docClick = (e) => {
        const panel = document.getElementById('chart-settings-panel');
        const btn = document.getElementById('chart-settings-btn');
        if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== btn) {
            panel.style.display = 'none';
        }
    };
    S.set('_docClickHandler', docClick);
    document.addEventListener('click', docClick);

    // Compact positions event listeners
    const compactListeners = {};
    const mkHandler = (eventName, fn) => {
        const handler = fn;
        compactListeners[`_${eventName}`] = handler;
        window.addEventListener(eventName, handler);
    };

    mkHandler('order_active', (e) => {
        if (!S._tradingMounted) return;
        const d = e?.detail || {};
        // Optimistically add the order to open orders DOM (only LIMIT, non-algo)
        addLimitOrderRow(d);
        // Refresh chart annotations for new price line
        loadChartAnnotations(true);
    });

    mkHandler('order_failed', (e) => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ openOrders: true }, 100);
    });

    mkHandler('order_filled', (e) => {
        if (!S._tradingMounted) return;
        const d = e?.detail || {};
        // Only play on opening fills (suppressToast = algo fills like CHASE/TWAP)
        if (!d.suppressToast && d.side) playFillSound(d.side);

        // Optimistically remove charting line immediately
        if (d.clientOrderId && _orderLineRegistry.has(d.clientOrderId)) {
            try { S.candleSeries.removePriceLine(_orderLineRegistry.get(d.clientOrderId)); } catch { }
            _orderLineRegistry.delete(d.clientOrderId);
            import('./positions-panel.js').then(m => m.refreshChartLeftAnnotationLabels());
        }

        // Optimistically remove from open orders DOM (no HTTP refetch)
        removeOpenOrderRow(d.clientOrderId);

        // Position is created by the separate position_updated WS event
        // Margin is updated by the separate margin_update WS event
        // Only refresh chart annotations for the filled order's price line removal
        loadChartAnnotations(true);
    });

    mkHandler('order_cancelled', (e) => {
        if (!S._tradingMounted) return;
        const d = e?.detail || {};

        // Optimistically remove charting line immediately
        if (d.clientOrderId && _orderLineRegistry.has(d.clientOrderId)) {
            try { S.candleSeries.removePriceLine(_orderLineRegistry.get(d.clientOrderId)); } catch { }
            _orderLineRegistry.delete(d.clientOrderId);
            import('./positions-panel.js').then(m => m.refreshChartLeftAnnotationLabels());
        }

        // Optimistically remove from open orders DOM (no HTTP refetch)
        removeOpenOrderRow(d.clientOrderId);
        loadChartAnnotations(true);
    });

    mkHandler('position_closed', (e) => {
        if (!S._tradingMounted) return;
        // ── Optimistic instant removal ──
        const d = e?.detail || {};
        if (d.positionId) {
            const row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);
            if (row) row.remove();
            S._positionMap.delete(d.positionId);
            const countEl = document.getElementById('compact-pos-count');
            if (countEl) countEl.textContent = S._positionMap.size;
            if (S._positionMap.size === 0) {
                const list = document.getElementById('compact-pos-list');
                if (list) list.innerHTML = '<div style="padding:6px 8px; color:var(--text-muted); text-align:center; font-size:10px;">No positions</div>';
                connectCompactMarkStreams([]);
            }
            _refreshEquityUpnl();
        }
        // ── Optimistic chart cleanup: remove price lines immediately ──
        for (const line of S.chartPriceLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
        S.set('chartPriceLines', []);
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationFingerprint', null);
        loadChartAnnotations(true);
        scheduleTradingRefresh({
            annotations: true,
            forceAnnotations: true,
        }, 50);
    });

    mkHandler('liquidation', (e) => {
        if (!S._tradingMounted) return;
        // ── Optimistic instant removal ──
        const d = e?.detail || {};
        if (d.positionId) {
            const row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);
            if (row) row.remove();
            S._positionMap.delete(d.positionId);
            const countEl = document.getElementById('compact-pos-count');
            if (countEl) countEl.textContent = S._positionMap.size;
            if (S._positionMap.size === 0) {
                const list = document.getElementById('compact-pos-list');
                if (list) list.innerHTML = '<div style="padding:6px 8px; color:var(--text-muted); text-align:center; font-size:10px;">No positions</div>';
                connectCompactMarkStreams([]);
            }
            _refreshEquityUpnl();
        }
        // ── Optimistic chart cleanup: remove price lines immediately ──
        for (const line of S.chartPriceLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
        S.set('chartPriceLines', []);
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationFingerprint', null);
        loadChartAnnotations(true);
        scheduleTradingRefresh({
            annotations: true,
            forceAnnotations: true,
        }, 50);
    });

    mkHandler('position_reduced', () => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({
            annotations: true,
            forceAnnotations: true,
        }, 60);
    });

    mkHandler('position_updated', (e) => {
        if (!S._tradingMounted) return;
        const d = e?.detail || {};
        if (!d.positionId) return;

        // Update in-memory position map
        const existing = S._positionMap.get(d.positionId) || {};
        S._positionMap.set(d.positionId, {
            symbol: d.symbol || existing.symbol,
            side: d.side || existing.side,
            entryPrice: d.entryPrice ?? existing.entryPrice,
            quantity: d.quantity ?? existing.quantity ?? 0,
            markPrice: existing.markPrice ?? d.entryPrice,
            liquidationPrice: d.liquidationPrice ?? existing.liquidationPrice ?? 0,
        });

        // Update compact panel DOM in-place
        let row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);

        // ── Optimistic creation: new position not yet in DOM ──
        if (!row && d.symbol && d.side && d.entryPrice != null) {
            const list = document.getElementById('compact-pos-list');
            if (list) {
                // Clear "No positions" placeholder
                const noPos = list.querySelector('div[style*="text-align:center"]');
                if (noPos && list.children.length === 1) list.innerHTML = '';

                const isLong = d.side === 'LONG';
                const mark = S._compactMarkPrices[d.symbol] || d.entryPrice;
                const pnl = 0;
                const pnlPct = 0;
                const notional = d.notional || (d.quantity * mark) || 0;
                const lev = d.leverage || 1;
                const margin = d.margin || 0;
                const liqPrice = d.liquidationPrice || 0;

                const tmp = document.createElement('div');
                tmp.innerHTML = `
                  <div class="compact-pos-row" data-cp-symbol="${d.symbol}" data-cp-side="${d.side}"
                       data-cp-id="${d.positionId}" data-cp-entry="${d.entryPrice}" data-cp-qty="${d.quantity || 0}" data-cp-margin="${margin}" data-cp-notional="${notional}">
                    <span class="cpr-sym">
                      <span class="cpr-name">${d.symbol.split('/')[0]}</span>
                      <span class="cpr-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
                      <span class="cpr-lev">${lev}x</span>
                    </span>
                    <span class="cpr-size" data-cpsize-id="${d.positionId}">$${notional.toFixed(2)}</span>
                    <span class="cpr-entry">${formatPrice(d.entryPrice)}</span>
                    <span class="cpr-mark" data-cpmark-id="${d.positionId}">${formatPrice(mark)}</span>
                    <span class="cpr-liq" data-cpliq-id="${d.positionId}">${liqPrice > 0 ? formatPrice(liqPrice) : '—'}</span>
                    <span class="cpr-pnl pnl-up" data-cppnl-id="${d.positionId}" data-cp-prev-pnl="0">
                      +0.00 <small>(+0.0%)</small>
                    </span>
                    <span class="cpr-close" data-cp-close="${d.positionId}" data-cp-close-sym="${d.symbol}" title="Market Close">✕</span>
                  </div>
                `;

                const newRow = tmp.firstElementChild;
                list.appendChild(newRow);

                // Attach close handler
                import('./positions-panel.js').then(({ marketClosePosition }) => {
                    newRow.querySelector('[data-cp-close]')?.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        marketClosePosition(d.positionId, d.symbol);
                    });
                });

                // Attach symbol click handler
                newRow.querySelector('.cpr-name')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (d.symbol !== S.selectedSymbol) {
                        import('./order-form.js').then(({ switchSymbol }) => {
                            switchSymbol(d.symbol);
                            scheduleTradingRefresh({ positions: true, openOrders: true, account: true }, 30);
                        });
                    }
                });

                // Update count badge
                const countEl = document.getElementById('compact-pos-count');
                if (countEl) countEl.textContent = S._positionMap.size;

                // Connect mark price stream for the new symbol
                connectCompactMarkStreams([...S._positionMap.values()]);
            }
        } else if (row) {
            if (d.entryPrice != null) {
                row.dataset.cpEntry = d.entryPrice;
                const entryEl = row.querySelector('.cpr-entry');
                if (entryEl) entryEl.textContent = formatPrice(d.entryPrice);
            }
            if (d.quantity != null) {
                row.dataset.cpQty = d.quantity;
            }
            if (d.margin != null) {
                row.dataset.cpMargin = d.margin;
            }
            if (d.notional != null) {
                row.dataset.cpNotional = d.notional;
                const sizeEl = row.querySelector(`[data-cpsize-id="${d.positionId}"]`);
                if (sizeEl) sizeEl.textContent = `$${d.notional.toFixed(2)}`;
            }
            if (d.liquidationPrice != null) {
                updateCompactLiqForPosition(d.positionId, d.liquidationPrice);
            }
        }

        _schedulePnlUiRefresh();
        scheduleChartRiskRefresh();
    });

    mkHandler('twap_progress', (e) => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ openOrders: true });
        if (e.detail?.symbol === S.selectedSymbol) scheduleChartRiskRefresh();
    });

    mkHandler('twap_completed', () => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ openOrders: true, annotations: true }, 80);
    });

    mkHandler('twap_cancelled', () => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ openOrders: true }, 30);
    });

    // Trail stop events — live chart visualization
    mkHandler('trail_stop_progress', (e) => {
        if (!S._tradingMounted) return;
        const d = e.detail;
        if (d?.symbol === S.selectedSymbol) {
            import('./trail-stop.js').then(m => m.drawLiveTrailStop(d));
        }
        // Live-update the open orders row DOM in-place
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
                // Row doesn't exist yet — schedule a full refresh
                scheduleTradingRefresh({ openOrders: true }, 30);
            }
        }
    });

    mkHandler('trail_stop_triggered', (e) => {
        if (!S._tradingMounted) return;
        const d = e.detail || {};

        // Toast notification
        const sym = d.symbol ? d.symbol.split('/')[0] : '';
        const priceStr = d.triggeredPrice ? `@ $${formatPrice(d.triggeredPrice)}` : '';
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`⚡ Trail stop filled: ${sym} ${d.side || ''} ${priceStr}`, 'success');
        });

        // Optimistic removal of the position row
        if (d.positionId) {
            const row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);
            if (row) row.remove();
            S._positionMap.delete(d.positionId);
            const countEl = document.getElementById('compact-pos-count');
            if (countEl) countEl.textContent = S._positionMap.size;
            if (S._positionMap.size === 0) {
                const list = document.getElementById('compact-pos-list');
                if (list) list.innerHTML = '<div style="padding:6px 8px; color:var(--text-muted); text-align:center; font-size:10px;">No positions</div>';
            }
        }

        // Clear all chart price lines + trail stop lines
        for (const line of S.chartPriceLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
        S.set('chartPriceLines', []);
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationFingerprint', null);
        import('./trail-stop.js').then(m => m.clearAllTrailStopLines());
        import('./positions-panel.js').then(m => m.loadChartAnnotations(true));

        import('./order-form.js').then(m => m._refreshEquityUpnl());
        scheduleTradingRefresh({ openOrders: true, annotations: true, forceAnnotations: true }, 50);
    });

    mkHandler('trail_stop_cancelled', () => {
        if (!S._tradingMounted) return;
        import('./trail-stop.js').then(m => m.clearAllTrailStopLines());
        scheduleTradingRefresh({ openOrders: true }, 30);
    });

    mkHandler('chase_progress', (e) => {
        if (!S._tradingMounted) return;
        const data = e.detail;
        // drawLiveChase handles symbol filtering internally
        import('./chase-limit.js').then(m => m.drawLiveChase(data));
        // Live-update chase order row in open orders panel
        if (data.chaseId) {
            const row = document.querySelector(`[data-chase-id="${data.chaseId}"]`);
            if (row) {
                const priceEl = row.querySelector('.chase-live-price');
                if (priceEl && data.currentOrderPrice) priceEl.textContent = `$${formatPrice(data.currentOrderPrice)}`;
                const repEl = row.querySelector('.chase-live-reprices');
                if (repEl) repEl.textContent = `${data.repriceCount || 0} reprices`;
            } else if (!data.parentScalperId) {
                // Standalone chase — create row inline from WS data (no HTTP poll)
                const list = document.getElementById('open-orders-list');
                if (list) {
                    // Remove "No open orders" placeholder if present
                    const noOrders = list.querySelector('div[style*="text-align:center"]');
                    if (noOrders && list.children.length === 1) list.innerHTML = '';

                    const isLong = data.side === 'LONG' || data.side === 'BUY';
                    const sym = data.symbol ? data.symbol.split('/')[0] : '??';
                    const tmp = document.createElement('div');
                    tmp.innerHTML = `
                      <div class="oo-row" data-chase-id="${data.chaseId}" style="border-left:3px solid #06b6d4; background:rgba(6,182,212,0.05);">
                        <span class="oor-sym">
                          <span class="oor-name" data-oo-symbol="${data.symbol || ''}">${sym}</span>
                          <span class="oor-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
                          <span style="font-size:9px; color:#06b6d4; font-weight:600; margin-left:2px;">CHASE</span>
                        </span>
                        <span class="oor-price" style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
                          <span class="chase-live-price" style="font-size:10px; font-weight:600;">$${data.currentOrderPrice ? formatPrice(data.currentOrderPrice) : '\u2014'}</span>
                          <span style="font-size:9px; color:var(--text-muted);">${data.stalkOffsetPct > 0 ? `${data.stalkOffsetPct}%` : 'best quote'}</span>
                        </span>
                        <span class="oor-qty chase-live-reprices" style="min-width:60px; font-size:10px;">
                          ${data.repriceCount || 0} reprices
                        </span>
                        <span class="oor-notional" style="font-size:10px; color:#06b6d4;">
                          🎯 chasing
                        </span>
                        <span class="oor-age">now</span>
                        <span class="oor-cancel" data-cancel-chase="${data.chaseId}" title="Cancel Chase">✕</span>
                      </div>
                    `;
                    const newRow = tmp.firstElementChild;
                    // Insert before plain limit orders (after TWAPs/trails/scalpers)
                    const firstPlainOrder = list.querySelector('.oo-row:not([data-chase-id]):not([data-trail-id]):not([data-scalper-id]):not([style*="border-left"])');
                    if (firstPlainOrder) {
                        list.insertBefore(newRow, firstPlainOrder);
                    } else {
                        list.appendChild(newRow);
                    }
                    // Wire cancel button
                    newRow.querySelector('[data-cancel-chase]')?.addEventListener('click', () => {
                        import('./chase-limit.js').then(m => m.cancelChase(data.chaseId));
                    });
                    // Update count badge
                    const countEl = document.getElementById('open-orders-count');
                    if (countEl) countEl.textContent = String((parseInt(countEl.textContent) || 0) + 1);
                }
            }
        }
        // Live-update chase price on matching compact position row
        if (data.symbol && data.currentOrderPrice) {
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
        // Remove this chase's lines from chart (leave other chases intact)
        if (data.chaseId) import('./chase-limit.js').then(m => m.removeChase(data.chaseId));
        // Remove chase price tag from position row
        if (data.symbol) {
            const tag = document.querySelector(`.compact-pos-row[data-cp-symbol="${data.symbol}"] .chase-price-tag`);
            if (tag) tag.remove();
        }
        const oor = document.querySelector(`[data-chase-id="${data.chaseId}"]`);
        if (oor) {
            oor.remove();
            const countEl = document.getElementById('open-orders-count');
            if (countEl) countEl.textContent = String(Math.max(0, (parseInt(countEl.textContent) || 1) - 1));
        }
        // margin_update WS event handles account state — no HTTP fetch needed
    });

    mkHandler('chase_cancelled', (e) => {
        if (!S._tradingMounted) return;
        const data = e.detail;
        // Remove this chase's lines from chart (leave other chases intact)
        if (data?.chaseId) import('./chase-limit.js').then(m => m.removeChase(data.chaseId));
        // Toast only for user-initiated cancel or distance breach
        if (data?.reason) {
            import('../../core/index.js').then(({ showToast }) => {
                const reason = data.reason === 'distance_breached' ? 'max distance reached' : 'cancelled';
                showToast(`Chase ${reason}: ${data.symbol?.split('/')[0] || ''}`, 'warning');
            }).catch(() => { });
        }
        // Remove chase price tag from position row
        if (data?.symbol) {
            const tag = document.querySelector(`.compact-pos-row[data-cp-symbol="${data.symbol}"] .chase-price-tag`);
            if (tag) tag.remove();
        }
        const oor = document.querySelector(`[data-chase-id="${data?.chaseId}"]`);
        if (oor) {
            oor.remove();
            const countEl = document.getElementById('open-orders-count');
            if (countEl) countEl.textContent = String(Math.max(0, (parseInt(countEl.textContent) || 1) - 1));
        }
        // margin_update WS event handles account state — no HTTP fetch needed
    });


    // Scalper events
    // Note: scalper_progress is NOT handled here — child chases broadcast
    // chase_progress individually, which drawLiveChase already handles.
    // scalper_progress is only fired for fill count updates on the parent row.
    // scalper_progress: updates parent row fill count + per-slot backoff countdown
    mkHandler('scalper_progress', (e) => {
        if (!S._tradingMounted) return;
        const data = e.detail;
        if (!data?.scalperId) return;

        // 1. Update parent row fill count
        const row = document.querySelector(`[data-scalper-id="${data.scalperId}"]`);
        if (row) {
            const fillEl = row.querySelector('.oor-price span:last-child');
            if (fillEl) fillEl.textContent = `${data.totalFillCount || 0} fills`;
        }

        // 2. Update per-slot badges in drawer (paused / retry countdown)
        const drawer = document.querySelector(`[data-scalper-drawer="${data.scalperId}"]`);
        if (!drawer) return;

        const allSlots = [...(data.longSlots || []), ...(data.shortSlots || [])];
        const slotsWithRetry = allSlots.filter(s => s.retryAt && !s.active);

        // Clear any previous countdown interval for this scalper
        const prevTimer = drawer._scalperCountdownTimer;
        if (prevTimer) clearInterval(prevTimer);

        function updateSlotBadges() {
            const now = Date.now();
            for (const slot of allSlots) {
                // Slot DOM node keyed by layer side+idx
                const key = `${slot.layerIdx}`;
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

        // Start live countdown if any slots are backing off
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
        import('../../core/index.js').then(({ showToast, formatPrice }) => {
            showToast(`⚔️ Scalper ${data?.side} L${data?.layerIdx} filled @ $${formatPrice(data?.fillPrice || 0)} (${sym})`, 'info');
        }).catch(() => { });
        scheduleChartRiskRefresh();
        scheduleTradingRefresh({ openOrders: true }, 500);
    });

    mkHandler('scalper_cancelled', (e) => {
        if (!S._tradingMounted) return;
        const data = e.detail;
        if (data?.scalperId) {
            import('./scalper.js').then(m => m.clearScalperById(data.scalperId)).catch(() => { });
        }
        const sym = data?.symbol ? data.symbol.split('/')[0] : '';
        import('../../core/index.js').then(({ showToast }) => {
            showToast(`⚔️ Scalper stopped: ${sym}`, 'info');
        }).catch(() => { });
        scheduleTradingRefresh({ openOrders: true }, 30);
    });

    S.set('_compactPosListeners', compactListeners);

}

// ── Compact-position poll ───────────────────────

export function startCompactPoll() {
    if (S._compactPollInterval) clearInterval(S._compactPollInterval);

    lastFallbackPositionSyncTs = 0;
    S.set('_compactPollInterval', setInterval(() => {
        if (!S._tradingMounted) return;

        _schedulePnlUiRefresh();

        const now = Date.now();
        // WS is alive if we got a pnl_update or margin_update recently,
        // OR if the WebSocket connection itself is open
        const wsOpen = window.__pmsState?.ws?.readyState === 1;
        const lastWsTs = S._lastTradingWsPnlTs || 0;
        const wsStale = !wsOpen && (now - lastWsTs) > 20000;
        if (wsStale && (now - lastFallbackPositionSyncTs) > 30000) {
            lastFallbackPositionSyncTs = now;
            scheduleTradingRefresh({ positions: true, account: true }, 0);
        }
    }, 3000));
}

export function stopCompactPoll() {
    if (S._compactPollInterval) { clearInterval(S._compactPollInterval); S.set('_compactPollInterval', null); }
    if (pnlUiRafId != null) {
        cancelAnimationFrame(pnlUiRafId);
        pnlUiRafId = null;
    }
}
