import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { TradeExecutor } from '../server/risk/trade-executor.js';

const prisma = new PrismaClient();
const TEST_PREFIX = `reconcile_balance_${Date.now()}`;
const TEST_SYMBOL = `${TEST_PREFIX.toUpperCase()}/USDT:USDT`;

const cleanupIds = {
    userId: null,
    subAccountId: null,
};

function makeExecutor() {
    const noop = () => { };
    const executor = new TradeExecutor(
        {},
        { remove: noop, updateBalance: noop, add: noop, updatePosition: noop },
        {},
        {},
    );

    // Disable async babysitter side effects in this test.
    executor._refreshBabysitter = noop;
    return executor;
}

describe('TradeExecutor reconcile balance consistency', () => {
    it('applies pnl cumulatively when reconciling multiple positions on one account', async () => {
        const user = await prisma.user.create({
            data: {
                username: `${TEST_PREFIX}_user`,
                passwordHash: 'test_hash',
                role: 'USER',
                status: 'APPROVED',
            },
        });
        cleanupIds.userId = user.id;

        const subAccount = await prisma.subAccount.create({
            data: {
                userId: user.id,
                name: `${TEST_PREFIX}_acct`,
                type: 'USER',
                initialBalance: 1000,
                currentBalance: 1000,
                status: 'ACTIVE',
            },
        });
        cleanupIds.subAccountId = subAccount.id;

        await prisma.virtualPosition.createMany({
            data: [
                {
                    subAccountId: subAccount.id,
                    symbol: TEST_SYMBOL,
                    side: 'LONG',
                    entryPrice: 100,
                    quantity: 1,
                    notional: 100,
                    leverage: 5,
                    margin: 20,
                    liquidationPrice: 50,
                    status: 'OPEN',
                },
                {
                    subAccountId: subAccount.id,
                    symbol: TEST_SYMBOL,
                    side: 'LONG',
                    entryPrice: 110,
                    quantity: 2,
                    notional: 220,
                    leverage: 5,
                    margin: 44,
                    liquidationPrice: 55,
                    status: 'OPEN',
                },
            ],
        });

        const executor = makeExecutor();
        const closePrice = 120;
        const result = await executor.reconcilePosition(TEST_SYMBOL, closePrice);

        assert.equal(result.closed, 2);

        const updatedAccount = await prisma.subAccount.findUnique({
            where: { id: subAccount.id },
            select: { currentBalance: true },
        });
        assert.ok(updatedAccount);
        assert.equal(updatedAccount.currentBalance, 1040);

        const logs = await prisma.balanceLog.findMany({
            where: { subAccountId: subAccount.id, reason: 'RECONCILE' },
            select: { changeAmount: true },
        });
        assert.equal(logs.length, 2);

        const totalChange = logs.reduce((sum, row) => sum + row.changeAmount, 0);
        assert.equal(totalChange, 40);
    });
});

after(async () => {
    if (cleanupIds.subAccountId) {
        await prisma.balanceLog.deleteMany({ where: { subAccountId: cleanupIds.subAccountId } });
        await prisma.tradeExecution.deleteMany({ where: { subAccountId: cleanupIds.subAccountId } });
        await prisma.virtualPosition.deleteMany({ where: { subAccountId: cleanupIds.subAccountId } });
        await prisma.botConfig.deleteMany({ where: { subAccountId: cleanupIds.subAccountId } });
        await prisma.subAccount.deleteMany({ where: { id: cleanupIds.subAccountId } });
    }

    if (cleanupIds.userId) {
        await prisma.user.deleteMany({ where: { id: cleanupIds.userId } });
    }

    await prisma.$disconnect();
});
