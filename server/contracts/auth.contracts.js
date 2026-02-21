import { z } from 'zod';

/** POST /register body */
export const RegisterBody = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string()
        .min(8, 'Password must be at least 8 characters')
        .refine(p => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), {
            message: 'Password must contain at least one letter and one number',
        }),
});

/** POST /login body */
export const LoginBody = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
});

/** :userId param */
export const UserIdParam = z.object({
    userId: z.string().min(1, 'userId is required'),
});
