import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiquidationEngine } from '../server/risk/liquidation.js';

function approxEqual(a, b, epsilon = 1e-6) {
    assert.ok(Math.abs(a - b) <= epsilon, `expected ${a} ≈ ${b} (±${epsilon})`);
}

describe('Cross-Margin Liquidation Pricing', () => {
    it('moves one position liquidation closer when another position loses', () => {
        const engine = new LiquidationEngine({ getEntry: () => null }, { getPrice: () => null });
        const account = { currentBalance: 100, maintenanceRate: 0.005 };
        const positions = [
            { id: 'p-btc', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 100, quantity: 1, notional: 100 },
            { id: 'p-eth', symbol: 'ETH/USDT:USDT', side: 'LONG', entryPrice: 100, quantity: 1, notional: 100 },
        ];

        const stableMarks = new Map([
            ['BTC/USDT:USDT', 100],
            ['ETH/USDT:USDT', 100],
        ]);
        const stressedMarks = new Map([
            ['BTC/USDT:USDT', 100],
            ['ETH/USDT:USDT', 50], // ETH loss consumes account equity
        ]);

        const stable = engine.calculateDynamicLiquidationPrices(account, positions, stableMarks, 0.90);
        const stressed = engine.calculateDynamicLiquidationPrices(account, positions, stressedMarks, 0.90);

        assert.ok(stressed['p-btc'] > stable['p-btc'], 'BTC liquidation should move closer as ETH loses');
        approxEqual(stable['p-btc'], 1.1111111111111112);
        approxEqual(stressed['p-btc'], 51.111111111111114);
    });

    it('uses threshold in liquidation price (lower threshold => earlier liquidation)', () => {
        const engine = new LiquidationEngine({ getEntry: () => null }, { getPrice: () => null });
        const account = { currentBalance: 100, maintenanceRate: 0.005 };
        const positions = [
            { id: 'p1', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 100, quantity: 1, notional: 100 },
        ];
        const marks = new Map([['BTC/USDT:USDT', 100]]);

        const liqAt090 = engine.calculateDynamicLiquidationPrices(account, positions, marks, 0.90)['p1'];
        const liqAt070 = engine.calculateDynamicLiquidationPrices(account, positions, marks, 0.70)['p1'];

        assert.ok(liqAt070 > liqAt090, 'lower threshold should produce an earlier (closer) liquidation price');
    });

    it('account-level liquidation price matches dynamic price of largest position', () => {
        const engine = new LiquidationEngine({ getEntry: () => null }, { getPrice: () => null });
        const account = { currentBalance: 120, maintenanceRate: 0.005 };
        const positions = [
            { id: 'small', symbol: 'ETH/USDT:USDT', side: 'LONG', entryPrice: 100, quantity: 1, notional: 100 },
            { id: 'large', symbol: 'BTC/USDT:USDT', side: 'LONG', entryPrice: 100, quantity: 2, notional: 200 },
        ];
        const marks = new Map([
            ['ETH/USDT:USDT', 80],
            ['BTC/USDT:USDT', 100],
        ]);

        const byPosition = engine.calculateDynamicLiquidationPrices(account, positions, marks, 0.90);
        const accountLiq = engine.calculateAccountLiqPrice(account, positions, null, 0.90, marks);

        approxEqual(accountLiq, byPosition.large);
    });
});
