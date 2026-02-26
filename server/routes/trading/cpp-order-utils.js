import prisma from '../../db/prisma.js';

const DEFAULT_CPP_SYNC_TTL_MS = 10_000;
const parsedSyncTtlMs = Number.parseInt(process.env.CPP_ACCOUNT_SYNC_TTL_MS || `${DEFAULT_CPP_SYNC_TTL_MS}`, 10);
const CPP_SYNC_TTL_MS = Number.isFinite(parsedSyncTtlMs) && parsedSyncTtlMs >= 0
    ? parsedSyncTtlMs
    : DEFAULT_CPP_SYNC_TTL_MS;
const syncedAtByAccount = new Map(); // subAccountId -> timestamp (ms)
const inFlightSyncByAccount = new Map(); // subAccountId -> Promise<void>

function cacheFresh(subAccountId) {
    if (CPP_SYNC_TTL_MS <= 0) return false;
    const ts = syncedAtByAccount.get(subAccountId);
    if (!ts) return false;
    return (Date.now() - ts) < CPP_SYNC_TTL_MS;
}

function sanitizeIdPart(value) {
    return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * Build a Binance-safe clientOrderId (<= 36 chars).
 * Optionally reserve suffix room for engine-appended postfixes (e.g. "_r12").
 */
export function makeCppClientOrderId(kind, subAccountId, { reserveSuffix = 0 } = {}) {
    const safeKind = (sanitizeIdPart(kind).slice(0, 6) || 'ord');
    const safeAccount = (sanitizeIdPart(subAccountId).slice(0, 6) || 'acct');
    const ts = Date.now().toString(36); // compact timestamp
    const rand = Math.random().toString(36).slice(2, 6);

    const maxLen = Math.max(12, 36 - Math.max(0, reserveSuffix));
    let id = `cpp-${safeKind}-${safeAccount}-${ts}${rand}`;
    if (id.length > maxLen) {
        id = id.slice(0, maxLen);
    }
    return id;
}

/**
 * Ensure the C++ engine has this account + rule loaded before mutating ops.
 * This avoids "account not found" rejects after C++ process restarts.
 */
export async function ensureCppAccountSynced(bridge, subAccountId, { force = false } = {}) {
    if (!bridge?.isHealthy()) {
        throw new Error('C++ engine unavailable for account sync');
    }
    if (!subAccountId) {
        throw new Error('Missing subAccountId for C++ account sync');
    }
    if (!force && cacheFresh(subAccountId)) {
        return;
    }
    if (!force) {
        const inFlight = inFlightSyncByAccount.get(subAccountId);
        if (inFlight) {
            await inFlight;
            return;
        }
    }

    const syncPromise = (async () => {
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            select: {
                id: true,
                currentBalance: true,
                maintenanceRate: true,
                status: true,
            },
        });

        if (!account) {
            throw new Error('Sub-account not found');
        }

        const rule = await prisma.riskRule.findUnique({
            where: { subAccountId },
            select: {
                maxLeverage: true,
                maxNotionalPerTrade: true,
                maxTotalExposure: true,
                liquidationThreshold: true,
            },
        });

        await bridge.sendCommand('upsert_account', {
            sub_account_id: account.id,
            balance: account.currentBalance,
            maintenance_rate: account.maintenanceRate ?? 0.005,
            status: account.status || 'ACTIVE',
        });

        await bridge.sendCommand('upsert_rule', {
            sub_account_id: account.id,
            max_leverage: rule?.maxLeverage ?? 100,
            max_notional_per_trade: rule?.maxNotionalPerTrade ?? 1_000_000,
            max_total_exposure: rule?.maxTotalExposure ?? 1_000_000,
            liquidation_threshold: rule?.liquidationThreshold ?? 0.9,
            margin_ratio_limit: 0.98,
        });

        syncedAtByAccount.set(subAccountId, Date.now());
    })();

    if (!force) {
        inFlightSyncByAccount.set(subAccountId, syncPromise);
    }

    try {
        await syncPromise;
    } finally {
        if (!force && inFlightSyncByAccount.get(subAccountId) === syncPromise) {
            inFlightSyncByAccount.delete(subAccountId);
        }
    }
}

export function invalidateCppAccountSync(subAccountId) {
    if (!subAccountId) return;
    syncedAtByAccount.delete(subAccountId);
    inFlightSyncByAccount.delete(subAccountId);
}
