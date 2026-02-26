import * as S from './state.js';

const MAX_SAMPLES = 256;
const REPORT_INTERVAL_MS = 30000;

const samples = new Map();
let frameMonitorId = null;
let frameDropCount = 0;
let longTaskCount = 0;
let lastFrameTs = 0;
let reportTimer = null;
let sessionOrderSeq = 0;
const orderLifecycle = new Map();
const queueDepths = new Map();

function _pushSample(metric, value) {
    if (!Number.isFinite(value) || value < 0) return;
    const arr = samples.get(metric) || [];
    arr.push(value);
    if (arr.length > MAX_SAMPLES) arr.shift();
    samples.set(metric, arr);
}

function _percentile(arr, p) {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
}

function _formatStat(metric) {
    const arr = samples.get(metric);
    if (!arr || arr.length === 0) return `${metric}=n/a`;
    const p50 = _percentile(arr, 50);
    const p95 = _percentile(arr, 95);
    const p99 = _percentile(arr, 99);
    return `${metric} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms n=${arr.length}`;
}

function _frameMonitor(ts) {
    if (lastFrameTs > 0) {
        const dt = ts - lastFrameTs;
        if (dt > 34) frameDropCount += 1;
        if (dt > 50) longTaskCount += 1;
        _pushSample('frame_time_ms', dt);
    }
    lastFrameTs = ts;
    frameMonitorId = requestAnimationFrame(_frameMonitor);
}

function _report() {
    if (!S._tradingMounted) return;
    const lines = [
        _formatStat('click_to_send_ms'),
        _formatStat('send_to_ack_ms'),
        _formatStat('ack_to_paint_ms'),
        _formatStat('depth_tick_to_paint_ms'),
        _formatStat('trade_tick_to_paint_ms'),
        _formatStat('frame_time_ms'),
        _formatStat('refresh_flush_ms'),
        _formatStat('refresh_open_orders_ms'),
        _formatStat('refresh_open_orders_fetch_ms'),
        _formatStat('refresh_open_orders_render_ms'),
        _formatStat('refresh_positions_ms'),
        _formatStat('refresh_annotations_ms'),
        _formatStat('refresh_chart_data_fetch_ms'),
        _formatStat('refresh_account_ms'),
    ];

    const queueSummary = [...queueDepths.entries()]
        .map(([name, depth]) => `${name}=${depth}`)
        .join(' ');

    console.log(`[Perf] ${lines.join(' | ')} | dropped_frames=${frameDropCount} long_frames=${longTaskCount}${queueSummary ? ` | queues ${queueSummary}` : ''}`);

    frameDropCount = 0;
    longTaskCount = 0;
}

export function startPerfMetrics() {
    if (frameMonitorId == null) {
        lastFrameTs = 0;
        frameMonitorId = requestAnimationFrame(_frameMonitor);
    }
    if (reportTimer == null) {
        reportTimer = setInterval(_report, REPORT_INTERVAL_MS);
    }
}

export function stopPerfMetrics() {
    if (frameMonitorId != null) {
        cancelAnimationFrame(frameMonitorId);
        frameMonitorId = null;
    }
    if (reportTimer != null) {
        clearInterval(reportTimer);
        reportTimer = null;
    }
    orderLifecycle.clear();
    queueDepths.clear();
    lastFrameTs = 0;
}

export function recordLatency(metric, valueMs) {
    _pushSample(metric, valueMs);
}

export function noteQueueDepth(name, depth) {
    queueDepths.set(name, Number.isFinite(depth) ? depth : 0);
}

export function beginOrderLatency(kind = 'market') {
    sessionOrderSeq += 1;
    const id = `${kind}_${Date.now()}_${sessionOrderSeq}`;
    orderLifecycle.set(id, {
        clickTs: performance.now(),
        sendTs: 0,
        ackTs: 0,
    });
    return id;
}

export function markOrderSent(orderId) {
    const row = orderLifecycle.get(orderId);
    if (!row || row.sendTs) return;
    row.sendTs = performance.now();
    recordLatency('click_to_send_ms', row.sendTs - row.clickTs);
}

export function markOrderAck(orderId) {
    const row = orderLifecycle.get(orderId);
    if (!row || row.ackTs) return;
    row.ackTs = performance.now();
    if (row.sendTs) {
        recordLatency('send_to_ack_ms', row.ackTs - row.sendTs);
    }
}

export function markOrderPaint(orderId) {
    const row = orderLifecycle.get(orderId);
    if (!row || !row.ackTs) return;
    const paintTs = performance.now();
    recordLatency('ack_to_paint_ms', paintTs - row.ackTs);
    orderLifecycle.delete(orderId);
}
