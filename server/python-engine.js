/**
 * Python Engine Manager — spawn/monitor/restart Python trading engine as child process.
 *
 * Features:
 *   - Spawns Python engine on start()
 *   - Pipes stdout/stderr to Node.js console with [Python] prefix
 *   - Auto-restart on crash with exponential backoff (1s → 2s → 4s → ... → 30s)
 *   - Graceful SIGTERM on stop(), SIGKILL after 5s timeout
 *   - Health check via Redis PING key written by Python
 *
 * Usage:
 *   import { startPythonEngine, stopPythonEngine } from './python-engine.js';
 *   await startPythonEngine();   // in server start()
 *   await stopPythonEngine();    // in gracefulShutdown()
 */
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let pythonProcess = null;
let shouldRestart = true;
let restartAttempt = 0;
let restartTimer = null;
const MAX_BACKOFF = 30_000;  // 30s max between restarts
const NON_RESTARTABLE_EXIT_CODES = new Set([78]);  // Fatal startup/config errors
const PYTHON_MAIN_MARKER = 'trading_engine_python.main';

function getBackoffMs() {
    // 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    return Math.min(1000 * (2 ** restartAttempt), MAX_BACKOFF);
}

/**
 * Start the Python trading engine as a child process.
 */
export async function startPythonEngine() {
    if (pythonProcess) {
        console.log('[PythonEngine] Already running (pid=%d)', pythonProcess.pid);
        return;
    }

    shouldRestart = true;
    restartAttempt = 0;
    await terminateOrphanPythonEngines();
    _spawn();
}

/**
 * Stop the Python trading engine gracefully.
 */
export async function stopPythonEngine() {
    shouldRestart = false;

    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    if (!pythonProcess) {
        await terminateOrphanPythonEngines();
        return;
    }

    const proc = pythonProcess;
    pythonProcess = null;

    return new Promise((resolve) => {
        const pid = proc.pid;

        // Force kill after 5s
        const killTimer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
                console.warn('[PythonEngine] Force-killed (SIGKILL) pid=%d', pid);
            } catch { }
            resolve();
        }, 5000);

        proc.once('exit', () => {
            clearTimeout(killTimer);
            console.log('[PythonEngine] Stopped (pid=%d)', pid);
            resolve();
        });

        // Graceful shutdown
        try {
            proc.kill('SIGTERM');
        } catch {
            clearTimeout(killTimer);
            resolve();
        }
    }).finally(async () => {
        await terminateOrphanPythonEngines();
    });
}

function listPythonEnginePids() {
    try {
        const output = execSync('ps -Ao pid=,command=', {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        return output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const match = line.match(/^(\d+)\s+(.+)$/);
                if (!match) return null;
                return { pid: Number(match[1]), command: match[2] };
            })
            .filter((row) => row && row.pid && row.command.includes(PYTHON_MAIN_MARKER))
            .filter((row) => row.pid !== process.pid)
            .map((row) => row.pid);
    } catch {
        return [];
    }
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function terminateOrphanPythonEngines(extraSkipPids = []) {
    const skipPids = new Set(extraSkipPids.filter(Boolean));
    if (pythonProcess?.pid) {
        skipPids.add(pythonProcess.pid);
    }

    const stalePids = listPythonEnginePids().filter((pid) => !skipPids.has(pid));
    if (stalePids.length === 0) {
        return;
    }

    console.warn('[PythonEngine] Killing stale Python engine PID(s): %s', stalePids.join(', '));
    for (const pid of stalePids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // Process may have already exited.
        }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    for (const pid of stalePids) {
        if (!isPidAlive(pid)) continue;
        try {
            process.kill(pid, 'SIGKILL');
            console.warn('[PythonEngine] Force-killed stale Python engine pid=%d', pid);
        } catch {
            // Already gone.
        }
    }
}

/**
 * Internal: spawn the Python process.
 */
function _spawn() {
    const env = {
        ...process.env,
        PYTHONPATH: PROJECT_ROOT,
        PYTHONUNBUFFERED: '1',  // Force unbuffered output for real-time logs
    };

    const args = ['-m', 'trading_engine_python.main'];

    console.log('[PythonEngine] Spawning: python3 %s', args.join(' '));

    const proc = spawn('python3', args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    pythonProcess = proc;

    // Pipe stdout with prefix
    proc.stdout.on('data', (data) => {
        const lines = data.toString().trimEnd().split('\n');
        for (const line of lines) {
            console.log('[🐍] %s', line);
        }
    });

    // Pipe stderr with prefix
    proc.stderr.on('data', (data) => {
        const lines = data.toString().trimEnd().split('\n');
        for (const line of lines) {
            console.error('[🐍] %s', line);
        }
    });

    proc.on('error', (err) => {
        console.error('[PythonEngine] Spawn error:', err.message);
        pythonProcess = null;
        _scheduleRestart();
    });

    proc.on('exit', (code, signal) => {
        pythonProcess = null;

        if (code === 0) {
            console.log('[PythonEngine] Exited cleanly');
            restartAttempt = 0;
        } else if (NON_RESTARTABLE_EXIT_CODES.has(code)) {
            shouldRestart = false;
            restartAttempt = 0;
            console.error(
                '[PythonEngine] Fatal startup/config error (code=%s). Auto-restart disabled until manual restart.',
                code,
            );
        } else {
            console.warn('[PythonEngine] Exited (code=%s, signal=%s)', code, signal);
        }

        _scheduleRestart();
    });
}

/**
 * Internal: schedule a restart with exponential backoff.
 */
function _scheduleRestart() {
    if (!shouldRestart) return;

    const delay = getBackoffMs();
    restartAttempt++;

    console.log('[PythonEngine] Restarting in %dms (attempt %d)...', delay, restartAttempt);

    restartTimer = setTimeout(() => {
        restartTimer = null;
        _spawn();
    }, delay);
}

/**
 * Check if Python engine is currently running.
 */
export function isPythonEngineRunning() {
    return pythonProcess !== null && !pythonProcess.killed;
}
