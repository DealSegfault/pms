/**
 * Python Bridge — WebSocket client that connects to the v7 Python bot's
 * bridge API and relays real-time status/events to the platform frontend.
 *
 * Connects to ws://localhost:7700/ws/stream and translates Python status_dict
 * fields into the bot_status format expected by the frontend.
 */

import { WebSocket } from 'ws';

const BRIDGE_URL = process.env.BRIDGE_URL || 'ws://localhost:7700/ws/stream';
const BRIDGE_REST = process.env.BRIDGE_REST || 'http://localhost:7700';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

class PythonBridge {
    constructor() {
        this._ws = null;
        this._wsEmitter = null;
        this._connected = false;
        this._reconnectMs = RECONNECT_BASE_MS;
        this._reconnectTimer = null;
        this._lastStatus = null;
        this._started = false;
    }

    /**
     * Start the bridge — connects to the Python bot's WS endpoint.
     * @param {Function} wsEmitter — function(type, payload) to broadcast to frontend
     */
    start(wsEmitter) {
        this._wsEmitter = wsEmitter;
        this._started = true;
        this._connect();
        console.log(`[PythonBridge] Starting — target: ${BRIDGE_URL}`);
    }

    /**
     * Stop the bridge and close the WebSocket.
     */
    stop() {
        this._started = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._connected = false;
        console.log('[PythonBridge] Stopped');
    }

    /**
     * Whether the bridge is currently connected to the Python bot.
     */
    isConnected() {
        return this._connected;
    }

    /**
     * Get the last received status from the Python bot.
     */
    getStatus() {
        return this._lastStatus;
    }

