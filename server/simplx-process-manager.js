/**
 * Simplx Process Manager — spawns, babysits, and auto-restarts the C++ engine.
 *
 * Feature-gated by CPP_ENGINE_ENABLED=1.
 *
 * On startup:
 *   1. Locates the compiled binary (build/ or build-release/)
 *   2. Spawns it as a child process with correct Redis + WS args
 *   3. Monitors for crashes and auto-restarts with exponential backoff
 *   4. On server shutdown, sends SIGINT and waits for clean exit
 *
 * Env vars:
 *   CPP_ENGINE_ENABLED=1     — enable the process manager
 *   CPP_ENGINE_BIN           — override binary path
 *   CPP_MAX_RESTART_DELAY=30 — max backoff seconds
 *   CPP_RESTART_ENABLED=1    — enable auto-restart (default: true)
 */

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'events';
import { log } from './structured-logger.js';

const CPP_ENGINE_ENABLED = process.env.CPP_ENGINE_ENABLED === '1' || process.env.CPP_ENGINE_ENABLED === 'true';
const CPP_RESTART_ENABLED = process.env.CPP_RESTART_ENABLED !== '0' && process.env.CPP_RESTART_ENABLED !== 'false';
const CPP_MONITORING = process.env.CPP_MONITORING !== '0' && process.env.CPP_MONITORING !== 'false';
const MAX_RESTART_DELAY_S = parseInt(process.env.CPP_MAX_RESTART_DELAY || '30', 10);
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const WEBVIZ_PORT = process.env.MONITORING_WEBVIZ_PORT || '7070';

const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SIMPLX_DIR = path.join(PROJECT_ROOT, 'engine_simplx');

class SimplxProcessManager extends EventEmitter {
    constructor() {
        super();
        this._child = null;
        this._webvizChild = null;
        this._shuttingDown = false;
        this._restartCount = 0;
        this._restartTimer = null;
        this._startedAt = null;
        this._lastExitCode = null;
        this._binPath = null;
    }

    /**
     * Find the compiled binary. Checks:
     *   1. CPP_ENGINE_BIN env override
     *   2. build/trading_oms_binance_service
     *   3. build-release/trading_oms_binance_service
     */
    _findBinary() {
        if (process.env.CPP_ENGINE_BIN) {
            const p = path.resolve(process.env.CPP_ENGINE_BIN);
            if (fs.existsSync(p)) return p;
            console.warn(`[SimplxPM] CPP_ENGINE_BIN=${p} not found`);
        }

        const candidates = [
            path.join(SIMPLX_DIR, 'build-release', 'trading_oms_binance_service'),
            path.join(SIMPLX_DIR, 'build', 'trading_oms_binance_service'),
        ];

        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }

