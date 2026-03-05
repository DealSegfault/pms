import crypto from 'crypto';

export const ROUTING_PREFIX_LENGTH = 12;
export const LEGACY_ROUTING_PREFIX_LENGTH = 8;

export function deriveRoutingPrefix(subAccountId) {
    const normalized = String(subAccountId || '').trim().toLowerCase();
    if (!normalized) {
        throw new Error('subAccountId is required');
    }
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, ROUTING_PREFIX_LENGTH);
}

export function deriveLegacyRoutingPrefix(subAccountId) {
    const normalized = String(subAccountId || '').trim().toLowerCase();
    if (!normalized) {
        throw new Error('subAccountId is required');
    }
    return normalized.slice(0, LEGACY_ROUTING_PREFIX_LENGTH);
}

export function getRoutingPrefix(accountOrId) {
    if (accountOrId && typeof accountOrId === 'object') {
        const persisted = String(accountOrId.routingPrefix || '').trim().toLowerCase();
        if (persisted) return persisted;
        return deriveRoutingPrefix(accountOrId.id);
    }
    return deriveRoutingPrefix(accountOrId);
}

export function getAcceptedRoutingPrefixes(accountOrId) {
    const current = getRoutingPrefix(accountOrId);
    const legacy = accountOrId && typeof accountOrId === 'object'
        ? deriveLegacyRoutingPrefix(accountOrId.id)
        : deriveLegacyRoutingPrefix(accountOrId);
    return Array.from(new Set([current, legacy]));
}

export function tagClientOrderId(accountOrId, orderType, originalId) {
    const prefix = getRoutingPrefix(accountOrId);
    const typePrefix = { MARKET: 'MKT', LIMIT: 'LMT', STOP_MARKET: 'STP', TAKE_PROFIT_MARKET: 'TPM' }[orderType] || 'ORD';
    const uid = originalId || crypto.randomBytes(6).toString('hex');
    return `PMS${prefix}_${typePrefix}_${uid}`;
}

export function parseTaggedClientOrderId(clientOrderId) {
    if (!clientOrderId?.startsWith('PMS')) return null;
    const parts = clientOrderId.split('_');
    if (parts.length < 2) return null;
    return {
        routingPrefix: parts[0].substring(3),
        originalId: parts.slice(1).join('_'),
    };
}
