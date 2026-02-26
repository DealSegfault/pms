/**
 * Simplx UDS Bridge — Unix Domain Socket bridge between JS backend and C++ trading_oms_binance_service.
 *
 * Feature-gated by CPP_ENGINE_UDS=1.  When disabled, falls back to Redis-based simplx-bridge.js.
 *
 * Responsibilities:
 *  - Connect to C++ engine via Unix domain socket (NDJSON protocol)
 *  - Read C++ outbound events as newline-delimited JSON
 *  - Send commands to C++ as newline-delimited JSON
 *  - Health monitoring via ENGINE_HEARTBEAT detection
 *  - Bootstrap: seed C++ engine with accounts + rules + open positions from Prisma on startup
 *  - Keep C++ exchange-position context live via periodic Binance position snapshots
 *  - Auto-reconnect on disconnect with 1s backoff
 *
 * Public API is identical to SimplxBridge (simplx-bridge.js) — drop-in replacement.
 */

import net from 'net';
import { EventEmitter } from 'events';
import prisma from './db/prisma.js';
import { validateEvent, validateCommand } from './event-schema.js';
import { handleEngineReady, requestEngineState } from './engine-bootstrap.js';
import { log } from './structured-logger.js';
import exchange from './exchange.js';
import { toCppSymbol } from './routes/trading/cpp-symbol.js';
import { UDS_MUTATING_COMMAND_OPS_SET } from './uds-command-contract.js';

const UDS_PATH = process.env.CPP_UDS_PATH || '/tmp/pms-engine.sock';
const HEALTH_TIMEOUT_MS = 5000; // Unhealthy if no heartbeat for 5s
const RECONNECT_DELAY_MS = 1000;
const EXCHANGE_POSITION_SYNC_ENABLED = process.env.CPP_ENGINE_SYNC_EXCHANGE_POSITIONS !== '0';
const DEFAULT_EXCHANGE_POSITION_SYNC_INTERVAL_MS = 3000;
const parsedExchangePositionSyncMs = Number.parseInt(process.env.CPP_ENGINE_EXCHANGE_POSITION_SYNC_MS || `${DEFAULT_EXCHANGE_POSITION_SYNC_INTERVAL_MS}`, 10);
const EXCHANGE_POSITION_SYNC_INTERVAL_MS = Number.isFinite(parsedExchangePositionSyncMs) && parsedExchangePositionSyncMs > 0
    ? parsedExchangePositionSyncMs
    : DEFAULT_EXCHANGE_POSITION_SYNC_INTERVAL_MS;

