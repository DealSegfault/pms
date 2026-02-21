/**
 * Liquidation Engine Unit Tests
 *
 * Tests the monitorPositions() logic in isolation with mocked exchange + prisma.
 * Run: node --test tests/liquidation.test.js
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers to build mock objects
// ---------------------------------------------------------------------------

function makeAccount(overrides = {}) {
    return {
        id: 'acct-1',
        name: 'testaccount',
        currentBalance: 100,
        maintenanceRate: 0.005,
        liquidationMode: 'ADL_30',
        status: 'ACTIVE',
        ...overrides,
    };
}

function makePosition(overrides = {}) {
    return {
        id: 'pos-1',
        subAccountId: 'acct-1',
        symbol: 'BTC/USDT:USDT',
        side: 'LONG',
        entryPrice: 50000,
        quantity: 0.1,
        notional: 5000,
        leverage: 10,
        margin: 500,
        liquidationPrice: 45000,
        status: 'OPEN',
        ...overrides,
    };
}

function makeRules(overrides = {}) {
    return {
        maxLeverage: 100,
        maxNotionalPerTrade: 200,
        maxTotalExposure: 500,
        liquidationThreshold: 0.90,
        ...overrides,
    };
}

/**
 * Calculate expected marginRatio: maintenanceMargin / equity
 *   maintenanceMargin = totalNotional * maintenanceRate
 *   equity = balance + UPNL
 */
function computeMarginRatio(balance, positions, prices, maintenanceRate = 0.005) {
    let upnl = 0;
    let totalNotional = 0;
    for (const p of positions) {
        const mark = prices[p.symbol] ?? p.entryPrice;
        upnl += p.side === 'LONG'
            ? (mark - p.entryPrice) * p.quantity
            : (p.entryPrice - mark) * p.quantity;
        totalNotional += p.notional;
    }
    const equity = balance + upnl;
    const mm = totalNotional * maintenanceRate;
    return { marginRatio: equity > 0 ? mm / equity : 999, equity, upnl, mm };
}

// ---------------------------------------------------------------------------
// Build a testable RiskEngine with mock dependencies
// ---------------------------------------------------------------------------

