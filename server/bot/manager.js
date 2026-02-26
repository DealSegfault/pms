/**
 * Bot Manager — Lifecycle management for per-user micro trading bots.
 *
 * Manages BotEngine instances, subscribes to Binance WebSocket feeds,
 * routes market data to active engines, and handles start/stop/config changes.
 */

import prisma from '../db/prisma.js';
import { WebSocket } from 'ws';
import BotEngine from './engine.js';
import riskEngine from '../risk/index.js';
import exchange from '../exchange.js';
import hotScanner from './hot-scanner.js';



const BINANCE_FUTURES_STREAM = 'wss://fstream.binance.com/stream';

// Default symbols to watch when user has no specific list
const DEFAULT_SYMBOLS = [
    'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT',
    'XRP/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT',
    'SUI/USDT:USDT', 'NEAR/USDT:USDT', 'PEPE/USDT:USDT', 'WIF/USDT:USDT',
];

class BotManager {
    constructor() {
        // Map<subAccountId, Map<symbol, BotEngine>>
        this._bots = new Map();

        // Reverse index: symbol → Set<subAccountId> for O(1) tick routing
        this._symbolToBots = new Map();

        // Combined WS connection for all bot data
        this._ws = null;
        this._wsReconnectTimer = null;
        this._subscribedStreams = new Set();

        // Track which symbols are needed across all users
        this._symbolRefCount = new Map(); // symbol -> count of users watching

        this._initialized = false;
        this._wsEmitter = null;

        // Periodic status broadcast timer
        this._statusBroadcastTimer = null;
        this._statusDirty = new Set(); // subAccountIds with pending changes

        // Scanner broadcast timer (replaced by event-driven push)
        this._scannerBroadcastTimer = null;

        // Event log buffer per sub-account (last 50 events)
        this._eventLogs = new Map(); // subAccountId -> Array<event>
    }

    /** Set the WS broadcast function for status updates to frontend */
    setWsEmitter(fn) {
        this._wsEmitter = fn;
        // Always start a scanner-only broadcast for hot pairs
        this._startScannerBroadcast();
    }

    /**
     * Initialize: restore any previously enabled bots from DB.
     */
    async initialize() {
        if (this._initialized) return;
        this._initialized = true;

        // Start the hot pair scanner (runs independently of bots)
        hotScanner.start();



        try {
            const activeBots = await prisma.botConfig.findMany({
                where: { enabled: true },
                include: { subAccount: true },
            });

            for (const config of activeBots) {
                if (config.subAccount?.status !== 'ACTIVE') continue;
                try {
                    await this.startBot(config.subAccountId);
                    console.log(`[BotManager] Restored bot for account ${config.subAccountId}`);
                } catch (err) {
                    console.error(`[BotManager] Failed to restore bot ${config.subAccountId}:`, err.message);
                }
            }

            console.log(`[BotManager] Initialized with ${this._bots.size} active bots`);
        } catch (err) {
            console.error('[BotManager] Init error:', err.message);
        }
    }

    /**
     * Start a bot for a sub-account.
     */
    async startBot(subAccountId) {
        // Load config from DB
        let config = await prisma.botConfig.findUnique({
            where: { subAccountId },
        });

        if (!config) {
            // Create default config
            config = await prisma.botConfig.create({
                data: { subAccountId, enabled: true },
            });
        }

        if (!config.enabled) {
            await prisma.botConfig.update({
                where: { subAccountId },
                data: { enabled: true },
            });
            config.enabled = true;
        }

        // Determine symbols to trade
        const symbols = this._getSymbols(config);

        // Create engine instances per symbol
        const engines = new Map();
        for (const sym of symbols) {
            const eventCb = (event) => this._emitEvent(subAccountId, event);
            const engine = new BotEngine(sym, subAccountId, config, riskEngine, exchange, eventCb);
            engines.set(sym, engine);

            // Track symbol ref count
            const count = this._symbolRefCount.get(sym) || 0;
            this._symbolRefCount.set(sym, count + 1);
        }

        this._bots.set(subAccountId, engines);

        // Populate symbol → subAccount reverse index
        for (const sym of symbols) {
            if (!this._symbolToBots.has(sym)) this._symbolToBots.set(sym, new Set());
            this._symbolToBots.get(sym).add(subAccountId);
        }

        // Ensure WS is connected and subscribed
        await this._ensureWebSocket();
        this._updateSubscriptions();

        console.log(`[BotManager] Started bot for ${subAccountId} with ${symbols.length} symbols`);

        // Broadcast status
        this._broadcastStatus(subAccountId);

        // Start periodic broadcast if not already running
        this._startStatusBroadcast();
    }

