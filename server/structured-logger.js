/**
 * Structured Logger — JSON-line error/warn logger for AI-debuggable diagnostics.
 *
 * Writes structured JSON lines to both console and logs/errors.jsonl.
 * Each line includes: timestamp, level, component, error code, message,
 * and a context object with the actual payload/state that caused the error.
 *
 * Usage:
 *   import { log } from './structured-logger.js';
 *   log.warn('uds-bridge', 'SCHEMA_VIOLATION', 'Missing sub_account_id', { op, payload });
 *   log.error('chase', 'REPRICE_FAILED', 'Cancel timed out', { chaseId, symbol, err });
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const MAX_LINES = 10_000; // Rotate after 10k lines
const MAX_CTX_SIZE = 2048; // Truncate context to prevent giant payloads

// ── Ring Buffer (last N errors kept in memory for /api/debug/diagnostics) ────

const RING_SIZE = 100;
const _ring = [];
let _ringIdx = 0;

/** Get the last N errors from the in-memory ring buffer. */
export function getRecentErrors(count = 20) {
    const result = [];
    const total = Math.min(count, _ring.length);
    for (let i = 0; i < total; i++) {
        const idx = (_ringIdx - 1 - i + _ring.length) % _ring.length;
        if (_ring[idx]) result.push(_ring[idx]);
    }
    return result;
}

// ── File Writer ──────────────────────────────────────────────────────────────

let _fd = null;
let _lineCount = 0;
let _currentDate = '';

function getDateStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
    } catch { /* best-effort */ }
}

function openLogFile() {
    const dateStr = getDateStr();
    if (_fd && _currentDate === dateStr) return; // Already open for today

    // Close previous
    if (_fd) {
        try { fs.closeSync(_fd); } catch { /* ignore */ }
    }

    ensureLogDir();
    _currentDate = dateStr;

    const filePath = path.join(LOG_DIR, `errors-${dateStr}.jsonl`);
    try {
        _fd = fs.openSync(filePath, 'a');
        // Count existing lines for rotation
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            _lineCount = content.split('\n').filter(l => l.length > 0).length;
        } catch {
            _lineCount = 0;
        }
    } catch (err) {
        console.error(`[StructuredLogger] Failed to open log file: ${err.message}`);
        _fd = null;
    }

    // Cleanup old files (keep last 7 days)
    cleanupOldLogs();
}

function cleanupOldLogs() {
    try {
        const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('errors-') && f.endsWith('.jsonl'));
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const file of files) {
            const match = file.match(/errors-(\d{4}-\d{2}-\d{2})\.jsonl/);
            if (match) {
                const fileDate = new Date(match[1]).getTime();
                if (fileDate < cutoff) {
                    try { fs.unlinkSync(path.join(LOG_DIR, file)); } catch { /* ignore */ }
                }
            }
        }
    } catch { /* best-effort */ }
}

function writeLine(entry) {
    openLogFile();
    if (!_fd) return;

    // Rotate if too many lines
    if (_lineCount >= MAX_LINES) {
        try { fs.closeSync(_fd); } catch { /* ignore */ }
        const filePath = path.join(LOG_DIR, `errors-${_currentDate}.jsonl`);
        const rotatedPath = path.join(LOG_DIR, `errors-${_currentDate}.${Date.now()}.jsonl`);
        try { fs.renameSync(filePath, rotatedPath); } catch { /* ignore */ }
        try {
            _fd = fs.openSync(filePath, 'a');
            _lineCount = 0;
        } catch {
            _fd = null;
            return;
        }
    }

    try {
        const line = JSON.stringify(entry) + '\n';
        fs.writeSync(_fd, line);
        _lineCount++;
    } catch { /* best-effort */ }
}

// ── Context Sanitization ────────────────────────────────────────────────────

function sanitizeContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    try {
        let json = JSON.stringify(ctx, (key, value) => {
            // Redact sensitive fields
            if (key === 'apiKey' || key === 'api_key' || key === 'secret' ||
                key === 'BINANCE_API_KEY' || key === 'BINANCE_API_SECRET' ||
                key === 'passwordHash' || key === 'password') {
                return '[REDACTED]';
            }
            // Truncate long strings
            if (typeof value === 'string' && value.length > 500) {
                return value.slice(0, 500) + '...[truncated]';
            }
            return value;
        });
        if (json.length > MAX_CTX_SIZE) {
            json = json.slice(0, MAX_CTX_SIZE) + '...[truncated]}';
        }
        return JSON.parse(json);
    } catch {
        return { _serialization_error: true };
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

function _log(level, component, code, message, context) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        component,
        code,
        msg: message,
    };

    if (context) {
        entry.ctx = sanitizeContext(context);
    }

    // Write to file
    writeLine(entry);

    // Push to in-memory ring buffer
    if (_ring.length < RING_SIZE) {
        _ring.push(entry);
    } else {
        _ring[_ringIdx % RING_SIZE] = entry;
    }
    _ringIdx = (_ringIdx + 1) % RING_SIZE;

    // Also log to console (preserving existing behavior)
    const prefix = `[${component}]`;
    const consoleMsg = code ? `${prefix} ${code}: ${message}` : `${prefix} ${message}`;

    if (level === 'error') {
        console.error(consoleMsg);
    } else if (level === 'warn') {
        console.warn(consoleMsg);
    } else {
        console.log(consoleMsg);
    }
}

export const log = {
    /** Log an error with structured context */
    error(component, code, message, context) {
        _log('error', component, code, message, context);
    },
    /** Log a warning with structured context */
    warn(component, code, message, context) {
        _log('warn', component, code, message, context);
    },
    /** Log an info message with structured context */
    info(component, code, message, context) {
        _log('info', component, code, message, context);
    },
};

export default log;
