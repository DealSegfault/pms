/**
 * PriceService — Single source of truth for mark prices.
 *
 * Maintains a local price cache fed by exchange tick events.
 * Falls back to Redis price cache (shared with Python babysitter),
 * then REST when WS prices are stale.
 * Injectable exchange dependency for testability.
 */
import { getPriceCache } from '../redis.js';

// Price is considered stale after 10 seconds without a WS update
const PRICE_STALE_MS = 10_000;

export class PriceService {
    /**
     * @param {Object} exchange — exchange module (must have getLatestPrice, latestPrices, fetchTicker)
     */
    constructor(exchange) {
        this._exchange = exchange;
        /** @type {Map<string, number>} symbol → markPrice */
        this._latestPrices = new Map();
    }

    // ── Synchronous fast path ────────────────────────

    /** Store a price (called on every tick). */
    setPrice(symbol, mark) {
        this._latestPrices.set(symbol, mark);
    }

    /** Get the latest cached price (may be stale). */
    getPrice(symbol) {
        return this._latestPrices.get(symbol) || null;
    }

    /** Check if a symbol has any cached price. */
    hasPrice(symbol) {
        return this._latestPrices.has(symbol);
    }

    // ── Async with freshness check ───────────────────

    /**
     * Get a fresh mark price for a symbol.
     * Checks WS cache first, falls back to REST if stale.
     * Returns null if no price is available from any source.
     */
    async getFreshPrice(symbol) {
        const ex = this._exchange;

        // 1. Try WS cache
        const wsPrice = ex.getLatestPrice(symbol);
        const wsData = ex.latestPrices?.get(symbol);
        const wsTimestamp = wsData?.timestamp || 0;
        const now = Date.now();

        if (wsPrice && (now - wsTimestamp) < PRICE_STALE_MS) {
            return wsPrice;
        }

        // 2. Try Redis price cache (cross-system: may have been written by Python babysitter)
        try {
            const cached = await getPriceCache(symbol);
            if (cached && cached.mark && (now - cached.ts) < PRICE_STALE_MS) {
                this._latestPrices.set(symbol, cached.mark);
                return cached.mark;
            }
        } catch { }

        // 3. Fall back to REST
        try {
            const ticker = await ex.fetchTicker(symbol);
            const mark = ticker.mark || ticker.last;
            if (mark) return mark;
        } catch (err) {
            console.warn(`[PriceService] REST fallback failed for ${symbol}:`, err.message);
        }

        // 4. Nothing available
        return null;
    }

    /**
     * Resolve fresh prices for multiple symbols with de-duplication.
     * Returns Map<symbol, price|null>.
     */
    async getFreshPrices(symbols) {
        const uniqueSymbols = [...new Set((symbols || []).filter(Boolean))];
        if (uniqueSymbols.length === 0) return new Map();

        const entries = await Promise.all(
            uniqueSymbols.map(async (symbol) => [symbol, await this.getFreshPrice(symbol)]),
        );
        return new Map(entries);
    }

    /**
     * Calculate total unrealized PnL for a list of positions
     * using fresh prices (async — may REST-fetch).
     */
    async calcPositionsUpnl(positions) {
        if (!positions || positions.length === 0) return 0;

        const marks = await this.getFreshPrices(positions.map((p) => p.symbol));
        let total = 0;
        for (const pos of positions) {
            const mark = marks.get(pos.symbol);
            if (mark === null) continue;
            total += pos.side === 'LONG'
                ? (mark - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - mark) * pos.quantity;
        }
        return total;
    }
}
