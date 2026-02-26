/**
 * Deleverage Agent — Auto-unwinds position when notional exceeds cap.
 *
 * Monitors position size via the risk book. When position notional
 * exceeds maxNotional, spawns a reduce-only scalper on the opposite
 * side to unwind. Kills the unwind scalper when position drops below
 * the re-entry threshold.
 */
import AgentBase from './agent-base.js';

export default class DeleverageAgent extends AgentBase {

    constructor(config) {
        super(config);

        // Position cap
        this.maxNotional = config.maxNotional || 500;
        this.reentryRatio = config.reentryRatio || 0.80; // stop deleveraging at 80% of max
        this.unwindPct = config.unwindPct || 30; // % of position to unwind per scalper

        // Scalper parameters
        this.leverage = config.leverage || 10;
        this.offsetPct = config.offsetPct || 0.2;
        this.childCount = config.childCount || 2;

        // Guard settings
        this.maxLossBps = config.maxLossBps || 200;
        this.minFillSpreadPct = config.minFillSpreadPct || 0.1;

        // State
        this._deleveraging = false;
        this._checkIntervalTicks = 10; // check every N ticks
    }

    onTick(symbol, price, now) {
        if (this._tickCount % this._checkIntervalTicks !== 0) return;

        const pos = this.getPosition();

        if (this._deleveraging) {
            // Check if position has dropped enough to stop deleveraging
            if (!pos || pos.notional < this.maxNotional * this.reentryRatio) {
                console.log(`[DeleverageAgent ${this.id}] Position $${pos?.notional?.toFixed(0) || 0} below ${(this.reentryRatio * 100).toFixed(0)}% of max — stopping unwind`);
                this._deleveraging = false;
                this.killScalper('unwind').catch(() => { });
            }
            return;
        }

        // Check if position exceeds cap
        if (pos && pos.notional >= this.maxNotional) {
            console.log(`[DeleverageAgent ${this.id}] Position $${pos.notional.toFixed(0)} ≥ max $${this.maxNotional} — spawning unwind scalper`);
            this._deleveraging = true;
            this._deployUnwind(pos).catch(err =>
                console.error(`[DeleverageAgent ${this.id}] Unwind error:`, err.message)
            );
        }
    }

    async _deployUnwind(pos) {
        const unwindSide = pos.side === 'LONG' ? 'SHORT' : 'LONG';
        const unwindSizeUsd = pos.notional * (this.unwindPct / 100);

        await this.spawnScalper('unwind', {
            startSide: unwindSide,
            leverage: this.leverage,
            longOffsetPct: this.offsetPct,
            shortOffsetPct: this.offsetPct,
            childCount: this.childCount,
            longSizeUsd: unwindSizeUsd,
            shortSizeUsd: unwindSizeUsd,
            allowLoss: false,
            maxLossPerCloseBps: this.maxLossBps,
            minFillSpreadPct: this.minFillSpreadPct,
            pnlFeedbackMode: 'soft',
        });

        console.log(`[DeleverageAgent ${this.id}] Deployed ${unwindSide} unwind scalper: $${unwindSizeUsd.toFixed(0)} (${this.unwindPct}% of $${pos.notional.toFixed(0)})`);
    }

    getStatus() {
        return {
            ...super.getStatus(),
            deleveraging: this._deleveraging,
            maxNotional: this.maxNotional,
            reentryRatio: this.reentryRatio,
            currentPosition: this.getPosition(),
        };
    }
}
