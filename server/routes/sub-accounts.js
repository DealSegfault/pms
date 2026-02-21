import { Router } from 'express';
import { prisma } from '../risk/index.js';
import { sanitize } from '../sanitize.js';
import { requireOwnership } from '../ownership.js';
import { validate } from '../middleware/validate.js';
import { CreateSubAccountBody, PatchSubAccountBody, SubAccountIdParam } from '../contracts/sub-accounts.contracts.js';

const router = Router();

// GET /api/sub-accounts - List user's accounts (admin sees all)
router.get('/', async (req, res) => {
    try {
        const where = req.user?.role === 'ADMIN' ? {} : { userId: req.user?.id };
        const accounts = await prisma.subAccount.findMany({
            where,
            include: {
                riskRule: true,
                positions: { where: { status: 'OPEN' } },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(sanitize(accounts));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sub-accounts/:id
router.get('/:id', requireOwnership('params', 'id'), async (req, res) => {
    try {
        const account = await prisma.subAccount.findUnique({
            where: { id: req.params.id },
            include: {
                riskRule: true,
                positions: { where: { status: 'OPEN' } },
            },
        });
        if (!account) return res.status(404).json({ error: 'Not found' });
        res.json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sub-accounts - Create
router.post('/', validate(CreateSubAccountBody), async (req, res) => {
    try {
        const { name, initialBalance, type } = req.body;
        const account = await prisma.subAccount.create({
            data: {
                name,
                type,
                userId: req.user?.id || null,
                initialBalance,
                currentBalance: initialBalance,
            },
        });

        // Log initial deposit
        await prisma.balanceLog.create({
            data: {
                subAccountId: account.id,
                balanceBefore: 0,
                balanceAfter: account.currentBalance,
                changeAmount: account.currentBalance,
                reason: 'DEPOSIT',
            },
        });

        res.status(201).json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/sub-accounts/:id - Update
router.patch('/:id', requireOwnership('params', 'id'), validate(PatchSubAccountBody), async (req, res) => {
    try {
        const { name, addBalance, status } = req.body;
        const data = {};
        if (name) data.name = name;
        if (status) data.status = status;

        const account = await prisma.subAccount.findUnique({ where: { id: req.params.id } });
        if (!account) return res.status(404).json({ error: 'Not found' });

        if (addBalance != null) {
            data.currentBalance = account.currentBalance + addBalance;

            await prisma.balanceLog.create({
                data: {
                    subAccountId: account.id,
                    balanceBefore: account.currentBalance,
                    balanceAfter: data.currentBalance,
                    changeAmount: addBalance,
                    reason: addBalance > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
                },
            });
        }

        const updated = await prisma.subAccount.update({
            where: { id: req.params.id },
            data,
        });
        res.json(sanitize(updated));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/sub-accounts/:id - Deactivate
router.delete('/:id', requireOwnership('params', 'id'), async (req, res) => {
    try {
        const account = await prisma.subAccount.update({
            where: { id: req.params.id },
            data: { status: 'FROZEN' },
        });
        res.json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
