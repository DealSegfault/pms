/**
 * Test helper — shared HTTP client for integration tests
 * Assumes server is running on http://localhost:3900
 *
 * Idempotent: safe to run repeatedly without leftover state issues.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3900';

/** Stable test user name — reused across runs for idempotency */
const STABLE_TEST_USERNAME = 'pms_test_user';
const STABLE_TEST_PASSWORD = 'test1234';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

let adminToken = null;
let userToken = null;
let adminUser = null;
let testUser = null;
let _setupDone = false;

/**
 * HTTP request helper
 */
async function request(path, opts = {}) {
    const url = `${BASE_URL}${path}`;
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (opts.apiKey) headers['X-PMS-Key'] = opts.apiKey;

    const res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const data = await res.json().catch(() => null);
    return { status: res.status, data, ok: res.ok };
}

/**
 * Idempotent login-or-register helper.
 * Tries login first; if it fails, registers then logs in.
 * Handles PENDING status by auto-approving when adminToken is available.
 */
async function loginOrRegister(username, password, approveWith = null) {
    // 1) Try login first (idempotent — works if user already exists)
    const login = await request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
    });

    if (login.ok) {
        return { token: login.data.token, user: login.data.user };
    }

    // 2) If login says PENDING, approve and retry
    if (login.status === 403 && login.data?.status === 'PENDING' && approveWith) {
        // Need userId — fetch from admin user list
        const users = await request('/api/auth/users', { token: approveWith });
        if (users.ok) {
            const pending = users.data.find(u => u.username === username);
            if (pending) {
                await request(`/api/auth/approve/${pending.id}`, {
                    method: 'POST',
                    token: approveWith,
                });
                const retry = await request('/api/auth/login', {
                    method: 'POST',
                    body: { username, password },
                });
                if (retry.ok) return { token: retry.data.token, user: retry.data.user };
            }
        }
    }

    // 3) User doesn't exist — register
    const reg = await request('/api/auth/register', {
        method: 'POST',
        body: { username, password },
    });
    if (!reg.ok) throw new Error(`Registration failed for ${username}: ${JSON.stringify(reg.data)}`);

    // 4) Approve if PENDING and we have admin powers
    if (reg.data.status === 'PENDING' && approveWith) {
        await request(`/api/auth/approve/${reg.data.id}`, {
            method: 'POST',
            token: approveWith,
        });
    }

    // 5) Login after registration
    const postReg = await request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
    });
    if (!postReg.ok) throw new Error(`Login failed after register for ${username}: ${JSON.stringify(postReg.data)}`);

    return { token: postReg.data.token, user: postReg.data.user };
}

/**
 * Setup: login to existing admin + create & approve a stable test user.
 * Fully idempotent — safe to call multiple times or across repeated test runs.
 */
async function setupTestUsers() {
    if (_setupDone) return { adminToken, userToken, adminUser, testUser };

    // 1) Admin — login or register (first user auto-becomes admin)
    const admin = await loginOrRegister(ADMIN_USERNAME, ADMIN_PASSWORD);
    adminToken = admin.token;
    adminUser = admin.user;

    // 2) Stable test user — login or register + auto-approve
    try {
        const user = await loginOrRegister(STABLE_TEST_USERNAME, STABLE_TEST_PASSWORD, adminToken);
        userToken = user.token;
        testUser = user.user;
    } catch {
        // Non-fatal: some test suites work without a test user
    }

    _setupDone = true;
    return { adminToken, userToken, adminUser, testUser };
}

export { BASE_URL, request, setupTestUsers };
export function getAdminToken() { return adminToken; }
export function getUserToken() { return userToken; }
export function getAdminUser() { return adminUser; }
export function getTestUser() { return testUser; }
