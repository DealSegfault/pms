/**
 * Ownership middleware — verifies the authenticated user owns the sub-account
 * passed via URL param, request body, or header.
 *
 * Admins bypass ownership checks.
 * Sets req.subAccount on success.
 */
import prisma from './db/prisma.js';
import { buildApiErrorBody } from './http/api-taxonomy.js';

/**
 * Factory: returns middleware that extracts subAccountId from the given source.
 * @param {'params' | 'body' | 'header'} source — where to find the subAccountId
 * @param {string} [key='subAccountId'] — key name in the source
 */
export function requireOwnership(source = 'params', key = 'subAccountId') {
    return async (req, res, next) => {
        const subAccountId =
            source === 'params' ? req.params[key] :
                source === 'body' ? req.body[key] :
                    source === 'header' ? req.headers[key.toLowerCase()] :
                        null;

        if (!subAccountId) {
            return res.status(400).json(buildApiErrorBody({
                code: 'VALIDATION_MISSING_SUBACCOUNT',
                category: 'VALIDATION',
                message: `Missing ${key}`,
            }));
        }

        // Admins can access any sub-account
        if (req.user?.role === 'ADMIN') {
            return next();
        }

        // Regular users: must own the sub-account
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            select: { userId: true },
        });

        if (!account) {
            return res.status(404).json(buildApiErrorBody({
                code: 'OWNERSHIP_SUBACCOUNT_NOT_FOUND',
                category: 'OWNERSHIP',
                message: 'Sub-account not found',
            }));
        }

        if (account.userId !== req.user?.id) {
            return res.status(403).json(buildApiErrorBody({
                code: 'OWNERSHIP_FORBIDDEN',
                category: 'OWNERSHIP',
                message: 'You do not own this sub-account',
            }));
        }

        next();
    };
}

/**
 * Middleware that checks ownership of a position (by positionId param).
 * Looks up the position's subAccount.userId and compares with req.user.id.
 * Admins bypass.
 */
export function requirePositionOwnership(paramKey = 'positionId') {
    return async (req, res, next) => {
        const positionId = req.params[paramKey];
        if (!positionId) {
            return res.status(400).json(buildApiErrorBody({
                code: 'VALIDATION_MISSING_POSITION_ID',
                category: 'VALIDATION',
                message: `Missing ${paramKey}`,
            }));
        }

        if (req.user?.role === 'ADMIN') {
            return next();
        }

        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { subAccountId: true, subAccount: { select: { userId: true } } },
        });

        if (position) {
            if (position.subAccount?.userId !== req.user?.id) {
                return res.status(403).json(buildApiErrorBody({
                    code: 'OWNERSHIP_POSITION_FORBIDDEN',
                    category: 'OWNERSHIP',
                    message: 'You do not own this position',
                }));
            }
            req.subAccountId = position.subAccountId;
            return next();
        }

        const hintedSubAccountId = req.body?.subAccountId || req.query?.subAccountId || null;
        if (!hintedSubAccountId) {
            return res.status(404).json(buildApiErrorBody({
                code: 'POSITION_NOT_FOUND',
                category: 'VALIDATION',
                message: 'Position not found',
            }));
        }

        const account = await prisma.subAccount.findUnique({
            where: { id: hintedSubAccountId },
            select: { userId: true },
        });
        if (!account) {
            return res.status(404).json(buildApiErrorBody({
                code: 'OWNERSHIP_SUBACCOUNT_NOT_FOUND',
                category: 'OWNERSHIP',
                message: 'Sub-account not found',
            }));
        }
        if (account.userId !== req.user?.id) {
            return res.status(403).json(buildApiErrorBody({
                code: 'OWNERSHIP_FORBIDDEN',
                category: 'OWNERSHIP',
                message: 'You do not own this sub-account',
            }));
        }

        req.subAccountId = hintedSubAccountId;
        next();
    };
}

/**
 * Middleware that checks ownership of a pending order (by orderId param).
 */
export function requireOrderOwnership(paramKey = 'orderId') {
    return async (req, res, next) => {
        const orderId = req.params[paramKey];
        if (!orderId) {
            return res.status(400).json(buildApiErrorBody({
                code: 'VALIDATION_MISSING_ORDER_ID',
                category: 'VALIDATION',
                message: `Missing ${paramKey}`,
            }));
        }

        if (req.user?.role === 'ADMIN') {
            return next();
        }

        const order = await prisma.pendingOrder.findUnique({
            where: { id: orderId },
            select: { subAccount: { select: { userId: true } } },
        });

        if (!order) {
            return res.status(404).json(buildApiErrorBody({
                code: 'ORDER_NOT_FOUND',
                category: 'VALIDATION',
                message: 'Order not found',
            }));
        }

        if (order.subAccount?.userId !== req.user?.id) {
            return res.status(403).json(buildApiErrorBody({
                code: 'OWNERSHIP_ORDER_FORBIDDEN',
                category: 'OWNERSHIP',
                message: 'You do not own this order',
            }));
        }

        next();
    };
}
