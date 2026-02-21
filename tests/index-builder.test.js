import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formulaToBuilderWeights,
    toggleBuilderSymbol,
    flipBuilderFactor,
    setBuilderFactor,
    normalizeBuilderWeights,
    equalizeBuilderWeights,
    summarizeBuilderWeights,
    validateIndexBuilderInput,
} from '../src/lib/index-builder.js';

test('formulaToBuilderWeights merges duplicate symbols and removes zero sums', () => {
    const out = formulaToBuilderWeights([
        { symbol: 'BTC/USDT', factor: 1 },
        { symbol: 'BTC/USDT', factor: -0.25 },
        { symbol: 'ETH/USDT', factor: -0.5 },
        { symbol: 'SOL/USDT', factor: 0 },
    ]);

    assert.deepEqual(out, [
        { symbol: 'BTC/USDT', factor: 0.75 },
        { symbol: 'ETH/USDT', factor: -0.5 },
    ]);
});

test('toggleBuilderSymbol adds then removes a symbol', () => {
    let state = [];
    state = toggleBuilderSymbol(state, 'BTC/USDT');
    assert.equal(state.length, 1);
    assert.equal(state[0].symbol, 'BTC/USDT');
    assert.equal(state[0].factor, 1);

    state = toggleBuilderSymbol(state, 'BTC/USDT');
    assert.equal(state.length, 0);
});

test('flipBuilderFactor and setBuilderFactor preserve long/short sign', () => {
    let state = [{ symbol: 'ETH/USDT', factor: 1 }];
    state = flipBuilderFactor(state, 'ETH/USDT');
    assert.equal(state[0].factor, -1);

    state = setBuilderFactor(state, 'ETH/USDT', 0.4);
    assert.equal(state[0].factor, -0.4);
});

test('normalizeBuilderWeights keeps signs and normalizes absolute total to 1', () => {
    const input = [
        { symbol: 'BTC/USDT', factor: 2 },
        { symbol: 'ETH/USDT', factor: -1 },
    ];

    const normalized = normalizeBuilderWeights(input);
    const summary = summarizeBuilderWeights(normalized);

    assert.equal(normalized[0].factor > 0, true);
    assert.equal(normalized[1].factor < 0, true);
    assert.equal(Math.abs(summary.sumWeights - 1) < 1e-10, true);
});

test('equalizeBuilderWeights uses equal absolute factors with original signs', () => {
    const out = equalizeBuilderWeights([
        { symbol: 'BTC/USDT', factor: 2 },
        { symbol: 'ETH/USDT', factor: -5 },
        { symbol: 'SOL/USDT', factor: 1 },
    ]);

    assert.equal(out[0].factor, 1 / 3);
    assert.equal(out[1].factor, -1 / 3);
    assert.equal(out[2].factor, 1 / 3);
});

test('validateIndexBuilderInput validates name and minimum symbols', () => {
    const missingName = validateIndexBuilderInput('   ', [{ symbol: 'BTC/USDT', factor: 1 }], 2);
    assert.equal(missingName.ok, false);

    const tooFew = validateIndexBuilderInput('My Index', [{ symbol: 'BTC/USDT', factor: 1 }], 2);
    assert.equal(tooFew.ok, false);

    const valid = validateIndexBuilderInput(
        ' Growth ',
        [
            { symbol: 'BTC/USDT', factor: 1 },
            { symbol: 'ETH/USDT', factor: -0.5 },
        ],
        2
    );

    assert.equal(valid.ok, true);
    assert.equal(valid.name, 'Growth');
    assert.equal(valid.formula.length, 2);
});
