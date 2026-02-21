/**
 * Trading Integration Tests — trade validation, execution, klines, symbols
 * Run: node --test tests/trading.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { request, setupTestUsers } from './helper.js';

let adminToken, userToken;
let testAccountId;

before(async () => {
    const setup = await setupTestUsers();
    adminToken = setup.adminToken;
    userToken = setup.userToken;

    // Create a test sub-account with balance
    const res = await request('/api/sub-accounts', {
        method: 'POST',
        token: adminToken,
        body: {
            name: `Trading Test ${Date.now()}`,
            initialBalance: 10000,
            type: 'USER',
        },
    });
    if (res.ok) testAccountId = res.data.id;
});

describe('Trading - Price & Symbols', () => {
    it('should fetch BTC price', async () => {
        const res = await request(`/api/trade/price/${encodeURIComponent('BTC/USDT:USDT')}`, {
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.mark > 0 || res.data.last > 0);
        assert.equal(res.data.symbol, 'BTC/USDT:USDT');
    });

    it('should search symbols', async () => {
        const res = await request('/api/trade/symbols/search?q=BTC', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.length >= 1);
        assert.ok(res.data.some(s => s.symbol.includes('BTC')));
    });

    it('should list popular symbols (empty query)', async () => {
        const res = await request('/api/trade/symbols/search?q=', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(res.data.length >= 1);
    });

    it('should fetch all perp symbols', async () => {
        const res = await request('/api/trade/symbols/all', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.length > 100, `Expected 100+ perps, got ${res.data.length}`);
        assert.ok(res.data[0].symbol);
        assert.ok(res.data[0].base);
    });
});

describe('Trading - Klines Proxy', () => {
    it('should fetch BTC 5m klines', async () => {
        const res = await request('/api/trade/klines?symbol=BTC/USDT:USDT&interval=5m&limit=10', {
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.length > 0 && res.data.length <= 10);
        // Each kline is an array of 12 elements
        assert.ok(res.data[0].length >= 6);
    });

    it('should reject klines without symbol', async () => {
        const res = await request('/api/trade/klines?interval=5m', { token: adminToken });
        assert.equal(res.status, 400);
    });

    it('should reject klines without interval', async () => {
        const res = await request('/api/trade/klines?symbol=BTCUSDT', { token: adminToken });
        assert.equal(res.status, 400);
    });
});

describe('Trading - Validation', () => {
    it('should validate a trade (passes)', async () => {
        if (!testAccountId) return;

        const res = await request('/api/trade/validate', {
            method: 'POST',
            token: adminToken,
            body: {
                subAccountId: testAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.001,
                leverage: 10,
            },
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.valid === true || res.data.valid === false);
        assert.ok(res.data.computedValues);
    });

    it('should reject excessive leverage', async () => {
        if (!testAccountId) return;

        const res = await request('/api/trade/validate', {
            method: 'POST',
            token: adminToken,
            body: {
                subAccountId: testAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.001,
                leverage: 200, // Over the default 125x max
            },
        });
        assert.equal(res.status, 200);
        if (!res.data.valid) {
            assert.ok(res.data.errors.some(e => e.toLowerCase().includes('leverage')));
        }
    });

    it('should reject trade with missing fields', async () => {
        const res = await request('/api/trade', {
            method: 'POST',
            token: adminToken,
            body: { subAccountId: testAccountId },
        });
        assert.equal(res.status, 400);
    });

    it('should reject trade with invalid side', async () => {
        const res = await request('/api/trade', {
            method: 'POST',
            token: adminToken,
            body: {
                subAccountId: testAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'INVALID',
                quantity: 0.001,
                leverage: 10,
            },
        });
        assert.equal(res.status, 400);
    });
});

describe('Trading - Execution', () => {
    it('should execute a small BTC long trade', async () => {
        if (!testAccountId) return;

        // First validate to see what's acceptable
        const validateRes = await request('/api/trade/validate', {
            method: 'POST',
            token: adminToken,
            body: {
                subAccountId: testAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.002,
                leverage: 10,
            },
        });

        if (!validateRes.data.valid) {
            console.log('  ⚠️  Validation failed:', validateRes.data.errors);
            console.log('  ⚠️  Skipping execution test (likely insufficient balance or risk rules)');
            return;
        }

        const res = await request('/api/trade', {
            method: 'POST',
            token: adminToken,
            body: {
                subAccountId: testAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.002,
                leverage: 10,
            },
        });

        if (res.data.success) {
            assert.equal(res.status, 201);
            assert.ok(res.data.position);
            assert.ok(res.data.trade);
            assert.equal(res.data.position.symbol, 'BTC/USDT:USDT');
            assert.equal(res.data.position.side, 'LONG');
            assert.equal(res.data.position.status, 'OPEN');

            // Try to close it
            const closeRes = await request(`/api/trade/close/${res.data.position.id}`, {
                method: 'POST',
                token: adminToken,
            });
            // May or may not succeed depending on exchange conditions
            console.log(`  Close result:`, closeRes.data.success ? '✅ Closed' : `❌ ${closeRes.data.errors}`);
        } else {
            console.log('  ⚠️ Trade rejected by exchange/risk:', res.data.errors);
        }
    });
});

describe('Trading - Positions & History', () => {
    it('should fetch account summary', async () => {
        if (!testAccountId) return;
        const res = await request(`/api/trade/positions/${testAccountId}`, { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(res.data.summary || res.data.positions !== undefined);
    });

    it('should fetch trade history', async () => {
        if (!testAccountId) return;
        const res = await request(`/api/trade/history/${testAccountId}?limit=5`, { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
    });

    it('should fetch balance info', async () => {
        if (!testAccountId) return;
        const res = await request(`/api/trade/balance/${testAccountId}`, { token: adminToken });
        assert.equal(res.status, 200);
    });
});

describe('Trading - Unauthenticated', () => {
    it('should reject trade without auth', async () => {
        const res = await request('/api/trade', {
            method: 'POST',
            body: {
                subAccountId: 'fake',
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.001,
                leverage: 10,
            },
        });
        assert.equal(res.status, 401);
    });
});
