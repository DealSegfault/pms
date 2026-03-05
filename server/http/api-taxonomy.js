const STATUS_BY_CATEGORY = {
    VALIDATION: 400,
    OWNERSHIP: 403,
    RISK: 422,
    AMBIGUITY: 409,
    EXCHANGE: 502,
    TIMEOUT: 504,
    INFRA: 503,
};

function statusForCategory(category) {
    return STATUS_BY_CATEGORY[category] || 500;
}

function normalizeMessage(value, fallback = 'Request failed') {
    const message = String(value || '').trim();
    return message || fallback;
}

function inferCommandFailure(message, explicitCode = '') {
    const text = normalizeMessage(message).toLowerCase();
    const codeText = String(explicitCode || '').toUpperCase();

    if (codeText.startsWith('OWNERSHIP_') || text.includes('do not own')) {
        return { code: codeText || 'OWNERSHIP_FORBIDDEN', category: 'OWNERSHIP', retryable: false };
    }
    if (
        codeText.includes('TIMEOUT') ||
        text.includes('timeout') ||
        text.includes('timed out') ||
        text.includes('python engine may be unavailable')
    ) {
        return { code: codeText || 'INFRA_TIMEOUT', category: 'TIMEOUT', retryable: true };
    }
    if (
        codeText.includes('RISK') ||
        text.includes('reduceonly') ||
        text.includes('reduce only') ||
        text.includes('insufficient margin') ||
        text.includes('risk')
    ) {
        return { code: codeText || 'RISK_REJECTED', category: 'RISK', retryable: false };
    }
    if (
        codeText.includes('VALIDATION') ||
        text.includes('required') ||
        text.includes('missing') ||
        text.includes('mismatch') ||
        text.includes('invalid')
    ) {
        return { code: codeText || 'VALIDATION_FAILED', category: 'VALIDATION', retryable: false };
    }
    if (
        codeText.includes('INFRA') ||
        text.includes('redis not available') ||
        text.includes('engine not available') ||
        text.includes('unreachable')
    ) {
        return { code: codeText || 'INFRA_UNAVAILABLE', category: 'INFRA', retryable: true };
    }
    if (codeText.includes('AMBIGUITY') || text.includes('ambiguous')) {
        return { code: codeText || 'AMBIGUOUS_RESULT', category: 'AMBIGUITY', retryable: false };
    }
    return { code: codeText || 'EXCHANGE_REJECTED', category: 'EXCHANGE', retryable: false };
}

function normalizeCommandFailure(result = {}) {
    const message = normalizeMessage(result.error || result.message, 'Command failed');
    const inferred = inferCommandFailure(message, result.errorCode);
    let status = Number(result.statusCode || 0);
    if (!status) {
        status = statusForCategory(result.errorCategory || inferred.category);
    }
    if (result.errorCode === 'POSITION_NOT_FOUND') {
        status = 404;
    }
    return {
        status,
        code: result.errorCode || inferred.code,
        category: result.errorCategory || inferred.category,
        retryable: result.retryable ?? inferred.retryable,
        message,
        details: result.details || undefined,
    };
}

export function buildApiErrorBody({ code, category, message, retryable = false, details, ok = false }) {
    const body = {
        ok,
        success: false,
        error: {
            code,
            category,
            message,
            retryable,
        },
        errorCode: code,
        errorCategory: category,
        retryable,
        message,
    };
    if (details) {
        body.error.details = details;
        body.details = details;
    }
    return body;
}

export function commandFailureResponse(result = {}) {
    const failure = normalizeCommandFailure(result);
    return {
        status: failure.status,
        body: buildApiErrorBody(failure),
    };
}

export function proxyFailureResponse(errorLike, { fallbackBinanceCode = -1 } = {}) {
    const rawMessage = normalizeMessage(
        errorLike?.message || errorLike?.msg || errorLike?.error || errorLike,
        'Proxy request failed',
    );
    const rawText = rawMessage.toLowerCase();
    const message = rawMessage.replace(/^risk check failed:\s*/i, '');
    const binanceCode = Number(errorLike?.code);
    let category = 'EXCHANGE';
    let code = 'PROXY_EXCHANGE_ERROR';
    let retryable = false;
    let status = 502;

    if (rawText.includes('missing required') || rawText.includes('required') || rawText.includes('invalid')) {
        category = 'VALIDATION';
        code = 'PROXY_VALIDATION_FAILED';
        status = 400;
    } else if (rawText.includes('not owned') || rawText.includes('no active sub-account') || rawText.includes('sub-account')) {
        category = 'OWNERSHIP';
        code = 'PROXY_OWNERSHIP_FORBIDDEN';
        status = 403;
    } else if (rawText.includes('rate limit')) {
        category = 'TIMEOUT';
        code = 'PROXY_RATE_LIMITED';
        status = 429;
        retryable = true;
    } else if (rawText.includes('risk check failed') || rawText.includes('reduceonly') || rawText.includes('insufficient margin')) {
        category = 'RISK';
        code = 'PROXY_RISK_REJECTED';
        status = 422;
    } else if (rawText.includes('timeout') || rawText.includes('timed out')) {
        category = 'TIMEOUT';
        code = 'PROXY_TIMEOUT';
        status = 504;
        retryable = true;
    } else if (rawText.includes('unavailable') || rawText.includes('not initialized') || rawText.includes('redis')) {
        category = 'INFRA';
        code = 'PROXY_INFRA_UNAVAILABLE';
        status = 503;
        retryable = true;
    }

    return {
        status,
        body: {
            code: Number.isFinite(binanceCode) ? binanceCode : fallbackBinanceCode,
            msg: message,
            pmsCode: code,
            category,
            retryable,
        },
    };
}