function hasBinanceCredentials() {
    const key = process.env.BINANCE_API_KEY || process.env.api_key;
    const secret = process.env.BINANCE_API_SECRET || process.env.secret;
    return Boolean(key && secret);
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _bridge = null;

export function getSimplxBridge() {
    return _bridge;
}

// ── Bridge Class ─────────────────────────────────────────────────────────────

class SimplxUdsBridge extends EventEmitter {
    constructor() {
        super();
        this._socket = null;
        this._readBuffer = '';
        this._requestIdCounter = 100_000;
        this._idempotencyCounter = 0;
        this._lastEventTs = 0;
        this._healthy = false;
        this._initialized = false;
        this._bootstrapped = false;
        this._shuttingDown = false;
        this._reconnectTimer = null;
        /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this._pendingRequests = new Map();
        this._schemaErrors = 0;
        this._exchangePositionSyncTimer = null;
        this._exchangePositionSyncDebounceTimer = null;
        this._exchangePositionSyncInFlight = false;
        this._lastExchangePositionSyncTs = 0;
        this._cachedExchangePositions = [];
        this._exchangePositionKeys = new Set();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        console.log('[UDS Bridge] Initializing C++ engine bridge (Unix Domain Socket)...');
        console.log(`[UDS Bridge]   socket path: ${UDS_PATH}`);

        this._connect();
        this._startExchangePositionSyncLoop();
    }

    _connect() {
        if (this._shuttingDown) return;

        // Clean up any existing socket
        if (this._socket) {
            this._socket.removeAllListeners();
            this._socket.destroy();
            this._socket = null;
        }

        this._socket = net.createConnection({ path: UDS_PATH });

        this._socket.on('connect', () => {
            console.log('[UDS Bridge] ✓ Connected to C++ engine');
            this._readBuffer = '';
        });

        this._socket.on('data', (chunk) => {
            this._onData(chunk);
        });

        this._socket.on('error', (err) => {
            if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') {
                log.error('uds-bridge', 'SOCKET_ERROR', err.message, { code: err.code });
            }
        });

        this._socket.on('close', () => {
            if (this._healthy) {
                console.warn('[UDS Bridge] Connection lost');
                this._healthy = false;
            }
            this._readBuffer = '';

            // Reject all pending requests — the C++ engine is gone
            for (const [, pending] of this._pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error('CPP_ENGINE_DISCONNECTED'));
            }
            this._pendingRequests.clear();

            this._scheduleReconnect();
        });
    }

    _scheduleReconnect() {
        if (this._shuttingDown) return;
        if (this._reconnectTimer) return;

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, RECONNECT_DELAY_MS);
    }

    _onData(chunk) {
        this._readBuffer += chunk.toString('utf-8');

        let nlPos;
        while ((nlPos = this._readBuffer.indexOf('\n')) !== -1) {
            const line = this._readBuffer.slice(0, nlPos).trim();
            this._readBuffer = this._readBuffer.slice(nlPos + 1);

            if (line.length > 0) {
                this._onCppEvent(line);
            }
        }

        // Guard against buffer overflow
        if (this._readBuffer.length > 65536) {
            console.warn('[UDS Bridge] Read buffer overflow, clearing');
            this._readBuffer = '';
        }
    }

    async shutdown() {
        if (!this._initialized) return;
        console.log('[UDS Bridge] Shutting down...');
        this._shuttingDown = true;

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._exchangePositionSyncTimer) {
            clearInterval(this._exchangePositionSyncTimer);
            this._exchangePositionSyncTimer = null;
        }
        if (this._exchangePositionSyncDebounceTimer) {
            clearTimeout(this._exchangePositionSyncDebounceTimer);
            this._exchangePositionSyncDebounceTimer = null;
        }

        if (this._socket) {
            this._socket.removeAllListeners();
            this._socket.destroy();
            this._socket = null;
        }

        this._healthy = false;
        this._initialized = false;
        this._bootstrapped = false;
        this._exchangePositionSyncInFlight = false;
        this._lastExchangePositionSyncTs = 0;
        this._cachedExchangePositions = [];
        this._exchangePositionKeys.clear();

        // Reject all pending requests
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Bridge shutting down'));
        }
        this._pendingRequests.clear();

        console.log('[UDS Bridge] ✓ Shutdown complete');
    }

    // ── Public API ───────────────────────────────────────────────────────────

    isHealthy() {
        if (!this._initialized || !this._socket) return false;
        return this._healthy && (Date.now() - this._lastEventTs) < HEALTH_TIMEOUT_MS;
    }

    isEnabled() {
        return true;
    }

    isBootstrapped() {
        return this._bootstrapped;
    }

    /** @deprecated Phase 3: Use riskEngine.book instead */
    getCachedPositions(_subAccountId) { return null; }
    /** @deprecated Phase 3: Use riskEngine.book instead */
    getCachedMargin(_subAccountId) { return null; }
    /** @deprecated Phase 3: Use riskEngine.book instead */
    getCachedStats(_subAccountId) { return null; }

    getExchangePositionsSnapshot(maxAgeMs = EXCHANGE_POSITION_SYNC_INTERVAL_MS * 2) {
        const ageMs = this._lastExchangePositionSyncTs
            ? Date.now() - this._lastExchangePositionSyncTs
            : null;
        const fresh = ageMs != null && ageMs <= Math.max(0, maxAgeMs);
        return {
            positions: this._cachedExchangePositions.map((p) => ({ ...p })),
            fresh,
            ageMs,
        };
    }

    _startExchangePositionSyncLoop() {
        if (!EXCHANGE_POSITION_SYNC_ENABLED) return;
        if (this._exchangePositionSyncTimer) return;
        this._exchangePositionSyncTimer = setInterval(() => {
            this.syncExchangePositions({ reason: 'interval' }).catch((err) => {
                log.warn('uds-bridge', 'EXCHANGE_POSITION_SYNC_LOOP_FAILED', err.message);
            });
        }, EXCHANGE_POSITION_SYNC_INTERVAL_MS);
        if (typeof this._exchangePositionSyncTimer.unref === 'function') {
            this._exchangePositionSyncTimer.unref();
        }
    }

    _scheduleExchangePositionSync(delayMs = 200) {
        if (!EXCHANGE_POSITION_SYNC_ENABLED) return;
        if (this._exchangePositionSyncDebounceTimer) return;
        this._exchangePositionSyncDebounceTimer = setTimeout(() => {
            this._exchangePositionSyncDebounceTimer = null;
            this.syncExchangePositions({ reason: 'event' }).catch((err) => {
                log.warn('uds-bridge', 'EXCHANGE_POSITION_SYNC_EVENT_FAILED', err.message);
            });
        }, Math.max(0, delayMs));
        if (typeof this._exchangePositionSyncDebounceTimer.unref === 'function') {
            this._exchangePositionSyncDebounceTimer.unref();
        }
    }

    _normalizeExchangePositions(rawPositions) {
        const normalized = [];
        const seen = new Set();

        for (const pos of rawPositions || []) {
            const rawSymbol = toCppSymbol(pos?.symbol || pos?.info?.symbol || '');
            if (!rawSymbol) continue;

            const contracts = Number(pos?.contracts ?? pos?.positionAmt ?? pos?.quantity ?? 0);
            const qty = Math.abs(contracts);
            if (!Number.isFinite(qty) || qty <= 0) continue;

            let side = String(pos?.side || '').toUpperCase();
            if (side === 'LONG' || side === 'BUY') side = 'LONG';
            else if (side === 'SHORT' || side === 'SELL') side = 'SHORT';
            else side = contracts < 0 ? 'SHORT' : 'LONG';

            const key = `${rawSymbol}|${side}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const entryPrice = Number(pos?.entryPrice ?? pos?.info?.entryPrice ?? 0);
            const markPrice = Number(pos?.markPrice ?? pos?.info?.markPrice ?? 0);
            const notionalRaw = Number(pos?.notional ?? pos?.info?.notional ?? 0);
            const leverage = Number(pos?.leverage ?? pos?.info?.leverage ?? 1);
            const liquidationPrice = Number(pos?.liquidationPrice ?? pos?.info?.liquidationPrice ?? 0);
            const basis = Number.isFinite(markPrice) && markPrice > 0
                ? markPrice
                : (Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 0);
            const notional = Number.isFinite(notionalRaw) && Math.abs(notionalRaw) > 0
                ? Math.abs(notionalRaw)
                : (basis > 0 ? qty * basis : 0);

            normalized.push({
                symbol: rawSymbol,
                side,
                quantity: qty,
                entry_price: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 0,
                mark_price: Number.isFinite(markPrice) && markPrice > 0 ? markPrice : 0,
                notional: Number.isFinite(notional) && notional > 0 ? notional : 0,
                leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : 1,
                liquidation_price: Number.isFinite(liquidationPrice) && liquidationPrice > 0 ? liquidationPrice : 0,
                updated_at_ms: Date.now(),
            });
        }

        return normalized;
    }

    async syncExchangePositions({ reason = 'manual', force = false } = {}) {
        if (!EXCHANGE_POSITION_SYNC_ENABLED) {
            return { synced: false, reason: 'disabled' };
        }
        if (!hasBinanceCredentials()) {
            return { synced: false, reason: 'missing_credentials' };
        }
        if (!force && (!this.isHealthy() || !this._bootstrapped)) {
            return { synced: false, reason: 'engine_not_ready' };
        }
        if (this._exchangePositionSyncInFlight) {
            return { synced: false, reason: 'in_flight' };
        }

        this._exchangePositionSyncInFlight = true;
        try {
            let removedCount = 0;
            const rawPositions = await exchange.fetchPositions();
            const normalized = this._normalizeExchangePositions(rawPositions);
            const nextKeys = new Set(normalized.map((p) => `${p.symbol}|${p.side}`));

            for (const pos of normalized) {
                await this.sendCommand('upsert_exchange_position', pos);
            }

            for (const staleKey of this._exchangePositionKeys) {
                if (nextKeys.has(staleKey)) continue;
                const [symbol, side] = staleKey.split('|');
                if (!symbol || !side) continue;
                await this.sendCommand('upsert_exchange_position', {
                    symbol,
                    side,
                    quantity: 0,
                    updated_at_ms: Date.now(),
                });
                removedCount++;
            }

            this._cachedExchangePositions = normalized;
            this._exchangePositionKeys = nextKeys;
            this._lastExchangePositionSyncTs = Date.now();

            return {
                synced: true,
                reason,
                positionCount: normalized.length,
                removedCount,
                ts: this._lastExchangePositionSyncTs,
            };
        } catch (err) {
            log.warn('uds-bridge', 'EXCHANGE_POSITION_SYNC_FAILED', err.message, { reason });
            return { synced: false, reason: 'fetch_failed', error: err.message };
        } finally {
            this._exchangePositionSyncInFlight = false;
        }
    }

    /**
     * Send a command to the C++ engine via UDS (NDJSON line).
     */
    async sendCommand(op, payload = {}, opts = {}) {
        if (!this._socket || this._socket.destroyed) return 0;

        // Validate outbound command
        const cmdValidation = validateCommand(op, payload);
        if (!cmdValidation.valid) {
            log.warn('uds-bridge', 'CMD_SCHEMA_VIOLATION', `Command schema violation '${op}': ${cmdValidation.errors.join(', ')}`, { op, payload });
        }

        const requestId = opts.request_id ?? ++this._requestIdCounter;
        const msg = {
            request_id: requestId,
            op,
            ...payload,
        };

        // Envelope wrapping for mutating ops
        let wire;
        if (UDS_MUTATING_COMMAND_OPS_SET.has(op) && !opts.skipEnvelope) {
            const idempotencyKey = opts.idempotency_key ?? `js-bridge-${op}-${++this._idempotencyCounter}-${Date.now()}`;
            wire = JSON.stringify({
                schema_version: 1,
                request_id: requestId,
                idempotency_key: idempotencyKey,
                op,
                payload,
            });
        } else {
            wire = JSON.stringify(msg);
        }

        // Write NDJSON line to socket
        this._socket.write(wire + '\n', (err) => {
            if (err) {
                log.warn('uds-bridge', 'SEND_WRITE_ERROR', `sendCommand('${op}') write failed: ${err.message}`, { op, requestId });
            }
        });
        return requestId;
    }

    /**
     * Send command and await a terminal response from the C++ engine.
     */
    sendCommandAwait(op, payload = {}, timeoutMs = 15000) {
        if (!this._socket || !this.isHealthy()) {
            return Promise.reject(new Error('CPP_ENGINE_UNAVAILABLE'));
        }

        const requestId = ++this._requestIdCounter;
        const idempotencyKey = `js-write-${op}-${this._idempotencyCounter++}-${Date.now()}`;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingRequests.delete(requestId);
                reject(new Error('CPP_ENGINE_TIMEOUT'));
            }, timeoutMs);

            this._pendingRequests.set(requestId, { resolve, reject, timer });

            const envelope = JSON.stringify({
                schema_version: 1,
                request_id: requestId,
                idempotency_key: idempotencyKey,
                op,
                payload,
            });

            this._socket.write(envelope + '\n', (err) => {
                if (err) {
                    this._pendingRequests.delete(requestId);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    /** @deprecated Phase 3: Use riskEngine.book.getPositionsForAccount() instead */
    async requestPositions(_subAccountId) { return null; }
    /** @deprecated Phase 3: Use riskEngine.getAccountSummary() instead */
    async requestMargin(_subAccountId) { return null; }

    async bootstrapAccounts() {
        if (this._bootstrapped) return;
        if (!this.isHealthy()) {
            console.warn('[UDS Bridge] Cannot bootstrap — C++ engine not healthy');
            return;
        }

        console.log('[UDS Bridge] Bootstrapping accounts into C++ engine...');

        try {
            const accounts = await prisma.subAccount.findMany({
                where: { status: 'ACTIVE' },
                select: { id: true, currentBalance: true, maintenanceRate: true, status: true },
            });

            let accountCount = 0;
            for (const acct of accounts) {
                await this.sendCommand('upsert_account', {
                    sub_account_id: acct.id,
                    balance: acct.currentBalance,
                    maintenance_rate: acct.maintenanceRate ?? 0.005,
                    status: acct.status,
                });
                accountCount++;
            }

            const rules = await prisma.riskRule.findMany({
                where: { subAccountId: { not: null } },
                select: {
                    subAccountId: true,
                    maxLeverage: true,
                    maxNotionalPerTrade: true,
                    maxTotalExposure: true,
                    liquidationThreshold: true,
                },
            });

            let ruleCount = 0;
            for (const rule of rules) {
                await this.sendCommand('upsert_rule', {
                    sub_account_id: rule.subAccountId,
                    max_leverage: rule.maxLeverage ?? 100,
                    max_notional_per_trade: rule.maxNotionalPerTrade ?? 1_000_000,
                    max_total_exposure: rule.maxTotalExposure ?? 1_000_000,
                    liquidation_threshold: rule.liquidationThreshold ?? 0.9,
                    margin_ratio_limit: 0.98,
                });
                ruleCount++;
            }

            const openPositions = await prisma.virtualPosition.findMany({
                where: { status: 'OPEN' },
                select: {
                    subAccountId: true,
                    symbol: true,
                    side: true,
                    entryPrice: true,
                    quantity: true,
                    notional: true,
                    leverage: true,
                    margin: true,
                    liquidationPrice: true,
                },
            });

            let positionCount = 0;
            for (const pos of openPositions) {
                const subAccountId = String(pos.subAccountId || '').trim();
                const rawSymbol = toCppSymbol(pos.symbol);
                const side = String(pos.side || '').toUpperCase();
                const quantity = Number(pos.quantity || 0);
                if (!subAccountId || !rawSymbol || (side !== 'LONG' && side !== 'SHORT') || !(quantity > 0)) {
                    continue;
                }

                await this.sendCommand('upsert_position', {
                    sub_account_id: subAccountId,
                    symbol: rawSymbol,
                    side,
                    entry_price: Number(pos.entryPrice || 0),
                    quantity,
                    notional: Number(pos.notional || 0),
                    leverage: Number(pos.leverage || 1),
                    margin: Number(pos.margin || 0),
                    liquidation_price: Number(pos.liquidationPrice || 0),
                });
                positionCount++;
            }

            const exchangeSync = await this.syncExchangePositions({ reason: 'bootstrap', force: true });
            const exchangePositionCount = exchangeSync?.positionCount ?? 0;

            this._bootstrapped = true;
            console.log(`[UDS Bridge] ✓ Bootstrapped ${accountCount} account(s), ${ruleCount} rule(s), ${positionCount} open position(s), ${exchangePositionCount} exchange position(s)`);

            // Phase 3: Request full state snapshot from engine
            await requestEngineState(this);
        } catch (err) {
            log.error('uds-bridge', 'BOOTSTRAP_FAILED', err.message, { stack: err.stack });
        }
    }

    getStatus() {
        const credentialsConfigured = hasBinanceCredentials();
        return {
            enabled: true,
            writeEnabled: true,
            credentialsConfigured,
            transport: 'uds',
            socketPath: UDS_PATH,
            initialized: this._initialized,
            healthy: this.isHealthy(),
            writeReady: this.isHealthy() && credentialsConfigured,
            bootstrapped: this._bootstrapped,
            lastEventMs: this._lastEventTs ? Date.now() - this._lastEventTs : null,
            exchangePositionSyncEnabled: EXCHANGE_POSITION_SYNC_ENABLED,
            exchangePositionSyncMs: EXCHANGE_POSITION_SYNC_INTERVAL_MS,
            exchangePositionLastSyncMs: this._lastExchangePositionSyncTs ? Date.now() - this._lastExchangePositionSyncTs : null,
            exchangePositionCount: this._cachedExchangePositions.length,
            pendingRequests: this._pendingRequests.size,
            schemaVersion: 2,
            schemaErrors: this._schemaErrors,
        };
    }

    // ── Internal: Event Processing ──────────────────────────────────────────

    _onCppEvent(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (parseErr) {
            log.warn('uds-bridge', 'JSON_PARSE_ERROR', `Malformed C++ event: ${parseErr.message}`, {
                preview: String(raw).slice(0, 200),
            });
            return;
        }

        // Handle ENGINE_HEARTBEAT
        if (msg.type === 'ENGINE_HEARTBEAT') {
            this._lastEventTs = Date.now();
            if (!this._healthy) {
                this._healthy = true;
                console.log('[UDS Bridge] ✓ C++ engine is alive (heartbeat received)');
                if (!this._bootstrapped) {
                    this.bootstrapAccounts().catch((err) => {
                        console.warn(`[UDS Bridge] Deferred bootstrap failed: ${err.message}`);
                    });
                }
                this._scheduleExchangePositionSync(100);
            }
            return; // Don't emit heartbeats to consumers
        }

        // Handle ENGINE_READY
        if (msg.type === 'ENGINE_READY' || (msg.stream === 'ENGINE_READY')) {
            this._lastEventTs = Date.now();
            this._healthy = true;
            console.log('[UDS Bridge] ✓ C++ engine ready');
            // Phase 3: Replace state from engine snapshot
            handleEngineReady(msg);
            this.emit('engine_ready', msg);
            if (!this._bootstrapped) {
                this.bootstrapAccounts().catch((err) => {
                    console.warn(`[UDS Bridge] Deferred bootstrap failed: ${err.message}`);
                });
            }
            this._scheduleExchangePositionSync(100);
            return;
        }

        // Standard event processing (same as simplx-bridge.js)
        const stream = msg.stream || msg.type;
        if (!stream) return;

        // Schema validation (warn-only, never drop)
        const validation = validateEvent(msg);
        if (!validation.valid) {
            this._schemaErrors++;
            if (this._schemaErrors <= 50) {
                log.warn('uds-bridge', 'EVENT_SCHEMA_VIOLATION', `Schema violation on '${stream}': ${validation.errors.join(', ')}`, { stream, msg });
            }
        }

        this._lastEventTs = Date.now();
        if (!this._healthy) {
            this._healthy = true;
            console.log('[UDS Bridge] ✓ C++ engine is alive (event received)');
            if (!this._bootstrapped) {
                this.bootstrapAccounts().catch((err) => {
                    console.warn(`[UDS Bridge] Deferred bootstrap failed: ${err.message}`);
                });
            }
            this._scheduleExchangePositionSync(100);
        }

        // Route events to consumers (identical to simplx-bridge.js)
        const subAccountId = msg.sub_account_id;
        if (stream === 'positions_snapshot' && subAccountId) {
            this.emit('positions_snapshot', msg);
        } else if (stream === 'margin_snapshot' && subAccountId) {
            this.emit('margin_snapshot', msg);
        } else if (stream === 'stats_snapshot' && subAccountId) {
            this.emit('stats_snapshot', msg);
        } else if (stream === 'order_update') {
            this.emit('order_update', msg);
            this._resolvePendingRequest(msg);
            const status = String(msg.status || '').toUpperCase();
            if (status === 'FILLED' || status === 'PARTIALLY_FILLED' || status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
                this._scheduleExchangePositionSync(200);
            }
        } else if (stream === 'trade_execution') {
            this.emit('trade_execution', msg);
            this._scheduleExchangePositionSync(150);
        } else if (stream === 'position_update') {
            this.emit('position_update', msg);
        } else if (stream === 'error') {
            this.emit('cpp_error', msg);
            const errReqId = msg.request_id;
            if (errReqId != null && this._pendingRequests.has(errReqId)) {
                const pending = this._pendingRequests.get(errReqId);
                this._pendingRequests.delete(errReqId);
                clearTimeout(pending.timer);
                pending.reject(new Error(msg.code || msg.message || 'CPP_ENGINE_ERROR'));
            }
        }

        // ── Order-type progress/done streams → named events ──
        // These allow the WS server + page-level handlers to receive typed events.
        if (stream.startsWith('trail_') || stream.startsWith('chase_') ||
            stream.startsWith('scalper_') || stream.startsWith('twap_') ||
            stream.startsWith('smart_order_')) {
            this.emit(stream, msg);
        }

        // Generic event for debugging
        this.emit('event', msg);
    }

    _resolvePendingRequest(msg) {
        const reqId = msg.request_id;
        if (reqId == null) return;
        const pending = this._pendingRequests.get(reqId);
        if (!pending) return;

        const TERMINAL_STATUSES = new Set(['FILLED', 'REJECTED', 'CANCELED', 'EXPIRED', 'ERROR']);
        const status = String(msg.status || '').toUpperCase();
        if (!TERMINAL_STATUSES.has(status)) return;

        this._pendingRequests.delete(reqId);
        clearTimeout(pending.timer);

        if (status === 'REJECTED' || status === 'ERROR') {
            pending.reject(new Error(msg.reason || `Order ${status}`));
        } else {
            pending.resolve(msg);
        }
    }
}

// ── Module Export ─────────────────────────────────────────────────────────────

export async function initSimplxBridge() {
    if (_bridge) return _bridge;

    _bridge = new SimplxUdsBridge();
    await _bridge.init();
    return _bridge;
}

export async function shutdownSimplxBridge() {
    if (_bridge) {
        await _bridge.shutdown();
        _bridge = null;
    }
}

export default { getSimplxBridge, initSimplxBridge, shutdownSimplxBridge };
