/**
 * Unit tests for risk-math.js — pure calculation functions.
 *
 * Zero mocking needed. These are pure, deterministic functions.
 * Run: node --test tests/risk-math.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    computePnl,
    computeAvailableMargin,
    computeMarginUsageRatio,
    createTradeSignature,
    createOpenTradeSignature,
} from '../server/risk/risk-math.js';

// ── computePnl ──────────────────────────────────────

describe('computePnl', () => {
    it('LONG profit: close > entry', () => {
        const pnl = computePnl('LONG', 100, 110, 2);
        assert.equal(pnl, 20); // (110-100)*2
    });

    it('LONG loss: close < entry', () => {
        const pnl = computePnl('LONG', 100, 90, 2);
        assert.equal(pnl, -20); // (90-100)*2
    });

    it('SHORT profit: close < entry', () => {
        const pnl = computePnl('SHORT', 100, 90, 2);
        assert.equal(pnl, 20); // (100-90)*2
    });

    it('SHORT loss: close > entry', () => {
        const pnl = computePnl('SHORT', 100, 110, 2);
        assert.equal(pnl, -20); // (100-110)*2
    });

    it('zero PnL when prices equal', () => {
        assert.equal(computePnl('LONG', 50, 50, 10), 0);
        assert.equal(computePnl('SHORT', 50, 50, 10), 0);
    });

    it('handles fractional quantities', () => {
        const pnl = computePnl('LONG', 50000, 51000, 0.001);
        assert.ok(Math.abs(pnl - 1) < 1e-10); // (51000-50000)*0.001 = 1
    });
});

// ── computeAvailableMargin ──────────────────────────

describe('computeAvailableMargin', () => {
    it('basic margin calculation with no opposite position', () => {
        const result = computeAvailableMargin({
            balance: 1000,
            maintenanceRate: 0.005,
            totalUpnl: 0,
            totalNotional: 5000,
        });
        assert.equal(result.equity, 1000);
        assert.equal(result.maintenanceMargin, 25); // 5000 * 0.005
        assert.equal(result.availableMargin, 975); // 1000 - 25
    });

    it('includes UPNL in equity', () => {
        const result = computeAvailableMargin({
            balance: 1000,
            maintenanceRate: 0.005,
            totalUpnl: -200,
            totalNotional: 5000,
        });
        assert.equal(result.equity, 800); // 1000 + (-200)
        assert.equal(result.availableMargin, 775); // 800 - 25
    });

    it('accounts for opposite position flip', () => {
        const result = computeAvailableMargin({
            balance: 1000,
            maintenanceRate: 0.005,
            totalUpnl: 0,
            totalNotional: 8000,
            oppositeNotional: 3000,
            oppositePnl: 50,
        });
        // equity = 1000 + 0 + 50 = 1050
        assert.equal(result.equity, 1050);
        // maintenance = (8000-3000) * 0.005 = 25
        assert.equal(result.maintenanceMargin, 25);
        assert.equal(result.availableMargin, 1025);
    });

    it('defaults oppositeNotional and oppositePnl to 0', () => {
        const result = computeAvailableMargin({
            balance: 500,
            maintenanceRate: 0.01,
            totalUpnl: 100,
            totalNotional: 2000,
        });
        assert.equal(result.equity, 600);
        assert.equal(result.maintenanceMargin, 20);
        assert.equal(result.availableMargin, 580);
    });
});

// ── computeMarginUsageRatio ─────────────────────────

describe('computeMarginUsageRatio', () => {
    it('calculates ratio correctly', () => {
        const ratio = computeMarginUsageRatio({
            equity: 1000,
            currentMarginUsed: 400,
            newMargin: 100,
        });
        assert.equal(ratio, 0.5); // 500/1000
    });

    it('returns 999 when equity is zero', () => {
        const ratio = computeMarginUsageRatio({
            equity: 0,
            currentMarginUsed: 100,
            newMargin: 50,
        });
        assert.equal(ratio, 999);
    });

    it('returns 999 when equity is negative', () => {
        const ratio = computeMarginUsageRatio({
            equity: -10,
            currentMarginUsed: 100,
            newMargin: 50,
        });
        assert.equal(ratio, 999);
    });

    it('can return ratio > 1 (over-margined)', () => {
        const ratio = computeMarginUsageRatio({
            equity: 100,
            currentMarginUsed: 80,
            newMargin: 30,
        });
        assert.equal(ratio, 1.1); // 110/100
    });
});

// ── createTradeSignature / createOpenTradeSignature ──

describe('createTradeSignature', () => {
    it('returns a 64-character hex string (SHA-256)', () => {
        const sig = createTradeSignature('acct-1', 'CLOSE', 'pos-1');
        assert.equal(typeof sig, 'string');
        assert.equal(sig.length, 64);
        assert.match(sig, /^[0-9a-f]{64}$/);
    });

    it('produces different signatures for different inputs', () => {
        const sig1 = createTradeSignature('acct-1', 'CLOSE', 'pos-1');
        const sig2 = createTradeSignature('acct-1', 'LIQUIDATE', 'pos-1');
        assert.notEqual(sig1, sig2);
    });

    it('produces different signatures on repeated calls (includes UUID)', () => {
        const sig1 = createTradeSignature('acct-1', 'CLOSE', 'pos-1');
        const sig2 = createTradeSignature('acct-1', 'CLOSE', 'pos-1');
        assert.notEqual(sig1, sig2);
    });
});

describe('createOpenTradeSignature', () => {
    it('returns a 64-character hex string (SHA-256)', () => {
        const sig = createOpenTradeSignature('acct-1', 'BTC/USDT', 'LONG', 0.5);
        assert.equal(typeof sig, 'string');
        assert.equal(sig.length, 64);
        assert.match(sig, /^[0-9a-f]{64}$/);
    });

    it('produces unique signatures on repeated calls', () => {
        const sig1 = createOpenTradeSignature('acct-1', 'BTC/USDT', 'LONG', 0.5);
        const sig2 = createOpenTradeSignature('acct-1', 'BTC/USDT', 'LONG', 0.5);
        assert.notEqual(sig1, sig2);
    });
});
