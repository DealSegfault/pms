/**
 * Babysitter close path tests.
 *
 * Verifies babysitter closes are exchange-first and only use virtual fallback
 * when explicitly enabled.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { TradeExecutor } from '../server/risk/trade-executor.js';

const prisma = new PrismaClient();
const TEST_PREFIX = `bbs_close_${Date.now()}`;

let userId;
let subAccountId;

const noopBook = {
    remove() { },
    updateBalance() { },
    add() { },
    updatePosition() { },
};

const noopPriceService = {
    getPrice() { return null; },
    hasPrice() { return false; },
    setPrice() { },
};

function makeExecutor(createMarketOrder) {
    const exchange = {
        createMarketOrder,
        setLeverage: async () => { },
        getLatestPrice: () => null,
    };
    const exec = new TradeExecutor(exchange, noopBook, noopPriceService, {});
    exec._refreshBabysitter = () => { };
    return exec;
}

async function createOpenPosition(symbol, entryPrice = 100, qty = 1) {
    const pos = await prisma.virtualPosition.create({
        data: {
            subAccountId,
            symbol,
            side: 'LONG',
            entryPrice,
            quantity: qty,
            notional: entryPrice * qty,
            leverage: 1,
            margin: entryPrice * qty,
            liquidationPrice: 0,
            status: 'OPEN',
            babysitterExcluded: false,
        },
    });
    return pos.id;
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
});

after(async () => {
    await prisma.tradeExecution.deleteMany({ where: { subAccountId } });
    await prisma.virtualPosition.deleteMany({ where: { subAccountId } });
    await prisma.balanceLog.deleteMany({ where: { subAccountId } });
    await prisma.botConfig.deleteMany({ where: { subAccountId } });
    await prisma.subAccount.deleteMany({ where: { id: subAccountId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
});

describe('Babysitter exchange close behavior', () => {
    it('should execute exchange close and persist exchange order id', async () => {
        delete process.env.BBS_ALLOW_VIRTUAL_CLOSE_FALLBACK;
        const positionId = await createOpenPosition('BBSEXCHANGE1/USDT:USDT');
        const executor = makeExecutor(async () => ({
            orderId: 'ex-order-1',
            price: 110,
            quantity: 1,
            fee: 0.5,
            status: 'closed',
        }));

        const result = await executor.closeVirtualPositionByPrice(positionId, 108, 'BABYSITTER_TP');
        assert.equal(result.success, true);
        assert.equal(result.source, 'exchange');
        assert.equal(result.exchangeOrderId, 'ex-order-1');
        assert.equal(result.closePrice, 110);

        const pos = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { status: true, realizedPnl: true },
        });
        assert.equal(pos?.status, 'CLOSED');
        assert.equal(pos?.realizedPnl, 9.5);

        const trade = await prisma.tradeExecution.findFirst({
            where: { positionId },
            orderBy: { timestamp: 'desc' },
        });
        assert.equal(trade?.exchangeOrderId, 'ex-order-1');
        assert.equal(trade?.action, 'BABYSITTER_TP');
        assert.equal(trade?.price, 110);
    });

    it('should not close virtually when exchange close fails and fallback is disabled', async () => {
        delete process.env.BBS_ALLOW_VIRTUAL_CLOSE_FALLBACK;
        const positionId = await createOpenPosition('BBSEXCHANGE2/USDT:USDT');
        const executor = makeExecutor(async () => {
            throw new Error('simulated exchange failure');
        });

        const result = await executor.closeVirtualPositionByPrice(positionId, 105, 'BABYSITTER_TP');
        assert.equal(result.success, false);
        assert.match(String(result.error || ''), /Exchange close failed/i);

        const pos = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { status: true },
        });
        assert.equal(pos?.status, 'OPEN');
    });

    it('should use virtual fallback only when explicitly enabled', async () => {
        process.env.BBS_ALLOW_VIRTUAL_CLOSE_FALLBACK = '1';
        const positionId = await createOpenPosition('BBSEXCHANGE3/USDT:USDT');
        const executor = makeExecutor(async () => {
            throw new Error('simulated exchange failure');
        });

        const result = await executor.closeVirtualPositionByPrice(positionId, 103, 'BABYSITTER_TP');
        assert.equal(result.success, true);
        assert.equal(result.source, 'virtual_fallback');

        const pos = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { status: true, realizedPnl: true },
        });
        assert.equal(pos?.status, 'CLOSED');
        assert.equal(pos?.realizedPnl, 3);

        const trade = await prisma.tradeExecution.findFirst({
            where: { positionId },
            orderBy: { timestamp: 'desc' },
        });
        assert.equal(trade?.exchangeOrderId ?? null, null);
        assert.equal(trade?.price, 103);

        delete process.env.BBS_ALLOW_VIRTUAL_CLOSE_FALLBACK;
    });
});
