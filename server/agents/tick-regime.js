/**
 * Tick Regime Detector — Lightweight regime classification from mark price + bid/ask.
 *
 * Computes 6 features from data available to agents without aggTrade streams:
 *   1. rvRatio      — fast/slow realized volatility ratio (vol spike detection)
 *   2. velocity     — directional price movement in bps/tick
 *   3. spreadRate   — rate of spread widening/narrowing
 *   4. spreadLevel  — current spread in bps
 *   5. dwellTicks   — how long price stays in same 10bps bucket
 *   6. volOfVol     — rolling std of RV values (regime instability)
 *
 * Classifies into 4 regimes:
 *   - trending       — directional momentum
 *   - mean_revert    — range-bound, low vol
 *   - liquidation    — extreme vol spike, spread blowout
 *   - toxic          — no edge, stay flat
 *
 * Designed for use inside TrendAgent.onTick() to gate entries and adapt params.
 */

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

export class TickRegimeDetector {

    /**
     * @param {Object} opts
     * @param {number} opts.rvFast    — fast RV window in ticks (default 5)
     * @param {number} opts.rvSlow    — slow RV window in ticks (default 50)
     * @param {number} opts.velWindow — velocity window in ticks (default 10)
     * @param {number} opts.warmup    — ticks before classification starts (default 60)
     */
    constructor(opts = {}) {
        this._rvFast = opts.rvFast || 5;
        this._rvSlow = opts.rvSlow || 50;
        this._velWindow = opts.velWindow || 10;
        this._warmup = opts.warmup || 60;

        // Price buffer
        this._prices = [];       // rolling mark prices
        this._tickCount = 0;

        // Spread tracking
        this._spreads = [];      // last 50 spread values in bps
        this._spreadHistory = []; // last 20 for rate computation

        // Dwell tracking
        this._currentBucket = null;
        this._dwellTicks = 0;

        // Vol-of-vol
        this._rvHistory = [];    // last 60 RV values for VoV

        // Direction persistence tracking
        this._dirSigns = [];     // last 20 direction signs (+1/-1)

        // Current regime
        this.regime = 'warmup';
        this.probs = { trending: 0, mean_revert: 0, liquidation: 0, toxic: 1 };
        this.confidence = 0;
        this.sizeMultiplier = 0.5;
    }

    /**
     * Feed a new tick. Call on every price update.
     * @param {number} price — mark price
     * @param {number|null} bid — best bid (null if unavailable)
     * @param {number|null} ask — best ask (null if unavailable)
     * @returns {{ regime, probs, confidence, sizeMultiplier, features }}
     */
    update(price, bid = null, ask = null) {
        if (!price || price <= 0) return this._result({});
        this._tickCount++;

        // ── Buffer prices ──────────────────────────────────
        this._prices.push(price);
        if (this._prices.length > this._rvSlow + 5) {
            this._prices.shift();
        }

        // ── Spread ─────────────────────────────────────────
        let spreadBps = 0;
        if (bid && ask && ask > bid && price > 0) {
            spreadBps = ((ask - bid) / price) * 10000;
            this._spreads.push(spreadBps);
            if (this._spreads.length > 50) this._spreads.shift();
            this._spreadHistory.push(spreadBps);
            if (this._spreadHistory.length > 20) this._spreadHistory.shift();
        }

        // ── Dwell time ─────────────────────────────────────
        const bucket = Math.floor(price / (price * 0.001)); // ~10bps buckets
        if (bucket !== this._currentBucket) {
            this._currentBucket = bucket;
            this._dwellTicks = 0;
        } else {
            this._dwellTicks++;
        }

        // ── Not enough data yet ────────────────────────────
        if (this._tickCount < this._warmup) {
            return this._result({});
        }

        // ── Compute features ───────────────────────────────
        const features = this._computeFeatures(price, spreadBps);

        // ── Classify ───────────────────────────────────────
        return this._classify(features);
    }

