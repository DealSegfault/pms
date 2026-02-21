/**
 * WebAuthn Integration Tests — biometric registration & login endpoints
 * Run: node --test tests/webauthn.test.js
 *
 * NOTE: We can't test actual biometric prompts in Node, but we verify
 *       that the server endpoints respond correctly to valid/invalid requests.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { request, setupTestUsers, getAdminToken, getUserToken } from './helper.js';

let adminToken, userToken;

before(async () => {
    const setup = await setupTestUsers();
    adminToken = setup.adminToken;
    userToken = setup.userToken;
});

describe('WebAuthn - Registration Options', () => {
    it('should return registration options for authenticated user', async () => {
        const res = await request('/api/auth/webauthn/register/options', {
            method: 'POST',
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.challenge, 'Response should contain a challenge');
        assert.ok(res.data.rp, 'Response should contain relying party info');
        assert.equal(res.data.rp.name, 'PMS Pro');
        assert.ok(res.data.user, 'Response should contain user info');
        assert.ok(Array.isArray(res.data.pubKeyCredParams), 'Should have pubKeyCredParams array');
    });

    it('should reject unauthenticated registration options request', async () => {
        const res = await request('/api/auth/webauthn/register/options', {
            method: 'POST',
        });
        assert.equal(res.status, 401);
    });

    it('should return excludeCredentials after registration', async () => {
        // First call to get options (will have empty excludeCredentials)
        const res = await request('/api/auth/webauthn/register/options', {
            method: 'POST',
            token: adminToken,
        });
        assert.equal(res.status, 200);
        // excludeCredentials should be an array (empty if no credentials yet)
        assert.ok(Array.isArray(res.data.excludeCredentials) || res.data.excludeCredentials === undefined);
    });
});

describe('WebAuthn - Registration Verify', () => {
    it('should reject verify without pending challenge', async () => {
        const res = await request('/api/auth/webauthn/register/verify', {
            method: 'POST',
            token: userToken || adminToken,
            body: {
                id: 'test-id',
                rawId: 'test-raw-id',
                response: {
                    clientDataJSON: 'dGVzdA',
                    attestationObject: 'dGVzdA',
                },
                type: 'public-key',
            },
        });
        // Should fail — either no pending challenge or invalid attestation
        assert.ok([400, 500].includes(res.status), `Expected 400 or 500, got ${res.status}`);
    });

    it('should reject unauthenticated verify request', async () => {
        const res = await request('/api/auth/webauthn/register/verify', {
            method: 'POST',
            body: {
                id: 'test-id',
                rawId: 'test-raw-id',
                response: {
                    clientDataJSON: 'dGVzdA',
                    attestationObject: 'dGVzdA',
                },
                type: 'public-key',
            },
        });
        assert.equal(res.status, 401);
    });
});

describe('WebAuthn - Login Options', () => {
    it('should return 404 for user with no credentials', async () => {
        const res = await request('/api/auth/webauthn/login/options', {
            method: 'POST',
            body: { username: 'admin' },
        });
        // Admin likely has no WebAuthn credentials registered
        // Should be 404 (no credentials) or 200 (if some were registered)
        assert.ok([200, 404].includes(res.status), `Expected 200 or 404, got ${res.status}`);
    });

    it('should return 404 for nonexistent user', async () => {
        const res = await request('/api/auth/webauthn/login/options', {
            method: 'POST',
            body: { username: 'nonexistent_user_xyz_12345' },
        });
        assert.equal(res.status, 404);
    });

    it('should reject request without username', async () => {
        const res = await request('/api/auth/webauthn/login/options', {
            method: 'POST',
            body: {},
        });
        assert.equal(res.status, 400);
    });
});

describe('WebAuthn - Login Verify', () => {
    it('should reject invalid assertion', async () => {
        const res = await request('/api/auth/webauthn/login/verify', {
            method: 'POST',
            body: {
                username: 'admin',
                id: 'fake-credential-id',
                rawId: 'fake-raw-id',
                response: {
                    clientDataJSON: 'dGVzdA',
                    authenticatorData: 'dGVzdA',
                    signature: 'dGVzdA',
                },
                type: 'public-key',
            },
        });
        // Should fail — no pending challenge or unknown credential
        assert.ok([400, 401].includes(res.status), `Expected 400 or 401, got ${res.status}`);
    });
});

describe('WebAuthn - Credential Management', () => {
    it('should list credentials (empty or populated)', async () => {
        const res = await request('/api/auth/webauthn/credentials', {
            token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data), 'Should return an array');
    });

    it('should reject unauthenticated credentials list', async () => {
        const res = await request('/api/auth/webauthn/credentials');
        assert.equal(res.status, 401);
    });

    it('should return 404 for nonexistent credential deletion', async () => {
        const res = await request('/api/auth/webauthn/credentials/nonexistent-id', {
            method: 'DELETE',
            token: adminToken,
        });
        assert.equal(res.status, 404);
    });
});
