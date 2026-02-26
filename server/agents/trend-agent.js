/**
 * Trend Agent — Spawns directional scalpers based on EMA crossover.
 *
 * Uses a fast and slow EMA on price ticks. When the fast crosses
 * above the slow, spawns a LONG scalper. When it crosses below,
 * spawns a SHORT scalper. Only one scalper active at a time.
 *
 * Risk controls:
 *   - Hard stop loss: kills agent when unrealized loss exceeds hardStopBps
 *   - Trailing stop: once profit exceeds trailingActivateBps, tracks HWM
 *     and triggers when retrace exceeds trailingOffsetBps
 *   - Volatility gate: blocks new entries when rvRatio > maxRvRatio
 *   - Regime gate: blocks entries during toxic/liquidation regimes
 *   - Signal flip close: spawns reduce-only scalper to close old position
 *     before opening new direction
 */
import AgentBase from './agent-base.js';
import { TickRegimeDetector } from './tick-regime.js';
import { CompositeSignal } from './composite-signal.js';
import exchange from '../exchange.js';

export default class TrendAgent extends AgentBase {

    constructor(config) {
        super(config);

        // Signal parameters
        this.fastPeriod = config.fastPeriod || 10;
        this.slowPeriod = config.slowPeriod || 50;
        this.fastEma = null;
        this.slowEma = null;
        this._prevSignal = null; // 'LONG' | 'SHORT' | null

        // Scalper parameters
        this.sizeUsd = config.sizeUsd || 50;
        this.leverage = config.leverage || 10;
        this.offsetPct = config.offsetPct || 0.15;
        this.childCount = config.childCount || 2;
        this.skew = config.skew || 0;

        // Guard settings (passed through to scalper)
        this.minFillSpreadPct = config.minFillSpreadPct || 0.08;
        this.fillDecayHalfLifeMs = config.fillDecayHalfLifeMs || 30000;
        this.maxLossPerCloseBps = config.maxLossPerCloseBps || 150;
        this.pnlFeedbackMode = config.pnlFeedbackMode || 'soft';

        // Cooldown: don't flip direction more than once per N ms
        this.minFlipIntervalMs = config.minFlipIntervalMs || 30000;
        this._lastFlipAt = 0;

        // ── Hard Stop Loss ─────────────────────────────────
        this.hardStopBps = config.hardStopBps ?? 300; // 3% — agent fully stops

        // ── Trailing Stop ──────────────────────────────────
        this.trailingActivateBps = config.trailingActivateBps ?? 100; // 1% profit to activate
        this.trailingOffsetBps = config.trailingOffsetBps ?? 50;      // 0.5% retrace to trigger
        this._trailingHwm = null;   // high-water-mark PnL in bps
        this._trailingActive = false;

        // ── Volatility Gate ────────────────────────────────
        this.maxRvRatio = config.maxRvRatio ?? 3.0;
        this._rvFastWindow = config.rvFastWindow || 5;
        this._rvSlowWindow = config.rvSlowWindow || 50;
        this._priceHistory = []; // rolling log-return buffer

        // ── Regime Classifier ──────────────────────────────
        this.regimeEnabled = config.regimeEnabled ?? true;
        this.toxicThreshold = config.toxicThreshold ?? 0.35;  // skip if P(toxic) > this
        this.liqThreshold = config.liqThreshold ?? 0.40;      // skip if P(liquidation) > this
        this._regime = new TickRegimeDetector({
            rvFast: this._rvFastWindow,
            rvSlow: this._rvSlowWindow,
        });
        this._lastRegime = null;

        // ── Composite Signal ───────────────────────────────
        this.useCompositeSignal = config.useCompositeSignal ?? true;
        this.minSignalConfidence = config.minSignalConfidence ?? 0.3;
        this._compositeSignal = new CompositeSignal({
            fastPeriod: this.fastPeriod,
            slowPeriod: this.slowPeriod,
            minConfidence: this.minSignalConfidence,
        });
        this._lastCompositeResult = null;
    }

