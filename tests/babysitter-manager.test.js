/**
 * Babysitter manager behavior tests.
 *
 * Ensures account-level enable/disable controls remain consistent with
 * per-position babysitter inclusion flags.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { BabysitterManager } from '../server/bot/babysitter-manager.js';

const prisma = new PrismaClient();
const manager = new BabysitterManager();

const TEST_PREFIX = `bbs_manager_${Date.now()}`;
let userId;
let subAccountId;
let positionId;

async function runAllowingRedisUnavailable(fn) {
    try {
        await fn();
    } catch (err) {
        const msg = String(err?.message || '');
        if (!msg.includes('Redis unavailable')) {
            throw err;
        }
    }
}

before(async () => {
    const user = await prisma.user.create({
        data: {
            username: `${TEST_PREFIX}_user`,
            passwordHash: 'test_hash',
            role: 'USER',
            status: 'APPROVED',
        },
    });
    userId = user.id;

    const subAccount = await prisma.subAccount.create({
        data: {
            userId,
            name: `${TEST_PREFIX}_account`,
            initialBalance: 1000,
            currentBalance: 1000,
            type: 'ELO',
            status: 'ACTIVE',
        },
    });
    subAccountId = subAccount.id;

    await prisma.botConfig.upsert({
        where: { subAccountId },
        update: { babysitterEnabled: true },
        create: {
            subAccountId,
            babysitterEnabled: true,
            enabled: false,
        },
    });

    const position = await prisma.virtualPosition.create({
        data: {
            subAccountId,
            symbol: 'BBSMANAGER/USDT:USDT',
            side: 'LONG',
            entryPrice: 100,
            quantity: 1,
            notional: 100,
            leverage: 1,
            margin: 100,
            liquidationPrice: 0,
            status: 'OPEN',
            babysitterExcluded: false,
        },
    });
    positionId = position.id;
});

after(async () => {
    await prisma.tradeExecution.deleteMany({ where: { positionId } });
    await prisma.virtualPosition.deleteMany({ where: { id: positionId } });
    await prisma.balanceLog.deleteMany({ where: { subAccountId } });
    await prisma.botConfig.deleteMany({ where: { subAccountId } });
    await prisma.subAccount.deleteMany({ where: { id: subAccountId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
});

describe('BabysitterManager account-level controls', () => {
    it('disableUser should exclude open positions and stay disabled after refresh', async () => {
        await runAllowingRedisUnavailable(() => manager.disableUser(subAccountId));

        const positionAfterDisable = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { babysitterExcluded: true },
        });
        const configAfterDisable = await prisma.botConfig.findUnique({
            where: { subAccountId },
            select: { babysitterEnabled: true },
        });

        assert.equal(positionAfterDisable?.babysitterExcluded, true);
        assert.equal(configAfterDisable?.babysitterEnabled, false);

        await manager.refreshForSubAccount(subAccountId, 'test_disable_persist');

        const configAfterRefresh = await prisma.botConfig.findUnique({
            where: { subAccountId },
            select: { babysitterEnabled: true },
        });
        assert.equal(configAfterRefresh?.babysitterEnabled, false);
    });

    it('enableUser should include open positions and mark config enabled', async () => {
        await prisma.virtualPosition.update({
            where: { id: positionId },
            data: { babysitterExcluded: true },
        });
        await prisma.botConfig.update({
            where: { subAccountId },
            data: { babysitterEnabled: false },
        });

        await runAllowingRedisUnavailable(() => manager.enableUser(subAccountId));

        const positionAfterEnable = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { babysitterExcluded: true },
        });
        const configAfterEnable = await prisma.botConfig.findUnique({
            where: { subAccountId },
            select: { babysitterEnabled: true },
        });

        assert.equal(positionAfterEnable?.babysitterExcluded, false);
        assert.equal(configAfterEnable?.babysitterEnabled, true);
    });
});
