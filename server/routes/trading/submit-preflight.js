import { checkCppWriteReady } from './cpp-write-ready.js';
import { ensureCppAccountSynced } from './cpp-order-utils.js';

export function getCppWriteBridgeOrThrow(getBridge) {
    const bridge = getBridge();
    const readiness = checkCppWriteReady(bridge);
    if (!readiness.ok) {
        const err = new Error(readiness.error || 'C++ engine not ready');
        err.httpStatus = 503;
        err.readiness = readiness;
        throw err;
    }
    return bridge;
}

export async function ensureSubmitPreflight({ getBridge, subAccountId, sync = true }) {
    const bridge = getCppWriteBridgeOrThrow(getBridge);
    if (sync) {
        await ensureCppAccountSynced(bridge, subAccountId);
    }
    return bridge;
}

