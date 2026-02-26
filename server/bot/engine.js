/**
 * Bot Engine — Per-symbol grid trader instance.
 *
 * JS port of core GridTrader logic from v7_grid/grid_trader.py.
 * Routes all trades through the platform's RiskEngine.
 */

import MicroSignals from './signals.js';
import { closePositionViaCpp } from '../routes/trading/close-utils.js';
import { getSimplxBridge } from '../simplx-uds-bridge.js';
import { checkCppWriteReady } from '../routes/trading/cpp-write-ready.js';
import { ensureCppAccountSynced, makeCppClientOrderId } from '../routes/trading/cpp-order-utils.js';
import { toCppSymbol } from '../routes/trading/cpp-symbol.js';

// ═══════════════════════════════════════════════════════
// GRID LAYER
// ═══════════════════════════════════════════════════════

class GridLayer {
    constructor({ price, qty, notional, entryTs, layerIdx, positionId = null }) {
        this.price = price;
        this.qty = qty;
        this.notional = notional;
        this.entryTs = entryTs;
        this.layerIdx = layerIdx;
        this.positionId = positionId; // PMS virtual position ID
    }
}

// ═══════════════════════════════════════════════════════
// BOT ENGINE — One per symbol per user
// ═══════════════════════════════════════════════════════

class BotEngine {
    /**
     * @param {string} symbol - ccxt format e.g. 'BTC/USDT:USDT'
     * @param {string} subAccountId
     * @param {object} config - BotConfig from DB
     * @param {object} riskEngine - Platform risk engine
     * @param {object} exchange - Platform exchange connector
     */
    constructor(symbol, subAccountId, config, riskEngine, exchange, eventCallback = null) {
        this.symbol = symbol;
        this.subAccountId = subAccountId;
        this.config = config;
        this.riskEngine = riskEngine;
        this.exchange = exchange;
        this.eventCallback = eventCallback;

        // Signal engine
        this.signals = new MicroSignals();

        // Grid state
        this.layers = [];
        this.state = 'IDLE'; // IDLE, ACTIVE, COOLDOWN
        this.cooldownUntil = 0;

        // Position tracking
        this.totalNotional = 0;
        this.avgEntry = 0;
        this.peakPnlBps = 0; // for trailing stop

        // Stats
        this.totalTrades = 0;
        this.totalPnl = 0;
        this.wins = 0;
        this.losses = 0;
        this.lastTradeTs = 0;

        // Trailing stop best price
        this._bestBidSinceEntry = 0;
    }

    /**
     * Emit a structured event to the manager.
     */
    _emit(type, detail = {}) {
        if (this.eventCallback) {
            this.eventCallback({
                type,
                symbol: this.symbol,
                detail,
                ts: Date.now() / 1000,
            });
        }
    }

    /**
     * Process L1 book update — main decision loop.
     */
    async onBook(bid, ask, bidQty, askQty, ts) {
        this.signals.onBook(bid, ask, bidQty, askQty, ts);

        if (this.state === 'COOLDOWN' && ts >= this.cooldownUntil) {
            this.state = 'IDLE';
        }

        if (this.state === 'COOLDOWN') return;

        const spreadBps = this.signals.spreadBps;
        if (spreadBps <= 0) return;

        // ── Check exit first ──
        if (this.layers.length > 0) {
            await this._checkExit(ts, spreadBps);
        }

        // ── Then check entry / averaging ──
        if (this.layers.length === 0) {
            await this._checkEntry(ts, spreadBps);
        } else if (this.layers.length < (this.config.maxLayers || 8)) {
            await this._checkAveraging(ts, spreadBps);
        }
    }

    /**
     * Process aggTrade event.
     */
    onTrade(price, qty, isBuyerMaker, ts) {
        this.signals.onTrade(price, qty, isBuyerMaker, ts);
    }

    // ─────────────────────────────────────
    // ENTRY LOGIC
    // ─────────────────────────────────────

