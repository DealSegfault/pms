/**
 * Unit tests for TP mode API validation.
 *
 * Tests that the bot config API correctly validates tpMode values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline the validateConfig logic to test it in isolation
// (mirrors server/routes/bot.js ALLOWED_FIELDS + validateConfig)

const ALLOWED_FIELDS = {
    tpMode: { type: 'string', enum: ['auto', 'fast', 'vol'] },
    maxNotional: { type: 'number', min: 6, max: 500 },
    minSpreadBps: { type: 'number', min: 1, max: 100 },
};

function validateConfig(body) {
    const errors = [];
    const cleaned = {};
    for (const [key, val] of Object.entries(body)) {
        const spec = ALLOWED_FIELDS[key];
        if (!spec) continue;
        if (spec.type === 'boolean') {
            cleaned[key] = Boolean(val);
        } else if (spec.type === 'number') {
            const n = Number(val);
            if (isNaN(n)) { errors.push(`${key} must be a number`); continue; }
            if (spec.min !== undefined && n < spec.min) { errors.push(`${key} min is ${spec.min}`); continue; }
            if (spec.max !== undefined && n > spec.max) { errors.push(`${key} max is ${spec.max}`); continue; }
            cleaned[key] = spec.int ? Math.round(n) : n;
        } else if (spec.type === 'string') {
            const s = String(val).slice(0, 1000);
            if (spec.enum && !spec.enum.includes(s)) {
                errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
                continue;
            }
            cleaned[key] = s;
        }
    }
    return { errors, cleaned };
}

describe('TP Mode API Validation', () => {
    it('accepts "auto" as valid tpMode', () => {
        const { errors, cleaned } = validateConfig({ tpMode: 'auto' });
        assert.equal(errors.length, 0);
        assert.equal(cleaned.tpMode, 'auto');
    });

    it('accepts "fast" as valid tpMode', () => {
        const { errors, cleaned } = validateConfig({ tpMode: 'fast' });
        assert.equal(errors.length, 0);
        assert.equal(cleaned.tpMode, 'fast');
    });

    it('accepts "vol" as valid tpMode', () => {
        const { errors, cleaned } = validateConfig({ tpMode: 'vol' });
        assert.equal(errors.length, 0);
        assert.equal(cleaned.tpMode, 'vol');
    });

    it('rejects invalid tpMode value', () => {
        const { errors, cleaned } = validateConfig({ tpMode: 'turbo' });
        assert.equal(errors.length, 1);
        assert.ok(errors[0].includes('must be one of'));
        assert.equal(cleaned.tpMode, undefined);
    });

    it('rejects empty string tpMode', () => {
        const { errors, cleaned } = validateConfig({ tpMode: '' });
        assert.equal(errors.length, 1);
        assert.equal(cleaned.tpMode, undefined);
    });

    it('ignores unknown fields', () => {
        const { errors, cleaned } = validateConfig({ tpMode: 'vol', unknownField: 123 });
        assert.equal(errors.length, 0);
        assert.equal(cleaned.tpMode, 'vol');
        assert.equal(cleaned.unknownField, undefined);
    });

    it('validates tpMode alongside other fields', () => {
        const { errors, cleaned } = validateConfig({
            tpMode: 'fast',
            maxNotional: 100,
            minSpreadBps: 5,
        });
        assert.equal(errors.length, 0);
        assert.equal(cleaned.tpMode, 'fast');
        assert.equal(cleaned.maxNotional, 100);
        assert.equal(cleaned.minSpreadBps, 5);
    });

    it('reports tpMode error alongside valid fields', () => {
        const { errors, cleaned } = validateConfig({
            tpMode: 'invalid',
            maxNotional: 100,
        });
        assert.equal(errors.length, 1);
        assert.equal(cleaned.tpMode, undefined);
        assert.equal(cleaned.maxNotional, 100);
    });
});
