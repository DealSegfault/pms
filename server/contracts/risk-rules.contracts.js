import { z } from 'zod';

/** PUT /global and PUT /:subAccountId body */
export const RiskRuleBody = z.object({
    maxLeverage: z.coerce.number().positive('maxLeverage must be positive'),
    maxNotionalPerTrade: z.coerce.number().positive('maxNotionalPerTrade must be positive'),
    maxTotalExposure: z.coerce.number().positive('maxTotalExposure must be positive'),
    liquidationThreshold: z.coerce.number().min(0).max(1, 'liquidationThreshold must be between 0 and 1'),
});

/** :subAccountId param */
export const SubAccountIdParam = z.object({
    subAccountId: z.string().min(1, 'subAccountId is required'),
});