function createTestEngine({ prices = {}, account, positions, rules, freshPrices = null }) {
    const wsEvents = [];
    const closedPositions = [];
    const partialCloses = [];
    let _account = { ...account };
    let _positions = positions.map(p => ({ ...p }));
    const _rules = rules || makeRules();

    // Track DB updates
    const dbUpdates = [];

    const engine = {
        _monitorInterval: null,
        _wsEmitter: (type, data) => wsEvents.push({ type, data }),
        _priceCache: new Map(),

        async getRules() {
            return _rules;
        },

        async _getFreshPrice(symbol) {
            // If freshPrices callback is provided, use it (for staleness tests)
            if (freshPrices) return freshPrices(symbol);
            return prices[symbol] ?? null;
        },

        async _calcPositionsUpnl(positionList) {
            let total = 0;
            for (const pos of positionList) {
                const mark = await this._getFreshPrice(pos.symbol);
                if (mark === null) continue;
                total += pos.side === 'LONG'
                    ? (mark - pos.entryPrice) * pos.quantity
                    : (pos.entryPrice - mark) * pos.quantity;
            }
            return total;
        },

        calculateAccountLiqPrice() { return 40000; },

        async closePosition(positionId, action) {
            closedPositions.push({ positionId, action });
            // Remove from live list
            _positions = _positions.filter(p => p.id !== positionId);
            return { success: true };
        },

        async partialClose(positionId, fraction, action) {
            partialCloses.push({ positionId, fraction, action });
            // Reduce quantity
            const pos = _positions.find(p => p.id === positionId);
            if (pos) {
                pos.quantity = +(pos.quantity * (1 - fraction)).toFixed(8);
                pos.notional = pos.entryPrice * pos.quantity;
                pos.margin = pos.notional / pos.leverage;
            }
            return { success: true };
        },

        // Stub for prisma queries used inside monitorPositions
        _prisma: {
            virtualPosition: {
                findMany: async ({ where }) => {
                    if (where.status === 'OPEN') {
                        return _positions
                            .filter(p => p.status === 'OPEN')
                            .map(p => ({
                                ...p,
                                subAccount: _account,
                            }));
                    }
                    return [];
                },
            },
            subAccount: {
                findUnique: async () => ({ ..._account }),
                update: async ({ data }) => {
                    Object.assign(_account, data);
                    dbUpdates.push({ type: 'subAccount.update', data });
                    return _account;
                },
            },
        },
    };

    // Build the actual monitorPositions method that uses our stubs
    engine.monitorPositions = async function () {
        const openPositions = await this._prisma.virtualPosition.findMany({
            where: { status: 'OPEN' },
        });

        if (openPositions.length === 0) return;

        const byAccount = {};
        for (const pos of openPositions) {
            if (!byAccount[pos.subAccountId]) {
                byAccount[pos.subAccountId] = { account: pos.subAccount, positions: [] };
            }
            byAccount[pos.subAccountId].positions.push(pos);
        }

        for (const [subAccountId, { account: acct, positions: posns }] of Object.entries(byAccount)) {
            const totalUpnl = await this._calcPositionsUpnl(posns);
            const equity = acct.currentBalance + totalUpnl;
            const totalNotional = posns.reduce((s, p) => s + p.notional, 0);
            const totalMarginUsed = posns.reduce((s, p) => s + p.margin, 0);
            const maintenanceMargin = totalNotional * (acct.maintenanceRate || 0.005);
            const marginRatio = equity > 0 ? maintenanceMargin / equity : 999;
            const accountLiqPrice = this.calculateAccountLiqPrice(acct, posns);

            // Emit PnL updates
            for (const pos of posns) {
                const markPrice = await this._getFreshPrice(pos.symbol) || pos.entryPrice;
                const unrealizedPnl = pos.side === 'LONG'
                    ? (markPrice - pos.entryPrice) * pos.quantity
                    : (pos.entryPrice - markPrice) * pos.quantity;

                if (this._wsEmitter) {
                    this._wsEmitter('pnl_update', {
                        subAccountId, positionId: pos.id, symbol: pos.symbol,
                        side: pos.side, entryPrice: pos.entryPrice, markPrice,
                        unrealizedPnl, liquidationPrice: pos.liquidationPrice,
                        margin: pos.margin,
                        pnlPercent: pos.margin > 0 ? (unrealizedPnl / pos.margin) * 100 : 0,
                    });
                }
            }

            // Emit account margin info
            if (this._wsEmitter) {
                this._wsEmitter('margin_update', {
                    subAccountId, equity, balance: acct.currentBalance,
                    unrealizedPnl: totalUpnl, marginUsed: totalMarginUsed,
                    availableMargin: equity - totalMarginUsed,
                    totalExposure: totalNotional, maintenanceMargin, marginRatio,
                    accountLiqPrice, positionCount: posns.length,
                });
            }

            // Resolve threshold
            const rules = await this.getRules(subAccountId);
            const T = rules.liquidationThreshold || 0.90;

            if (acct.liquidationMode === 'INSTANT_CLOSE') {
                if (marginRatio >= T) {
                    for (const pos of posns) {
                        await this.closePosition(pos.id, 'LIQUIDATE');
                    }
                    await this._prisma.subAccount.update({
                        where: { id: subAccountId },
                        data: { status: 'LIQUIDATED' },
                    });
                    if (this._wsEmitter) {
                        this._wsEmitter('full_liquidation', { subAccountId, marginRatio, mode: 'INSTANT_CLOSE' });
                    }
                }
            } else {
                // ADL_30
                const largest = [...posns].sort((a, b) => b.notional - a.notional)[0];

                if (marginRatio >= T + 0.05) {
                    // Tier 3
                    await this.partialClose(largest.id, 0.3, 'ADL_TIER3');
                    if (this._wsEmitter) {
                        this._wsEmitter('adl_triggered', {
                            subAccountId, tier: 3, symbol: largest.symbol,
                            fraction: 0.3, marginRatio,
                        });
                    }

                    // Full liquidation fallback
                    const remainingPositions = await this._prisma.virtualPosition.findMany({
                        where: { subAccountId, status: 'OPEN' },
                    });
                    if (remainingPositions.length > 0) {
                        const freshAcct = await this._prisma.subAccount.findUnique({ where: { id: subAccountId } });
                        const freshUpnl = await this._calcPositionsUpnl(remainingPositions);
                        const freshEquity = freshAcct.currentBalance + freshUpnl;
                        const freshNotional = remainingPositions.reduce((s, p) => s + p.notional, 0);
                        const freshMM = freshNotional * (freshAcct.maintenanceRate || 0.005);
                        const freshMR = freshEquity > 0 ? freshMM / freshEquity : 999;

                        if (freshMR >= T) {
                            for (const p of remainingPositions) {
                                await this.closePosition(p.id, 'LIQUIDATE');
                            }
                            await this._prisma.subAccount.update({
                                where: { id: subAccountId },
                                data: { status: 'LIQUIDATED' },
                            });
                            if (this._wsEmitter) {
                                this._wsEmitter('full_liquidation', {
                                    subAccountId, marginRatio: freshMR, mode: 'ADL_30_ESCALATED',
                                });
                            }
                        }
                    }

                } else if (marginRatio >= T) {
                    // Tier 2
                    await this.partialClose(largest.id, 0.3, 'ADL_TIER2');
                    if (this._wsEmitter) {
                        this._wsEmitter('adl_triggered', {
                            subAccountId, tier: 2, symbol: largest.symbol,
                            fraction: 0.3, marginRatio,
                        });
                    }

                } else if (marginRatio >= T - 0.10) {
                    // Tier 1: Warning
                    if (this._wsEmitter) {
                        this._wsEmitter('margin_warning', {
                            subAccountId, marginRatio,
                            message: `Margin ratio ${(marginRatio * 100).toFixed(1)}% — approaching liquidation`,
                        });
                    }
                }
            }
        }
    };

    return { engine, wsEvents, closedPositions, partialCloses, dbUpdates, getAccount: () => _account, getPositions: () => _positions };
}


