/**
 * Composite Signal — Multi-factor directional signal with confidence scoring.
 *
 * Combines 5 sub-signals into a single confidence-scored direction:
 *   1. EMA crossover delta (30%) — normalized distance between fast/slow EMA
 *   2. Price velocity (25%) — momentum in bps over a window
 *   3. Direction persistence (20%) — fraction of recent ticks aligned
 *   4. Regime boost (15%) — bonus in trending, penalty in mean_revert
 *   5. Spread contraction (10%) — narrowing spread = informed flow arriving
 *
 * Also provides a flow-based size multiplier (VPIN proxy):
 *   - Narrow spread + aligned velocity → 1.0 (full size)
 *   - Wide spread + contra velocity → 0.5 (half size)
 */

export class CompositeSignal {

    /**
     * @param {Object} opts
     * @param {number} opts.fastPeriod  — fast EMA period (default 10)
     * @param {number} opts.slowPeriod  — slow EMA period (default 50)
     * @param {number} opts.velWindow   — velocity lookback in ticks (default 10)
     * @param {number} opts.minConfidence — minimum |score| to emit a signal (default 0.3)
     */
    constructor(opts = {}) {
        this._fastPeriod = opts.fastPeriod || 10;
        this._slowPeriod = opts.slowPeriod || 50;
        this._velWindow = opts.velWindow || 10;
        this.minConfidence = opts.minConfidence ?? 0.3;

        // EMA state
        this._fastEma = null;
        this._slowEma = null;

        // Price buffer for velocity
        this._prices = [];
        this._tickCount = 0;

        // Direction tracking
        this._dirSigns = []; // last 20 direction signs

        // Spread tracking for flow proxy
        this._recentSpreads = []; // last 20 spread values in bps
    }

