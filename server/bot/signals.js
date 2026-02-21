/**
 * Microstructure Signal Engine — JS port of v7_grid/signals.py
 *
 * Computes from aggTrade + L1 book:
 *   TI  = Trade Imbalance (rolling windows)
 *   QI  = Quote Imbalance (L1)
 *   MD  = MicroPrice Displacement
 *   RV  = Realized Volatility
 *   Pump / Exhaust detection
 *   Spread tracking
 */

// ═══════════════════════════════════════════════════════
// EMA Z-SCORE TRACKER
// ═══════════════════════════════════════════════════════

class EMAZScore {
    /**
     * @param {number} halflife - in seconds
     * @param {number} dt - expected update interval
     * @param {number} zCap - clamp abs z-score
     */
    constructor(halflife = 2.0, dt = 0.1, zCap = 5.0) {
        this._alpha = 1.0 - Math.exp(-Math.LN2 * dt / Math.max(halflife, 0.01));
        this._mean = 0;
        this._var = 1;
        this._warm = 0;
        this._zCap = Math.max(zCap, 1.0);
    }

    update(x) {
        const a = this._alpha;
        this._mean += a * (x - this._mean);
        const diff = x - this._mean;
        this._var += a * (diff * diff - this._var);
        if (this._warm < 20) this._warm++;
        return this.z;
    }

    get z() {
        if (this._warm < 5) return 0;
        const std = Math.sqrt(Math.max(this._var, 1e-12));
        const raw = (0 - this._mean) / std; // inverted — positive z = mean below zero
        return Math.max(-this._zCap, Math.min(this._zCap, raw));
    }
}

// ═══════════════════════════════════════════════════════
// ROLLING WINDOW ACCUMULATOR
// ═══════════════════════════════════════════════════════

class RollingQty {
    constructor(windowSec) {
        this._windowSec = windowSec;
        this._buys = [];  // [ts, qty]
        this._sells = [];
        this.buySum = 0;
        this.sellSum = 0;
    }

    add(ts, qty, isSell) {
        if (isSell) {
            this._sells.push([ts, qty]);
            this.sellSum += qty;
        } else {
            this._buys.push([ts, qty]);
            this.buySum += qty;
        }
        this._evict(ts);
    }

    _evict(now) {
        const cutoff = now - this._windowSec;
        while (this._buys.length && this._buys[0][0] < cutoff) {
            this.buySum -= this._buys.shift()[1];
        }
        while (this._sells.length && this._sells[0][0] < cutoff) {
            this.sellSum -= this._sells.shift()[1];
        }
        if (this.buySum < 0) this.buySum = 0;
        if (this.sellSum < 0) this.sellSum = 0;
    }

    /** Trade Imbalance: (buy - sell) / (buy + sell), range [-1, 1] */
    get ti() {
        const total = this.buySum + this.sellSum;
        return total > 1e-12 ? (this.buySum - this.sellSum) / total : 0;
    }

    /** Fraction of volume that is buy-aggression, range [0, 1] */
    get buyRatio() {
        const total = this.buySum + this.sellSum;
        return total > 1e-12 ? this.buySum / total : 0.5;
    }
}

// ═══════════════════════════════════════════════════════
// REALIZED VOLATILITY TRACKER
// ═══════════════════════════════════════════════════════

class RollingRV {
    constructor(windowSec = 1.0) {
        this._windowSec = windowSec;
        this._prices = [];  // [ts, price]
        this._lastPrice = 0;
    }

    add(ts, price) {
        if (price <= 0) return;
        this._prices.push([ts, price]);
        this._lastPrice = price;
        const cutoff = ts - this._windowSec;
        while (this._prices.length && this._prices[0][0] < cutoff) {
            this._prices.shift();
        }
    }

    /** Realized vol (stdev of log returns in window) in bps */
    get rv() {
        if (this._prices.length < 3) return 0;
        const rets = [];
        for (let i = 1; i < this._prices.length; i++) {
            const prev = this._prices[i - 1][1];
            const cur = this._prices[i][1];
            if (prev > 0 && cur > 0) {
                rets.push(Math.log(cur / prev));
            }
        }
        if (rets.length < 2) return 0;
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
        return Math.sqrt(Math.max(0, variance)) * 10000; // bps
    }
}

// ═══════════════════════════════════════════════════════
// MEDIAN TRACKER (simple sorted-insert for small windows)
// ═══════════════════════════════════════════════════════

class RollingMedian {
    constructor(maxLen = 200) {
        this._vals = [];
        this._maxLen = maxLen;
    }

    add(v) {
        this._vals.push(v);
        if (this._vals.length > this._maxLen) this._vals.shift();
    }

