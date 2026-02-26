/**
 * Market Data Routes — PROXY VERSION
 *
 * Symbols, prices, klines, tickers.
 * No account-ownership checks needed.
 *
 * Exchange-dependent endpoints use direct Binance REST or Redis price cache.
 * Heavy endpoints (klines, tickers) proxy directly to Binance FAPI.
 */
import { Router } from 'express';
import { getPriceCache, getAllPriceCaches } from '../../redis.js';

const router = Router();

let tickerCache = { data: null, ts: 0 };

// In-memory market info cache (populated from Binance exchangeInfo)
let marketsCache = null;
let marketsCacheTs = 0;
const MARKETS_TTL_MS = 300_000; // 5 min

async function getMarkets() {
    const now = Date.now();
    if (marketsCache && (now - marketsCacheTs) < MARKETS_TTL_MS) return marketsCache;
    try {
        const resp = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const data = await resp.json();
        const markets = {};
        for (const s of data.symbols) {
            if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;
            if (s.status !== 'TRADING') continue;
            const ccxtSymbol = `${s.baseAsset}/USDT:USDT`;
            markets[ccxtSymbol] = {
                id: s.symbol,
                base: s.baseAsset,
                quote: 'USDT',
                active: true,
                linear: true,
                swap: true,
                precision: {
                    price: parseInt(s.pricePrecision) || 2,
                    amount: parseInt(s.quantityPrecision) || 3,
                },
                limits: {
                    cost: { min: parseFloat(s.filters?.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5) },
                    amount: {
                        min: parseFloat(s.filters?.find(f => f.filterType === 'LOT_SIZE')?.minQty || 0.001),
                        max: parseFloat(s.filters?.find(f => f.filterType === 'LOT_SIZE')?.maxQty || null),
                    },
                },
                contractSize: 1,
            };
        }
        marketsCache = markets;
        marketsCacheTs = now;
        return markets;
    } catch (err) {
        console.error('[MarketData] Failed to fetch exchangeInfo:', err.message);
        return marketsCache || {};
    }
}

