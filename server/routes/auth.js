import { Router } from 'express';
import prisma from '../db/prisma.js';
import {
    hashPassword, verifyPassword, generateToken, generateApiKey,
    authMiddleware, adminMiddleware, invalidateApiKeyCache,
} from '../auth.js';
import { validate } from '../middleware/validate.js';
import { RegisterBody, LoginBody, UserIdParam } from '../contracts/auth.contracts.js';

const router = Router();


// ── Public ────────────────────────────────────────

/** Register a new user (status = PENDING until admin approves) */
router.post('/register', validate(RegisterBody), async (req, res) => {
    try {
        const { username, password } = req.body;

        // Use a transaction to atomically check user count and create,
        // preventing a race where two requests both see count=0
        const user = await prisma.$transaction(async (tx) => {
            const existing = await tx.user.findUnique({ where: { username } });
            if (existing) return null; // signal conflict

            const count = await tx.user.count();
            const isFirst = count === 0;

            return tx.user.create({
                data: {
                    username,
                    passwordHash: await hashPassword(password),
                    role: isFirst ? 'ADMIN' : 'USER',
                    status: isFirst ? 'APPROVED' : 'PENDING',
                },
            });
        });

        if (!user) {
            return res.status(409).json({ error: 'Username already taken' });
        }

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            status: user.status,
            message: user.status === 'APPROVED' ? 'Account created and approved' : 'Registration submitted — awaiting admin approval',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Login → JWT */
router.post('/login', validate(LoginBody), async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await prisma.user.findUnique({ where: { username } });
        if (!user || !await verifyPassword(password, user.passwordHash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (user.status === 'BANNED') {
            return res.status(403).json({ error: 'Account banned' });
        }
        if (user.status === 'PENDING') {
            return res.status(403).json({ error: 'Account pending admin approval', status: 'PENDING' });
        }

        const token = generateToken(user);
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                status: user.status,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Authenticated ────────────────────────────────

/** Get current user info */
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { id: true, username: true, role: true, status: true, apiKey: true, createdAt: true },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Generate / regenerate bot API key for current user */
router.post('/api-key', authMiddleware, async (req, res) => {
    try {
        // Audit Fix #7: Invalidate old key from cache before generating new one
        const existing = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { apiKey: true },
        });
        if (existing?.apiKey) {
            invalidateApiKeyCache(existing.apiKey);
        }

        const apiKey = generateApiKey();
        await prisma.user.update({
            where: { id: req.user.id },
            data: { apiKey },
        });
        res.json({ apiKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin ────────────────────────────────────────

/** List all users */
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true, username: true, role: true, status: true,
                apiKey: true, createdAt: true,
                subAccounts: { select: { id: true, name: true, type: true, status: true, currentBalance: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Approve a user */
router.post('/approve/:userId', authMiddleware, adminMiddleware, validate(UserIdParam, 'params'), async (req, res) => {
    try {
        const user = await prisma.user.update({
            where: { id: req.params.userId },
            data: { status: 'APPROVED' },
        });
        res.json({ id: user.id, username: user.username, status: user.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Ban a user */
router.post('/ban/:userId', authMiddleware, adminMiddleware, validate(UserIdParam, 'params'), async (req, res) => {
    try {
        // Audit Fix #7: Invalidate API key cache immediately on ban
        const existing = await prisma.user.findUnique({
            where: { id: req.params.userId },
            select: { apiKey: true },
        });
        if (existing?.apiKey) {
            invalidateApiKeyCache(existing.apiKey);
        }

        const user = await prisma.user.update({
            where: { id: req.params.userId },
            data: { status: 'BANNED' },
        });
        res.json({ id: user.id, username: user.username, status: user.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