    get median() {
        if (!this._vals.length) return 0;
        const sorted = [...this._vals].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
}

// ═══════════════════════════════════════════════════════
// ENTRY / EXIT SIGNAL STRUCTS
// ═══════════════════════════════════════════════════════

class EntrySignal {
    constructor() {
        this.shouldEnter = false;
        this.pump = 0;
        this.exhaust = 0;
        this.signalStrength = 0;
    }
}

class ExitSignal {
    constructor() {
        this.shouldExit = false;
        this.reason = '';
        this.fastTP = false;
    }
}

// ═══════════════════════════════════════════════════════
// MICRO SIGNALS — One instance per symbol
// ═══════════════════════════════════════════════════════

class MicroSignals {
    constructor() {
        // Book state
        this.bid = 0;
        this.ask = 0;
        this.bidQty = 0;
        this.askQty = 0;
        this.mid = 0;

        // Spread tracking
        this._spreadMedian = new RollingMedian(200);
        this.medianSpreadBps = 0;

        // Trade imbalance windows
        this._ti2s = new RollingQty(2);
        this._ti5s = new RollingQty(5);
        this._ti10s = new RollingQty(10);

        // Volatility
        this._rv1s = new RollingRV(1.0);
        this._rv5s = new RollingRV(5.0);
        this._rv30s = new RollingRV(30.0);

        // Z-scores for pump/exhaust detection
        this._pumpZ = new EMAZScore(2.0, 0.1, 5.0);
        this._exhaustZ = new EMAZScore(3.0, 0.1, 5.0);

        // Flow tracking
        this._lastTradeTs = 0;
        this._tradeCount = 0;
        this._warmupDone = false;

        // Book-derived signals
        this.qi = 0;       // Quote imbalance
        this.md = 0;       // MicroPrice displacement

        // Trend tracking (30s price change)
        this._priceHistory = [];  // [ts, price]
    }

    /**
     * Process L1 book update.
     */
    onBook(bid, ask, bidQty, askQty, ts) {
        if (bid <= 0 || ask <= 0 || ask <= bid) return;

        this.bid = bid;
        this.ask = ask;
        this.bidQty = bidQty;
        this.askQty = askQty;
        this.mid = (bid + ask) / 2;

        // Spread in bps
        const spreadBps = ((ask - bid) / this.mid) * 10000;
        this._spreadMedian.add(spreadBps);
        this.medianSpreadBps = this._spreadMedian.median;

        // Quote imbalance: (bidQty - askQty) / (bidQty + askQty)
        const totalQ = bidQty + askQty;
        this.qi = totalQ > 0 ? (bidQty - askQty) / totalQ : 0;

        // MicroPrice displacement: how far micro-price deviates from mid
        if (totalQ > 0) {
            const microPrice = bid + (bidQty / totalQ) * (ask - bid);
            this.md = ((microPrice - this.mid) / this.mid) * 10000; // bps
        } else {
            this.md = 0;
        }
    }

    /**
     * Process aggTrade event — feeds microstructure signals.
     */
    onTrade(price, qty, isBuyerMaker, ts) {
        if (price <= 0 || qty <= 0) return;
        const isSell = !isBuyerMaker; // buyer-maker means seller was aggressor

        this._ti2s.add(ts, qty, isSell);
        this._ti5s.add(ts, qty, isSell);
        this._ti10s.add(ts, qty, isSell);

        this._rv1s.add(ts, price);
        this._rv5s.add(ts, price);
        this._rv30s.add(ts, price);

        // Pump detection: sudden buy pressure surge
        const buyRatio = this._ti2s.buyRatio;
        this._pumpZ.update(buyRatio - 0.5); // center around 0.5

        // Exhaust detection: buy pressure fading (derivative of TI)
        const ti2 = this._ti2s.ti;
        const ti10 = this._ti10s.ti;
        this._exhaustZ.update(ti10 - ti2); // exhaust when short-term TI drops below long-term

        // Price history for trend
        this._priceHistory.push([ts, price]);
        const cutoff30 = ts - 30;
        while (this._priceHistory.length && this._priceHistory[0][0] < cutoff30) {
            this._priceHistory.shift();
        }

        this._tradeCount++;
        this._lastTradeTs = ts;
        if (this._tradeCount >= 30 && !this._warmupDone) {
            this._warmupDone = true;
        }
    }

    /**
     * Get current spread in bps.
     */
    get spreadBps() {
        if (this.bid <= 0 || this.ask <= 0 || this.mid <= 0) return 0;
        return ((this.ask - this.bid) / this.mid) * 10000;
    }

    /**
     * Get 30s trend in bps (positive = price going up).
     */
    get trend30sBps() {
        if (this._priceHistory.length < 2) return 0;
        const first = this._priceHistory[0][1];
        const last = this._priceHistory[this._priceHistory.length - 1][1];
        return ((last - first) / first) * 10000;
    }

