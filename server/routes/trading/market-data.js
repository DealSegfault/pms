/**
 * Market Data Routes — symbols, prices, klines, tickers.
 * No account-ownership checks needed for these endpoints.
 */
import { Router } from 'express';
import exchange from '../../exchange.js';

const router = Router();

let tickerCache = { data: null, ts: 0 };

// GET /api/trade/symbols/search - Search symbols
router.get('/symbols/search', async (req, res) => {
    try {
        const q = req.query.q || '';
        if (!q) {
            const popular = exchange.getPopularSymbols();
            const tickers = [];
            for (const s of popular) {
                const price = exchange.getLatestPrice(s);
                tickers.push({ symbol: s, base: s.split('/')[0], price });
            }
            return res.json(tickers);
        }
        const results = await exchange.searchSymbols(q);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/symbol-info/:symbol - Get symbol trading rules (min notional, precision, etc.)
router.get('/symbol-info/:symbol', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.symbol);
        const markets = exchange.markets;
        if (!Object.keys(markets).length) {
            return res.status(503).json({
                error: 'Exchange markets unavailable. Retry when exchange reconnects.',
                exchangeReady: exchange.ready,
            });
        }
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

// GET /api/trade/price/:symbol - Get current price
router.get('/price/:symbol', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.symbol);
        const cachedMark = exchange.getLatestPrice(symbol);
        if (cachedMark && Number.isFinite(cachedMark)) {
            return res.json({
                symbol,
                mark: cachedMark,
                last: cachedMark,
                source: 'cache',
                timestamp: Date.now(),
            });
        }

        const ticker = await exchange.fetchTicker(symbol);
        res.json({ ...ticker, source: 'rest' });
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

        // ── 1s special case ──────────────────────────────────────────────
        // Binance Futures /fapi/v1/klines does not support interval=1s.
        // Instead, fetch the last 15 min of aggTrades and aggregate into 1s bars.
        if (interval === '1s') {
            const now = Date.now();
            const windowMs = 15 * 60 * 1000; // 15 minutes
            const since = startTime ? parseInt(startTime) : now - windowMs;

            // Binance limits aggTrades to 1000 per call; fetch in one shot covering 15 min
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

            // Aggregate into 1s OHLCV bars keyed by second boundary
            const bars = new Map(); // ts (ms) → { o, h, l, c, v }
            for (const t of trades) {
                const ts = Math.floor(t.T / 1000) * 1000; // floor to second
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

            // Return in standard kline array format:
            // [openTime, open, high, low, close, baseVol, closeTime, quoteVol, ...]
            const result = [...bars.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([ts, b]) => [
                    ts,
                    String(b.o), String(b.h), String(b.l), String(b.c),
                    String(b.v),
                    ts + 999, // closeTime
                    String(b.v * b.c), // quoteVolume approx
                    0, '0', '0', '0',
                ]);

            return res.json(result);
        }

        // ── Standard klines ──────────────────────────────────────────────
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


// GET /api/trade/symbols/all - Full perp list for localStorage caching
router.get('/symbols/all', async (req, res) => {
    try {
        const markets = exchange.markets;
        if (!Object.keys(markets).length) return res.json([]);
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
        // Cache 60s
        if (tickerCache.data && now - tickerCache.ts < 60000) {
            return res.json(tickerCache.data);
        }

        const markets = exchange.markets;
        if (!Object.keys(markets).length) {
            return res.json([]);
        }
        const perps = Object.keys(markets)
            .filter(s => s.endsWith(':USDT') && markets[s].active);

        // Fetch 24h tickers + funding from Binance
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
