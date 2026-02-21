/**
 * Repository helpers — thin wrappers around frequent Prisma patterns.
 *
 * These are convenience shortcuts, NOT an abstraction wall.
 * Modules may still use `prisma.model.method()` directly for one-off queries.
 */
import prisma from './prisma.js';

// ──────────────────────────────────────────────────
// User
// ──────────────────────────────────────────────────

export const UserRepo = {
    findById: (id, select) =>
        prisma.user.findUnique({ where: { id }, ...(select && { select }) }),

    findByUsername: (username) =>
        prisma.user.findUnique({ where: { username } }),

    findByApiKey: (apiKey) =>
        prisma.user.findUnique({ where: { apiKey } }),

    update: (id, data) =>
        prisma.user.update({ where: { id }, data }),

    findAll: (select, orderBy) =>
        prisma.user.findMany({ ...(select && { select }), ...(orderBy && { orderBy }) }),
};

// ──────────────────────────────────────────────────
// SubAccount
// ──────────────────────────────────────────────────

export const SubAccountRepo = {
    findById: (id, select) =>
        prisma.subAccount.findUnique({ where: { id }, ...(select && { select }) }),

    findOwner: (id) =>
        prisma.subAccount.findUnique({ where: { id }, select: { userId: true } }),
};

// ──────────────────────────────────────────────────
// VirtualPosition
// ──────────────────────────────────────────────────

export const VirtualPositionRepo = {
    findByIdWithOwner: (id) =>
        prisma.virtualPosition.findUnique({
            where: { id },
            select: { subAccount: { select: { userId: true } } },
        }),

    updateExclusion: (id, excluded) =>
        prisma.virtualPosition.update({
            where: { id },
            data: { babysitterExcluded: excluded },
        }),

    countIncluded: (subAccountId) =>
        prisma.virtualPosition.count({
            where: { subAccountId, status: 'OPEN', babysitterExcluded: false },
        }),
};

// ──────────────────────────────────────────────────
// PendingOrder
// ──────────────────────────────────────────────────

export const PendingOrderRepo = {
    findByIdWithOwner: (id) =>
        prisma.pendingOrder.findUnique({
            where: { id },
            select: { subAccount: { select: { userId: true } } },
        }),
};

// ──────────────────────────────────────────────────
// TradeExecution
// ──────────────────────────────────────────────────

export const TradeExecutionRepo = {
    findExistingByOrderIds: (orderIds) =>
        prisma.tradeExecution.findMany({
            where: { exchangeOrderId: { in: orderIds } },
            select: { exchangeOrderId: true },
        }),

    createMany: (data) =>
        prisma.tradeExecution.createMany({ data }),
};

// ──────────────────────────────────────────────────
// BotConfig
// ──────────────────────────────────────────────────

export const BotConfigRepo = {
    findBySubAccount: (subAccountId) =>
        prisma.botConfig.findUnique({ where: { subAccountId } }),

    findEnabled: (include) =>
        prisma.botConfig.findMany({ where: { enabled: true }, ...(include && { include }) }),

    create: (data) =>
        prisma.botConfig.create({ data }),

    update: (subAccountId, data) =>
        prisma.botConfig.update({ where: { subAccountId }, data }),

    updateMany: (where, data) =>
        prisma.botConfig.updateMany({ where, data }),

    upsert: (subAccountId, create, update) =>
        prisma.botConfig.upsert({
            where: { subAccountId },
            create: { subAccountId, ...create },
            update,
        }),

    setEnabled: (subAccountId, enabled) =>
        prisma.botConfig.updateMany({ where: { subAccountId }, data: { enabled } }),
};