    _computeFeatures(price, spreadBps) {
        const prices = this._prices;

        // ── Log returns ─────────────────────
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1] > 0) {
                returns.push(Math.log(prices[i] / prices[i - 1]));
            }
        }

        // ── RV (fast and slow) ──────────────
        const fastRv = this._rollingStd(returns.slice(-this._rvFast)) * 10000; // bps
        const slowRv = this._rollingStd(returns.slice(-this._rvSlow)) * 10000;
        const rvRatio = slowRv > 0.001 ? fastRv / slowRv : 1.0;

        // Track RV for vol-of-vol
        this._rvHistory.push(slowRv);
        if (this._rvHistory.length > 60) this._rvHistory.shift();
        const volOfVol = this._rollingStd(this._rvHistory);

        // ── Price velocity ──────────────────
        let velocityBps = 0;
        if (prices.length >= this._velWindow + 1) {
            const pOld = prices[prices.length - this._velWindow - 1];
            const pNew = prices[prices.length - 1];
            if (pOld > 0) velocityBps = ((pNew - pOld) / pOld) * 10000;
        }

        // ── Direction persistence ───────────
        const dirSign = velocityBps > 0.5 ? 1 : velocityBps < -0.5 ? -1 : 0;
        this._dirSigns.push(dirSign);
        if (this._dirSigns.length > 20) this._dirSigns.shift();
        // Persistence = fraction of signs matching current direction
        const dirPersistence = dirSign !== 0
            ? this._dirSigns.filter(s => s === dirSign).length / this._dirSigns.length
            : 0;

        // ── Spread widening rate ────────────
        let spreadRate = 0;
        if (this._spreadHistory.length >= 5) {
            const first = this._spreadHistory[0];
            const last = this._spreadHistory[this._spreadHistory.length - 1];
            spreadRate = last - first; // positive = widening
        }

        return {
            rvRatio,
            fastRv,
            slowRv,
            velocityBps,
            dirPersistence,
            spreadBps,
            spreadRate,
            dwellTicks: this._dwellTicks,
            volOfVol,
        };
    }

    _classify(f) {
        // ── P(trending) ────────────────────────────
        const velNorm = Math.tanh(Math.abs(f.velocityBps) / 15); // 15bps = strong
        const dirNorm = f.dirPersistence;
        const rvModerate = Math.max(0, 1 - Math.abs(f.rvRatio - 1.2) / 2); // sweet spot ~1.2
        const pTrend = sigmoid(
            2.0 * velNorm
            + 2.0 * dirNorm
            + 1.0 * rvModerate
            - 0.5 * Math.max(0, f.spreadRate / 3) // penalize widening spread
            - 1.5 // bias: require evidence
        );

        // ── P(mean_revert) ─────────────────────────
        const rvLow = Math.max(0, 1 - f.slowRv / 30); // low vol = good
        const dwellNorm = Math.min(1, f.dwellTicks / 20); // high dwell = absorption
        const spreadStable = Math.max(0, 1 - Math.abs(f.spreadRate) / 2);
        const pGrid = sigmoid(
            2.0 * rvLow
            + 1.5 * dwellNorm
            + 1.0 * spreadStable
            - 1.5 * velNorm // penalize momentum
            - 1.0 // bias
        );

        // ── P(liquidation cascade) ─────────────────
        const rvSpikeNorm = Math.min(1, Math.max(0, (f.rvRatio - 2) / 3)); // rv ratio > 2
        const spreadBlowout = Math.min(1, Math.max(0, f.spreadRate / 5)); // rapid widening
        const vovNorm = Math.min(1, f.volOfVol / 15); // high vol-of-vol
        const extremeVel = Math.min(1, Math.abs(f.velocityBps) / 30); // very fast move
        const pLiq = sigmoid(
            2.5 * rvSpikeNorm
            + 2.0 * spreadBlowout
            + 1.5 * vovNorm
            + 1.0 * extremeVel
            - 2.5 // high bias: rare events
        );

        // ── Normalize to sum=1, compute toxic ──────
        const raw = { trending: pTrend, mean_revert: pGrid, liquidation: pLiq };
        const sum = pTrend + pGrid + pLiq + 0.001;
        const probs = {
            trending: pTrend / sum,
            mean_revert: pGrid / sum,
            liquidation: pLiq / sum,
            toxic: 0,
        };

        const maxProb = Math.max(probs.trending, probs.mean_revert, probs.liquidation);
        if (maxProb < 0.35) {
            probs.toxic = 1 - maxProb;
            const s2 = probs.trending + probs.mean_revert + probs.liquidation + probs.toxic;
            probs.trending /= s2;
            probs.mean_revert /= s2;
            probs.liquidation /= s2;
            probs.toxic /= s2;
        }

        // Dominant regime
        const regime = Object.entries(probs).reduce((a, b) => b[1] > a[1] ? b : a, ['unknown', 0])[0];
        const confidence = maxProb;

        // ── Size multiplier ────────────────────────
        // Scale 0.5–1.0 based on maximum regime probability
        const sizeMultiplier = 0.5 + 0.5 * Math.min(1, maxProb);

        this.regime = regime;
        this.probs = probs;
        this.confidence = confidence;
        this.sizeMultiplier = sizeMultiplier;

        return this._result(f);
    }

    _result(features) {
        return {
            regime: this.regime,
            probs: { ...this.probs },
            confidence: this.confidence,
            sizeMultiplier: this.sizeMultiplier,
            features,
        };
    }

    _rollingStd(arr) {
        if (arr.length < 2) return 0;
        const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
        const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
        return Math.sqrt(Math.max(0, variance));
    }
}