    /**
     * Send a control command to the Python bot.
     * @param {Object} command — e.g. {action: 'pause_symbol', symbol: 'XYZUSDT'}
     */
    async sendControl(command) {
        try {
            const resp = await fetch(`${BRIDGE_REST}/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(command),
            });
            return await resp.json();
        } catch (err) {
            console.error('[PythonBridge] Control command failed:', err.message);
            return { ok: false, error: err.message };
        }
    }

    // ─── Internal ─────────────────────────────────────────

    _connect() {
        if (!this._started) return;
        if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        try {
            this._ws = new WebSocket(BRIDGE_URL);
        } catch (err) {
            console.error('[PythonBridge] WS creation failed:', err.message);
            this._scheduleReconnect();
            return;
        }

        this._ws.on('open', () => {
            this._connected = true;
            this._reconnectMs = RECONNECT_BASE_MS;
            console.log('[PythonBridge] ✓ Connected to Python v7 bot');
        });

        this._ws.on('message', (raw) => {
            try {
                // Python's json module outputs Infinity/NaN as literal tokens
                // which are not valid JSON — replace with null before parsing
                const cleaned = raw.toString().replace(/\bInfinity\b/g, 'null').replace(/\bNaN\b/g, 'null');
                const msg = JSON.parse(cleaned);
                this._handleMessage(msg);
            } catch (err) {
                console.error('[PythonBridge] Parse error:', err.message);
            }
        });

        this._ws.on('close', () => {
            this._connected = false;
            this._ws = null;
            if (this._started) {
                this._scheduleReconnect();
            }
        });

        this._ws.on('error', (err) => {
            // Suppress ECONNREFUSED noise when bot isn't running
            if (err.code !== 'ECONNREFUSED') {
                console.error('[PythonBridge] WS error:', err.message);
            }
        });
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, this._reconnectMs);
        // Exponential backoff, capped
        this._reconnectMs = Math.min(this._reconnectMs * 1.5, RECONNECT_MAX_MS);
    }

    /**
     * Handle incoming messages from the Python bridge WS.
     */
    _handleMessage(msg) {
        if (msg.type === 'status') {
            this._lastStatus = msg.data;
            this._broadcastStatus(msg.data);
        } else if (msg.type === 'event') {
            this._broadcastEvent(msg.data);
        }
    }

    /**
     * Translate Python status into the frontend's bot_status format and broadcast.
     */
    _broadcastStatus(pyStatus) {
        if (!this._wsEmitter) return;

        // Map Python engines to JS engine format
        const engines = (pyStatus.engines || []).map(e => this._mapEngine(e));

        const payload = {
            subAccountId: null, // shared model — not tied to a specific sub-account
            source: 'v7',
            active: true,
            pairs: pyStatus.pairs || 0,
            engines,
            totalPnl: pyStatus.total_pnl_usd || 0,
            totalPnlBps: pyStatus.total_pnl_bps || 0,
            totalTrades: pyStatus.total_trades || 0,
            totalFees: pyStatus.total_fees || 0,
            winPct: pyStatus.win_pct || 0,
            portfolioNotional: pyStatus.portfolio_notional || 0,
            maxTotalNotional: pyStatus.max_total_notional || 0,
            portfolioUtilPct: pyStatus.portfolio_utilization_pct || 0,
            activeGrids: pyStatus.active_grids || 0,
            uptimeSec: pyStatus.uptime_sec || 0,
            sessionId: pyStatus.session_id || '',
            live: pyStatus.live || false,
            events: [],
            hotPairs: [], // hot pairs come from the JS scanner
        };

        this._wsEmitter('bot_status', payload);
    }

    /**
     * Translate a Python event into the frontend's bot_event format and broadcast.
     */
    _broadcastEvent(pyEvent) {
        if (!this._wsEmitter) return;

        this._wsEmitter('bot_event', {
            subAccountId: null,
            source: 'v7',
            event: {
                type: pyEvent.action || 'unknown',
                symbol: pyEvent.symbol || '',
                price: pyEvent.price || 0,
                qty: pyEvent.qty || 0,
                notional: pyEvent.notional || 0,
                pnlBps: pyEvent.pnl_bps || 0,
                pnlUsd: pyEvent.pnl_usd || 0,
                layerIdx: pyEvent.layer_idx || 0,
                layers: pyEvent.layers || 0,
                reason: pyEvent.reason || '',
                spreadBps: pyEvent.spread_bps || 0,
                ts: pyEvent.event_ts || Date.now() / 1000,
            },
        });
    }

    /**
     * Map a single Python status_dict engine to the JS bot_status engine format.
     *
     * Python keys → JS keys:
     *   symbol            → symbol
     *   layers            → gridDepth
     *   total_notional    → totalExposure
     *   unrealized_bps    → unrealizedPnlBps
     *   unrealized_usd    → unrealizedPnlUsd
     *   realized_bps      → totalPnlBps
     *   realized_usd      → totalPnl
     *   trades            → totalTrades
     *   spread_bps        → spreadBps
     *   median_spread_bps → medianSpreadBps
     *   vol_drift_mult    → volDrift
     *   recovery_debt_usd → recoveryDebt
     *   etc.
     */
    _mapEngine(e) {
        return {
            source: 'v7',
            symbol: e.symbol || '',
            state: e.layers > 0 ? 'ACTIVE' : 'IDLE',
            gridDepth: e.layers || 0,
            maxLayers: e.max_layers || 8,
            dynamicMaxLayers: e.dynamic_max_layers || 8,
            avgEntry: e.avg_entry || 0,
            totalExposure: e.total_notional || 0,
            unrealizedPnlBps: e.unrealized_bps || 0,
            unrealizedPnlUsd: e.unrealized_usd || 0,
            totalPnlBps: e.realized_bps || 0,
            totalPnl: e.realized_usd || 0,
            totalFees: e.total_fees || 0,
            totalTrades: e.trades || 0,
            winRate: e.win_rate || 0,
            spreadBps: e.spread_bps || 0,
            medianSpreadBps: e.median_spread_bps || 0,
            tpTargetBps: e.tp_target_bps || 0,
            edgeBps: e.edge_bps || 0,
            edgeLcbBps: e.edge_lcb_bps || 0,
            edgeRequiredBps: e.edge_required_bps || 0,
            entryEnabled: e.entry_enabled !== false,
            symbolNotionalCap: e.symbol_notional_cap || 0,
            recoveryDebt: e.recovery_debt_usd || 0,
            recoveryExitHurdleBps: e.recovery_exit_hurdle_bps || 0,
            circuitBreaker: e.circuit_breaker || false,
            volDrift: e.vol_drift_mult || 0,
            volBaselineBps: e.vol_baseline_bps || 0,
            volLiveBps: e.vol_live_bps || 0,
            pending: e.pending || false,
            live: e.live || false,
            // Recovery metrics
            recoveryMode: e.recovery_mode || 'flat',
            recoveryVelocityBpsHr: e.recovery_velocity_bps_hr || 0,
            recoveryEtaHours: e.recovery_eta_hours || 0,
            sessionRpnl: e.session_rpnl || 0,
            sessionTrades: e.session_trades || 0,
            recoveryAdds1h: e.recovery_adds_1h || 0,
        };
    }
}

// Singleton
const pythonBridge = new PythonBridge();
export default pythonBridge;
export { PythonBridge };