    onTick(symbol, price, now) {
        if (!price || price <= 0) return;

        // ── Update price history for vol gate ──────────────
        this._priceHistory.push(price);
        if (this._priceHistory.length > this._rvSlowWindow + 1) {
            this._priceHistory.shift();
        }

        // ── Feed regime classifier ─────────────────────────
        if (this.regimeEnabled) {
            const ba = exchange.getLatestBidAsk(this.symbol);
            const regimeResult = this._regime.update(price, ba?.bid || null, ba?.ask || null);
            if (regimeResult.regime !== this._lastRegime) {
                this._lastRegime = regimeResult.regime;
                console.log(`[TrendAgent ${this.id}] Regime → ${regimeResult.regime} (` +
                    `trend=${(regimeResult.probs.trending * 100).toFixed(0)}% ` +
                    `mr=${(regimeResult.probs.mean_revert * 100).toFixed(0)}% ` +
                    `liq=${(regimeResult.probs.liquidation * 100).toFixed(0)}% ` +
                    `toxic=${(regimeResult.probs.toxic * 100).toFixed(0)}%)`);
            }
        }

        // ── Update EMAs (always, for status display) ───────
        const fastAlpha = 2 / (this.fastPeriod + 1);
        const slowAlpha = 2 / (this.slowPeriod + 1);

        if (this.fastEma === null) {
            this.fastEma = price;
            this.slowEma = price;
            // Also feed composite signal to warm it up
            if (this.useCompositeSignal) {
                const ba = exchange.getLatestBidAsk(this.symbol);
                this._compositeSignal.compute(price, ba?.bid || null, ba?.ask || null);
            }
            return;
        }

        this.fastEma = fastAlpha * price + (1 - fastAlpha) * this.fastEma;
        this.slowEma = slowAlpha * price + (1 - slowAlpha) * this.slowEma;

        // Wait for enough ticks to warm up slow EMA
        if (this._tickCount < this.slowPeriod) {
            if (this.useCompositeSignal) {
                const ba = exchange.getLatestBidAsk(this.symbol);
                this._compositeSignal.compute(price, ba?.bid || null, ba?.ask || null);
            }
            return;
        }

        // ── Position Risk Monitors ─────────────────────────
        this._checkStopLoss(price, now);

        // ── Signal ─────────────────────────────────────────
        let signal;
        if (this.useCompositeSignal) {
            const ba = exchange.getLatestBidAsk(this.symbol);
            const regimeData = this.regimeEnabled ? {
                regime: this._regime.regime,
                probs: this._regime.probs,
                confidence: this._regime.confidence,
            } : null;
            this._lastCompositeResult = this._compositeSignal.compute(
                price, ba?.bid || null, ba?.ask || null, regimeData
            );
            // Composite signal already has minimum confidence gating
            signal = this._lastCompositeResult.direction; // 'LONG' | 'SHORT' | null
            if (!signal) return; // not confident enough
        } else {
            signal = this.fastEma > this.slowEma ? 'LONG' : 'SHORT';
        }

        // Only act on signal change
        if (signal === this._prevSignal) return;
        this._prevSignal = signal;

        // Regime-adaptive cooldown
        let effectiveCooldown = this.minFlipIntervalMs;
        if (this.regimeEnabled && this._regime.regime !== 'warmup') {
            if (this._regime.regime === 'trending') {
                effectiveCooldown = Math.max(10000, this.minFlipIntervalMs * 0.33);
            } else if (this._regime.regime === 'mean_revert') {
                effectiveCooldown = Math.max(this.minFlipIntervalMs, 60000);
            }
        }

        if (now - this._lastFlipAt < effectiveCooldown) {
            return;
        }
        this._lastFlipAt = now;

        // Reset trailing stop on direction change
        this._trailingHwm = null;
        this._trailingActive = false;

        // Spawn directional scalper
        this._deployScalper(signal).catch(err => {
            console.error(`[TrendAgent ${this.id}] Deploy error:`, err.message);
        });
    }

