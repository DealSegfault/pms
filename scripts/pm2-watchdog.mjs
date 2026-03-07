#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ECOSYSTEM_FILE = path.join(PROJECT_ROOT, 'ecosystem.config.cjs');

const PM2_BIN = process.env.PM2_BIN || 'pm2';
const PM2_SYSTEMD_UNIT = process.env.PM2_SYSTEMD_UNIT || 'pm2-root';
const BACKEND_NAME = process.env.WATCHDOG_BACKEND_NAME || 'pms-backend';
const ENGINE_NAME = process.env.WATCHDOG_ENGINE_NAME || 'pms-engine';
const BACKEND_URL = process.env.WATCHDOG_BACKEND_URL || 'http://127.0.0.1:3900/api/health';
const POLL_MS = parseEnvInt('WATCHDOG_POLL_MS', 10_000);
const RESTART_COOLDOWN_MS = parseEnvInt('WATCHDOG_RESTART_COOLDOWN_MS', 30_000);
const HEALTH_FAILURES = parseEnvInt('WATCHDOG_HEALTH_FAILURES', 3);
const MEMORY_STRIKES = parseEnvInt('WATCHDOG_MEMORY_STRIKES', 2);
const BACKEND_MEMORY_MB = parseEnvInt('WATCHDOG_BACKEND_MEMORY_MB', 320);
const ENGINE_MEMORY_MB = parseEnvInt('WATCHDOG_ENGINE_MEMORY_MB', 0);
const PM2_FAILURES = parseEnvInt('WATCHDOG_PM2_FAILURES', 3);
const LOG_LINES = parseEnvInt('WATCHDOG_LOG_LINES', 40);
const REQUEST_TIMEOUT_MS = parseEnvInt('WATCHDOG_REQUEST_TIMEOUT_MS', 4_000);
const ONCE = process.env.WATCHDOG_ONCE === '1';
const DRY_RUN = process.env.WATCHDOG_DRY_RUN === '1';

const FATAL_LOG_PATTERNS = [
    /heap out of memory/i,
    /allocation failed/i,
    /out of memory/i,
    /\boom\b/i,
    /\bkilled\b/i,
    /fatal error/i,
    /sigkill/i,
    /exit code 137/i,
    /process out of memory/i,
    /memory limit/i,
];

const state = {
    healthFailures: 0,
    pm2Failures: 0,
    memoryStrikes: new Map(),
    restartCooldowns: new Map(),
    lastFatalSignature: new Map(),
};

process.title = 'pms-watchdog';

function parseEnvInt(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) ? value : fallback;
}

function now() {
    return Date.now();
}

function log(level, message) {
    const text = `[Watchdog] ${message}`;
    if (level === 'error') {
        console.error(text);
        return;
    }
    if (level === 'warn') {
        console.warn(text);
        return;
    }
    console.log(text);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args) {
    return execFileSync(command, args, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function truncateOneLine(value, limit = 160) {
    const singleLine = String(value || '').replace(/\s+/g, ' ').trim();
    if (singleLine.length <= limit) return singleLine;
    return `${singleLine.slice(0, limit - 3)}...`;
}

function getPm2Processes() {
    const raw = run(PM2_BIN, ['jlist']);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('pm2 jlist returned a non-array payload');
    }
    return parsed;
}

function findProcess(processes, name) {
    return processes.find((entry) => entry?.name === name) || null;
}

function statusOf(proc) {
    return proc?.pm2_env?.status || 'missing';
}

function memoryMb(proc) {
    return Math.round((proc?.monit?.memory || 0) / 1024 / 1024);
}

function readTail(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    try {
        return run('tail', ['-n', String(LOG_LINES), filePath]);
    } catch {
        return '';
    }
}

function recentFatalLine(proc) {
    const logPath = proc?.pm2_env?.pm_err_log_path;
    if (!logPath) return '';
    const lines = readTail(logPath)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.reverse().find((line) => FATAL_LOG_PATTERNS.some((pattern) => pattern.test(line))) || '';
}

async function checkBackendHealth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(BACKEND_URL, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
        });
        if (!response.ok) {
            return { ok: false, reason: `health HTTP ${response.status}` };
        }

        const payload = await response.json().catch(() => null);
        if (!payload || payload.status !== 'ok') {
            return { ok: false, reason: 'health payload not ok' };
        }
        if (payload.database === false) {
            return { ok: false, reason: 'health database=false' };
        }
        if (payload.redis === false) {
            return { ok: false, reason: 'health redis=false' };
        }

        return { ok: true, reason: 'ok' };
    } catch (error) {
        return { ok: false, reason: truncateOneLine(error.message || error) };
    } finally {
        clearTimeout(timeout);
    }
}

function inCooldown(key) {
    const lastActionAt = state.restartCooldowns.get(key) || 0;
    return now() - lastActionAt < RESTART_COOLDOWN_MS;
}

function noteAction(key) {
    state.restartCooldowns.set(key, now());
}

function logFatalSignature(name, signature) {
    if (!signature) return;
    if (state.lastFatalSignature.get(name) === signature) return;
    state.lastFatalSignature.set(name, signature);
    log('warn', `${name} recent fatal log: ${truncateOneLine(signature)}`);
}

