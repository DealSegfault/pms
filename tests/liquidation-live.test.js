/**
 * Real-Time Liquidation Integration Test
 *
 * Uses LIVE Binance prices to stress-test the full liquidation pipeline.
 * No exchange trading — only price feeds + in-memory risk engine.
 *
 * Run:  node tests/liquidation-live.test.js
 *
 * 12 test phases covering:
 *   1. Live price acquisition (REST)
 *   2. PriceService integration
 *   3. Healthy account evaluation
 *   4. Hard liquidation (equity ≤ 0)
 *   5. ADL tier cascade (T1 warning → T2 partial → T3 critical)
 *   6. INSTANT_CLOSE mode
 *   7. Multi-position cross-margin
 *   8. Continuous tick simulation (latency bench)
 *   9. Stale price fallback
 *  10. Account status guards (LIQUIDATED / FROZEN)
 *  11. SHORT position edge cases
 *  12. Reentrancy guard
 */
import https from 'https';

const SYMBOL = 'BTC/USDT:USDT';
const SYMBOL2 = 'ETH/USDT:USDT';

function log(tag, msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`  [${ts}] ${tag} ${msg}`);
}

/** Fetch mark price from Binance REST API. */
function fetchMarkPrice(symbol) {
    const clean = symbol.replace('/', '').replace(':USDT', '');
    return new Promise((resolve, reject) => {
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${clean}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const mark = parseFloat(parsed.markPrice);
                    if (mark > 0) resolve(mark);
                    else reject(new Error(`Invalid mark price: ${data}`));
                } catch (err) { reject(err); }
            });
        }).on('error', reject);
        setTimeout(() => reject(new Error(`REST timeout for ${symbol}`)), 10000);
    });
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

