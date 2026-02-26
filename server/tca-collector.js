/**
 * TCA Collector — STUB
 * 
 * V2: TCA metrics collection disabled. Will be rebuilt when core is stable.
 * Exports no-op functions to satisfy remaining imports in chase-limit.js.
 */

class TcaCollector {
    recordOrder() { }
    recordFill() { }
    recordCancel() { }
    recordLatency() { }
    getMetrics() { return {}; }
    getSymbolMetrics() { return {}; }
    reset() { }
}

const tca = new TcaCollector();
export default tca;