        return null;
    }

    /**
     * Build the CLI args for the C++ service.
     */
    async _buildArgs() {
        const ingressMode = (process.env.CPP_REDIS_INGRESS_MODE || 'channel').toLowerCase();
        const args = [
            '--redis-host', REDIS_HOST,
            '--redis-port', REDIS_PORT,
            '--redis-ingress-mode', ingressMode,
            '--redis-ingress-burst', '4096',
            '--queue-shards', process.env.CPP_QUEUE_SHARDS || '4',
            '--core-shards', process.env.CPP_CORE_SHARDS || '4',
            '--max-queue', '20000',
            '--max-per-second', '100000',
            '--max-batch', '32',
            '--flush-us', '2000',
            '--emit-queue-status', '0',
            '--emit-position-updates', '1',
            '--monitoring-enable', CPP_MONITORING ? '1' : '0',
            '--default-max-leverage', '125',
            '--default-max-notional', '10000000',
            '--default-max-exposure', '50000000',
            '--default-liq-threshold', '0.9',
            '--default-margin-ratio-limit', '0.98',

        ];

        if (ingressMode === 'stream' || ingressMode === 'both') {
            args.push('--redis-stream-start-id', process.env.CPP_REDIS_STREAM_START_ID || '$');
            args.push('--redis-stream-read-count', process.env.CPP_REDIS_STREAM_READ_COUNT || '512');
            args.push('--redis-stream-block-ms', process.env.CPP_REDIS_STREAM_BLOCK_MS || '10');
        }

        // Binance API credentials (support both BINANCE_API_KEY and api_key from .env)
        const apiKey = process.env.BINANCE_API_KEY || process.env.api_key;
        const apiSecret = process.env.BINANCE_API_SECRET || process.env.secret;
        if (apiKey) {
            args.push('--binance-api-key', apiKey);
        }
        if (apiSecret) {
            args.push('--binance-api-secret', apiSecret);
        }

        // Binance WS connection — C++ engine connects directly via native TLS (TlsTcpClient).
        // The user data stream requires a listen key in the URL path.
        let wsUrl = process.env.CPP_WS_URL || process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/ws';
        if (apiKey && !process.env.CPP_WS_URL) {
            try {
                const fapi = process.env.BINANCE_FAPI_URL || 'https://fapi.binance.com';
                const resp = await fetch(`${fapi}/fapi/v1/listenKey`, {
                    method: 'POST',
                    headers: { 'X-MBX-APIKEY': apiKey },
                });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.listenKey) {
                        wsUrl = `wss://fstream.binance.com/ws/${data.listenKey}`;
                        console.log(`[SimplxPM] Created listenKey for C++ user data stream`);
                        // Keepalive: PUT every 30min to prevent listen key expiry
                        // Clear any previous keepalive before creating a new one (Fix #27)
                        if (this._listenKeyKeepAlive) {
                            clearInterval(this._listenKeyKeepAlive);
                        }
                        this._listenKeyKeepAlive = setInterval(async () => {
                            try {
                                await fetch(`${fapi}/fapi/v1/listenKey`, {
                                    method: 'PUT',
                                    headers: { 'X-MBX-APIKEY': apiKey },
                                });
                            } catch { }
                        }, 30 * 60_000);
                    }
                }
            } catch (err) {
                console.warn('[SimplxPM] Failed to create listenKey:', err.message);
            }
        }
        args.push('--binance-ws-url', wsUrl);
        args.push('--binance-ws-binance-protocol', '1');
        // Orders go via REST (more reliable), WS is for receiving execution reports
        args.push('--prefer-rest-for-orders', 'true');
        args.push('--rest-fallback-enabled', 'true');

        // Subscribe to market streams — empty by default since JS forwards ticks via Redis
        if (process.env.CPP_WS_SUBSCRIBE) {
            args.push('--binance-subscribe', process.env.CPP_WS_SUBSCRIBE);
        }

        // REST client timeouts — defaults (1s connect, 2s request) are too
        // tight for HTTPS→Binance through TLS; orders time out and get REJECTED.
        args.push('--binance-rest-connect-timeout-ms', process.env.CPP_REST_CONNECT_TIMEOUT_MS || '5000');
        args.push('--binance-rest-timeout-ms', process.env.CPP_REST_TIMEOUT_MS || '10000');

        // Phase 1: UDS (Unix Domain Socket) IPC for direct JS↔C++ communication
        const udsEnabled = process.env.CPP_ENGINE_UDS === '1' || process.env.CPP_ENGINE_UDS === 'true';
        if (udsEnabled) {
            const udsPath = process.env.CPP_UDS_PATH || '/tmp/pms-engine.sock';
            args.push('--uds-enabled', '1');
            args.push('--uds-path', udsPath);
            console.log(`[SimplxPM] UDS enabled at ${udsPath}`);
        }

        return args;
    }

    /**
     * Recompile the C++ engine via the top-level Makefile.
     * Non-fatal: if the build fails, we fall back to the existing binary.
     */
    _recompile() {
        console.log('[SimplxPM] Recompiling C++ engine...');
        try {
            execSync('make release', {
                cwd: SIMPLX_DIR,
                stdio: 'inherit',
                timeout: 120_000, // 2 min safety cap
            });
            console.log('[SimplxPM] Recompile done ✅');
        } catch (err) {
            console.warn(`[SimplxPM] Recompile failed (${err.message}) — will use existing binary if available`);
        }
    }

    /**
     * Kill any process listening on the given port.
     */
    _killPort(port) {
        try {
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
        } catch { /* ignore */ }
    }

    /**
     * Start the C++ engine process.
     */
    async start() {
        if (!CPP_ENGINE_ENABLED) {
            console.log('[SimplxPM] Disabled (set CPP_ENGINE_ENABLED=1 to enable)');
            return false;
        }

        // Synthetic hot-reload: recompile before launching
        this._recompile();

        this._binPath = this._findBinary();
        if (!this._binPath) {
            console.warn('[SimplxPM] Binary not found. Build with: cd engine_simplx && make');
            return false;
        }

        return this._spawn();
    }

    async _spawn() {
        if (this._shuttingDown) return false;

        // Kill any stale trading_oms_binance_service processes to prevent
        // credential-less old binaries from competing for orders on Redis.
        try {
            const binName = path.basename(this._binPath);
            execSync(`pkill -f "${binName}" 2>/dev/null || true`, { stdio: 'ignore' });
        } catch { /* best-effort */ }

        const args = await this._buildArgs();
        console.log(`[SimplxPM] Starting: ${path.basename(this._binPath)} (restart #${this._restartCount})`);

        try {
            this._child = spawn(this._binPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: SIMPLX_DIR,
            });
        } catch (err) {
            log.error('cpp-engine', 'SPAWN_FAILED', err.message, { binary: this._binPath, stack: err.stack });
            this._scheduleRestart();
            return false;
        }

        this._startedAt = Date.now();

        // Pipe stdout/stderr with prefix — buffer partial lines to prevent fragmentation
        let _stdoutBuf = '';
        this._child.stdout.on('data', (chunk) => {
            _stdoutBuf += chunk.toString();
            const parts = _stdoutBuf.split('\n');
            _stdoutBuf = parts.pop(); // keep incomplete last line
            for (const line of parts) {
                if (!line.trim()) continue;
                console.log(`[C++] ${line}`);
            }
        });

        // C++ stderr noise filter — suppress high-frequency debug lines
        const _suppressPrefixes = [
            '[chase] REPRICE ',         // every tick reprice
            '[chase] ACK ',             // every chase ack
            '[chase] START ',           // chase start (logged by JS)
            '[queue] DISPATCH ',        // every batch dispatch
            '[ws_pool] Subscribed ',    // ws subscribe churn
            '[ws_pool] Unsubscribed ',  // ws unsubscribe churn
            '[ws_pool] Created ',       // ws pool init
            '[ws_pool] Status:',        // periodic status
            '[rest] ⚠️ SLOW REST ',     // every REST call logged as slow
            '[rest] NEW ',              // every new order (redundant)
            '[rest] CANCEL_REPLACE ',   // every chase reprice REST call
            '[REST] processCancel',     // verbose cancel debug
            '[OMS] handleCancelOrder',  // verbose cancel debug
            '[OMS] Emitted ENGINE_READY', // internal, already logged by bootstrap
            '[user_stream] ORDER_TRADE_UPDATE', // redundant with EventPersister
            '[user_stream] ACCOUNT_UPDATE',     // redundant
            'DNS ',                     // DNS resolution noise
            '[TlsTransport] handshake', // TLS handshake
            'Error: errno=Undefined error: 0', // macOS MSG_NOSIGNAL false alarm
        ];
        let _stderrBuf = '';
        this._child.stderr.on('data', (chunk) => {
            _stderrBuf += chunk.toString();
            const parts = _stderrBuf.split('\n');
            _stderrBuf = parts.pop(); // keep incomplete last line
            for (const line of parts) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Skip lines matching any noise prefix
                if (_suppressPrefixes.some(p => trimmed.includes(p))) continue;
                console.log(`[C++] ${trimmed}`);
            }
        });

        this._child.on('exit', (code, signal) => {
            const uptime = ((Date.now() - this._startedAt) / 1000).toFixed(1);
            this._lastExitCode = code;

            if (this._shuttingDown) {
                console.log(`[SimplxPM] Clean shutdown (code=${code}, signal=${signal}, uptime=${uptime}s)`);
                this._child = null;
                this.emit('stopped');
                return;
            }

            console.warn(`[SimplxPM] Process exited (code=${code}, signal=${signal}, uptime=${uptime}s)`);
            log.error('cpp-engine', 'ENGINE_CRASH', `C++ engine crashed (code=${code}, signal=${signal}, uptime=${uptime}s)`, {
                exitCode: code, signal, uptimeSeconds: parseFloat(uptime),
                restartCount: this._restartCount,
                warnings: [
                    'In-flight orders in OrderQueue are LOST',
                    'Active chase/scalper/TWAP sessions are LOST',
                    'Phantom exchange orders may exist — run reconciliation',
                ],
            });
            this._child = null;
            this.emit('crashed', { code, signal, uptime });

            if (CPP_RESTART_ENABLED) {
                this._scheduleRestart();
            } else {
                console.log('[SimplxPM] Auto-restart disabled');
            }
        });

        this._child.on('error', (err) => {
            log.error('cpp-engine', 'PROCESS_ERROR', err.message, { binary: this._binPath });
        });

        this.emit('started', { pid: this._child.pid, restart: this._restartCount });

        // Auto-start monitoring webviz if monitoring is enabled
        if (CPP_MONITORING && !this._webvizChild) {
            this._startWebviz();
        }

        return true;
    }

    _scheduleRestart() {
        if (this._shuttingDown) return;

        // Exponential backoff: 1s, 2s, 4s, 8s... capped at MAX_RESTART_DELAY_S
        const delay = Math.min(
            Math.pow(2, Math.min(this._restartCount, 10)) * 1000,
            MAX_RESTART_DELAY_S * 1000
        );
        this._restartCount++;

        console.log(`[SimplxPM] Restarting in ${(delay / 1000).toFixed(1)}s (attempt #${this._restartCount})`);

        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this._spawn();
        }, delay);
    }

    /**
     * Spawn the monitoring webviz Node.js server.
     */
    _startWebviz() {
        // Kill any stale process holding the webviz port
        this._killPort(WEBVIZ_PORT);

        const serverPath = path.join(PROJECT_ROOT, 'simplx', 'tools', 'monitoring_webviz', 'server.js');
        if (!fs.existsSync(serverPath)) {
            console.warn(`[SimplxPM] Webviz server not found at ${serverPath}`);
            return;
        }

        const monFile = path.join(SIMPLX_DIR, 'monitoring_oms.ndjson');
        try {
            this._webvizChild = spawn('node', [serverPath, '--file', monFile, '--port', WEBVIZ_PORT], {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: PROJECT_ROOT,
            });

            this._webvizChild.stdout.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(l => l.trim());
                for (const line of lines) {
                    console.log(`[Webviz] ${line}`);
                }
            });
            this._webvizChild.stderr.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(l => l.trim());
                for (const line of lines) {
                    console.error(`[Webviz ERR] ${line}`);
                }
            });

            this._webvizChild.on('exit', (code) => {
                if (!this._shuttingDown) {
                    console.warn(`[SimplxPM] Webviz exited (code=${code}), will not auto-restart`);
                }
                this._webvizChild = null;
            });

            this._webvizChild.on('error', (err) => {
                console.error(`[SimplxPM] Webviz spawn error: ${err.message}`);
                this._webvizChild = null;
            });

            console.log(`[SimplxPM] Webviz started on http://localhost:${WEBVIZ_PORT} (pid ${this._webvizChild.pid})`);
        } catch (err) {
            console.error(`[SimplxPM] Failed to start webviz: ${err.message}`);
        }
    }

    _stopWebviz() {
        if (this._webvizChild) {
            try { this._webvizChild.kill('SIGTERM'); } catch { /* ignore */ }
            this._webvizChild = null;
        }
        // Fallback: kill anything still holding the webviz port
        this._killPort(WEBVIZ_PORT);
    }

    async stop() {
        this._shuttingDown = true;

        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }

        // Fix #27: Clear listenKey keepalive to prevent leaked intervals
        if (this._listenKeyKeepAlive) {
            clearInterval(this._listenKeyKeepAlive);
            this._listenKeyKeepAlive = null;
        }

        this._stopWebviz();

        if (!this._child) {
            return;
        }

        console.log(`[SimplxPM] Stopping (SIGINT → pid ${this._child.pid})...`);

        return new Promise((resolve) => {
            const killTimer = setTimeout(() => {
                if (this._child) {
                    console.warn('[SimplxPM] Force-killing (SIGKILL)');
                    try { this._child.kill('SIGKILL'); } catch { /* ignore */ }
                }
                resolve();
            }, 5000);

            this._child.once('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });

            try {
                this._child.kill('SIGINT');
            } catch {
                clearTimeout(killTimer);
                resolve();
            }
        });
    }

    /**
     * Reset restart counter (call when engine has been stable for a while).
     */
    resetBackoff() {
        this._restartCount = 0;
    }

    getStatus() {
        return {
            enabled: CPP_ENGINE_ENABLED,
            running: this._child !== null,
            pid: this._child?.pid || null,
            restartCount: this._restartCount,
            lastExitCode: this._lastExitCode,
            uptimeMs: this._startedAt ? Date.now() - this._startedAt : 0,
            binaryPath: this._binPath,
            shuttingDown: this._shuttingDown,
        };
    }
}

// Singleton
let _manager = null;

export function getProcessManager() {
    return _manager;
}

export async function startProcessManager() {
    if (_manager) return _manager;
    _manager = new SimplxProcessManager();

    const started = await _manager.start();
    if (started) {
        // Reset backoff after 60s stable uptime
        const stabilityCheck = setInterval(() => {
            if (_manager?.getStatus().running && _manager.getStatus().uptimeMs > 60000) {
                _manager.resetBackoff();
            }
        }, 60000);

        // Cleanup interval on shutdown
        _manager.once('stopped', () => clearInterval(stabilityCheck));
    }

    return _manager;
}

export async function stopProcessManager() {
    if (_manager) {
        await _manager.stop();
        _manager = null;
    }
}

export default { startProcessManager, stopProcessManager, getProcessManager };
