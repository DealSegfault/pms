/**
 * Grid Agent — Runs a persistent Neutral-mode scalper for market-making.
 *
 * Monitors fill rate and net PnL. If the scalper is unprofitable beyond
 * a configured drawdown threshold, pauses it and restarts with wider
 * offsets after a cooldown period.
 */
import AgentBase from './agent-base.js';

export default class GridAgent extends AgentBase {

    constructor(config) {
        super(config);

        // Scalper parameters
        this.sizeUsd = config.sizeUsd || 100;
        this.leverage = config.leverage || 10;
        this.offsetPct = config.offsetPct || 0.2;
        this.childCount = config.childCount || 3;
        this.skew = config.skew || 0;

        // Guard settings
        this.minFillSpreadPct = config.minFillSpreadPct || 0.08;
        this.fillDecayHalfLifeMs = config.fillDecayHalfLifeMs || 30000;
        this.minRefillDelayMs = config.minRefillDelayMs || 3000;
        this.maxFillsPerMinute = config.maxFillsPerMinute || 5;
        this.pnlFeedbackMode = config.pnlFeedbackMode || 'full';

        // Self-management
        this.maxDrawdownUsd = config.maxDrawdownUsd || 10;
        this.cooldownMs = config.cooldownMs || 60000;
        this.widenFactor = config.widenFactor || 1.5; // multiply offset on restart
        this.maxWidenings = config.maxWidenings || 3;

        // State
        this._netPnl = 0;
        this._wideningCount = 0;
        this._pausedAt = null;
        this._currentOffsetPct = this.offsetPct;
        this._checkIntervalTicks = 20; // check every N ticks
    }

    async start() {
        await super.start();
        // Deploy the neutral scalper immediately
        await this._deployGrid();
    }

    onTick(symbol, price, now) {
        // If paused, check if cooldown has elapsed
        if (this._pausedAt) {
            if (now - this._pausedAt >= this.cooldownMs) {
                this._pausedAt = null;
                this._wideningCount++;
                if (this._wideningCount <= this.maxWidenings) {
                    this._currentOffsetPct *= this.widenFactor;
                    console.log(`[GridAgent ${this.id}] Cooldown elapsed, restarting with offset ${this._currentOffsetPct.toFixed(3)}%`);
                    this._deployGrid().catch(err =>
                        console.error(`[GridAgent ${this.id}] Restart error:`, err.message)
                    );
                } else {
                    console.log(`[GridAgent ${this.id}] Max widenings (${this.maxWidenings}) reached, staying paused`);
                }
            }
            return;
        }

        // Periodic PnL check
        if (this._tickCount % this._checkIntervalTicks !== 0) return;

        const pos = this.getPosition();
        if (pos) {
            const currentPrice = this.getPrice();
            const unrealized = pos.side === 'LONG'
                ? (currentPrice - pos.entryPrice) * pos.qty
                : (pos.entryPrice - currentPrice) * pos.qty;

            // If drawdown exceeds limit, pause
            if (unrealized < -this.maxDrawdownUsd) {
                console.log(`[GridAgent ${this.id}] Drawdown $${unrealized.toFixed(2)} exceeds -$${this.maxDrawdownUsd}, pausing`);
                this._pausedAt = now;
                this.killScalper('grid').catch(() => { });
            }
        }
    }

    async _deployGrid() {
        await this.spawnScalper('grid', {
            startSide: 'LONG', // doesn't matter in neutral
            leverage: this.leverage,
            longOffsetPct: this._currentOffsetPct,
            shortOffsetPct: this._currentOffsetPct,
            childCount: this.childCount,
            skew: this.skew,
            longSizeUsd: this.sizeUsd,
            shortSizeUsd: this.sizeUsd,
            neutralMode: true,
            allowLoss: false,
            minFillSpreadPct: this.minFillSpreadPct,
            fillDecayHalfLifeMs: this.fillDecayHalfLifeMs,
            minRefillDelayMs: this.minRefillDelayMs,
            maxFillsPerMinute: this.maxFillsPerMinute,
            pnlFeedbackMode: this.pnlFeedbackMode,
        });

        console.log(`[GridAgent ${this.id}] Deployed neutral scalper: offset=${this._currentOffsetPct.toFixed(3)}%, ${this.childCount} layers, $${this.sizeUsd}/side`);
    }

    getStatus() {
        return {
            ...super.getStatus(),
            currentOffsetPct: this._currentOffsetPct,
            wideningCount: this._wideningCount,
            paused: !!this._pausedAt,
            pausedAt: this._pausedAt,
        };
    }
}
