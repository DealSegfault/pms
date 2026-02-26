/**
 * Shared readiness check for C++ write-path routes.
 * Prevents ACK-first responses when engine auth configuration is incomplete.
 */
export function checkCppWriteReady(bridge) {
    if (!bridge?.isHealthy()) {
        return {
            ok: false,
            status: 503,
            error: 'C++ engine unavailable for write path',
        };
    }

    const status = bridge.getStatus?.();
    const credentialsConfigured = status?.credentialsConfigured
        ?? Boolean((process.env.BINANCE_API_KEY || process.env.api_key) && (process.env.BINANCE_API_SECRET || process.env.secret));

    if (!credentialsConfigured) {
        return {
            ok: false,
            status: 503,
            error: 'C++ write path missing Binance credentials (BINANCE_API_KEY/BINANCE_API_SECRET)',
        };
    }

    return { ok: true };
}
