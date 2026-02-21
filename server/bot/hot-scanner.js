/**
 * Hot Pair Scanner — Port of v5/hot_scanner.py
 *
 * Periodically fetches all Binance perpetual tickers,
 * ranks by 24h abs change %, filters by spread & volume.
 * Results are cached and available for the scanner tab.
 */

import exchange from '../exchange.js';

// ── Configuration ──────────────────────────────
const SCAN_INTERVAL_MS = 30_000;   // Rescan every 30s
const TOP_N = 20;       // Return top N pairs
const MIN_QUOTE_VOLUME = 5_000_000;  // $5M minimum 24h volume
const STABLECOIN_BASES = new Set(['USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USDD']);

class HotScanner {
    constructor() {
        this._cache = [];
        this._lastScanTs = 0;
        this._scanning = false;
        this._timer = null;
        this._onScanCallbacks = [];  // event-driven consumers
    }

    /** Start periodic scanning */
    start() {
        if (this._timer) return;
        this._scan(); // immediate
        this._timer = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
        console.log('[HotScanner] Started periodic scanning');
    }

    /** Stop scanning */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** Get current hot pairs (cached) */
    getHotPairs() {
        return this._cache;
    }

    /** Get scan age in seconds */
    getScanAge() {
        return this._lastScanTs ? (Date.now() - this._lastScanTs) / 1000 : Infinity;
    }

    /**
     * Register a callback invoked after each successful scan.
     * @param {Function} cb - receives the hot pairs array
     * @returns {Function} unsubscribe function
     */
    onScanComplete(cb) {
        this._onScanCallbacks.push(cb);
        return () => {
            this._onScanCallbacks = this._onScanCallbacks.filter(fn => fn !== cb);
        };
    }

    /** Perform a scan */
    async _scan() {
        if (this._scanning) return;
        if (!exchange.ready) return;

        this._scanning = true;
        try {
            const tickers = await exchange.exchange.fetchTickers();
            const markets = exchange.markets;
            if (!Object.keys(markets).length) return;

            const candidates = [];

            for (const [symbol, ticker] of Object.entries(tickers)) {
                const market = markets[symbol];
                if (!market) continue;

                // Only linear USDT perpetuals
                if (!market.linear || !market.active || !market.swap) continue;
                if (!symbol.endsWith(':USDT')) continue;

                // Skip stablecoins
                const base = market.base || '';
                if (STABLECOIN_BASES.has(base)) continue;

                const changePct = parseFloat(ticker.percentage || 0);
                const quoteVolume = parseFloat(ticker.quoteVolume || 0);
                const bid = parseFloat(ticker.bid || 0);
                const ask = parseFloat(ticker.ask || 0);
                const last = parseFloat(ticker.last || 0);
                const mid = (bid + ask) / 2;
                const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;

                // Minimum volume filter
                if (quoteVolume < MIN_QUOTE_VOLUME) continue;

                candidates.push({
                    symbol,              // ccxt format: BTC/USDT:USDT
                    base,
                    changePct,
                    absChangePct: Math.abs(changePct),
                    quoteVolume,
                    last,
                    bid,
                    ask,
                    spreadBps,
                    high24h: parseFloat(ticker.high || 0),
                    low24h: parseFloat(ticker.low || 0),
                    fundingRate: ticker.info?.lastFundingRate
                        ? parseFloat(ticker.info.lastFundingRate)
                        : null,
                });
            }

            // Sort by absolute change % (biggest movers)
            candidates.sort((a, b) => b.absChangePct - a.absChangePct);

            // Take top N
            this._cache = candidates.slice(0, TOP_N);
            this._lastScanTs = Date.now();

            // Notify event-driven consumers
            for (const cb of this._onScanCallbacks) {
                try { cb(this._cache); } catch { }
            }
        } catch (err) {
            console.error('[HotScanner] Scan failed:', err.message);
        }
        this._scanning = false;
    }
}

// Singleton
const hotScanner = new HotScanner();
export default hotScanner;
