/**
 * PostgreSQL Advisory Locks — replaces Redis SETNX for reconcile locks.
 *
 * Uses session-level advisory locks (pg_try_advisory_lock / pg_advisory_unlock)
 * which are non-blocking and auto-release on disconnect.
 *
 * Key differences from the old Redis approach:
 *  - No TTL needed — PG releases on disconnect (no forgotten-lock bugs)
 *  - No Redis dependency for this use case
 *  - Fail-closed: if PG is down, the lock acquisition fails (safe)
 */

import prisma from './prisma.js';

/**
 * hashKey: Convert a string to a 32-bit integer for PG advisory lock key.
 * PG advisory locks take bigint keys; we use hashtext() equivalent.
 */
function hashKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return hash;
}

/**
 * Try to acquire a session-level advisory lock (non-blocking).
 * Returns true if acquired, false if already held by another session.
 */
export async function acquireReconcileLock(key) {
    try {
        const lockId = hashKey(`reconcile:${key}`);
        const result = await prisma.$queryRawUnsafe(
            `SELECT pg_try_advisory_lock($1) AS acquired`, lockId
        );
        return result[0]?.acquired === true;
    } catch (err) {
        console.warn(`[PGLock] Lock acquire failed for ${key}: ${err.message} — failing CLOSED`);
        return false;
    }
}

/**
 * Release a session-level advisory lock.
 */
export async function releaseReconcileLock(key) {
    try {
        const lockId = hashKey(`reconcile:${key}`);
        await prisma.$queryRawUnsafe(
            `SELECT pg_advisory_unlock($1)`, lockId
        );
    } catch { /* best-effort */ }
}