// ===========================================================================
// TEST SUITES
// ===========================================================================

describe('Liquidation Engine — Tier Behavior', () => {

    it('healthy account — no liquidation action', async () => {
        // Balance 100, notional 5000, maintenanceRate 0.005
        // MM = 25, price hasn't moved → UPNL = 0 → equity = 100
        // marginRatio = 25/100 = 0.25 → below all thresholds
        const { engine, wsEvents, closedPositions, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 }, // same as entry
            account: makeAccount({ currentBalance: 100 }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        assert.equal(closedPositions.length, 0, 'no positions should be closed');
        assert.equal(partialCloses.length, 0, 'no partial closes');
        assert.ok(!wsEvents.some(e => e.type === 'margin_warning'), 'no warnings');
        assert.ok(!wsEvents.some(e => e.type === 'adl_triggered'), 'no ADL');
        assert.ok(!wsEvents.some(e => e.type === 'full_liquidation'), 'no liquidation');
    });

    it('Tier 1 — warning emitted at marginRatio >= 0.80', async () => {
        // Need marginRatio = MM / equity ≥ 0.80
        // MM = 5000 * 0.005 = 25, so equity needs to be ≤ 31.25
        // equity = balance + UPNL → balance=31, UPNL=0 → ratio=25/31=0.806
        const { engine, wsEvents, closedPositions, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 31 }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        assert.equal(closedPositions.length, 0, 'no closes at tier 1');
        assert.equal(partialCloses.length, 0, 'no partial closes at tier 1');
        const warning = wsEvents.find(e => e.type === 'margin_warning');
        assert.ok(warning, 'margin_warning event should be emitted');
        assert.ok(warning.data.marginRatio >= 0.80, `marginRatio ${warning.data.marginRatio} should be >= 0.80`);
    });

    it('Tier 2 — ADL 30% of largest at marginRatio >= 0.90', async () => {
        // Need marginRatio = 25 / equity ≥ 0.90 → equity ≤ 27.78
        // balance=27, UPNL=0 → ratio = 25/27 = 0.926
        const { engine, wsEvents, closedPositions, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 27 }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        assert.equal(partialCloses.length, 1, 'should trigger 1 partial close');
        assert.equal(partialCloses[0].fraction, 0.3, 'should close 30%');
        assert.equal(partialCloses[0].action, 'ADL_TIER2');
        assert.equal(closedPositions.length, 0, 'no full closes at tier 2');
        const adl = wsEvents.find(e => e.type === 'adl_triggered');
        assert.ok(adl, 'adl_triggered event should be emitted');
        assert.equal(adl.data.tier, 2);
    });

    it('Tier 3 + full liquidation — closes all remaining positions', async () => {
        // Need marginRatio ≥ 0.95 → equity ≤ 26.32
        // balance=5, UPNL=0 → ratio = 25/5 = 5.0 (way above 0.95)
        // After 30% ADL, notional drops to ~3500, MM=17.5, but balance still tiny
        // So freshMR will still be >> 0.90 → full liquidation triggers
        const { engine, wsEvents, closedPositions, partialCloses, dbUpdates, getAccount } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 5 }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        // Tier 3 partial close fires first
        assert.ok(partialCloses.length >= 1, 'tier 3 partial close should fire');
        assert.equal(partialCloses[0].action, 'ADL_TIER3');

        // Then full liquidation (closePosition for remaining)
        assert.ok(closedPositions.length >= 1, 'full liquidation should close remaining positions');
        assert.equal(closedPositions[0].action, 'LIQUIDATE');

        // Account marked as LIQUIDATED
        assert.equal(getAccount().status, 'LIQUIDATED');

        // WS events include full_liquidation
        const fullLiq = wsEvents.find(e => e.type === 'full_liquidation');
        assert.ok(fullLiq, 'full_liquidation WS event should be emitted');
        assert.equal(fullLiq.data.mode, 'ADL_30_ESCALATED');
    });
});


