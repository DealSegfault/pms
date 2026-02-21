/**
 * Babysitter Process Manager — spawns the Python babysitter as a child process.
 *
 * - Kills stale babysitter processes before spawning (prevents orphan accumulation)
 * - Auto-restarts on crash (max 5 retries in 60s)
 * - Pipes stdout/stderr with [Babysitter] prefix
 * - Graceful kill on shutdown
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const PYTHON = process.env.BABYSITTER_PYTHON || 'python3';
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 3_000;

let _child = null;
let _stopping = false;
let _restartTimestamps = [];
let _restartTimer = null;

function _prefixLines(tag, data) {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
        console.log(`[${tag}] ${line}`);
    }
}

/**
 * Kill any stale babysitter Python processes that survived a previous restart.
 * This prevents orphan accumulation that leads to Binance IP bans.
 */
function _killStaleBabysitters() {
    try {
        // Kill any python processes running babysitter.main (except our own child if it exists)
        const ownPid = _child?.pid;
        const result = execSync(
            `pgrep -f "babysitter.main" 2>/dev/null || true`,
            { encoding: 'utf8', timeout: 3000 }
        ).trim();

        if (!result) return;

        const pids = result.split('\n').map(p => parseInt(p.trim(), 10)).filter(Boolean);
        for (const pid of pids) {
            if (pid === ownPid) continue; // don't kill our own child
            try {
                process.kill(pid, 'SIGKILL');
                console.log(`[Babysitter] Killed stale orphan process PID=${pid}`);
            } catch { /* already dead */ }
        }
    } catch {
        // pgrep not available or failed — that's fine
    }
}

function _spawn() {
    if (_stopping) return;

    // Rate-limit restarts
    const now = Date.now();
    _restartTimestamps = _restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);
    if (_restartTimestamps.length >= MAX_RESTARTS) {
        console.error('[Babysitter] Too many restarts in 60s — giving up. Check Python babysitter logs.');
        return;
    }
    _restartTimestamps.push(now);

    // Kill any orphaned babysitter processes from previous runs
    _killStaleBabysitters();

    console.log('[Babysitter] Spawning Python babysitter process...');

    _child = spawn(PYTHON, ['-m', 'babysitter.main'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    const childPid = _child.pid;
    console.log(`[Babysitter] Python process started with PID=${childPid}`);

    _child.stdout.on('data', (data) => _prefixLines('Babysitter', data));
    _child.stderr.on('data', (data) => _prefixLines('Babysitter:err', data));

    _child.on('error', (err) => {
        console.error('[Babysitter] Failed to spawn:', err.message);
    });

    _child.on('exit', (code, signal) => {
        _child = null;
        if (_stopping) {
            console.log(`[Babysitter] Process PID=${childPid} stopped.`);
            return;
        }
        console.warn(`[Babysitter] PID=${childPid} exited (code=${code}, signal=${signal}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
        _restartTimer = setTimeout(_spawn, RESTART_DELAY_MS);
    });
}

export function start() {
    _stopping = false;
    _restartTimestamps = [];
    _spawn();
}

export function stop() {
    _stopping = true;
    if (_restartTimer) {
        clearTimeout(_restartTimer);
        _restartTimer = null;
    }
    if (!_child) {
        // Even if we have no tracked child, kill any stale orphans
        _killStaleBabysitters();
        return Promise.resolve();
    }

    const childPid = _child.pid;
    console.log(`[Babysitter] Stopping Python process PID=${childPid}...`);

    return new Promise((resolve) => {
        const child = _child;

        child.kill('SIGTERM');

        // Force-kill after 2s if still alive (reduced from 5s — no reason to wait long)
        const forceTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
            console.warn(`[Babysitter] Force-killed PID=${childPid}`);
        }, 2000);

        child.on('exit', () => {
            clearTimeout(forceTimer);
            resolve();
        });

        // Safety: resolve after 3s no matter what, then sweep orphans
        setTimeout(() => {
            clearTimeout(forceTimer);
            _killStaleBabysitters();
            resolve();
        }, 3000);
    });
}

export default { start, stop };
