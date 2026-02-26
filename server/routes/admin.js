import { Router } from 'express';
import riskEngine, { prisma } from '../risk/index.js';
import { closePositionViaCpp, closeAllPositionsViaCpp } from './trading/close-utils.js';
import { getRiskSnapshot } from '../redis.js';
import { sanitize } from '../sanitize.js';
import { validate } from '../middleware/validate.js';
import {
    SetBalanceBody, LiquidationModeBody, PositionIdParam,
    SubAccountIdParam, BalanceLogQuery,
} from '../contracts/admin.contracts.js';

const router = Router();

// GET /api/admin/dashboard - Overview of all sub-accounts
router.get('/dashboard', async (req, res) => {
    try {
        const accounts = await prisma.subAccount.findMany({
            include: {
                riskRule: true,
                positions: { where: { status: 'OPEN' } },
            },
        });

        const dashboard = [];
        for (const acct of accounts) {
            const summary = await riskEngine.getAccountSummary(acct.id);
            dashboard.push(summary);
        }

        // Get main account balance from exchange
        let mainBalance = null;
        try {
            const { default: exchange } = await import('../exchange.js');
            mainBalance = await exchange.fetchBalance();
        } catch { }

        res.json({ accounts: dashboard, mainAccountBalance: mainBalance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/force-close/:positionId - Force close any position
router.post('/force-close/:positionId', validate(PositionIdParam, 'params'), async (req, res) => {
    try {
        const result = await closePositionViaCpp(req.params.positionId, 'ADMIN_CLOSE');
        res.status(202).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/freeze/:subAccountId - Freeze trading
router.post('/freeze/:subAccountId', validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        const account = await prisma.subAccount.update({
            where: { id: req.params.subAccountId },
            data: { status: 'FROZEN' },
        });
        res.json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/unfreeze/:subAccountId - Unfreeze trading
router.post('/unfreeze/:subAccountId', validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        const account = await prisma.subAccount.update({
            where: { id: req.params.subAccountId },
            data: { status: 'ACTIVE' },
        });
        res.json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/force-close-all/:subAccountId - Force close all positions
router.post('/force-close-all/:subAccountId', validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        const result = await closeAllPositionsViaCpp(req.params.subAccountId, 'ADMIN_CLOSE');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/balance-log/:subAccountId - Audit trail
router.get('/balance-log/:subAccountId', validate(SubAccountIdParam, 'params'), validate(BalanceLogQuery, 'query'), async (req, res) => {
    try {
        const { limit } = req.query;
        const logs = await prisma.balanceLog.findMany({
            where: { subAccountId: req.params.subAccountId },
            orderBy: { timestamp: 'desc' },
            take: limit,
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/all-positions - All open positions across all accounts
router.get('/all-positions', async (req, res) => {
    try {
        const accounts = await prisma.subAccount.findMany({
            include: { positions: { where: { status: 'OPEN' } } },
        });
        const all = [];

        for (const acct of accounts) {
            const snapshot = await getRiskSnapshot(acct.id);
            const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;
            const hasSnapshotPositions = snapshotFresh && Array.isArray(snapshot.positions) && snapshot.positions.length > 0;

            if (!hasSnapshotPositions && (!acct.positions || acct.positions.length === 0)) {
                continue;
            }

            if (hasSnapshotPositions) {
                for (const p of snapshot.positions) {
                    all.push({
                        ...p,
                        subAccountId: acct.id,
                        status: 'OPEN',
                        subAccount: acct,
                    });
                }
                continue;
            }

            const summary = await riskEngine.getAccountSummary(acct.id);
            for (const p of (summary?.positions || [])) {
                all.push({
                    ...p,
                    subAccountId: acct.id,
                    status: 'OPEN',
                    subAccount: acct,
                });
            }
        }

        res.json(sanitize(all));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/takeover/:positionId - Admin takeover of a position
router.post('/takeover/:positionId', validate(PositionIdParam, 'params'), async (req, res) => {
    try {
        const adminUserId = req.user?.id || 'admin';
        const result = await riskEngine.takeoverPosition(req.params.positionId, adminUserId);
        if (!result.success) {
            return res.status(400).json({ error: 'Takeover failed', reasons: result.errors });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/liquidation-mode/:subAccountId - Set liquidation mode
router.post('/liquidation-mode/:subAccountId', validate(SubAccountIdParam, 'params'), validate(LiquidationModeBody), async (req, res) => {
    try {
        const { mode } = req.body;
        const account = await prisma.subAccount.update({
            where: { id: req.params.subAccountId },
            data: { liquidationMode: mode },
        });
        res.json(sanitize(account));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/at-risk - Accounts near liquidation
router.get('/at-risk', async (req, res) => {
    try {
        const accounts = await prisma.subAccount.findMany({
            where: { status: 'ACTIVE' },
            include: { positions: { where: { status: 'OPEN' } } },
        });

        const atRisk = [];
        for (const acct of accounts) {
            if (acct.positions.length === 0) continue;
            const summary = await riskEngine.getAccountSummary(acct.id);
            if (summary && summary.summary.marginRatio >= 0.5) {
                atRisk.push(summary);
            }
        }
        res.json(atRisk);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/set-balance/:subAccountId - Admin set balance directly
router.post('/set-balance/:subAccountId', validate(SubAccountIdParam, 'params'), validate(SetBalanceBody), async (req, res) => {
    try {
        const { balance } = req.body;

        const account = await prisma.subAccount.findUnique({ where: { id: req.params.subAccountId } });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        const data = { currentBalance: balance };
        // If account is unfunded (initialBalance = 0), also set the starting point
        // so the equity curve begins at the correct value
        if (account.initialBalance === 0) {
            data.initialBalance = balance;
        }

        await prisma.subAccount.update({
            where: { id: req.params.subAccountId },
            data,
        });

        await prisma.balanceLog.create({
            data: {
                subAccountId: account.id,
                balanceBefore: account.currentBalance,
                balanceAfter: balance,
                changeAmount: balance - account.currentBalance,
                reason: 'ADMIN_SET',
            },
        });

        res.json({ success: true, previousBalance: account.currentBalance, newBalance: balance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/reset/:subAccountId - Full account reset (balance → $0, clear everything)
router.post('/reset/:subAccountId', validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        await prisma.$transaction([
            // Close all open positions
            prisma.virtualPosition.updateMany({
                where: { subAccountId, status: 'OPEN' },
                data: { status: 'CLOSED', realizedPnl: 0, closedAt: new Date() },
            }),
            // Delete trade history
            prisma.tradeExecution.deleteMany({ where: { subAccountId } }),
            // Delete balance logs
            prisma.balanceLog.deleteMany({ where: { subAccountId } }),
            // Delete pending orders
            prisma.pendingOrder.deleteMany({ where: { subAccountId } }),
            // Delete closed positions too (full wipe)
            prisma.virtualPosition.deleteMany({ where: { subAccountId } }),
            // Reset balances
            prisma.subAccount.update({
                where: { id: subAccountId },
                data: { currentBalance: 0, initialBalance: 0, status: 'ACTIVE' },
            }),
        ]);

        res.json({ success: true, message: `Account "${account.name}" fully reset` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/delete-account/:subAccountId - Cascade delete account + all related data
router.delete('/delete-account/:subAccountId', validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        const { subAccountId } = req.params;

        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        await prisma.$transaction([
            prisma.tradeExecution.deleteMany({ where: { subAccountId } }),
            prisma.balanceLog.deleteMany({ where: { subAccountId } }),
            prisma.pendingOrder.deleteMany({ where: { subAccountId } }),
            prisma.virtualPosition.deleteMany({ where: { subAccountId } }),
            prisma.riskRule.deleteMany({ where: { subAccountId } }),
            prisma.botConfig.deleteMany({ where: { subAccountId } }),
            prisma.subAccount.delete({ where: { id: subAccountId } }),
        ]);

        res.json({ success: true, message: `Account "${account.name}" deleted` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
