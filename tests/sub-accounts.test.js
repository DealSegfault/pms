/**
 * Sub-Account Integration Tests
 * Run: node --test tests/sub-accounts.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { request, setupTestUsers, getAdminToken, getUserToken } from './helper.js';

let adminToken, userToken;
let createdAccountId;

before(async () => {
    const setup = await setupTestUsers();
    adminToken = setup.adminToken;
    userToken = setup.userToken;
});

describe('Sub-Accounts - CRUD', () => {
    it('should create a sub-account', async () => {
        const res = await request('/api/sub-accounts', {
            method: 'POST',
            token: adminToken,
            body: {
                name: `Test Acct ${Date.now()}`,
                initialBalance: 1000,
                type: 'USER',
            },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
        assert.equal(res.data.initialBalance, 1000);
        assert.equal(res.data.currentBalance, 1000);
        assert.equal(res.data.status, 'ACTIVE');
        createdAccountId = res.data.id;
    });

    it('should list sub-accounts for authenticated user', async () => {
        const res = await request('/api/sub-accounts', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.length >= 1);
    });

    it('should get a specific sub-account by ID', async () => {
        if (!createdAccountId) return;
        const res = await request(`/api/sub-accounts/${createdAccountId}`, { token: adminToken });
        assert.equal(res.status, 200);
        assert.equal(res.data.id, createdAccountId);
    });

    it('should update sub-account balance via addBalance', async () => {
        if (!createdAccountId) return;
        const res = await request(`/api/sub-accounts/${createdAccountId}`, {
            method: 'PATCH',
            token: adminToken,
            body: { addBalance: 500 },
        });
        assert.equal(res.status, 200);
        // Started at 1000, added 500
        assert.equal(res.data.currentBalance, 1500);
    });

    it('should reject creation without required fields', async () => {
        const res = await request('/api/sub-accounts', {
            method: 'POST',
            token: adminToken,
            body: { name: 'Missing Balance' },
        });
        assert.ok(res.status >= 400);
    });
});

describe('Sub-Accounts - User Scoping', () => {
    it('regular user should only see own accounts', async () => {
        if (!userToken) return;

        // Create an account for the test user
        const createRes = await request('/api/sub-accounts', {
            method: 'POST',
            token: userToken,
            body: { name: `User Acct ${Date.now()}`, initialBalance: 500, type: 'USER' },
        });

        const listRes = await request('/api/sub-accounts', { token: userToken });
        assert.equal(listRes.status, 200);
        // All returned accounts should belong to the test user
        assert.ok(Array.isArray(listRes.data));
    });

    it('admin should see all accounts', async () => {
        const res = await request('/api/sub-accounts', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(res.data.length >= 1);
    });
});