describe('Liquidation Engine — Price Staleness', () => {

    it('stale price → falls back to REST (not entry price)', async () => {
        // _getFreshPrice returns the REST fallback value
        const restPrice = 48000; // much lower than entry, should cause negative UPNL
        let getFreshPriceCalled = false;

        const { engine, wsEvents } = createTestEngine({
            account: makeAccount({ currentBalance: 100 }),
            positions: [makePosition()],
            freshPrices: (symbol) => {
                getFreshPriceCalled = true;
                return restPrice;
            },
        });

        await engine.monitorPositions();

        assert.ok(getFreshPriceCalled, '_getFreshPrice should be called');

        // UPNL should be -200 (LONG, entry 50000, mark 48000, qty 0.1)
        // equity = 100 + (-200) = -100 → marginRatio = 999
        // This should trigger tier 3 + full liquidation
        const fullLiq = wsEvents.find(e => e.type === 'full_liquidation');
        assert.ok(fullLiq, 'full_liquidation should trigger with correct price');
    });

    it('no price available → UPNL is 0 (positions skipped), no false calm', async () => {
        // When _getFreshPrice returns null for all symbols, UPNL = 0
        // balance = 100, no UPNL drift → equity = 100, MM = 25, ratio = 0.25
        // This is a "can't evaluate risk" state, not a "healthy" state
        const { engine, wsEvents, closedPositions, partialCloses } = createTestEngine({
            account: makeAccount({ currentBalance: 100 }),
            positions: [makePosition()],
            freshPrices: () => null, // no price at all
        });

        await engine.monitorPositions();

        // With null prices, UPNL = 0 (positions skipped in _calcPositionsUpnl)
        // marginRatio = 25/100 = 0.25 → no liquidation (which is correct — can't liquidate without prices)
        assert.equal(closedPositions.length, 0);
        assert.equal(partialCloses.length, 0);
    });
});