    /**
     * Check hard stop loss and trailing stop on every tick.
     */
    _checkStopLoss(price, now) {
        const pos = this.getPosition();
        if (!pos) {
            // No position — reset trailing state
            this._trailingHwm = null;
            this._trailingActive = false;
            return;
        }

        // Compute unrealised PnL in bps
        let pnlBps = 0;
        if (pos.side === 'LONG') {
            pnlBps = (price - pos.entryPrice) / pos.entryPrice * 10000;
        } else {
            pnlBps = (pos.entryPrice - price) / pos.entryPrice * 10000;
        }

        // ── Hard stop loss ─────────────────────────────────
        if (this.hardStopBps > 0 && pnlBps < -this.hardStopBps) {
            console.error(`[TrendAgent ${this.id}] 🛑 HARD STOP — loss ${pnlBps.toFixed(1)}bps exceeds -${this.hardStopBps}bps. Stopping agent.`);
            this.stop('hard_stop').catch(() => { });
            return;
        }

        // ── Trailing stop ──────────────────────────────────
        if (this.trailingActivateBps > 0 && this.trailingOffsetBps > 0) {
            if (!this._trailingActive && pnlBps >= this.trailingActivateBps) {
                this._trailingActive = true;
                this._trailingHwm = pnlBps;
                console.log(`[TrendAgent ${this.id}] 📈 Trailing stop ACTIVATED at ${pnlBps.toFixed(1)}bps`);
            }

            if (this._trailingActive) {
                if (pnlBps > this._trailingHwm) {
                    this._trailingHwm = pnlBps;
                }
                const retrace = this._trailingHwm - pnlBps;
                if (retrace >= this.trailingOffsetBps) {
                    console.error(`[TrendAgent ${this.id}] 📉 TRAILING STOP — retrace ${retrace.toFixed(1)}bps from HWM ${this._trailingHwm.toFixed(1)}bps. Stopping agent.`);
                    this.stop('trailing_stop').catch(() => { });
                    return;
                }
            }
        }
    }

    /**
     * Compute rvRatio (fast vol / slow vol) from price history.
     * Returns Infinity if not enough data.
     */
    _computeRvRatio() {
        const prices = this._priceHistory;
        if (prices.length < this._rvSlowWindow + 1) return 1.0; // not enough data, allow

        // Compute log returns
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }

        // Fast variance (last N returns)
        const fastReturns = returns.slice(-this._rvFastWindow);
        const fastMean = fastReturns.reduce((s, r) => s + r, 0) / fastReturns.length;
        const fastVar = fastReturns.reduce((s, r) => s + (r - fastMean) ** 2, 0) / fastReturns.length;

        // Slow variance (all returns)
        const slowMean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const slowVar = returns.reduce((s, r) => s + (r - slowMean) ** 2, 0) / returns.length;

