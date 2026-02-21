/**
 * Shared Binance Futures Stream Manager (Singleton)
 *
 * Multiplexes ALL frontend Binance WebSocket subscriptions through a single
 * combined-stream connection: wss://fstream.binance.com/stream
 *
 * Features:
 *   - Reference-counted subscriptions (shared across pages)
 *   - Dynamic SUBSCRIBE / UNSUBSCRIBE via Binance combined stream protocol
 *   - Centralized reconnection with exponential backoff
 *   - Data-timeout health check (reconnect if no data for 30s)
 *   - Auto-close when all subscriptions are removed
 *
 * Usage:
 *   import { streams } from '../lib/binance-streams.js';
 *   const unsub = streams.subscribe('btcusdt@kline_5m', (data) => { ... });
 *   // later:
 *   unsub();
 */

const COMBINED_STREAM_URL = 'wss://fstream.binance.com/stream';
const HEALTH_CHECK_INTERVAL = 15000;  // 15s
const DATA_TIMEOUT = 30000;           // 30s without data → reconnect
const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

class BinanceStreamManager {
    constructor() {
        /** @type {WebSocket|null} */
        this._ws = null;

        /** Map<streamName, { refCount: number, callbacks: Set<Function> }> */
        this._subs = new Map();

        /** Currently subscribed streams on the server side */
        this._activeStreams = new Set();

        this._reconnectDelay = MIN_RECONNECT_DELAY;
        this._reconnectTimer = null;
        this._healthTimer = null;
        this._lastDataTs = 0;
        this._connecting = false;
        this._idCounter = 1;
        this._destroyed = false;
    }

    /**
     * Subscribe to a Binance stream.
     * @param {string} streamName - e.g. 'btcusdt@kline_5m', 'btcusdt@depth20@100ms'
     * @param {Function} callback - receives the parsed data object for that stream
     * @returns {Function} unsubscribe function
     */
    subscribe(streamName, callback) {
        // IMPORTANT: Binance stream names are case-sensitive (e.g. markPrice, aggTrade)
        // Do NOT lowercase — use exact name for subscribe AND for matching responses
        const name = streamName;

        if (!this._subs.has(name)) {
            this._subs.set(name, { refCount: 0, callbacks: new Set() });
        }

        const entry = this._subs.get(name);
        entry.refCount++;
        entry.callbacks.add(callback);

        // If this is a new stream, tell Binance to subscribe
        if (!this._activeStreams.has(name)) {
            this._ensureConnection();
            this._sendSubscribe([name]);
        } else {
            // Connection already has this stream — make sure WS is alive
            this._ensureConnection();
        }

        // Return unsubscribe function
        return () => {
            this._unsubscribe(name, callback);
        };
    }

    /**
     * Unsubscribe a specific callback from a stream.
     */
    _unsubscribe(streamName, callback) {
        const entry = this._subs.get(streamName);
        if (!entry) return;

        entry.callbacks.delete(callback);
        entry.refCount--;

        if (entry.refCount <= 0) {
            this._subs.delete(streamName);
            // Tell Binance to unsubscribe
            this._sendUnsubscribe([streamName]);
            this._activeStreams.delete(streamName);

            // If no more subscriptions, close the connection
            if (this._subs.size === 0) {
                this._close();
            }
        }
    }

