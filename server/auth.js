import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import dotenv from 'dotenv';
import prisma from './db/prisma.js';

dotenv.config();

if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET environment variable is not set. Refusing to start with a predictable secret.');
    console.error('       Set JWT_SECRET in your .env file:  JWT_SECRET=$(openssl rand -hex 32)');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

export async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

export function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY },
    );
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

export function generateApiKey() {
    return `pms_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Express middleware: JWT auth from Authorization header.
 * Sets req.user = { id, username, role }
 */
export function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const payload = verifyToken(header.slice(7));
    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = payload;
    next();
}

/**
 * Express middleware: requires admin role.
 * Must be used AFTER authMiddleware.
 */
export function adminMiddleware(req, res, next) {
    if (req.user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ── API key cache (avoids DB hit on every request) ──
const API_KEY_CACHE_TTL_MS = 60_000; // 60 seconds
const apiKeyCache = new Map(); // apiKey → { user, expires }

async function lookupApiKey(apiKey) {
    const cached = apiKeyCache.get(apiKey);
    if (cached && cached.expires > Date.now()) {
        return cached.user;
    }
    const user = await prisma.user.findUnique({ where: { apiKey } });
    if (user) {
        apiKeyCache.set(apiKey, { user, expires: Date.now() + API_KEY_CACHE_TTL_MS });
    } else {
        apiKeyCache.delete(apiKey);
    }
    return user;
}

/** Invalidate a cached API key (call after key regeneration or user status change). */
export function invalidateApiKeyCache(apiKey) {
    if (apiKey) apiKeyCache.delete(apiKey);
}

/**
 * Express middleware: authenticate via X-PMS-Key header (bot API key).
 * Falls back to JWT auth if no API key present.
 * Sets req.user and req.apiKeyUser (the full DB user object).
 */
export function botApiKeyMiddleware() {
    return async (req, res, next) => {
        const apiKey = req.headers['x-pms-key'];
        if (apiKey) {
            const user = await lookupApiKey(apiKey);
            if (!user) {
                return res.status(401).json({ error: 'Invalid API key' });
            }
            if (user.status !== 'APPROVED') {
                return res.status(403).json({ error: 'Account not approved' });
            }
            req.user = { id: user.id, username: user.username, role: user.role };
            req.apiKeyUser = user;
            return next();
        }
        // Fall back to JWT
        return authMiddleware(req, res, next);
    };
}

/**
 * Flexible middleware: allows both JWT and API key auth.
 * For routes that both the web UI and bots access.
 */
export function flexAuthMiddleware() {
    return async (req, res, next) => {
        const apiKey = req.headers['x-pms-key'];
        const authHeader = req.headers.authorization;

        if (apiKey) {
            const user = await lookupApiKey(apiKey);
            if (!user) return res.status(401).json({ error: 'Invalid API key' });
            if (user.status !== 'APPROVED') return res.status(403).json({ error: 'Account not approved' });
            req.user = { id: user.id, username: user.username, role: user.role };
            return next();
        }

        if (authHeader?.startsWith('Bearer ')) {
            const payload = verifyToken(authHeader.slice(7));
            if (!payload) return res.status(401).json({ error: 'Invalid token' });
            req.user = payload;
            return next();
        }

        return res.status(401).json({ error: 'Authentication required' });
    };
}


