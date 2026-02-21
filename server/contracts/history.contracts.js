import { z } from 'zod';

/** GET /orders/:subAccountId and /trades/:subAccountId query */
export const HistoryQuery = z.object({
    symbol: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    startTime: z.coerce.number().int().positive().optional(),
    endTime: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).default(0),
});

/** GET /all query */
export const AllHistoryQuery = z.object({
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
});

/** POST /backfill/:subAccountId body */
export const BackfillBody = z.object({
    symbols: z.array(z.string()).optional(),
    days: z.coerce.number().int().min(1).max(365).default(7),
});

/** :subAccountId param */
export const SubAccountIdParam = z.object({
    subAccountId: z.string().min(1, 'subAccountId is required'),
});
