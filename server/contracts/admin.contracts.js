import { z } from 'zod';

/** POST /set-balance/:subAccountId body */
export const SetBalanceBody = z.object({
    balance: z.coerce.number({ invalid_type_error: 'balance must be a number' }),
});

/** POST /liquidation-mode/:subAccountId body */
export const LiquidationModeBody = z.object({
    mode: z.enum(['ADL_30', 'INSTANT_CLOSE', 'TAKEOVER'], {
        errorMap: () => ({ message: 'mode must be ADL_30, INSTANT_CLOSE, or TAKEOVER' }),
    }),
});

/** :positionId param */
export const PositionIdParam = z.object({
    positionId: z.string().min(1, 'positionId is required'),
});

/** :subAccountId param */
export const SubAccountIdParam = z.object({
    subAccountId: z.string().min(1, 'subAccountId is required'),
});

/** GET /balance-log query */
export const BalanceLogQuery = z.object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
});
