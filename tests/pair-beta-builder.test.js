import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computePairStatsFromSeries,
    computePairBasketWeights,
    weightsToFormula,
} from '../src/lib/pair-beta-builder.js';

test('computePairStatsFromSeries returns expected beta/corr for linear series', () => {
    const left = [
        { time: 1, close: 10 },
        { time: 2, close: 11 },
        { time: 3, close: 12 },
        { time: 4, close: 13 },
    ];
    const right = [
        { time: 1, close: 5 },
        { time: 2, close: 5.5 },
        { time: 3, close: 6 },
        { time: 4, close: 6.5 },
    ];

    const stats = computePairStatsFromSeries('BTC/ETH', left, right);
    assert.ok(stats);
    assert.equal(stats.pair, 'BTC/ETH');
    assert.equal(Math.abs(stats.corr - 1) < 1e-12, true);
    assert.equal(Math.abs(stats.beta - 2) < 1e-12, true);
    assert.equal(Math.abs(stats.ret) < 1e-12, true);
});

test('computePairBasketWeights matches Kingfisher pair long/short allocation logic', () => {
    const weights = computePairBasketWeights({
        basketLong: ['BTC/ETH'],
        basketShort: ['SOL/ADA'],
        tradeSize: 100,
        resolvePairBaseSymbol: (base) => `${base}/USDT:USDT`,
    });

    assert.deepEqual(weights, {
        'BTC/USDT:USDT': 25,
        'ETH/USDT:USDT': -25,
        'ADA/USDT:USDT': 25,
        'SOL/USDT:USDT': -25,
    });
});

test('weightsToFormula in kingfisher mode keeps relative sizing and normalizes around abs mean 1', () => {
    const formula = weightsToFormula({
        'BTC/USDT:USDT': 25,
        'ETH/USDT:USDT': -25,
        'ADA/USDT:USDT': 25,
        'SOL/USDT:USDT': -25,
    }, 'kingfisher');

    const bySymbol = Object.fromEntries(formula.map((x) => [x.symbol, x.factor]));
    assert.equal(bySymbol['BTC/USDT:USDT'], 1);
    assert.equal(bySymbol['ETH/USDT:USDT'], -1);
    assert.equal(bySymbol['ADA/USDT:USDT'], 1);
    assert.equal(bySymbol['SOL/USDT:USDT'], -1);
});