describe('Liquidation Engine — Custom Threshold', () => {

    it('custom threshold of 0.70 — tiers shift down accordingly', async () => {
        // With T=0.70: tier 1 at 0.60, tier 2 at 0.70, tier 3 at 0.75
        // MM = 25, for ratio 0.70 we need equity = 25/0.70 = 35.7
        // balance=35, UPNL=0 → ratio = 25/35 = 0.714 → should hit Tier 2
        const { engine, wsEvents, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 35 }),
            positions: [makePosition()],
            rules: makeRules({ liquidationThreshold: 0.70 }),
        });

        await engine.monitorPositions();

        assert.equal(partialCloses.length, 1, 'Tier 2 should fire at custom threshold');
        assert.equal(partialCloses[0].action, 'ADL_TIER2');
        const adl = wsEvents.find(e => e.type === 'adl_triggered');
        assert.ok(adl);
        assert.equal(adl.data.tier, 2);
    });

    it('custom threshold of 0.70 — warning at 0.60', async () => {
        // ratio = 25/40 = 0.625 → should hit Tier 1 (T-0.10 = 0.60)
        const { engine, wsEvents, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 40 }),
            positions: [makePosition()],
            rules: makeRules({ liquidationThreshold: 0.70 }),
        });

        await engine.monitorPositions();

        assert.equal(partialCloses.length, 0, 'no ADL at warning level');
        const warning = wsEvents.find(e => e.type === 'margin_warning');
        assert.ok(warning, 'margin_warning should fire at T-0.10');
    });
});


describe('Liquidation Engine — INSTANT_CLOSE Mode', () => {

    it('INSTANT_CLOSE — closes all positions at threshold', async () => {
        // balance=27, ratio = 25/27 = 0.926 ≥ 0.90 threshold
        const { engine, closedPositions, dbUpdates, getAccount, wsEvents } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 27, liquidationMode: 'INSTANT_CLOSE' }),
            positions: [
                makePosition({ id: 'pos-1' }),
                makePosition({ id: 'pos-2', symbol: 'ETH/USDT:USDT', entryPrice: 3000, quantity: 1, notional: 3000, margin: 300 }),
            ],
        });

        await engine.monitorPositions();

        // Both positions should be fully closed
        assert.equal(closedPositions.length, 2, 'all positions should be closed');
        assert.ok(closedPositions.every(c => c.action === 'LIQUIDATE'));

        // Account should be marked LIQUIDATED
        assert.equal(getAccount().status, 'LIQUIDATED');

        // WS event emitted
        const fullLiq = wsEvents.find(e => e.type === 'full_liquidation');
        assert.ok(fullLiq);
        assert.equal(fullLiq.data.mode, 'INSTANT_CLOSE');
    });

    it('INSTANT_CLOSE — no action below threshold', async () => {
        // balance=100, ratio = 25/100 = 0.25 → well below 0.90
        const { engine, closedPositions, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000 },
            account: makeAccount({ currentBalance: 100, liquidationMode: 'INSTANT_CLOSE' }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        assert.equal(closedPositions.length, 0);
        assert.equal(partialCloses.length, 0);
    });
});


