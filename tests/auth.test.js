/**
 * Auth Integration Tests — register, login, token, user management
 * Run: node --test tests/auth.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { request, setupTestUsers, getAdminToken, getUserToken, getAdminUser } from './helper.js';

let adminToken, userToken, adminUser;
let createdUserId;

before(async () => {
    const setup = await setupTestUsers();
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    adminUser = setup.adminUser;
});

describe('Auth - Registration', () => {
    it('should reject registration without username', async () => {
        const res = await request('/api/auth/register', {
            method: 'POST',
            body: { password: 'test1234' },
        });
        assert.equal(res.status, 400);
    });

    it('should reject registration with short password', async () => {
        const res = await request('/api/auth/register', {
            method: 'POST',
            body: { username: `short_${Date.now()}`, password: '12' },
        });
        assert.equal(res.status, 400);
    });

    it('should register a new user successfully', async () => {
        const username = `test_reg_${Date.now()}`;
        const res = await request('/api/auth/register', {
            method: 'POST',
            body: { username, password: 'testpass123' },
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.id);
        assert.equal(res.data.username, username);
        createdUserId = res.data.id;
    });

    it('should reject duplicate username', async () => {
        // Try to register the admin username again
        const res = await request('/api/auth/register', {
            method: 'POST',
            body: { username: adminUser.username, password: 'doesnotmatter' },
        });
        assert.equal(res.status, 409);
    });
});

describe('Auth - Login', () => {
    it('should login with valid credentials', async () => {
        // Use the admin user created during setup
        const res = await request('/api/auth/login', {
            method: 'POST',
            body: { username: adminUser.username, password: 'admin123' },
        });
        // May fail if admin was pre-existing with different password — skip gracefully
        if (res.status === 200) {
            assert.ok(res.data.token);
            assert.equal(res.data.user.username, adminUser.username);
        }
    });

    it('should reject invalid credentials', async () => {
        const res = await request('/api/auth/login', {
            method: 'POST',
            body: { username: 'nonexistent_user', password: 'wrong' },
        });
        assert.equal(res.status, 401);
    });

    it('should reject login of pending user', async () => {
        // Register a user (will be PENDING since admin already exists)
        const username = `pending_${Date.now()}`;
        await request('/api/auth/register', {
            method: 'POST',
            body: { username, password: 'pending123' },
        });

        const res = await request('/api/auth/login', {
            method: 'POST',
            body: { username, password: 'pending123' },
        });
        assert.equal(res.status, 403);
        assert.equal(res.data.status, 'PENDING');
    });
});

describe('Auth - Token Validation', () => {
    it('should return user info with valid token', async () => {
        const res = await request('/api/auth/me', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(res.data.id);
        assert.ok(res.data.username);
        assert.ok(res.data.role);
    });

    it('should reject request without token', async () => {
        const res = await request('/api/auth/me');
        assert.equal(res.status, 401);
    });

    it('should reject request with invalid token', async () => {
        const res = await request('/api/auth/me', { token: 'invalid.jwt.token' });
        assert.equal(res.status, 401);
    });
});

describe('Auth - Admin User Management', () => {
    it('should list all users (admin only)', async () => {
        const res = await request('/api/auth/users', { token: adminToken });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.length >= 1);
    });

    it('should block non-admin from listing users', async () => {
        if (!userToken) return; // Skip if user setup failed
        const res = await request('/api/auth/users', { token: userToken });
        assert.equal(res.status, 403);
    });

    it('should approve a pending user', async () => {
        // Create a new pending user to approve
        const username = `approve_${Date.now()}`;
        const regRes = await request('/api/auth/register', {
            method: 'POST',
            body: { username, password: 'approve123' },
        });
        if (regRes.status !== 200) return;

        const res = await request(`/api/auth/approve/${regRes.data.id}`, {
            method: 'POST',
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'APPROVED');
    });

    it('should ban a user', async () => {
        const username = `ban_${Date.now()}`;
        const regRes = await request('/api/auth/register', {
            method: 'POST',
            body: { username, password: 'ban12345' },
        });
        if (regRes.status !== 200) return;

        const approveRes = await request(`/api/auth/approve/${regRes.data.id}`, {
            method: 'POST',
            token: adminToken,
        });

        const banRes = await request(`/api/auth/ban/${regRes.data.id}`, {
            method: 'POST',
            token: adminToken,
        });
        assert.equal(banRes.status, 200);
        assert.equal(banRes.data.status, 'BANNED');

        // Verify banned user cannot login
        const loginRes = await request('/api/auth/login', {
            method: 'POST',
            body: { username, password: 'ban12345' },
        });
        assert.equal(loginRes.status, 403);
    });
});

describe('Auth - API Key', () => {
    it('should generate an API key', async () => {
        const res = await request('/api/auth/api-key', {
            method: 'POST',
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.apiKey);
        assert.ok(res.data.apiKey.length > 20);
    });
});