    /**
     * Ensure the WebSocket connection is open.
     */
    _ensureConnection() {
        if (this._destroyed) return;
        if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
        if (this._connecting) return;

        this._connecting = true;
        clearTimeout(this._reconnectTimer);

        try {
            this._ws = new WebSocket(COMBINED_STREAM_URL);
        } catch (err) {
            console.error('[StreamMgr] Failed to create WebSocket:', err);
            this._connecting = false;
            this._scheduleReconnect();
            return;
        }

        this._ws.onopen = () => {
            console.log('[StreamMgr] ✓ Connected to Binance combined stream');
            this._connecting = false;
            this._reconnectDelay = MIN_RECONNECT_DELAY;
            this._lastDataTs = Date.now();
            this._startHealthCheck();

            // Re-subscribe all active streams
            const allStreams = [...this._subs.keys()];
            if (allStreams.length > 0) {
                this._sendSubscribe(allStreams);
            }
        };

        this._ws.onmessage = (evt) => {
            this._lastDataTs = Date.now();

            try {
                const msg = JSON.parse(evt.data);

                // Binance combined stream format: { stream: "btcusdt@kline_5m", data: {...} }
                if (msg.stream && msg.data) {
                    // Binance returns exact stream name as subscribed (case-sensitive)
                    const entry = this._subs.get(msg.stream);
                    if (entry) {
                        for (const cb of entry.callbacks) {
                            try {
                                cb(msg.data);
                            } catch (err) {
                                console.error(`[StreamMgr] Callback error for ${msg.stream}:`, err);
                            }
                        }
                    }
                }
                // Subscription confirmation messages (id + result) are ignored
            } catch { /* parse error, ignore */ }
        };

        this._ws.onerror = (err) => {
            console.warn('[StreamMgr] WebSocket error');
        };

        this._ws.onclose = () => {
            console.log('[StreamMgr] Disconnected');
            this._connecting = false;
            this._ws = null;
            this._activeStreams.clear();
            this._stopHealthCheck();

            // Only reconnect if we still have subscriptions
            if (this._subs.size > 0 && !this._destroyed) {
                this._scheduleReconnect();
            }
        };
    }

    /**
     * Send SUBSCRIBE message to Binance.
     */
    _sendSubscribe(streamNames) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Filter out already-active streams
        const toSub = streamNames.filter(s => !this._activeStreams.has(s));
        if (toSub.length === 0) return;

        this._ws.send(JSON.stringify({
            method: 'SUBSCRIBE',
            params: toSub,
            id: this._idCounter++,
        }));

        for (const s of toSub) {
            this._activeStreams.add(s);
        }
    }

    /**
     * Send UNSUBSCRIBE message to Binance.
     */
    _sendUnsubscribe(streamNames) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        this._ws.send(JSON.stringify({
            method: 'UNSUBSCRIBE',
            params: streamNames,
            id: this._idCounter++,
        }));
    }

    /**
     * Schedule a reconnect with exponential backoff.
     */
    _scheduleReconnect() {
        if (this._destroyed) return;
        clearTimeout(this._reconnectTimer);

        console.log(`[StreamMgr] Reconnecting in ${this._reconnectDelay}ms...`);
        this._reconnectTimer = setTimeout(() => {
            this._ensureConnection();
        }, this._reconnectDelay);

        // Exponential backoff
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }

    /**
     * Health check: if no data received for DATA_TIMEOUT ms, force reconnect.
     */
    _startHealthCheck() {
        this._stopHealthCheck();
        this._healthTimer = setInterval(() => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                const elapsed = Date.now() - this._lastDataTs;
                if (elapsed > DATA_TIMEOUT && this._subs.size > 0) {
                    console.warn(`[StreamMgr] No data for ${(elapsed / 1000).toFixed(0)}s, reconnecting...`);
                    this._ws.close();
                }
            }
        }, HEALTH_CHECK_INTERVAL);
    }

    _stopHealthCheck() {
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
    }

    /**
     * Close the connection cleanly.
     */
    _close() {
        this._stopHealthCheck();
        clearTimeout(this._reconnectTimer);

        if (this._ws) {
            this._ws.onclose = null; // prevent reconnect
            this._ws.close();
            this._ws = null;
        }

        this._activeStreams.clear();
        this._connecting = false;
    }

    /**
     * Destroy the manager (call on app teardown).
     */
    destroy() {
        this._destroyed = true;
        this._subs.clear();
        this._close();
    }

    /**
     * Get debug info about current subscriptions.
     */
    getDebugInfo() {
        return {
            connected: this._ws?.readyState === WebSocket.OPEN,
            subscriptions: [...this._subs.entries()].map(([name, entry]) => ({
                stream: name,
                refCount: entry.refCount,
                callbacks: entry.callbacks.size,
            })),
            activeStreams: [...this._activeStreams],
        };
    }
}

// Singleton
export const streams = new BinanceStreamManager();