    /**
     * Get current pump score [0, 5+]
     */
    get pumpScore() {
        return Math.max(0, this._pumpZ.z);
    }

    /**
     * Get current exhaust score [0, 5+]
     */
    get exhaustScore() {
        return Math.max(0, this._exhaustZ.z);
    }

    /**
     * Check entry conditions for a short trade.
     * @param {object} config - Bot config from DB
     * @returns {EntrySignal}
     */
    entrySignal(config) {
        const sig = new EntrySignal();
        if (!this._warmupDone) return sig;

        const spread = this.spreadBps;
        const minSpread = config.minSpreadBps || 7.0;
        const maxSpread = config.maxSpreadBps || 40.0;

        // Spread filter
        if (spread < minSpread || spread > maxSpread) return sig;

        // Pump + exhaust detection
        const pump = this.pumpScore;
        const exhaust = this.exhaustScore;

        // Entry when: pump detected (buyers surging) AND exhaust starting (buyers thinning)
        const pumpThreshold = 2.0;
        const exhaustThreshold = 1.0;

        if (pump >= pumpThreshold && exhaust >= exhaustThreshold) {
            // Trend guard — don't short into a waterfall
            const trend30 = this.trend30sBps;
            if (trend30 < -30) return sig; // too much downward momentum

            // Buy ratio guard — don't short when insane buying
            const buyRatio = this._ti2s.buyRatio;
            if (buyRatio > 0.72) return sig;

            sig.shouldEnter = true;
            sig.pump = pump;
            sig.exhaust = exhaust;
            sig.signalStrength = Math.min(1.0, (pump - 1) * 0.3 + (exhaust - 0.5) * 0.3);
        }

        return sig;
    }

    /**
     * Check exit conditions.
     * @param {object} position - { avgEntry, notional, layers, entryTs }
     * @param {object} config - Bot config from DB
     * @param {number} now - current timestamp
     * @returns {ExitSignal}
     */
    exitSignal(position, config, now) {
        const sig = new ExitSignal();
        if (!position || !this.bid) return sig;

        const { avgEntry, entryTs } = position;
        const holdSec = now - entryTs;

        // Min hold filter — don't close too early
        const minHold = config.minHoldSec || 5.0;
        if (holdSec < minHold) return sig;

        // Current PnL in bps (short position: profit when price drops)
        const currentPnlBps = ((avgEntry - this.bid) / avgEntry) * 10000;

        // TP calculation with decay
        let tpBps = config.minProfitBps || 10.0;
        const tpSpreadMult = 1.2;
        const spreadTP = this.medianSpreadBps * tpSpreadMult;
        tpBps = Math.max(tpBps, spreadTP);

        // TP decay: tightens over time
        if (config.tpDecayEnabled) {
            const halfLife = (config.tpDecayHalfLife || 30.0) * 60; // convert min to sec
            const decayFactor = Math.exp(-Math.LN2 * holdSec / Math.max(halfLife, 1));
            const floor = 0.5;
            const adjusted = floor + (1.0 - floor) * decayFactor;
            tpBps *= adjusted;
        }

        // Standard TP check
        if (currentPnlBps >= tpBps) {
            sig.shouldExit = true;
            sig.reason = 'tp';
            return sig;
        }

        // Fast TP: if flow reversed strongly, take smaller profit
        const ti = this._ti5s.ti;
        if (ti < -0.25 && currentPnlBps > -10) {
            sig.shouldExit = true;
            sig.reason = 'fast_tp';
            sig.fastTP = true;
            return sig;
        }

        // Trailing stop
        if (config.trailingStopEnabled) {
            const tsStop = config.trailingStopBps || 15.0;
            // We'd need peak tracking per position — handled in engine.js
        }

        return sig;
    }

    /**
     * Get a snapshot of all signal values.
     */
    snapshot() {
        return {
            bid: this.bid,
            ask: this.ask,
            mid: this.mid,
            spreadBps: this.spreadBps,
            medianSpreadBps: this.medianSpreadBps,
            qi: this.qi,
            md: this.md,
            ti2s: this._ti2s.ti,
            ti5s: this._ti5s.ti,
            ti10s: this._ti10s.ti,
            buyRatio: this._ti2s.buyRatio,
            rv1s: this._rv1s.rv,
            rv5s: this._rv5s.rv,
            rv30s: this._rv30s.rv,
            pumpScore: this.pumpScore,
            exhaustScore: this.exhaustScore,
            trend30sBps: this.trend30sBps,
            warm: this._warmupDone,
            tradeCount: this._tradeCount,
        };
    }
}

export { EMAZScore, RollingQty, RollingRV, RollingMedian, MicroSignals, EntrySignal, ExitSignal };
export default MicroSignals;