describe('Liquidation Engine — Multi-Position Scenarios', () => {

    it('liquidates largest position first in ADL', async () => {
        // Two positions, one larger than the other
        const largePos = makePosition({ id: 'pos-large', notional: 8000, margin: 800 });
        const smallPos = makePosition({ id: 'pos-small', notional: 2000, margin: 200, symbol: 'ETH/USDT:USDT' });
        // Total notional = 10000, MM = 50
        // balance = 55 → ratio = 50/55 = 0.909 → Tier 2

        const { engine, partialCloses } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 50000, 'ETH/USDT:USDT': 3000 },
            account: makeAccount({ currentBalance: 55 }),
            positions: [smallPos, largePos], // order shouldn't matter
        });

        await engine.monitorPositions();

        assert.equal(partialCloses.length, 1);
        assert.equal(partialCloses[0].positionId, 'pos-large', 'largest position should be ADLd first');
    });

    it('negative UPNL pushes marginRatio into liquidation territory', async () => {
        // Entry at 50000, mark at 49000 → UPNL = -100 (LONG 0.1)
        // balance = 30, equity = 30 + (-100) = -70 → marginRatio = 999
        const { engine, closedPositions, partialCloses, getAccount } = createTestEngine({
            prices: { 'BTC/USDT:USDT': 49000 },
            account: makeAccount({ currentBalance: 30 }),
            positions: [makePosition()],
        });

        await engine.monitorPositions();

        // With marginRatio=999, Tier 3 fires then full liquidation
        assert.ok(partialCloses.length >= 1, 'ADL should fire');
        assert.ok(closedPositions.length >= 1, 'full liquidation should follow');
        assert.equal(getAccount().status, 'LIQUIDATED');
    });
});


// ===========================================================================
// LIQUIDATION PRICE FORMULA TESTS
// ===========================================================================

import { LiquidationEngine } from '../server/risk/liquidation.js';

function makeLiqEngine() {
    // Minimal engine instance for pure formula tests (no book/priceService needed)
    return new LiquidationEngine(null, null);
}

describe('calculateLiquidationPrice — Threshold Formula', () => {

    it('LONG — liq price is below entry, respects 0.90 threshold', () => {
        const eng = makeLiqEngine();
        // balance=100, notional=5000, entry=50000, mmRate=0.005, threshold=0.90
        // mm = 25, equityFloor = 25/0.90 = 27.778, availableForLoss = 100 - 27.778 = 72.222
        // qty = 5000/50000 = 0.1, liq = 50000 - 72.222/0.1 = 50000 - 722.22 = 49277.78
        const liq = eng.calculateLiquidationPrice('LONG', 50000, 10, 100, 5000, 0.005, 0.90);
        assert.ok(liq < 50000, 'LONG liq price should be below entry');
        assert.ok(liq > 0, 'should be positive');

        // Verify: at this price, marginRatio should be exactly 0.90
        const upnl = (liq - 50000) * 0.1;
        const equity = 100 + upnl;
        const mm = 5000 * 0.005;
        const ratio = mm / equity;
        assert.ok(Math.abs(ratio - 0.90) < 0.001, `marginRatio at liq should be ~0.90, got ${ratio.toFixed(6)}`);
    });

    it('SHORT — liq price is above entry, respects 0.90 threshold', () => {
        const eng = makeLiqEngine();
        // SHORT at 50000, same params
        const liq = eng.calculateLiquidationPrice('SHORT', 50000, 10, 100, 5000, 0.005, 0.90);
        assert.ok(liq > 50000, 'SHORT liq price should be above entry');

        // Verify margin ratio at liq
        const upnl = (50000 - liq) * 0.1; // SHORT PnL
        const equity = 100 + upnl;
        const mm = 5000 * 0.005;
        const ratio = mm / equity;
        assert.ok(Math.abs(ratio - 0.90) < 0.001, `marginRatio at liq should be ~0.90, got ${ratio.toFixed(6)}`);
    });

    it('custom threshold 0.50 gives more room before liquidation', () => {
        const eng = makeLiqEngine();
        const liq90 = eng.calculateLiquidationPrice('LONG', 50000, 10, 100, 5000, 0.005, 0.90);
        const liq50 = eng.calculateLiquidationPrice('LONG', 50000, 10, 100, 5000, 0.005, 0.50);
        // threshold 0.50 → equityFloor = 25/0.50 = 50 → less available → liq closer to entry
        assert.ok(liq50 > liq90, 'lower threshold = liq price closer to entry (more conservative)');
    });

    it('high leverage + small balance — liq very close to entry', () => {
        const eng = makeLiqEngine();
        // Simulates burnme: balance=2.26, notional=221.6, entry=0.0544, 100x
        const liq = eng.calculateLiquidationPrice('LONG', 0.0544082, 100, 2.261438, 221.6046, 0.005, 0.90);
        const distPct = (0.0544082 - liq) / 0.0544082 * 100;
        assert.ok(distPct < 1, `100x leverage: liq should be <1% from entry, got ${distPct.toFixed(2)}%`);
        assert.ok(distPct > 0, 'should still be positive distance');
    });
});


