/**
 * Express validation middleware factory.
 * Usage:
 *   import { validate } from '../middleware/validate.js';
 *   router.post('/foo', validate(MyBodySchema), handler);
 *   router.get('/bar', validate(MyQuerySchema, 'query'), handler);
 *   router.get('/baz/:id', validate(MyParamSchema, 'params'), handler);
 */

/**
 * @param {import('zod').ZodSchema} schema  - Zod schema to validate against
 * @param {'body'|'query'|'params'} [source='body'] - Where to read input from
 * @returns {import('express').RequestHandler}
 */
export function validate(schema, source = 'body') {
    return (req, _res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            // Pass ZodError to the errorHandler middleware
            return next(result.error);
        }
        // Replace with parsed (coerced/defaulted) values
        req[source] = result.data;
        next();
    };
}