function runOrDry(command, args, summary) {
    if (DRY_RUN) {
        log('warn', `[dry-run] ${summary}`);
        return '';
    }
    return run(command, args);
}

function restartApp(name, reason, proc) {
    if (inCooldown(name)) {
        log('warn', `Cooldown active for ${name}; skipping restart (${reason})`);
        return;
    }

    const status = statusOf(proc);
    const summary = `${status === 'missing' ? 'start' : 'restart'} ${name} (${reason})`;
    try {
        if (status === 'missing') {
            runOrDry(PM2_BIN, ['start', ECOSYSTEM_FILE, '--only', name], summary);
        } else {
            runOrDry(PM2_BIN, ['restart', name, '--update-env'], summary);
        }
        noteAction(name);
        log('warn', summary);
    } catch (error) {
        log('error', `Failed to ${summary}: ${truncateOneLine(error.message || error)}`);
    }
}

function restartPm2(reason) {
    if (inCooldown(PM2_SYSTEMD_UNIT)) {
        log('warn', `Cooldown active for ${PM2_SYSTEMD_UNIT}; skipping restart (${reason})`);
        return;
    }

    try {
        runOrDry('systemctl', ['restart', PM2_SYSTEMD_UNIT], `restart ${PM2_SYSTEMD_UNIT} (${reason})`);
        noteAction(PM2_SYSTEMD_UNIT);
        log('warn', `restart ${PM2_SYSTEMD_UNIT} (${reason})`);
    } catch (error) {
        log('error', `Failed to restart ${PM2_SYSTEMD_UNIT}: ${truncateOneLine(error.message || error)}`);
    }
}

function trackMemory(name, proc, limitMb) {
    if (!limitMb || limitMb <= 0) return false;
    const currentMb = memoryMb(proc);
    if (currentMb < limitMb) {
        state.memoryStrikes.set(name, 0);
        return false;
    }

    const strikes = (state.memoryStrikes.get(name) || 0) + 1;
    state.memoryStrikes.set(name, strikes);
    if (strikes === 1) {
        log('warn', `${name} memory high: ${currentMb}MB >= ${limitMb}MB`);
    }
    return strikes >= MEMORY_STRIKES;
}

async function inspectApp(processes, name, options = {}) {
    const proc = findProcess(processes, name);
    const status = statusOf(proc);
    const fatalLine = recentFatalLine(proc);
    logFatalSignature(name, fatalLine);

    if (status !== 'online') {
        const reason = fatalLine ? `status=${status}; ${truncateOneLine(fatalLine)}` : `status=${status}`;
        restartApp(name, reason, proc);
        return;
    }

    if (trackMemory(name, proc, options.memoryLimitMb || 0)) {
        const reason = `memory ${memoryMb(proc)}MB >= ${options.memoryLimitMb}MB for ${MEMORY_STRIKES} checks`;
        restartApp(name, fatalLine ? `${reason}; ${truncateOneLine(fatalLine)}` : reason, proc);
        return;
    }

    if (options.healthCheck) {
        const health = await checkBackendHealth();
        if (health.ok) {
            state.healthFailures = 0;
            return;
        }

        state.healthFailures += 1;
        log('warn', `${name} health failure ${state.healthFailures}/${HEALTH_FAILURES}: ${health.reason}`);
        if (state.healthFailures >= HEALTH_FAILURES) {
            const reason = fatalLine
                ? `health failed ${state.healthFailures} checks; ${health.reason}; ${truncateOneLine(fatalLine)}`
                : `health failed ${state.healthFailures} checks; ${health.reason}`;
            restartApp(name, reason, proc);
            state.healthFailures = 0;
        }
    }
}

async function checkOnce() {
    let processes;

    try {
        processes = getPm2Processes();
        state.pm2Failures = 0;
    } catch (error) {
        state.pm2Failures += 1;
        log(
            'warn',
            `pm2 jlist failed ${state.pm2Failures}/${PM2_FAILURES}: ${truncateOneLine(error.message || error)}`,
        );
        if (state.pm2Failures >= PM2_FAILURES) {
            restartPm2('pm2 jlist failed repeatedly');
            state.pm2Failures = 0;
        }
        return;
    }

    await inspectApp(processes, ENGINE_NAME, {
        memoryLimitMb: ENGINE_MEMORY_MB,
        healthCheck: false,
    });
    await inspectApp(processes, BACKEND_NAME, {
        memoryLimitMb: BACKEND_MEMORY_MB,
        healthCheck: true,
    });
}

async function main() {
    log(
        'info',
        `Starting watchdog (poll=${POLL_MS}ms backend=${BACKEND_NAME} engine=${ENGINE_NAME} dryRun=${DRY_RUN ? '1' : '0'})`,
    );

    do {
        try {
            await checkOnce();
        } catch (error) {
            log('error', `Watchdog loop failed: ${truncateOneLine(error.stack || error.message || error)}`);
        }

        if (!ONCE) {
            await sleep(POLL_MS);
        }
    } while (!ONCE);
}

main().catch((error) => {
    log('error', `Fatal watchdog error: ${truncateOneLine(error.stack || error.message || error)}`);
    process.exitCode = 1;
});
