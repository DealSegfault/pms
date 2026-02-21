/**
 * Shared error model for API contracts.
 * Produces a deterministic error envelope:
 *   { ok: false, error: { code, message, details? } }
 *
 * Usage:
 *   throw new AppError(400, 'VALIDATION_FAILED', 'Invalid input', details);
 *   // or let the errorHandler catch ZodErrors automatically
 */

import { ZodError } from 'zod';

/**
 * Application-level typed error.
 */
export class AppError extends Error {
    /**
     * @param {number} status  - HTTP status code (400, 404, 409, 422, etc.)
     * @param {string} code    - Machine-readable error code
     * @param {string} message - Human-readable message
     * @param {any[]}  [details] - Optional structured detail array (e.g. per-field)
     */
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/**
 * Format a ZodError into a flat detail array.
 */
function formatZodError(zodError) {
    return zodError.issues.map(e => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
    }));
}

/**
 * Express error-handling middleware (4-arg signature).
 * Mount AFTER all routes:
 *   app.use(errorHandler);
 */
export function errorHandler(err, _req, res, _next) {
    // Already sent
    if (res.headersSent) return;

    // Zod validation error
    if (err instanceof ZodError) {
        return res.status(400).json({
            ok: false,
            error: {
                code: 'VALIDATION_FAILED',
                message: 'Request validation failed',
                details: formatZodError(err),
            },
        });
    }

    // App-level typed error
    if (err instanceof AppError) {
        const payload = {
            ok: false,
            error: {
                code: err.code,
                message: err.message,
            },
        };
        if (err.details) payload.error.details = err.details;
        return res.status(err.status).json(payload);
    }

    // Fallback — unexpected error
    console.error('[errorHandler] Unhandled:', err);
    res.status(500).json({
        ok: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: process.env.NODE_ENV === 'production'
                ? 'Internal server error'
                : (err.message || 'Internal server error'),
        },
    });
}