    /**
     * Stop a bot for a sub-account.
     */
    async stopBot(subAccountId, closePositions = false) {
        const engines = this._bots.get(subAccountId);
        if (!engines) return;

        // Shutdown all engines
        for (const [sym, engine] of engines) {
            await engine.shutdown(closePositions);

            // Decrement ref count
            const count = (this._symbolRefCount.get(sym) || 1) - 1;
            if (count <= 0) {
                this._symbolRefCount.delete(sym);
            } else {
                this._symbolRefCount.set(sym, count);
            }
        }

        this._bots.delete(subAccountId);

        // Clean up symbol → subAccount reverse index
        for (const [sym] of engines) {
            const set = this._symbolToBots.get(sym);
            if (set) {
                set.delete(subAccountId);
                if (set.size === 0) this._symbolToBots.delete(sym);
            }
        }

        // Update DB
        await prisma.botConfig.updateMany({
            where: { subAccountId },
            data: { enabled: false },
        });

        // Update subscriptions (some symbols may no longer be needed)
        this._updateSubscriptions();

        // Close WS if no bots active
        if (this._bots.size === 0 && this._ws) {
            this._ws.close();
            this._ws = null;
        }

        // Stop periodic broadcast if no bots remain
        if (this._bots.size === 0) {
            this._stopStatusBroadcast();
        }

        console.log(`[BotManager] Stopped bot for ${subAccountId}`);
        this._broadcastStatus(subAccountId);
    }

    /**
     * Reconfigure a running bot (hot-reload config).
     */
    async reconfigure(subAccountId) {
        const wasRunning = this._bots.has(subAccountId);
        if (wasRunning) {
            await this.stopBot(subAccountId, false);
        }

        const config = await prisma.botConfig.findUnique({
            where: { subAccountId },
        });

        if (config?.enabled) {
            await this.startBot(subAccountId);
        }
    }

    /**
     * Get status for a sub-account's bot.
     */
    getStatus(subAccountId) {
        const engines = this._bots.get(subAccountId);
        if (!engines) {
            return {
                active: false,
                pairs: 0,
                engines: [],
                totalPnl: 0,
                totalTrades: 0,
            };
        }

        const engineStatuses = [];
        let totalPnl = 0;
        let totalTrades = 0;

        for (const [sym, engine] of engines) {
            const status = engine.getStatus();
            engineStatuses.push(status);
            totalPnl += status.totalPnl + status.unrealizedPnlUsd;
            totalTrades += status.totalTrades;
        }

        return {
            active: true,
            pairs: engines.size,
            engines: engineStatuses,
            totalPnl,
            totalTrades,
        };
    }

    /**
     * Get list of all active bot sub-account IDs.
     */
    getActiveBots() {
        return [...this._bots.keys()];
    }

    // ─────────────────────────────────────
    // WEBSOCKET MANAGEMENT
    // ─────────────────────────────────────

    async _ensureWebSocket() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
        if (this._ws && this._ws.readyState === WebSocket.CONNECTING) return;