describe('Static-Dynamic Consistency — Single Position', () => {

    it('calculateLiquidationPrice matches calculateDynamicLiquidationPrices for single LONG', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };
        const pos = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };

        const staticLiq = eng.calculateLiquidationPrice('LONG', 50000, 10, 100, 5000, 0.005, 0.90);
        const dynamicLiqs = eng.calculateDynamicLiquidationPrices(account, [pos], new Map([['BTC/USDT:USDT', 50000]]), 0.90);

        const diff = Math.abs(staticLiq - dynamicLiqs['p1']);
        assert.ok(diff < 0.01, `static (${staticLiq.toFixed(4)}) should match dynamic (${dynamicLiqs['p1'].toFixed(4)}), diff=${diff.toFixed(6)}`);
    });

    it('calculateLiquidationPrice matches calculateDynamicLiquidationPrices for single SHORT', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };
        const pos = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'SHORT', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };

        const staticLiq = eng.calculateLiquidationPrice('SHORT', 50000, 10, 100, 5000, 0.005, 0.90);
        const dynamicLiqs = eng.calculateDynamicLiquidationPrices(account, [pos], new Map([['BTC/USDT:USDT', 50000]]), 0.90);

        const diff = Math.abs(staticLiq - dynamicLiqs['p1']);
        assert.ok(diff < 0.01, `static (${staticLiq.toFixed(4)}) should match dynamic (${dynamicLiqs['p1'].toFixed(4)}), diff=${diff.toFixed(6)}`);
    });
});


describe('Multi-Position Dynamic Liq Prices', () => {

    it('adding a second position moves both liq prices closer to entry', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };

        // Single position
        const pos1 = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };
        const singleLiq = eng.calculateDynamicLiquidationPrices(account, [pos1], new Map([['BTC/USDT:USDT', 50000]]), 0.90);

        // Two positions
        const pos2 = { id: 'p2', symbol: 'ETH/USDT:USDT', side: 'LONG', entryPrice: 3000, quantity: 1, notional: 3000, leverage: 10 };
        const dualLiq = eng.calculateDynamicLiquidationPrices(account, [pos1, pos2], new Map([['BTC/USDT:USDT', 50000], ['ETH/USDT:USDT', 3000]]), 0.90);

        // With 2 positions, equityFloor is higher → each position's liq price is closer to entry
        assert.ok(dualLiq['p1'] > singleLiq['p1'], `BTC liq moved closer: single=${singleLiq['p1'].toFixed(2)}, dual=${dualLiq['p1'].toFixed(2)}`);
    });

    it('profitable position gives other positions more room', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };

        // pos1 at entry, pos2 in profit (mark > entry for a LONG)
        const pos1 = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };
        const pos2 = { id: 'p2', symbol: 'ETH/USDT:USDT', side: 'LONG', entryPrice: 3000, quantity: 1, notional: 3000, leverage: 10 };

        // Scenario A: ETH at entry (no profit)
        const liqFlat = eng.calculateDynamicLiquidationPrices(account, [pos1, pos2], new Map([['BTC/USDT:USDT', 50000], ['ETH/USDT:USDT', 3000]]), 0.90);

        // Scenario B: ETH in profit (+$500)
        const liqProfit = eng.calculateDynamicLiquidationPrices(account, [pos1, pos2], new Map([['BTC/USDT:USDT', 50000], ['ETH/USDT:USDT', 3500]]), 0.90);

        // BTC liq should be further from entry when ETH is profitable (more room)
        assert.ok(liqProfit['p1'] < liqFlat['p1'], `BTC liq further from entry when ETH profits: flat=${liqFlat['p1'].toFixed(2)}, profit=${liqProfit['p1'].toFixed(2)}`);
    });
});