    async _checkEntry(now, spreadBps) {
        const signal = this.signals.entrySignal(this.config);
        if (!signal.shouldEnter) return;

        // Portfolio exposure check
        if (this.totalNotional >= (this.config.maxExposure || 500)) return;

        // Size the entry
        const notional = Math.min(
            this.config.maxNotional || 50,
            (this.config.maxExposure || 500) - this.totalNotional,
        );
        if (notional < 6) return; // Binance min notional

        const price = this.signals.ask;
        if (price <= 0) return;

        const quantity = notional / price;

        try {
            // V2: route trade through C++ engine
            const bridge = getSimplxBridge();
            const readiness = checkCppWriteReady(bridge);
            if (!readiness.ok) throw new Error(readiness.error);
            await ensureCppAccountSynced(bridge, this.subAccountId);

            const clientOrderId = makeCppClientOrderId('bot', this.subAccountId);
            await bridge.sendCommand('new', {
                sub_account_id: this.subAccountId,
                client_order_id: clientOrderId,
                symbol: toCppSymbol(this.symbol),
                side: 'SELL',
                type: 'MARKET',
                qty: quantity,
                leverage: 10,
            });

            // ACK-first: record layer optimistically, fill-handler will persist
            const layer = new GridLayer({
                price,
                qty: quantity,
                notional,
                entryTs: now,
                layerIdx: 0,
                positionId: null, // will be set by fill-handler
            });

            this.layers.push(layer);
            this.state = 'ACTIVE';
            this._recalcAvgEntry();
            this._bestBidSinceEntry = this.signals.bid;
            this.totalTrades++;
            this.lastTradeTs = now;

            console.log(`[BOT] ${this.symbol} ENTRY L0 @ ~$${price.toFixed(4)} notional=$${notional.toFixed(0)} signal=${signal.signalStrength.toFixed(2)}`);
            this._emit('entry', { layer: 0, price, notional, signal: signal.signalStrength });
        } catch (err) {
            console.error(`[BOT] ${this.symbol} Entry failed:`, err.message);
            this._emit('error', { action: 'entry', message: err.message });
        }
    }

    // ─────────────────────────────────────
    // AVERAGING LOGIC
    // ─────────────────────────────────────

    async _checkAveraging(now, spreadBps) {
        const lastLayer = this.layers[this.layers.length - 1];
        if (!lastLayer) return;

        // Exponential spacing: base spacing × spacing_growth^layer_idx
        const baseSpacing = this.signals.medianSpreadBps * 1.5;
        const spacingGrowth = 2.0;
        const layerIdx = this.layers.length;
        const requiredMoveBps = baseSpacing * Math.pow(spacingGrowth, layerIdx - 1);

        // Price must have moved UP enough from last layer (we're short, so price going up = underwater)
        const actualMoveBps = ((this.signals.ask - lastLayer.price) / lastLayer.price) * 10000;
        if (actualMoveBps < requiredMoveBps) return;

        // Size growth: deeper layers are bigger
        const sizeGrowth = 1.5;
        const baseNotional = this.config.maxNotional || 50;
        const layerNotional = Math.min(
            baseNotional,
            (this.config.maxNotional || 50) * Math.pow(sizeGrowth, Math.min(layerIdx, 4) * 0.3),
        );

        // Portfolio exposure check
        if (this.totalNotional + layerNotional > (this.config.maxExposure || 500)) return;
        if (layerNotional < 6) return;

        const price = this.signals.ask;
        const quantity = layerNotional / price;

        try {
            // V2: route trade through C++ engine
            const bridge = getSimplxBridge();
            const readiness = checkCppWriteReady(bridge);
            if (!readiness.ok) throw new Error(readiness.error);
            await ensureCppAccountSynced(bridge, this.subAccountId);

            const clientOrderId = makeCppClientOrderId('bot', this.subAccountId);
            await bridge.sendCommand('new', {
                sub_account_id: this.subAccountId,
                client_order_id: clientOrderId,
                symbol: toCppSymbol(this.symbol),
                side: 'SELL',
                type: 'MARKET',
                qty: quantity,
                leverage: 10,
            });

            this.layers.push(new GridLayer({
                price,
                qty: quantity,
                notional: layerNotional,
                entryTs: now,
                layerIdx,
                positionId: null,
            }));

            this._recalcAvgEntry();
            this.totalTrades++;
            this.lastTradeTs = now;

            console.log(`[BOT] ${this.symbol} AVERAGE L${layerIdx} @ ~$${price.toFixed(4)} notional=$${layerNotional.toFixed(0)} grid=${this.layers.length} layers`);
            this._emit('averaging', { layer: layerIdx, price, notional: layerNotional, totalLayers: this.layers.length });
        } catch (err) {
            console.error(`[BOT] ${this.symbol} Averaging failed:`, err.message);
            this._emit('error', { action: 'averaging', message: err.message });
        }
    }

    // ─────────────────────────────────────
    // EXIT LOGIC
    // ─────────────────────────────────────