async function runTests() {
    const results = { passed: 0, failed: 0, tests: [] };
    function record(name, pass, detail = '') {
        results.tests.push({ name, pass, detail });
        if (pass) results.passed++; else results.failed++;
        console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 1: Live Price Acquisition
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 1: Live Price Acquisition ══════');

    let btcPrice, ethPrice;
    const fetchStart = Date.now();
    try {
        [btcPrice, ethPrice] = await Promise.all([
            fetchMarkPrice(SYMBOL),
            fetchMarkPrice(SYMBOL2),
        ]);
        const fetchLatency = Date.now() - fetchStart;
        record('REST: BTC mark price fetched', true, `$${btcPrice.toFixed(2)}`);
        record('REST: ETH mark price fetched', true, `$${ethPrice.toFixed(2)}`);
        record('REST: fetch latency < 5s', fetchLatency < 5000, `${fetchLatency}ms`);
    } catch (err) {
        record('Price fetch', false, err.message);
        printSummary(results);
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 1.5: Load heavy modules after prices are ready
    // ═══════════════════════════════════════════════════════════════════════════

    log('LOAD', 'Loading PositionBook, PriceService, LiquidationEngine...');
    const { PositionBook } = await import('../server/risk/position-book.js');
    const { PriceService } = await import('../server/risk/price-service.js');
    const { LiquidationEngine } = await import('../server/risk/liquidation.js');
    log('LOAD', 'Modules loaded ✓');

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 2: PriceService Integration
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 2: PriceService Integration ══════');

    const mockExchange = {
        latestPrices: new Map(),
        getLatestPrice(sym) { return this.latestPrices.get(sym)?.mark || null; },
        async fetchTicker(sym) { return { mark: this.latestPrices.get(sym)?.mark || 0, last: 0 }; },
    };
    const priceService = new PriceService(mockExchange);

    priceService.setPrice(SYMBOL, btcPrice);
    priceService.setPrice(SYMBOL2, ethPrice);
    mockExchange.latestPrices.set(SYMBOL, { mark: btcPrice, timestamp: Date.now() });
    mockExchange.latestPrices.set(SYMBOL2, { mark: ethPrice, timestamp: Date.now() });

    record('getPrice(BTC) correct', priceService.getPrice(SYMBOL) === btcPrice);
    record('getPrice(ETH) correct', priceService.getPrice(SYMBOL2) === ethPrice);
    record('hasPrice() correct', priceService.hasPrice(SYMBOL) && !priceService.hasPrice('FAKE/USDT:USDT'));

    const freshP = await priceService.getFreshPrice(SYMBOL);
    record('getFreshPrice() async path', freshP > 0, `$${freshP}`);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Engine Setup (shared across all phases)
    // ═══════════════════════════════════════════════════════════════════════════

    const book = new PositionBook();
    const engine = new LiquidationEngine(book, priceService);

    // Bypass all DB/Redis calls
    engine._publishRiskSnapshot = () => { };
    engine.getRules = async () => ({
        maxLeverage: 100, maxNotionalPerTrade: 200,
        maxTotalExposure: 50000, liquidationThreshold: 0.90,
    });

    const wsEvents = [];
    engine.setWsEmitter((type, data) => wsEvents.push({ type, data, ts: Date.now() }));

    const liquidationCalls = [];
    const partialCloseCalls = [];
    const closeCalls = [];

    engine.setTradeActions({
        closePosition: async (posId, action) => { closeCalls.push({ posId, action }); },
        partialClose: async (posId, fraction, action) => { partialCloseCalls.push({ posId, fraction, action }); },
        liquidatePosition: async (posId) => { liquidationCalls.push({ posId, ts: Date.now() }); },
    });

    // Override _liquidateAllPositions — skip prisma calls
    engine._liquidateAllPositions = async function (subAccountId, account, positions, marginRatio, mode) {
        this._liquidationLock.add(subAccountId);
        if (this._wsEmitter) this._wsEmitter('full_liquidation', { subAccountId, marginRatio, mode });
        try {
            const posIds = positions instanceof Map ? [...positions.keys()] : [...positions].map(p => p.id);
            for (const posId of posIds) {
                try { await this._liquidatePosition(posId); } catch { }
            }
            const be = this._book.getEntry(subAccountId);
            if (be) be.account.status = 'LIQUIDATED';
            this._emitZeroedMargin(subAccountId, 0, 'LIQUIDATED');
        } finally { this._liquidationLock.delete(subAccountId); }
    };

    // Override _adlTier3 — skip prisma calls in escalation
    engine._adlTier3 = async function (subAccountId, account, positions, largest, marginRatio, T) {
        this._liquidationLock.add(subAccountId);
        if (this._wsEmitter) this._wsEmitter('adl_triggered', { subAccountId, tier: 3, symbol: largest.symbol, fraction: 0.3, marginRatio });
        try {
            await this._partialClose(largest.id, 0.3, 'ADL_TIER3');
            const fe = this._book.getEntry(subAccountId);
            if (fe && fe.positions.size > 0) {
                let u = 0, n = 0;
                for (const p of fe.positions.values()) {
                    const mp = this._priceService.getPrice(p.symbol) || p.entryPrice;
                    u += p.side === 'LONG' ? (mp - p.entryPrice) * p.quantity : (p.entryPrice - mp) * p.quantity;
                    n += p.notional;
                }
                const eq = fe.account.currentBalance + u;
                const mr = eq > 0 ? (n * fe.account.maintenanceRate) / eq : 999;
                if (mr >= T) {
                    if (this._wsEmitter) this._wsEmitter('full_liquidation', { subAccountId, marginRatio: mr, mode: 'ADL_30_ESCALATED' });
                    for (const pid of [...fe.positions.keys()]) { try { await this._liquidatePosition(pid); } catch { } }
                    fe.account.status = 'LIQUIDATED';
                    this._emitZeroedMargin(subAccountId, 0, 'LIQUIDATED');
                }
            }
        } finally { this._liquidationLock.delete(subAccountId); }
    };

    function reset() {
        book.delete('test-acct-1');
        liquidationCalls.length = 0;
        closeCalls.length = 0;
        partialCloseCalls.length = 0;
        wsEvents.length = 0;
    }

    function loadAccount({ balance, positions, mode = 'ADL_30', status = 'ACTIVE' }) {
        book.load({
            'test-acct-1': {
                account: {
                    id: 'test-acct-1', name: 'Test', currentBalance: balance,
                    maintenanceRate: 0.005, liquidationMode: mode, status,
                },
                positions,
                rules: { liquidationThreshold: 0.90, maxLeverage: 100, maxNotionalPerTrade: 200, maxTotalExposure: 50000 },
            },
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 3: Healthy Account Evaluation
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 3: Healthy Account ══════');
    {
        reset();
        const bal = 1000, notional = bal * 10, qty = notional / btcPrice;
        loadAccount({
            balance: bal, positions: [{
                id: 'p1', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: btcPrice, quantity: qty, notional, leverage: 10,
                margin: bal, liquidationPrice: btcPrice * 0.5, openedAt: new Date(),
            }]
        });

        const t0 = Date.now();
        await engine.evaluateAccount('test-acct-1');
        const lat = Date.now() - t0;

        record('No liquidation triggered', liquidationCalls.length === 0 && closeCalls.length === 0);
        record('Emits pnl_update', wsEvents.some(e => e.type === 'pnl_update'));
        record('Emits margin_update', wsEvents.some(e => e.type === 'margin_update'));
        record('Eval latency < 5ms', lat < 5, `${lat}ms`);
        const me = wsEvents.find(e => e.type === 'margin_update');
        if (me) record('Equity > 0 & MR < 1', me.data.equity > 0 && me.data.marginRatio < 1,
            `eq=$${me.data.equity.toFixed(2)} MR=${(me.data.marginRatio * 100).toFixed(1)}%`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 4: Hard Liquidation — Equity ≤ 0
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 4: Hard Liquidation (equity ≤ 0) ══════');
    {
        reset();
        const bal = 10, entry = btcPrice * 1.5, notional = bal * 50, qty = notional / entry;
        const upnl = (btcPrice - entry) * qty;
        const equity = bal + upnl;

        log('CALC', `entry=$${entry.toFixed(0)} uPnL=$${upnl.toFixed(2)} equity=$${equity.toFixed(2)}`);
        loadAccount({
            balance: bal, positions: [{
                id: 'p-bk', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: entry, quantity: qty, notional, leverage: 50,
                margin: bal, liquidationPrice: entry * 0.99, openedAt: new Date(),
            }]
        });

        const t0 = Date.now();
        await engine.evaluateAccount('test-acct-1');
        const lat = Date.now() - t0;

        record('Equity is negative', equity < 0, `$${equity.toFixed(2)}`);
        record('liquidatePosition called', liquidationCalls.length > 0, `${liquidationCalls.length} calls`);
        record('full_liquidation WS event', wsEvents.some(e => e.type === 'full_liquidation'));
        record('Account status → LIQUIDATED', book.getEntry('test-acct-1')?.account.status === 'LIQUIDATED');
        record('Latency < 10ms', lat < 10, `${lat}ms`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 5: ADL Tier Cascade
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 5: ADL Tier Cascade ══════');

    // Helper: engineer a position with target margin ratio
    function engineerPosition(targetMR, posId) {
        const bal = 100, lev = 50, notional = bal * lev, qty = notional / btcPrice;
        const targetEquity = notional * 0.005 / targetMR;
        const neededUpnl = targetEquity - bal;
        const entry = btcPrice - neededUpnl / qty;
        const actualUpnl = (btcPrice - entry) * qty;
        const actualEquity = bal + actualUpnl;
        const actualMR = (notional * 0.005) / actualEquity;
        log('ENG', `${posId}: targetMR=${(targetMR * 100).toFixed(1)}% actualMR=${(actualMR * 100).toFixed(1)}% eq=$${actualEquity.toFixed(2)}`);
        return {
            pos: {
                id: posId, subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: entry, quantity: qty, notional, leverage: lev,
                margin: bal, liquidationPrice: entry * 0.95, openedAt: new Date(),
            },
            balance: bal, actualMR, actualEquity,
        };
    }

    // Tier 1: Warning (T-0.10 ≤ MR < T)
    {
        reset();
        const { pos, balance, actualMR } = engineerPosition(0.82, 'p-t1');
        loadAccount({ balance, positions: [pos] });
        await engine.evaluateAccount('test-acct-1');
        record('Tier 1: margin_warning emitted', wsEvents.some(e => e.type === 'margin_warning'),
            `MR=${(actualMR * 100).toFixed(1)}%`);
        record('Tier 1: no liquidation or ADL', liquidationCalls.length === 0 && partialCloseCalls.length === 0);
    }

    // Tier 2: ADL partial (T ≤ MR < T+0.05)
    {
        reset();
        const { pos, balance, actualMR } = engineerPosition(0.92, 'p-t2');
        loadAccount({ balance, positions: [pos] });
        await engine.evaluateAccount('test-acct-1');
        record('Tier 2: partial close triggered', partialCloseCalls.length > 0,
            `MR=${(actualMR * 100).toFixed(1)}% partials=${partialCloseCalls.length}`);
        record('Tier 2: adl_triggered WS event', wsEvents.some(e => e.type === 'adl_triggered'));
    }

    // Tier 3: Critical (MR ≥ T + 0.05) → may escalate to full liquidation
    {
        reset();
        const { pos, balance, actualMR } = engineerPosition(0.97, 'p-t3');
        loadAccount({ balance, positions: [pos] });
        await engine.evaluateAccount('test-acct-1');
        record('Tier 3: adl_triggered (tier=3)', wsEvents.some(e => e.type === 'adl_triggered' && e.data.tier === 3),
            `MR=${(actualMR * 100).toFixed(1)}%`);
        record('Tier 3: partial or escalation triggered', partialCloseCalls.length > 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 6: INSTANT_CLOSE Mode
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 6: INSTANT_CLOSE Mode ══════');
    {
        reset();
        const { pos, balance, actualMR } = engineerPosition(0.95, 'p-ic');
        loadAccount({ balance, positions: [pos], mode: 'INSTANT_CLOSE' });
        await engine.evaluateAccount('test-acct-1');
        record('INSTANT_CLOSE: liquidatePosition called', liquidationCalls.length > 0,
            `MR=${(actualMR * 100).toFixed(1)}% calls=${liquidationCalls.length}`);
        record('INSTANT_CLOSE: full_liquidation WS event', wsEvents.some(e => e.type === 'full_liquidation'));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 7: Multi-Position Cross-Margin
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 7: Cross-Margin ══════');
    {
        reset();
        const bal = 200;
        const btcEntry = btcPrice * 0.99, btcN = 5000, btcQ = btcN / btcEntry;
        const btcUp = (btcPrice - btcEntry) * btcQ;
        const ethEntry = ethPrice * 1.05, ethN = 5000, ethQ = ethN / ethEntry;
        const ethUp = (ethPrice - ethEntry) * ethQ;
        const totalEq = bal + btcUp + ethUp;

        log('XM', `BTC_pnl=$${btcUp.toFixed(2)} ETH_pnl=$${ethUp.toFixed(2)} eq=$${totalEq.toFixed(2)}`);

        loadAccount({
            balance: bal, positions: [
                {
                    id: 'p-btc', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                    entryPrice: btcEntry, quantity: btcQ, notional: btcN, leverage: 25,
                    margin: btcN / 25, liquidationPrice: btcEntry * 0.9, openedAt: new Date()
                },
                {
                    id: 'p-eth', subAccountId: 'test-acct-1', symbol: SYMBOL2, side: 'LONG',
                    entryPrice: ethEntry, quantity: ethQ, notional: ethN, leverage: 25,
                    margin: ethN / 25, liquidationPrice: ethEntry * 0.9, openedAt: new Date()
                },
            ]
        });
        await engine.evaluateAccount('test-acct-1');

        const me = wsEvents.find(e => e.type === 'margin_update');
        if (me) {
            const diff = Math.abs(me.data.equity - Math.max(0, totalEq));
            record('Equity matches cross-margin calc', diff < 0.01,
                `reported=$${me.data.equity.toFixed(2)} expected=$${Math.max(0, totalEq).toFixed(2)}`);
        }
        record('2 pnl_update events', wsEvents.filter(e => e.type === 'pnl_update').length === 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 8: Rapid Tick Simulation (latency benchmark)
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 8: Rapid Tick Simulation ══════');
    {
        reset();
        const bal = 10000;
        loadAccount({
            balance: bal, positions: [{
                id: 'p-tick', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: btcPrice, quantity: 0.01, notional: btcPrice * 0.01, leverage: 10,
                margin: btcPrice * 0.001, liquidationPrice: btcPrice * 0.5, openedAt: new Date(),
            }]
        });

        // Simulate 1000 rapid price ticks (±0.5% random walk)
        const latencies = [];
        let price = btcPrice;
        for (let i = 0; i < 1000; i++) {
            price *= (1 + (Math.random() - 0.5) * 0.01); // ±0.5%
            priceService.setPrice(SYMBOL, price);
            const t0 = performance.now();
            await engine.evaluateAccount('test-acct-1');
            latencies.push(performance.now() - t0);
        }

        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const max = Math.max(...latencies);
        const sorted = [...latencies].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.50)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];

        record('1000 evals in tight loop', true,
            `avg=${avg.toFixed(3)}ms p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms`);
        record('Avg latency < 1ms', avg < 1, `${avg.toFixed(3)}ms`);
        record('P99 latency < 3ms', p99 < 3, `${p99.toFixed(3)}ms`);
        record('Max latency < 10ms', max < 10, `${max.toFixed(3)}ms`);
        record('No false liquidation on healthy acct', liquidationCalls.length === 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 9: Stale Price Fallback
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 9: Stale Price Fallback ══════');
    {
        reset();
        loadAccount({
            balance: 500, positions: [{
                id: 'p-stale', subAccountId: 'test-acct-1', symbol: 'UNKNOWN/USDT:USDT', side: 'LONG',
                entryPrice: 100, quantity: 10, notional: 1000, leverage: 10,
                margin: 100, liquidationPrice: 90, openedAt: new Date(),
            }]
        });
        await engine.evaluateAccount('test-acct-1');

        record('No crash with unknown symbol', true);
        record('No liquidation', liquidationCalls.length === 0);
        record('margin_update emitted', wsEvents.some(e => e.type === 'margin_update'));
        const me = wsEvents.find(e => e.type === 'margin_update');
        if (me) record('uPnL=0 (fallback to entry)', Math.abs(me.data.unrealizedPnl) < 0.001);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 10: Account Status Guards
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 10: Status Guards ══════');
    {
        reset();
        loadAccount({
            balance: 0, status: 'LIQUIDATED', positions: [{
                id: 'p-dead', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: btcPrice, quantity: 0.1, notional: btcPrice * 0.1, leverage: 10,
                margin: btcPrice * 0.01, liquidationPrice: btcPrice * 0.5, openedAt: new Date(),
            }]
        });
        await engine.evaluateAccount('test-acct-1');
        record('LIQUIDATED: short-circuits', wsEvents.length === 0 && liquidationCalls.length === 0);
    }
    {
        reset();
        loadAccount({
            balance: 100, status: 'FROZEN', positions: [{
                id: 'p-frz', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: btcPrice, quantity: 0.1, notional: btcPrice * 0.1, leverage: 10,
                margin: btcPrice * 0.01, liquidationPrice: btcPrice * 0.5, openedAt: new Date(),
            }]
        });
        await engine.evaluateAccount('test-acct-1');
        record('FROZEN: short-circuits', wsEvents.length === 0 && liquidationCalls.length === 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 11: SHORT Position Edge Cases
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 11: SHORT Positions ══════');
    {
        reset();
        // SHORT at 0.95x market → price above entry → loss for short
        const entry = btcPrice * 0.95, notional = 5000, qty = notional / entry;
        loadAccount({
            balance: 1000, positions: [{
                id: 'p-short', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'SHORT',
                entryPrice: entry, quantity: qty, notional, leverage: 5,
                margin: 1000, liquidationPrice: entry * 1.2, openedAt: new Date(),
            }]
        });
        await engine.evaluateAccount('test-acct-1');
        const pnlEvt = wsEvents.find(e => e.type === 'pnl_update');
        record('SHORT PnL direction correct (loss when mark > entry)',
            pnlEvt?.data?.unrealizedPnl < 0, `uPnL=$${pnlEvt?.data?.unrealizedPnl?.toFixed(2)}`);
    }
    {
        reset();
        // SHORT that triggers hard liquidation (price moved way up from entry)
        const entry = btcPrice * 0.7, bal = 10, notional = bal * 50, qty = notional / entry;
        const upnl = (entry - btcPrice) * qty;
        const eq = bal + upnl;
        log('SHORT_LIQ', `entry=$${entry.toFixed(0)} uPnL=$${upnl.toFixed(2)} eq=$${eq.toFixed(2)}`);
        loadAccount({
            balance: bal, positions: [{
                id: 'p-short-liq', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'SHORT',
                entryPrice: entry, quantity: qty, notional, leverage: 50,
                margin: bal, liquidationPrice: entry * 1.02, openedAt: new Date(),
            }]
        });
        await engine.evaluateAccount('test-acct-1');
        record('SHORT hard liq: equity negative', eq < 0, `$${eq.toFixed(2)}`);
        record('SHORT hard liq: liquidatePosition called', liquidationCalls.length > 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 12: Reentrancy Guard
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════ Phase 12: Reentrancy Guard ══════');
    {
        reset();
        loadAccount({
            balance: 1000, positions: [{
                id: 'p-re', subAccountId: 'test-acct-1', symbol: SYMBOL, side: 'LONG',
                entryPrice: btcPrice, quantity: 0.01, notional: btcPrice * 0.01, leverage: 10,
                margin: btcPrice * 0.001, liquidationPrice: btcPrice * 0.5, openedAt: new Date(),
            }]
        });
        // Fire 50 concurrent evaluations
        await Promise.all(Array.from({ length: 50 }, () => engine.evaluateAccount('test-acct-1')));
        record('No crash on 50 concurrent evals', true);
        record('No false liquidation', liquidationCalls.length === 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════

    printSummary(results);
}

function printSummary(results) {
    console.log('\n' + '═'.repeat(50));
    console.log(`  TOTAL: ${results.passed + results.failed} tests | ✅ ${results.passed} passed | ❌ ${results.failed} failed`);
    console.log('═'.repeat(50) + '\n');
    if (results.failed > 0) {
        console.log('  Failed tests:');
        for (const t of results.tests.filter(t => !t.pass))
            console.log(`    ❌ ${t.name} — ${t.detail}`);
        console.log('');
    }
    process.exit(results.failed > 0 ? 1 : 0);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Liquidation Engine — Real-Time Integration Test Suite  ║');
console.log('║  Live Prices + Virtual Positions + Latency Benchmark   ║');
console.log('╚══════════════════════════════════════════════════════════╝');

runTests().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