        if (slowVar < 1e-20) return 1.0;
        return Math.sqrt(fastVar / slowVar);
    }

    async _deployScalper(direction) {
        // ── Volatility gate ────────────────────────────────
        const rvRatio = this._computeRvRatio();
        if (rvRatio > this.maxRvRatio) {
            console.warn(`[TrendAgent ${this.id}] ⚡ VOL GATE — rvRatio ${rvRatio.toFixed(2)} > ${this.maxRvRatio}. Skipping ${direction} deploy.`);
            return;
        }

        // ── Regime gate ────────────────────────────────────
        if (this.regimeEnabled && this._regime.regime !== 'warmup') {
            const p = this._regime.probs;
            if (p.toxic > this.toxicThreshold) {
                console.warn(`[TrendAgent ${this.id}] ☠️ REGIME GATE — toxic ${(p.toxic * 100).toFixed(0)}% > ${(this.toxicThreshold * 100).toFixed(0)}%. Skipping ${direction} deploy.`);
                return;
            }
            if (p.liquidation > this.liqThreshold) {
                console.warn(`[TrendAgent ${this.id}] 💥 REGIME GATE — liquidation ${(p.liquidation * 100).toFixed(0)}% > ${(this.liqThreshold * 100).toFixed(0)}%. Skipping ${direction} deploy.`);
                return;
            }
        }

        // Kill any existing scalper
        if (this.hasScalper('trend')) {
            await this.killScalper('trend');
        }

        // ── Close old position on signal flip ──────────────
        // If there's an open position in the opposite direction, spawn a
        // temporary reduce-only scalper to close it first.
        const pos = this.getPosition();
        if (pos && pos.side !== direction) {
            console.log(`[TrendAgent ${this.id}] Closing stale ${pos.side} position ($${pos.notional?.toFixed(0) || '?'}) before flipping to ${direction}`);
            try {
                await this.spawnScalper('trend_close', {
                    startSide: pos.side === 'LONG' ? 'SHORT' : 'LONG',
                    leverage: this.leverage,
                    longOffsetPct: this.offsetPct,
                    shortOffsetPct: this.offsetPct,
                    childCount: this.childCount,
                    longSizeUsd: (pos.notional || this.sizeUsd),
                    shortSizeUsd: (pos.notional || this.sizeUsd),
                    allowLoss: true, // accept loss to close stale position
                    maxLossPerCloseBps: 0, // no guard — we want to close it
                    pnlFeedbackMode: 'off',
                });
                // Give the close scalper a moment to work before spawning the new one
                await new Promise(r => setTimeout(r, 2000));
                // Kill the closer — it may still be working but we don't want it to linger
                if (this.hasScalper('trend_close')) {
                    await this.killScalper('trend_close');
                }
            } catch (err) {
                console.warn(`[TrendAgent ${this.id}] Close stale pos error:`, err.message);
            }
        }

        // ── Regime + flow-based sizing ──────────────────────
        const sizeMult = this.regimeEnabled ? this._regime.sizeMultiplier : 1.0;
        const flowMult = (this.useCompositeSignal && this._lastCompositeResult)
            ? this._lastCompositeResult.flowMultiplier : 1.0;
        const effectiveSize = this.sizeUsd * sizeMult * flowMult;

        await this.spawnScalper('trend', {
            startSide: direction,
            leverage: this.leverage,
            longOffsetPct: this.offsetPct,
            shortOffsetPct: this.offsetPct,
            childCount: this.childCount,
            skew: this.skew,
            longSizeUsd: effectiveSize,
            shortSizeUsd: effectiveSize,
            allowLoss: false,
            minFillSpreadPct: this.minFillSpreadPct,
            fillDecayHalfLifeMs: this.fillDecayHalfLifeMs,
            maxLossPerCloseBps: this.maxLossPerCloseBps,
            pnlFeedbackMode: this.pnlFeedbackMode,
        });

        const regimeTag = this.regimeEnabled ? ` regime=${this._regime.regime}` : '';
        const signalTag = (this.useCompositeSignal && this._lastCompositeResult)
            ? ` conf=${this._lastCompositeResult.confidence.toFixed(2)} flow×${flowMult.toFixed(2)}`
            : '';
        console.log(`[TrendAgent ${this.id}] Deployed ${direction} scalper ($${effectiveSize.toFixed(0)} size×${(sizeMult * flowMult).toFixed(2)} rvR=${rvRatio.toFixed(2)}${regimeTag}${signalTag})`);
    }

    getStatus() {
        const compositeInfo = this._lastCompositeResult
            ? {
                compositeDirection: this._lastCompositeResult.direction,
                compositeConfidence: this._lastCompositeResult.confidence,
                compositeRawScore: this._lastCompositeResult.rawScore,
                compositeComponents: this._lastCompositeResult.components,
                flowMultiplier: this._lastCompositeResult.flowMultiplier,
            }
            : {};
        return {
            ...super.getStatus(),
            fastEma: this.fastEma,
            slowEma: this.slowEma,
            signal: this._prevSignal,
            lastFlipAt: this._lastFlipAt,
            trailingActive: this._trailingActive,
            trailingHwm: this._trailingHwm,
            rvRatio: this._computeRvRatio(),
            regime: this._regime.regime,
            regimeProbs: { ...this._regime.probs },
            regimeConfidence: this._regime.confidence,
            regimeSizeMultiplier: this._regime.sizeMultiplier,
            useCompositeSignal: this.useCompositeSignal,
            ...compositeInfo,
        };
    }
}
