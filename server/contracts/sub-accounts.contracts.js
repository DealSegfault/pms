import { z } from 'zod';

/** POST / — create sub-account */
export const CreateSubAccountBody = z.object({
    name: z.string().min(1, 'name is required'),
    initialBalance: z.coerce.number().min(0).default(0),
    type: z.enum(['USER', 'BOT']).default('USER'),
});

/** PATCH /:id — update sub-account */
export const PatchSubAccountBody = z.object({
    name: z.string().min(1).optional(),
    addBalance: z.coerce.number().optional(),
    status: z.enum(['ACTIVE', 'FROZEN']).optional(),
});

/** :id param */
export const SubAccountIdParam = z.object({
    id: z.string().min(1, 'id is required'),
});