        return new Promise((resolve) => {
            const streams = this._buildStreamList();
            if (!streams.length) { resolve(); return; }

            const url = `${BINANCE_FUTURES_STREAM}?streams=${streams.join('/')}`;
            this._ws = new WebSocket(url);

            this._ws.on('open', () => {
                console.log(`[BotManager] WS connected with ${streams.length} streams`);
                this._subscribedStreams = new Set(streams);
                resolve();
            });

            this._ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.data) {
                        this._handleWsMessage(msg.stream, msg.data);
                    }
                } catch { }
            });

            this._ws.on('close', () => {
                console.log('[BotManager] WS disconnected');
                this._ws = null;
                // Reconnect if we still have active bots
                if (this._bots.size > 0) {
                    clearTimeout(this._wsReconnectTimer);
                    this._wsReconnectTimer = setTimeout(() => this._ensureWebSocket(), 3000);
                }
            });

            this._ws.on('error', (err) => {
                console.error('[BotManager] WS error:', err.message);
            });
        });
    }

    _buildStreamList() {
        const symbols = [...this._symbolRefCount.keys()];
        const streams = [];

        for (const sym of symbols) {
            const raw = this._toRawSymbol(sym).toLowerCase();
            streams.push(`${raw}@aggTrade`);
            streams.push(`${raw}@bookTicker`);
        }

        return streams;
    }

    _updateSubscriptions() {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        const needed = new Set(this._buildStreamList());
        const current = this._subscribedStreams;

        // Find streams to subscribe
        const toSubscribe = [...needed].filter(s => !current.has(s));
        // Find streams to unsubscribe
        const toUnsubscribe = [...current].filter(s => !needed.has(s));

        if (toSubscribe.length > 0) {
            this._ws.send(JSON.stringify({
                method: 'SUBSCRIBE',
                params: toSubscribe,
                id: Date.now(),
            }));
            toSubscribe.forEach(s => this._subscribedStreams.add(s));
        }

        if (toUnsubscribe.length > 0) {
            this._ws.send(JSON.stringify({
                method: 'UNSUBSCRIBE',
                params: toUnsubscribe,
                id: Date.now() + 1,
            }));
            toUnsubscribe.forEach(s => this._subscribedStreams.delete(s));
        }
    }

    _handleWsMessage(stream, data) {
        const now = Date.now() / 1000;

        if (stream.endsWith('@aggTrade')) {
            const symbol = this._fromRawSymbol(data.s);
            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const isBuyerMaker = data.m;
            const ts = data.T / 1000;

            // O(watchers) fan-out via symbol index
            const watchers = this._symbolToBots.get(symbol);
            if (watchers) {
                for (const accountId of watchers) {
                    const engine = this._bots.get(accountId)?.get(symbol);
                    if (engine) engine.onTrade(price, qty, isBuyerMaker, ts);
                }
            }
        } else if (stream.endsWith('@bookTicker')) {
            const symbol = this._fromRawSymbol(data.s);
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);
            const bidQty = parseFloat(data.B);
            const askQty = parseFloat(data.A);

            // O(watchers) fan-out via symbol index
            const watchers = this._symbolToBots.get(symbol);
            if (watchers) {
                for (const accountId of watchers) {
                    const engine = this._bots.get(accountId)?.get(symbol);
                    if (engine) {
                        engine.onBook(bid, ask, bidQty, askQty, now).catch(err => {
                            console.error(`[BotManager] Engine error ${symbol}:`, err.message);
                        });
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────

    _getSymbols(config) {
        if (config.symbols && config.symbols.trim()) {
            return config.symbols.split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => this._normalizeToCcxt(s));
        }
        return DEFAULT_SYMBOLS;
    }

    /** Convert 'BTC/USDT:USDT' → 'btcusdt' */
    _toRawSymbol(ccxtSymbol) {
        return ccxtSymbol.replace(/\/|:/g, '').toUpperCase();
    }

    /** Convert 'BTCUSDT' → 'BTC/USDT:USDT' */
    _fromRawSymbol(raw) {
        // Handle futures symbols that end with USDT
        const base = raw.replace(/USDT$/, '');
        return `${base}/USDT:USDT`;
    }

    /** Normalize various formats to ccxt: 'BTCUSDT' → 'BTC/USDT:USDT' */
    _normalizeToCcxt(sym) {
        if (sym.includes('/')) return sym;
        const base = sym.replace(/USDT$/i, '');
        return `${base.toUpperCase()}/USDT:USDT`;
    }

    _broadcastStatus(subAccountId) {
        if (this._wsEmitter) {
            const status = this.getStatus(subAccountId);
            // Include recent event log + hot pairs
            const events = this._eventLogs.get(subAccountId) || [];
            const hotPairs = hotScanner.getHotPairs();

            this._wsEmitter('bot_status', {
                subAccountId, ...status, events, hotPairs,
            });
        }
    }

    /**
     * Emit a bot event (entry, exit, error, etc.) to the frontend.
     */
    _emitEvent(subAccountId, event) {
        // Store in buffer
        if (!this._eventLogs.has(subAccountId)) {
            this._eventLogs.set(subAccountId, []);
        }
        const log = this._eventLogs.get(subAccountId);
        log.push({ ...event, ts: event.ts || Date.now() / 1000 });
        // Keep last 100 events
        if (log.length > 100) log.splice(0, log.length - 100);

        // Mark this account as needing a status broadcast
        this._statusDirty.add(subAccountId);

        // Push immediately via WS
        if (this._wsEmitter) {
            this._wsEmitter('bot_event', { subAccountId, event });
        }
    }

    /**
     * Start periodic status broadcast (every 2s) for all active bots.
     */
    _startStatusBroadcast() {
        if (this._statusBroadcastTimer) return;
        this._statusBroadcastTimer = setInterval(() => {
            // Only broadcast for accounts with state changes (dirty flag)
            if (this._statusDirty.size === 0) return;
            for (const accountId of this._statusDirty) {
                this._broadcastStatus(accountId);
            }
            this._statusDirty.clear();
        }, 2000);
    }

    /**
     * Stop periodic status broadcast.
     */
    _stopStatusBroadcast() {
        if (this._statusBroadcastTimer) {
            clearInterval(this._statusBroadcastTimer);
            this._statusBroadcastTimer = null;
        }
    }

    /**
     * Start scanner-only broadcast (sends hot pairs even when no bots are running).
     * Runs at lower frequency (5s) to provide market-wide hot pair data.
     */
    _startScannerBroadcast() {
        if (this._scannerBroadcastTimer) return;
        // Event-driven: broadcast only when scanner produces new results
        this._scannerBroadcastTimer = hotScanner.onScanComplete((hotPairs) => {
            // Only broadcast if no per-bot broadcast is running
            // (to avoid duplicate hot pair payloads)
            if (this._bots.size === 0 && this._wsEmitter) {
                this._wsEmitter('bot_status', {
                    subAccountId: null,
                    active: false,
                    pairs: 0,
                    engines: [],
                    totalPnl: 0,
                    totalTrades: 0,
                    events: [],
                    hotPairs,
                });
            }
        });
    }

    /**
     * Graceful shutdown.
     */
    async shutdown() {
        console.log('[BotManager] Shutting down...');
        this._stopStatusBroadcast();
        if (this._scannerBroadcastTimer) {
            // _scannerBroadcastTimer is now an unsubscribe function from onScanComplete
            if (typeof this._scannerBroadcastTimer === 'function') {
                this._scannerBroadcastTimer();
            } else {
                clearInterval(this._scannerBroadcastTimer);
            }
            this._scannerBroadcastTimer = null;
        }
        hotScanner.stop();
        for (const [accountId] of this._bots) {
            await this.stopBot(accountId, false);
        }
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        clearTimeout(this._wsReconnectTimer);
    }
}

// Singleton
const botManager = new BotManager();
export default botManager;
export { BotManager };
