import test from 'node:test';
import assert from 'node:assert/strict';

import { commandFailureResponse, proxyFailureResponse } from '../http/api-taxonomy.js';

test('commandFailureResponse maps Python timeouts to retryable 504 failures', () => {
    const failure = commandFailureResponse({
        success: false,
        error: 'Execution timeout — Python engine may be unavailable',
    });

    assert.equal(failure.status, 504);
    assert.equal(failure.body.error.code, 'INFRA_TIMEOUT');
    assert.equal(failure.body.error.category, 'TIMEOUT');
    assert.equal(failure.body.error.retryable, true);
});

test('commandFailureResponse preserves explicit risk classification from Python', () => {
    const failure = commandFailureResponse({
        success: false,
        error: 'ReduceOnly Order is rejected',
        errorCode: 'RISK_REJECTED',
        errorCategory: 'RISK',
        retryable: false,
    });

    assert.equal(failure.status, 422);
    assert.equal(failure.body.error.code, 'RISK_REJECTED');
    assert.equal(failure.body.error.category, 'RISK');
});

test('proxyFailureResponse distinguishes validation from exchange infra', () => {
    const validation = proxyFailureResponse(
        { message: 'Missing required parameters' },
        { fallbackBinanceCode: -1100 },
    );
    const timeout = proxyFailureResponse(
        { message: 'request timeout from exchange' },
        { fallbackBinanceCode: -1 },
    );

    assert.equal(validation.status, 400);
    assert.equal(validation.body.pmsCode, 'PROXY_VALIDATION_FAILED');
    assert.equal(validation.body.code, -1100);

    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.pmsCode, 'PROXY_TIMEOUT');
    assert.equal(timeout.body.retryable, true);
});

test('commandFailureResponse keeps structured details for validation failures', () => {
    const details = {
        symbol: 'BTCUSDT',
        requestedLots: 50,
        maxLots: 16,
        totalSize: 100,
        minNotional: 6,
    };
    const failure = commandFailureResponse({
        success: false,
        error: 'Requested 50 lots exceeds max 16 for BTCUSDT',
        errorCode: 'VALIDATION_TWAP_LOTS_INVALID',
        errorCategory: 'VALIDATION',
        details,
    });

    assert.equal(failure.status, 400);
    assert.equal(failure.body.error.code, 'VALIDATION_TWAP_LOTS_INVALID');
    assert.deepEqual(failure.body.details, details);
    assert.deepEqual(failure.body.error.details, details);
});