    async _checkExit(now, spreadBps) {
        if (!this.layers.length) return;

        const bid = this.signals.bid;
        if (bid <= 0) return;

        // Track best bid for trailing stop
        if (bid < this._bestBidSinceEntry || this._bestBidSinceEntry <= 0) {
            this._bestBidSinceEntry = bid;
        }

        const position = {
            avgEntry: this.avgEntry,
            entryTs: this.layers[0].entryTs,
            layers: this.layers.length,
            notional: this.totalNotional,
        };

        // Current PnL (short: profit when price drops)
        const pnlBps = ((this.avgEntry - bid) / this.avgEntry) * 10000;

        // ── Inverse Grid TP for multi-layer positions ──
        if (this.config.inverseTPEnabled && this.layers.length >= (this.config.inverseTPMinLayers || 3)) {
            const closed = await this._checkInverseTP(now, bid, pnlBps);
            if (closed) return;
        }

        // ── Scaled exit ──
        if (this.config.scaledExitEnabled && this.layers.length >= 2) {
            const closed = await this._checkScaledExit(now, bid, pnlBps);
            if (closed) return;
        }

        // ── Trailing stop ──
        if (this.config.trailingStopEnabled) {
            const tsStop = this.config.trailingStopBps || 15.0;
            const retraceFromBest = ((bid - this._bestBidSinceEntry) / this._bestBidSinceEntry) * 10000;
            if (pnlBps > 0 && retraceFromBest > tsStop) {
                await this._closeAll(now, 'trailing_stop', pnlBps);
                return;
            }
        }

        // ── Standard signal-based exit ──
        const exitSig = this.signals.exitSignal(position, this.config, now);
        if (exitSig.shouldExit) {
            await this._closeAll(now, exitSig.reason, pnlBps);
            return;
        }

        // ── Circuit breaker ──
        const maxLoss = this.config.maxLossBps || 500;
        if (pnlBps < -maxLoss) {
            await this._closeAll(now, 'circuit_breaker', pnlBps);
            this.state = 'COOLDOWN';
            this.cooldownUntil = now + (this.config.lossCooldownSec || 8.0);
        }
    }

    // ─────────────────────────────────────
    // INVERSE GRID TP
    // ─────────────────────────────────────

    async _checkInverseTP(now, bid, currentPnlBps) {
        // Compute TP zones that mirror entry grid spacing downward
        const zones = this._computeInverseTPZones();
        if (!zones.length) return false;

        for (const zone of zones) {
            if (currentPnlBps >= zone.targetBps) {
                // Close a fraction at this zone
                const fraction = 1.0 / (this.layers.length);
                const posId = this.layers[this.layers.length - 1].positionId;
                if (!posId) continue;

                try {
                    // V2: close position via C++
                    const result = await closePositionViaCpp(posId, 'BOT_INVERSE_TP');
                    if (result.success) {
                        const removed = this.layers.pop();
                        this._recalcAvgEntry();
                        this.wins++;
                        console.log(`[BOT] ${this.symbol} INVERSE TP zone ${zone.idx} @ ${bid.toFixed(4)} pnl=${currentPnlBps.toFixed(1)}bps`);
                        this._emit('inverse_tp', { zone: zone.idx, price: bid, pnlBps: currentPnlBps, remainingLayers: this.layers.length });

                        if (this.layers.length === 0) {
                            this.state = 'IDLE';
                            this._resetState();
                        }
                        return true;
                    }
                } catch (err) {
                    console.error(`[BOT] ${this.symbol} Inverse TP failed:`, err.message);
                    this._emit('error', { action: 'inverse_tp', message: err.message });
                }
            }
        }
        return false;
    }

    _computeInverseTPZones() {
        if (this.layers.length < 2) return [];
        const zones = [];
        const spacingGrowth = 2.0;
        const baseSpacing = this.signals.medianSpreadBps * 1.5;
        const maxZones = 5;

        for (let i = 0; i < Math.min(this.layers.length - 1, maxZones); i++) {
            zones.push({
                idx: i,
                targetBps: baseSpacing * Math.pow(spacingGrowth, i),
            });
        }
        return zones.sort((a, b) => b.targetBps - a.targetBps); // check widest first
    }

    // ─────────────────────────────────────
    // SCALED EXIT
    // ─────────────────────────────────────

