/**
 * API Contracts Validation Tests
 * Tests Zod schemas, error-model, and validate middleware.
 * Run: node --test tests/contracts.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Schema tests ──

import { RegisterBody, LoginBody, UserIdParam } from '../server/contracts/auth.contracts.js';
import { CreateSubAccountBody, PatchSubAccountBody } from '../server/contracts/sub-accounts.contracts.js';
import { RiskRuleBody } from '../server/contracts/risk-rules.contracts.js';
import { HistoryQuery, AllHistoryQuery, BackfillBody } from '../server/contracts/history.contracts.js';
import { SetBalanceBody, LiquidationModeBody, BalanceLogQuery } from '../server/contracts/admin.contracts.js';
import { AppError, errorHandler } from '../server/http/error-model.js';

// ── Auth contracts ──

describe('Auth contracts', () => {
    it('RegisterBody accepts valid input', () => {
        const result = RegisterBody.safeParse({ username: 'alice', password: 'pass1234' });
        assert.ok(result.success);
        assert.equal(result.data.username, 'alice');
    });

    it('RegisterBody rejects missing username', () => {
        const result = RegisterBody.safeParse({ password: 'pass1234' });
        assert.ok(!result.success);
    });

    it('RegisterBody rejects short password', () => {
        const result = RegisterBody.safeParse({ username: 'alice', password: '12' });
        assert.ok(!result.success);
    });

    it('RegisterBody rejects password without letter', () => {
        const result = RegisterBody.safeParse({ username: 'alice', password: '12345678' });
        assert.ok(!result.success);
    });

    it('RegisterBody rejects password without number', () => {
        const result = RegisterBody.safeParse({ username: 'alice', password: 'abcdefgh' });
        assert.ok(!result.success);
    });

    it('LoginBody accepts valid input', () => {
        const result = LoginBody.safeParse({ username: 'bob', password: 'secret' });
        assert.ok(result.success);
    });

    it('LoginBody rejects empty username', () => {
        const result = LoginBody.safeParse({ username: '', password: 'secret' });
        assert.ok(!result.success);
    });

    it('UserIdParam accepts valid id', () => {
        const result = UserIdParam.safeParse({ userId: 'abc-123' });
        assert.ok(result.success);
    });

    it('UserIdParam rejects empty', () => {
        const result = UserIdParam.safeParse({ userId: '' });
        assert.ok(!result.success);
    });
});

// ── Sub-account contracts ──

describe('Sub-account contracts', () => {
    it('CreateSubAccountBody applies defaults', () => {
        const result = CreateSubAccountBody.safeParse({ name: 'My Account' });
        assert.ok(result.success);
        assert.equal(result.data.initialBalance, 0);
        assert.equal(result.data.type, 'USER');
    });

    it('CreateSubAccountBody coerces string balance', () => {
        const result = CreateSubAccountBody.safeParse({ name: 'Acct', initialBalance: '500' });
        assert.ok(result.success);
        assert.equal(result.data.initialBalance, 500);
    });

    it('CreateSubAccountBody rejects missing name', () => {
        const result = CreateSubAccountBody.safeParse({ initialBalance: 100 });
        assert.ok(!result.success);
    });

    it('PatchSubAccountBody accepts partial update', () => {
        const result = PatchSubAccountBody.safeParse({ addBalance: 100 });
        assert.ok(result.success);
        assert.equal(result.data.addBalance, 100);
    });

    it('PatchSubAccountBody rejects invalid status', () => {
        const result = PatchSubAccountBody.safeParse({ status: 'INVALID' });
        assert.ok(!result.success);
    });
});

// ── Risk-rules contracts ──

describe('Risk-rules contracts', () => {
    it('RiskRuleBody accepts valid numeric input', () => {
        const result = RiskRuleBody.safeParse({
            maxLeverage: 50,
            maxNotionalPerTrade: 200,
            maxTotalExposure: 500,
            liquidationThreshold: 0.9,
        });
        assert.ok(result.success);
    });

    it('RiskRuleBody coerces string numbers', () => {
        const result = RiskRuleBody.safeParse({
            maxLeverage: '50',
            maxNotionalPerTrade: '200',
            maxTotalExposure: '500',
            liquidationThreshold: '0.9',
        });
        assert.ok(result.success);
        assert.equal(result.data.maxLeverage, 50);
    });

    it('RiskRuleBody rejects non-numeric "abc"', () => {
        const result = RiskRuleBody.safeParse({
            maxLeverage: 'abc',
            maxNotionalPerTrade: 200,
            maxTotalExposure: 500,
            liquidationThreshold: 0.9,
        });
        assert.ok(!result.success, 'should reject non-numeric string');
    });

    it('RiskRuleBody rejects negative leverage', () => {
        const result = RiskRuleBody.safeParse({
            maxLeverage: -5,
            maxNotionalPerTrade: 200,
            maxTotalExposure: 500,
            liquidationThreshold: 0.9,
        });
        assert.ok(!result.success);
    });

    it('RiskRuleBody rejects threshold > 1', () => {
        const result = RiskRuleBody.safeParse({
            maxLeverage: 50,
            maxNotionalPerTrade: 200,
            maxTotalExposure: 500,
            liquidationThreshold: 1.5,
        });
        assert.ok(!result.success);
    });
});

// ── History contracts ──

describe('History contracts', () => {
    it('HistoryQuery applies defaults', () => {
        const result = HistoryQuery.safeParse({});
        assert.ok(result.success);
        assert.equal(result.data.limit, 100);
        assert.equal(result.data.offset, 0);
    });

    it('HistoryQuery rejects limit > 1000', () => {
        const result = HistoryQuery.safeParse({ limit: 5000 });
        assert.ok(!result.success);
    });

    it('AllHistoryQuery applies defaults', () => {
        const result = AllHistoryQuery.safeParse({});
        assert.ok(result.success);
        assert.equal(result.data.limit, 200);
    });

    it('BackfillBody applies default days', () => {
        const result = BackfillBody.safeParse({});
        assert.ok(result.success);
        assert.equal(result.data.days, 7);
    });

    it('BackfillBody rejects days > 365', () => {
        const result = BackfillBody.safeParse({ days: 500 });
        assert.ok(!result.success);
    });
});

// ── Admin contracts ──

describe('Admin contracts', () => {
    it('SetBalanceBody coerces string to number', () => {
        const result = SetBalanceBody.safeParse({ balance: '1000' });
        assert.ok(result.success);
        assert.equal(result.data.balance, 1000);
    });

    it('SetBalanceBody rejects non-numeric', () => {
        const result = SetBalanceBody.safeParse({ balance: 'not_a_number' });
        assert.ok(!result.success);
    });

    it('LiquidationModeBody accepts valid mode', () => {
        const result = LiquidationModeBody.safeParse({ mode: 'TAKEOVER' });
        assert.ok(result.success);
    });

    it('LiquidationModeBody rejects invalid mode', () => {
        const result = LiquidationModeBody.safeParse({ mode: 'INVALID' });
        assert.ok(!result.success);
    });

    it('BalanceLogQuery applies default limit', () => {
        const result = BalanceLogQuery.safeParse({});
        assert.ok(result.success);
        assert.equal(result.data.limit, 100);
    });
});

// ── Error model ──

describe('Error model', () => {
    it('AppError has correct properties', () => {
        const err = new AppError(400, 'VALIDATION_FAILED', 'Bad input', [{ path: 'name', message: 'required' }]);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.equal(err.message, 'Bad input');
        assert.ok(Array.isArray(err.details));
    });

    it('errorHandler formats AppError correctly', () => {
        const err = new AppError(422, 'INVALID_DATA', 'Test error');
        let statusCode, body;
        const res = {
            headersSent: false,
            status(code) { statusCode = code; return this; },
            json(data) { body = data; },
        };
        errorHandler(err, {}, res, () => { });
        assert.equal(statusCode, 422);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'INVALID_DATA');
        assert.equal(body.error.message, 'Test error');
    });

    it('errorHandler formats ZodError correctly', () => {
        const result = RiskRuleBody.safeParse({ maxLeverage: 'abc' });
        assert.ok(!result.success);
        let statusCode, body;
        const res = {
            headersSent: false,
            status(code) { statusCode = code; return this; },
            json(data) { body = data; },
        };
        errorHandler(result.error, {}, res, () => { });
        assert.equal(statusCode, 400);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'VALIDATION_FAILED');
        assert.ok(Array.isArray(body.error.details));
    });
});
