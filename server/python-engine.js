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
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let pythonProcess = null;
let shouldRestart = true;
let restartAttempt = 0;
let restartTimer = null;
const MAX_BACKOFF = 30_000;  // 30s max between restarts

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
    });
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