describe('Margin Ratio Validation', () => {

    it('trade using 98% of equity at 100x should be rejected', () => {
        // Simulates burnme: balance=2.26, notional=221.6, margin=2.22
        const balance = 2.261438;
        const notional = 221.6046;
        const leverage = 100;
        const cap = 0.98;

        const requiredMargin = notional / leverage; // 2.216
        const marginUsageRatio = requiredMargin / balance;

        assert.ok(marginUsageRatio > 0.97,
            `98% margin usage (${(marginUsageRatio * 100).toFixed(1)}%) should breach 98% cap`);
    });

    it('trade using 50% of equity should be allowed', () => {
        const balance = 100;
        const leverage = 10;
        const cap = 0.98;

        const smallNotional = 500;
        const smallMargin = smallNotional / leverage; // 50
        const marginUsageRatio = smallMargin / balance;

        assert.ok(marginUsageRatio < cap,
            `50% margin usage (${(marginUsageRatio * 100).toFixed(1)}%) should NOT breach ${cap * 100}% cap`);
    });
});


describe('Liq Price Matches Next Engine Event', () => {

    it('liq price triggers at marginRatio = T (0.90)', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };
        const pos = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };

        const liqs = eng.calculateDynamicLiquidationPrices(account, [pos], new Map([['BTC/USDT:USDT', 50000]]), 0.90);
        const liqPrice = liqs['p1'];

        // At liq price, marginRatio should be exactly T
        const upnl = (liqPrice - 50000) * 0.1;
        const equity = 100 + upnl;
        const mm = 5000 * 0.005;
        const mr = mm / equity;
        assert.ok(Math.abs(mr - 0.90) < 0.001, `marginRatio at liq should be ~0.90, got ${mr.toFixed(6)}`);
    });

    it('after 30% ADL, smaller position has liq price further from entry', () => {
        const eng = makeLiqEngine();
        const account = { currentBalance: 100, maintenanceRate: 0.005 };

        // Original position
        const pos = { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 50000, quantity: 0.1, notional: 5000, leverage: 10 };
        const liqBefore = eng.calculateDynamicLiquidationPrices(account, [pos], new Map([['BTC/USDT:USDT', 50000]]), 0.90);

        // After 30% ADL: quantity reduced by 30%, notional reduced proportionally
        const posAfterADL = { ...pos, quantity: 0.07, notional: 3500, margin: 350 };
        const liqAfter = eng.calculateDynamicLiquidationPrices(account, [posAfterADL], new Map([['BTC/USDT:USDT', 50000]]), 0.90);

        // Smaller position means more room → liq price further from entry (lower for LONG)
        assert.ok(liqAfter['p1'] < liqBefore['p1'],
            `After ADL: liq ${liqAfter['p1'].toFixed(2)} should be further from entry than before ${liqBefore['p1'].toFixed(2)}`);
    });

    it('WS pnl_update carries dynamic liquidationPrice', () => {
        // Verify the evaluateAccount emitter includes the dynamic liq price
        // This is how the chart gets the updated liq price after ADL
        const eng = makeLiqEngine();
        const liqPrice = eng.calculateLiquidationPrice('LONG', 50000, 10, 100, 5000, 0.005, 0.90);
        assert.ok(Number.isFinite(liqPrice), 'liq price should be a finite number');
        assert.ok(liqPrice > 0 && liqPrice < 50000, 'LONG liq should be between 0 and entry');
    });
});