// GET /api/trade/symbols/search - Search symbols
router.get('/symbols/search', async (req, res) => {
    try {
        const q = (req.query.q || '').toUpperCase();
        const markets = await getMarkets();
        const symbols = Object.keys(markets);

        if (!q) {
            // Popular top 20 by alphabetical
            const popular = symbols.slice(0, 20);
            const prices = await getAllPriceCaches();
            const tickers = popular.map(s => ({
                symbol: s,
                base: markets[s].base,
                price: prices[s]?.mark || null,
            }));
            return res.json(tickers);
        }

        const results = symbols
            .filter(s => s.includes(q) || markets[s].base.includes(q) || markets[s].id.includes(q))
            .slice(0, 30)
            .map(s => ({ symbol: s, base: markets[s].base, id: markets[s].id }));
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/symbol-info/:symbol - Trading rules
router.get('/symbol-info/:symbol', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.symbol);
        const markets = await getMarkets();
        const market = markets[symbol];
        if (!market) return res.status(404).json({ error: 'Symbol not found' });

        res.json({
            symbol,
            minNotional: market.limits?.cost?.min || 5,
            minQty: market.limits?.amount?.min || 0.001,
            maxQty: market.limits?.amount?.max || null,
            pricePrecision: market.precision?.price || 2,
            qtyPrecision: market.precision?.amount || 3,
            contractSize: market.contractSize || 1,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/price/:symbol - Current price (from Redis cache or Binance REST)
router.get('/price/:symbol', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.symbol);

        // Try Redis price cache first (written by Python MarketDataService)
        const cached = await getPriceCache(symbol);
        if (cached && cached.mark) {
            return res.json({
                symbol,
                mark: cached.mark,
                last: cached.mark,
                source: 'redis',
                timestamp: Date.now(),
            });
        }

        // Fallback: direct Binance REST
        const markets = await getMarkets();
        const market = markets[symbol];
        const binanceId = market?.id || symbol.replace('/', '').replace(':USDT', '');
        const resp = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${binanceId}`);
        const data = await resp.json();
        res.json({
            symbol,
            mark: parseFloat(data.price),
            last: parseFloat(data.price),
            source: 'rest',
            timestamp: Date.now(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/klines - Proxy to Binance FAPI klines (avoids CORS)
router.get('/klines', async (req, res) => {
    try {
        const { symbol, interval, limit, startTime, endTime } = req.query;
        if (!symbol || !interval) {
            return res.status(400).json({ error: 'symbol and interval are required' });
        }
        const clean = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
        const binanceSymbol = clean.endsWith('USDT') ? clean : clean + 'USDT';

        // 1s special case — aggregate from aggTrades
        if (interval === '1s') {
            const now = Date.now();
            const windowMs = 15 * 60 * 1000;
            const since = startTime ? parseInt(startTime) : now - windowMs;

            const aggParams = new URLSearchParams({
                symbol: binanceSymbol,
                startTime: since,
                limit: '1000',
            });
            if (endTime) aggParams.set('endTime', endTime);

            const aggResp = await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?${aggParams}`);
            const trades = await aggResp.json();

            if (!Array.isArray(trades) || trades.length === 0) {
                return res.json([]);
            }

            const bars = new Map();
            for (const t of trades) {
                const ts = Math.floor(t.T / 1000) * 1000;
                const price = parseFloat(t.p);
                const qty = parseFloat(t.q);
                if (!bars.has(ts)) {
                    bars.set(ts, { o: price, h: price, l: price, c: price, v: qty });
                } else {
                    const b = bars.get(ts);
                    b.h = Math.max(b.h, price);
                    b.l = Math.min(b.l, price);
                    b.c = price;
                    b.v += qty;
                }
            }

            const result = [...bars.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([ts, b]) => [
                    ts,
                    String(b.o), String(b.h), String(b.l), String(b.c),
                    String(b.v),
                    ts + 999,
                    String(b.v * b.c),
                    0, '0', '0', '0',
                ]);

            return res.json(result);
        }

        // Standard klines
        const params = new URLSearchParams({
            symbol: binanceSymbol,
            interval,
            limit: limit || '500',
        });
        if (startTime) params.set('startTime', startTime);
        if (endTime) params.set('endTime', endTime);

        const resp = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/symbols/all - Full perp list
router.get('/symbols/all', async (req, res) => {
    try {
        const markets = await getMarkets();
        const perps = Object.keys(markets)
            .filter(s => s.endsWith(':USDT') && markets[s].active)
            .map(s => ({
                symbol: s,
                base: markets[s].base,
                id: markets[s].id,
            }));
        res.json(perps);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/symbols/tickers - Symbols with 24h change + funding rate
router.get('/symbols/tickers', async (req, res) => {
    try {
        const now = Date.now();
        if (tickerCache.data && now - tickerCache.ts < 60000) {
            return res.json(tickerCache.data);
        }

        const markets = await getMarkets();
        const perps = Object.keys(markets)
            .filter(s => s.endsWith(':USDT') && markets[s].active);

        const [tickerResp, fundingResp] = await Promise.all([
            fetch('https://fapi.binance.com/fapi/v1/ticker/24hr').then(r => r.json()),
            fetch('https://fapi.binance.com/fapi/v1/premiumIndex').then(r => r.json()),
        ]);

        const tickerMap = {};
        for (const t of tickerResp) tickerMap[t.symbol] = t;
        const fundingMap = {};
        for (const f of fundingResp) fundingMap[f.symbol] = f;

        const result = perps.map(s => {
            const m = markets[s];
            const binId = m.id;
            const ticker = tickerMap[binId] || {};
            const funding = fundingMap[binId] || {};
            return {
                symbol: s,
                base: m.base,
                id: binId,
                price: parseFloat(ticker.lastPrice) || 0,
                change24h: parseFloat(ticker.priceChangePercent) || 0,
                volume24h: parseFloat(ticker.quoteVolume) || 0,
                fundingRate: parseFloat(funding.lastFundingRate) || 0,
            };
        });

        tickerCache = { data: result, ts: now };
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