    /**
     * Feed a tick and compute composite signal.
     * @param {number} price — mark price
     * @param {number|null} bid
     * @param {number|null} ask
     * @param {Object} regimeData — from TickRegimeDetector { regime, probs, confidence }
     * @returns {{ direction: 'LONG'|'SHORT'|null, confidence: number, rawScore: number, components: Object, flowMultiplier: number }}
     */
    compute(price, bid = null, ask = null, regimeData = null) {
        if (!price || price <= 0) return this._noSignal();
        this._tickCount++;

        // ── Buffer price ───────────────────────────────────
        this._prices.push(price);
        if (this._prices.length > this._slowPeriod + this._velWindow + 5) {
            this._prices.shift();
        }

        // ── Update EMAs ────────────────────────────────────
        const fastAlpha = 2 / (this._fastPeriod + 1);
        const slowAlpha = 2 / (this._slowPeriod + 1);

        if (this._fastEma === null) {
            this._fastEma = price;
            this._slowEma = price;
            return this._noSignal();
        }

        this._fastEma = fastAlpha * price + (1 - fastAlpha) * this._fastEma;
        this._slowEma = slowAlpha * price + (1 - slowAlpha) * this._slowEma;

        // Not enough data
        if (this._tickCount < this._slowPeriod) return this._noSignal();

        // ── 1. EMA crossover delta (weight: 0.30) ──────────
        // Normalized to roughly [-1, 1] range
        const emaDelta = (this._fastEma - this._slowEma) / this._slowEma * 10000; // bps
        const emaNorm = Math.tanh(emaDelta / 20); // ±20bps = strong signal
        const emaComponent = emaNorm * 0.30;

        // ── 2. Velocity (weight: 0.25) ─────────────────────
        let velocityBps = 0;
        if (this._prices.length >= this._velWindow + 1) {
            const pOld = this._prices[this._prices.length - this._velWindow - 1];
            velocityBps = ((price - pOld) / pOld) * 10000;
        }
        const velNorm = Math.tanh(velocityBps / 15); // ±15bps = strong
        const velComponent = velNorm * 0.25;

        // ── 3. Direction persistence (weight: 0.20) ────────
        const dirSign = velocityBps > 0.5 ? 1 : velocityBps < -0.5 ? -1 : 0;
        this._dirSigns.push(dirSign);
        if (this._dirSigns.length > 20) this._dirSigns.shift();

        let dirComponent = 0;
        if (dirSign !== 0) {
            const aligned = this._dirSigns.filter(s => s === dirSign).length;
            const persistence = aligned / this._dirSigns.length;
            dirComponent = (dirSign > 0 ? persistence : -persistence) * 0.20;
        }

        // ── 4. Regime boost (weight: 0.15) ─────────────────
        let regimeComponent = 0;
        if (regimeData && regimeData.regime !== 'warmup') {
            if (regimeData.regime === 'trending') {
                // Boost in direction of current signal
                const signalDir = (emaComponent + velComponent) > 0 ? 1 : -1;
                regimeComponent = signalDir * regimeData.probs.trending * 0.15;
            } else if (regimeData.regime === 'mean_revert') {
                // Penalize (reduce confidence in directional signals)
                regimeComponent = 0; // neutral, effectively reduces total confidence
            } else if (regimeData.regime === 'toxic' || regimeData.regime === 'liquidation') {
                // Counter-signal (fade the move slightly)
                const signalDir = (emaComponent + velComponent) > 0 ? 1 : -1;
                regimeComponent = -signalDir * 0.05;
            }
        }

        // ── 5. Spread contraction (weight: 0.10) ───────────
        let spreadComponent = 0;
        if (bid && ask && ask > bid && price > 0) {
            const spreadBps = ((ask - bid) / price) * 10000;
            this._recentSpreads.push(spreadBps);
            if (this._recentSpreads.length > 20) this._recentSpreads.shift();

            if (this._recentSpreads.length >= 5) {
                const oldSpread = this._recentSpreads[0];
                const newSpread = this._recentSpreads[this._recentSpreads.length - 1];
                const contraction = oldSpread - newSpread; // positive = narrowing
                // Narrowing spread in direction of signal = informed flow
                const signalDir = (emaComponent + velComponent) > 0 ? 1 : -1;
                spreadComponent = signalDir * Math.tanh(contraction / 3) * 0.10;
            }
        }

        // ── Composite ──────────────────────────────────────
        const rawScore = emaComponent + velComponent + dirComponent + regimeComponent + spreadComponent;
        const confidence = Math.min(1, Math.abs(rawScore));

        // Direction
        let direction = null;
        if (confidence >= this.minConfidence) {
            direction = rawScore > 0 ? 'LONG' : 'SHORT';
        }

        // ── Flow size multiplier (VPIN proxy) ──────────────
        const flowMultiplier = this._computeFlowMultiplier(velocityBps, bid, ask, price);

        return {
            direction,
            confidence,
            rawScore,
            flowMultiplier,
            fastEma: this._fastEma,
            slowEma: this._slowEma,
            components: {
                ema: emaComponent,
                velocity: velComponent,
                direction: dirComponent,
                regime: regimeComponent,
                spread: spreadComponent,
            },
        };
    }

    /**
     * Flow-based size multiplier (0.5–1.0).
     * Proxy for VPIN using spread dynamics + velocity alignment.
     */
    _computeFlowMultiplier(velocityBps, bid, ask, price) {
        if (!bid || !ask || ask <= bid || price <= 0) return 0.75; // no data → conservative

        const spreadBps = ((ask - bid) / price) * 10000;

        // Spread score: narrow = good (informed flow), wide = bad
        const spreadScore = Math.max(0, Math.min(1, 1 - spreadBps / 10)); // 0-10bps range

        // Velocity alignment: strong directional move = informed
        const velScore = Math.min(1, Math.abs(velocityBps) / 10);

        // Combined: both narrow spread AND momentum = high confidence flow
        const flowScore = 0.6 * spreadScore + 0.4 * velScore;

        // Map to [0.5, 1.0]
        return 0.5 + 0.5 * flowScore;
    }

    _noSignal() {
        return {
            direction: null,
            confidence: 0,
            rawScore: 0,
            flowMultiplier: 0.75,
            fastEma: this._fastEma,
            slowEma: this._slowEma,
            components: { ema: 0, velocity: 0, direction: 0, regime: 0, spread: 0 },
        };
    }
}
