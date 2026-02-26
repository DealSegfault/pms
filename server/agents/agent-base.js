/**
 * Agent Base — Abstract base class for all trading agents.
 *
 * Agents use the scalper as their ONLY execution primitive. They never
 * place orders directly — they spawn and manage scalper instances.
 *
 * Lifecycle:  new Agent(config) → agent.start() → agent.tick(price) → agent.stop()
 *
 * Subclasses MUST implement:
 *   - onTick(symbol, price, now)  — react to price changes
 *   - onPositionUpdate(position)  — react to position changes (optional)
 */
import { EventEmitter } from 'events';
import exchange from '../exchange.js';
import riskEngine from '../risk/index.js';
import { broadcast } from '../ws.js';
import { startScalperInternal, cancelScalperInternal } from '../routes/trading/scalper.js';

let _nextAgentId = 1;

export default class AgentBase extends EventEmitter {

    /**
     * @param {Object} config — agent-specific config
     * @param {string} config.type — agent type name (e.g. 'trend', 'grid', 'deleverage')
     * @param {string} config.subAccountId — trading account
     * @param {string} config.symbol — trading pair
     */
    constructor(config) {
        super();
        this.id = `agent_${Date.now()}_${_nextAgentId++}`;
        this.type = config.type || 'unknown';
        this.subAccountId = config.subAccountId;
        this.symbol = config.symbol;
        this.config = { ...config };
        this.status = 'created'; // created → active → stopped
        this.startedAt = null;
        this.stoppedAt = null;
        this.stopReason = null;

        // Managed scalper IDs
        this._managedScalpers = new Map(); // tag → scalperId

        // Internals
        this._priceHandler = null;
        this._tickCount = 0;
        this._lastBroadcastAt = 0;
    }

    // ── Lifecycle ──────────────────────────────────────────

    async start() {
        if (this.status === 'active') return;
        this.status = 'active';
        this.startedAt = Date.now();

        // Subscribe to price feed
        exchange.subscribeToPrices([this.symbol]);
        this._priceHandler = ({ symbol, mark }) => {
            if (symbol === this.symbol && this.status === 'active') {
                this._tickCount++;
                try {
                    this.onTick(symbol, mark, Date.now());
                } catch (err) {
                    console.error(`[Agent ${this.id}] onTick error:`, err.message);
                }
                // Throttled status broadcast every 5s
                const now = Date.now();
                if (now - this._lastBroadcastAt > 5000) {
                    this._lastBroadcastAt = now;
                    this._broadcastStatus();
                }
            }
        };
        exchange.on('price', this._priceHandler);

        console.log(`[Agent ${this.id}] Started: ${this.type} on ${this.symbol}`);
        this._broadcastStatus();
    }

    async stop(reason = 'manual') {
        if (this.status === 'stopped') return;
        this.status = 'stopped';
        this.stoppedAt = Date.now();
        this.stopReason = reason;

        // Unsubscribe from price feed
        if (this._priceHandler) {
            exchange.off('price', this._priceHandler);
            this._priceHandler = null;
        }

        // Kill all managed scalpers
        const killPromises = [];
        for (const [tag, scalperId] of this._managedScalpers) {
            console.log(`[Agent ${this.id}] Killing scalper ${scalperId} (${tag})`);
            killPromises.push(
                cancelScalperInternal(scalperId).catch(err =>
                    console.warn(`[Agent ${this.id}] Kill ${scalperId} error:`, err.message)
                )
            );
        }
        await Promise.allSettled(killPromises);
        this._managedScalpers.clear();

        console.log(`[Agent ${this.id}] Stopped: ${reason}`);
        this._broadcastStatus();
    }

    // ── Scalper Primitives ─────────────────────────────────

    /**
     * Spawn a scalper. Returns the scalper result object.
     * @param {string} tag — unique label for this scalper within the agent (e.g. 'trend_long')
     * @param {Object} opts — same options as startScalperInternal
     */
    async spawnScalper(tag, opts) {
        // Kill existing scalper with same tag first
        if (this._managedScalpers.has(tag)) {
            await this.killScalper(tag);
        }

        const result = await startScalperInternal({
            subAccountId: this.subAccountId,
            symbol: this.symbol,
            ...opts,
            _agentOwned: true,
        });

        this._managedScalpers.set(tag, result.scalperId);
        console.log(`[Agent ${this.id}] Spawned scalper ${result.scalperId} (${tag}): ${opts.startSide} ${this.symbol}`);
        this._broadcastStatus();
        return result;
    }

    /**
     * Kill a managed scalper by tag.
     */
    async killScalper(tag) {
        const scalperId = this._managedScalpers.get(tag);
        if (!scalperId) return;
        this._managedScalpers.delete(tag);
        await cancelScalperInternal(scalperId).catch(() => { });
        console.log(`[Agent ${this.id}] Killed scalper ${scalperId} (${tag})`);
        this._broadcastStatus();
    }

    /**
     * Check if a scalper with this tag is active.
     */
    hasScalper(tag) {
        return this._managedScalpers.has(tag);
    }

    // ── Position Helpers ───────────────────────────────────

    /**
     * Get current position for the agent's symbol from the risk book.
     * @returns {{ side: string, qty: number, entryPrice: number, notional: number } | null}
     */
    getPosition() {
        try {
            const bookEntry = riskEngine.book.getEntry(this.subAccountId);
            if (!bookEntry) return null;
            for (const [, pos] of bookEntry.positions) {
                if (pos.symbol === this.symbol && pos.quantity > 0) {
                    return {
                        side: pos.side,
                        qty: pos.quantity,
                        entryPrice: pos.entryPrice,
                        notional: pos.notional,
                        leverage: pos.leverage,
                    };
                }
            }
        } catch { /* ignore */ }
        return null;
    }

    /**
     * Get latest price for the symbol.
     */
    getPrice() {
        return exchange.getLatestPrice(this.symbol) || 0;
    }

    // ── Abstract Methods (subclasses MUST implement) ───────

    /**
     * Called on every price tick. Override in subclass.
     * @param {string} symbol
     * @param {number} price
     * @param {number} now — timestamp ms
     */
    onTick(symbol, price, now) {
        throw new Error('Agent subclass must implement onTick()');
    }

    // ── Status / Broadcast ─────────────────────────────────

    /**
     * Build agent-specific status object. Override to add custom fields.
     */
    getStatus() {
        return {
            agentId: this.id,
            type: this.type,
            subAccountId: this.subAccountId,
            symbol: this.symbol,
            status: this.status,
            startedAt: this.startedAt,
            stoppedAt: this.stoppedAt,
            stopReason: this.stopReason,
            tickCount: this._tickCount,
            managedScalpers: Object.fromEntries(this._managedScalpers),
            config: this.config,
        };
    }

    _broadcastStatus() {
        broadcast('agent_status', this.getStatus());
    }
}