    async _checkScaledExit(now, bid, currentPnlBps) {
        // Close layers one at a time as they reach individual TP targets
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const layerPnlBps = ((layer.price - bid) / layer.price) * 10000;
            const layerTP = (this.config.minProfitBps || 10) * (1 + layer.layerIdx * 0.5);

            if (layerPnlBps >= layerTP && layer.positionId) {
                try {
                    // V2: close position via C++
                    const result = await closePositionViaCpp(layer.positionId, 'BOT_SCALED_EXIT');
                    if (result.success) {
                        this.layers.splice(i, 1);
                        this._recalcAvgEntry();
                        this.wins++;
                        console.log(`[BOT] ${this.symbol} SCALED EXIT L${layer.layerIdx} @ ${bid.toFixed(4)} pnl=${layerPnlBps.toFixed(1)}bps`);
                        this._emit('scaled_exit', { layer: layer.layerIdx, price: bid, pnlBps: layerPnlBps, remainingLayers: this.layers.length });

                        if (this.layers.length === 0) {
                            this.state = 'IDLE';
                            this._resetState();
                        }
                        return true;
                    }
                } catch (err) {
                    console.error(`[BOT] ${this.symbol} Scaled exit failed:`, err.message);
                    this._emit('error', { action: 'scaled_exit', message: err.message });
                }
            }
        }
        return false;
    }

    // ─────────────────────────────────────
    // CLOSE ALL
    // ─────────────────────────────────────

    async _closeAll(now, reason, pnlBps) {
        const positionIds = [...new Set(this.layers.map(l => l.positionId).filter(Boolean))];

        for (const posId of positionIds) {
            try {
                await closePositionViaCpp(posId, 'BOT_CLOSE');
            } catch (err) {
                console.error(`[BOT] ${this.symbol} Close failed (${posId}):`, err.message);
            }
        }

        const isWin = pnlBps > 0;
        if (isWin) this.wins++;
        else this.losses++;

        console.log(`[BOT] ${this.symbol} CLOSE ALL reason=${reason} pnl=${pnlBps.toFixed(1)}bps layers=${this.layers.length} ${isWin ? '✅' : '❌'}`);
        this._emit('close', { reason, pnlBps, layers: this.layers.length, isWin });

        this.layers = [];
        this.state = reason === 'circuit_breaker' ? 'COOLDOWN' : 'IDLE';
        if (reason !== 'circuit_breaker') {
            // Small cooldown after every close to prevent re-entry churn
            this.cooldownUntil = now + Math.max(this.config.lossCooldownSec || 8, 3);
            this.state = 'COOLDOWN';
        }
        this._resetState();
    }

    // ─────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────

    _recalcAvgEntry() {
        if (!this.layers.length) {
            this.totalNotional = 0;
            this.avgEntry = 0;
            return;
        }
        let totalQty = 0;
        let totalCost = 0;
        for (const l of this.layers) {
            totalQty += l.qty;
            totalCost += l.qty * l.price;
        }
        this.totalNotional = this.layers.reduce((s, l) => s + l.notional, 0);
        this.avgEntry = totalQty > 0 ? totalCost / totalQty : 0;
    }

    _resetState() {
        this.peakPnlBps = 0;
        this._bestBidSinceEntry = 0;
    }

    /**
     * Get current status snapshot.
     */
    getStatus() {
        const bid = this.signals.bid;
        let unrealizedPnlBps = 0;
        let unrealizedPnlUsd = 0;

        if (this.layers.length > 0 && bid > 0 && this.avgEntry > 0) {
            unrealizedPnlBps = ((this.avgEntry - bid) / this.avgEntry) * 10000;
            const totalQty = this.layers.reduce((s, l) => s + l.qty, 0);
            unrealizedPnlUsd = (this.avgEntry - bid) * totalQty;
        }

        return {
            symbol: this.symbol,
            state: this.state,
            layers: this.layers.length,
            maxLayers: this.config.maxLayers || 8,
            totalNotional: this.totalNotional,
            avgEntry: this.avgEntry,
            currentBid: bid,
            currentAsk: this.signals.ask,
            spreadBps: this.signals.spreadBps,
            medianSpreadBps: this.signals.medianSpreadBps,
            unrealizedPnlBps,
            unrealizedPnlUsd,
            totalTrades: this.totalTrades,
            totalPnl: this.totalPnl,
            wins: this.wins,
            losses: this.losses,
            lastTradeTs: this.lastTradeTs,
            signals: this.signals.snapshot(),
        };
    }

    /**
     * Shutdown: close all positions if requested.
     */
    async shutdown(closePositions = false) {
        if (closePositions && this.layers.length > 0) {
            await this._closeAll(Date.now() / 1000, 'shutdown', 0);
        }
        this.state = 'IDLE';
        this.layers = [];
    }
}

export default BotEngine;
export { BotEngine, GridLayer };
