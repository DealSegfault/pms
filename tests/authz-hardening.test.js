/**
 * AuthZ Hardening Regression Tests
 * Verifies that authorization guards are correctly enforced:
 *   - Admin endpoints reject non-admin users (403)
 *   - Bot/trade endpoints reject cross-account access (403)
 *
 * Run: node --test tests/authz-hardening.test.js
 * Requires server running on localhost:3900
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { request, setupTestUsers, getAdminToken, getUserToken } from './helper.js';

let adminToken, userToken;
let adminAccountId, userAccountId;

before(async () => {
    const setup = await setupTestUsers();
    adminToken = setup.adminToken;
    userToken = setup.userToken;

    if (!userToken) {
        console.warn('⚠️  Could not create test user — some authz tests will be skipped');
    }

    // Create a sub-account owned by admin
    const adminAcct = await request('/api/sub-accounts', {
        method: 'POST',
        token: adminToken,
        body: { name: `AuthZ Admin ${Date.now()}`, initialBalance: 100, type: 'USER' },
    });
    if (adminAcct.ok) adminAccountId = adminAcct.data.id;

    // Create a sub-account owned by testUser (if available)
    if (userToken) {
        const userAcct = await request('/api/sub-accounts', {
            method: 'POST',
            token: userToken,
            body: { name: `AuthZ User ${Date.now()}`, initialBalance: 100, type: 'USER' },
        });
        if (userAcct.ok) userAccountId = userAcct.data.id;
    }
});

// ── Admin endpoint protection ────────────────────────

describe('AuthZ — Admin endpoints require admin role', () => {
    it('GET /api/admin/dashboard → 403 for non-admin', async () => {
        if (!userToken) return;
        const res = await request('/api/admin/dashboard', { token: userToken });
        assert.equal(res.status, 403, 'Non-admin should be rejected');
    });

    it('POST /api/admin/freeze/:id → 403 for non-admin', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/admin/freeze/${adminAccountId}`, {
            method: 'POST',
            token: userToken,
        });
        assert.equal(res.status, 403);
    });

    it('POST /api/admin/set-balance/:id → 403 for non-admin', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/admin/set-balance/${adminAccountId}`, {
            method: 'POST',
            token: userToken,
            body: { balance: 999999 },
        });
        assert.equal(res.status, 403);
    });

    it('GET /api/admin/all-positions → 403 for non-admin', async () => {
        if (!userToken) return;
        const res = await request('/api/admin/all-positions', { token: userToken });
        assert.equal(res.status, 403);
    });

    it('GET /api/admin/at-risk → 403 for non-admin', async () => {
        if (!userToken) return;
        const res = await request('/api/admin/at-risk', { token: userToken });
        assert.equal(res.status, 403);
    });

    it('GET /api/admin/dashboard → 200 for admin', async () => {
        const res = await request('/api/admin/dashboard', { token: adminToken });
        assert.equal(res.status, 200);
    });
});

// ── Bot endpoint ownership ────────────────────────

describe('AuthZ — Bot endpoints enforce ownership', () => {
    it('GET /api/bot/config/:adminAccount → 403 for non-owner', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/bot/config/${adminAccountId}`, { token: userToken });
        assert.equal(res.status, 403);
    });

    it('PUT /api/bot/config/:adminAccount → 403 for non-owner', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/bot/config/${adminAccountId}`, {
            method: 'PUT',
            token: userToken,
            body: { maxNotional: 50 },
        });
        assert.equal(res.status, 403);
    });

    it('POST /api/bot/toggle/:adminAccount → 403 for non-owner', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/bot/toggle/${adminAccountId}`, {
            method: 'POST',
            token: userToken,
        });
        assert.equal(res.status, 403);
    });

    it('GET /api/bot/status/:adminAccount → 403 for non-owner', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request(`/api/bot/status/${adminAccountId}`, { token: userToken });
        assert.equal(res.status, 403);
    });

    it('POST /api/bot/babysitter/enable → 403 for non-owner', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request('/api/bot/babysitter/enable', {
            method: 'POST',
            token: userToken,
            body: { subAccountId: adminAccountId },
        });
        assert.equal(res.status, 403);
    });

    it('GET /api/bot/config/:ownAccount → 200 for owner', async () => {
        if (!userToken || !userAccountId) return;
        const res = await request(`/api/bot/config/${userAccountId}`, { token: userToken });
        assert.equal(res.status, 200);
    });
});

// ── Trade endpoint ownership ────────────────────────

describe('AuthZ — Trade endpoints enforce ownership', () => {
    it('POST /api/trade/validate → 403 for non-owner subAccountId', async () => {
        if (!userToken || !adminAccountId) return;
        const res = await request('/api/trade/validate', {
            method: 'POST',
            token: userToken,
            body: {
                subAccountId: adminAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.001,
                leverage: 10,
            },
        });
        assert.equal(res.status, 403);
    });

    it('POST /api/trade/validate → 200 for own subAccountId', async () => {
        if (!userToken || !userAccountId) return;
        const res = await request('/api/trade/validate', {
            method: 'POST',
            token: userToken,
            body: {
                subAccountId: userAccountId,
                symbol: 'BTC/USDT:USDT',
                side: 'LONG',
                quantity: 0.001,
                leverage: 10,
            },
        });
        assert.equal(res.status, 200);
    });
});

// ── Unauthenticated access ────────────────────────

describe('AuthZ — Unauthenticated requests rejected', () => {
    it('GET /api/admin/dashboard → 401 without token', async () => {
        const res = await request('/api/admin/dashboard');
        assert.equal(res.status, 401);
    });

    it('GET /api/bot/config/fake → 401 without token', async () => {
        const res = await request('/api/bot/config/fake');
        assert.equal(res.status, 401);
    });
});
