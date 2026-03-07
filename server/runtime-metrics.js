import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

import prisma from './db/prisma.js';
import { getPythonEngineStatus } from './python-engine.js';

const MB = 1024 * 1024;
const LOCAL_PG_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

let testSnapshotProvider = null;

function toMb(bytes) {
    if (!Number.isFinite(bytes)) return null;
    return Number((bytes / MB).toFixed(1));
}

function safeExecPs(args = []) {
    try {
        return execFileSync('ps', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return '';
    }
}

function readLinuxMeminfo() {
    try {
        const text = fs.readFileSync('/proc/meminfo', 'utf8');
        const values = new Map();
        for (const line of text.split('\n')) {
            const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
            if (!match) continue;
            values.set(match[1], Number(match[2]) * 1024);
        }
        return {
            totalBytes: values.get('MemTotal') ?? os.totalmem(),
            freeBytes: values.get('MemFree') ?? os.freemem(),
            availableBytes: values.get('MemAvailable') ?? os.freemem(),
            swapFreeBytes: values.get('SwapFree') ?? null,
        };
    } catch {
        return {
            totalBytes: os.totalmem(),
            freeBytes: os.freemem(),
            availableBytes: os.freemem(),
            swapFreeBytes: null,
        };
    }
}

function parseDatabaseUrl() {
    const raw = process.env.DATABASE_URL || '';
    if (!raw) return null;
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function isLocalPostgres(url) {
    if (!url) return false;
    if (!/^postgres(ql)?:$/i.test(url.protocol)) return false;
    return LOCAL_PG_HOSTS.has(url.hostname || '');
}

function getProcessRssMb(pid) {
    if (!pid) return null;
    const output = safeExecPs(['-o', 'rss=', '-p', String(pid)]).trim();
    const rssKb = Number.parseInt(output, 10);
    if (!Number.isFinite(rssKb) || rssKb <= 0) return null;
    return Number((rssKb / 1024).toFixed(1));
}

function listLocalPostgresPids() {
    const output = safeExecPs(['-Ao', 'pid=,comm=,command=']);
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
            if (!match) return null;
            return {
                pid: Number(match[1]),
                command: match[2],
                fullCommand: match[3],
            };
        })
        .filter(Boolean)
        .filter((row) => row.command.includes('postgres') || row.fullCommand.includes('postgres'))
        .map((row) => row.pid)
        .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function getLocalPostgresMemory() {
    const pids = listLocalPostgresPids();
    const rssMb = pids
        .map((pid) => getProcessRssMb(pid))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
    return {
        localRssMb: pids.length ? Number(rssMb.toFixed(1)) : null,
        processCount: pids.length,
    };
}

async function readPostgresStats({ includeQueries = false } = {}) {
    const url = parseDatabaseUrl();
    if (!url || !/^postgres(ql)?:$/i.test(url.protocol)) {
        return {
            hostMode: 'unknown',
            localRssMb: null,
            processCount: 0,
            connections: {
                total: 0,
                active: 0,
                idle: 0,
                idleInTxn: 0,
            },
            oldestActiveQuerySec: 0,
            activeQueries: [],
            databaseSizeMb: null,
        };
    }

    let connectionStats = {
        total: 0,
        active: 0,
        idle: 0,
        idleInTxn: 0,
    };
    let oldestActiveQuerySec = 0;
    let activeQueries = [];
    let databaseSizeMb = null;

    try {
        const [connectionRows, ageRows, sizeRows, queryRows] = await Promise.all([
            prisma.$queryRaw`
                SELECT
                    COUNT(*)::int AS "total",
                    COUNT(*) FILTER (WHERE state = 'active')::int AS "active",
                    COUNT(*) FILTER (WHERE state = 'idle')::int AS "idle",
                    COUNT(*) FILTER (WHERE state = 'idle in transaction')::int AS "idleInTxn"
                FROM pg_stat_activity
                WHERE datname = current_database()
            `,
            prisma.$queryRaw`
                SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - query_start))), 0)::float AS "oldestActiveQuerySec"
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND state = 'active'
                  AND pid <> pg_backend_pid()
            `,
            prisma.$queryRaw`SELECT pg_database_size(current_database()) AS "databaseSizeBytes"`,
            includeQueries
                ? prisma.$queryRaw`
                    SELECT
                        pid::int AS "pid",
                        COALESCE(state, 'unknown') AS "state",
                        EXTRACT(EPOCH FROM (NOW() - query_start))::float AS "ageSec",
                        wait_event_type AS "waitEventType",
                        LEFT(query, 240) AS "querySample"
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND state = 'active'
                      AND pid <> pg_backend_pid()
                    ORDER BY "ageSec" DESC
                    LIMIT 5
                `
                : Promise.resolve([]),
        ]);

        connectionStats = connectionRows[0] || connectionStats;
        oldestActiveQuerySec = Number(ageRows[0]?.oldestActiveQuerySec || 0);
        databaseSizeMb = toMb(Number(sizeRows[0]?.databaseSizeBytes || 0));
        activeQueries = Array.isArray(queryRows)
            ? queryRows.map((row) => ({
                pid: Number(row.pid || 0),
                state: row.state || 'unknown',
                ageSec: Number(Number(row.ageSec || 0).toFixed(2)),
                waitEventType: row.waitEventType || null,
                querySample: row.querySample || '',
            }))
            : [];
    } catch {
        // Best effort only.
    }

    const hostMode = isLocalPostgres(url) ? 'local' : 'remote';
    const localMemory = hostMode === 'local' ? getLocalPostgresMemory() : { localRssMb: null, processCount: 0 };

    return {
        hostMode,
        localRssMb: localMemory.localRssMb,
        processCount: localMemory.processCount,
        connections: {
            total: Number(connectionStats.total || 0),
            active: Number(connectionStats.active || 0),
            idle: Number(connectionStats.idle || 0),
            idleInTxn: Number(connectionStats.idleInTxn || 0),
        },
        oldestActiveQuerySec: Number(oldestActiveQuerySec.toFixed(2)),
        activeQueries,
        databaseSizeMb,
    };
}

export function getTcaMemoryThresholds() {
    const warnMb = Number.parseInt(process.env.TCA_MEMORY_WARN_MB, 10) || 700;
    const criticalMb = Number.parseInt(process.env.TCA_MEMORY_CRITICAL_MB, 10) || 850;
    const minAvailableMb = Number.parseInt(process.env.TCA_MEMORY_MIN_AVAILABLE_MB, 10) || 128;
    const hostBudgetMb = Number.parseInt(process.env.TCA_MEMORY_HOST_BUDGET_MB, 10) || 1024;
    return {
        hostTotal: hostBudgetMb,
        warn: warnMb,
        critical: criticalMb,
        minAvailable: minAvailableMb,
    };
}

export async function getRuntimeMemorySnapshot({ includeQueries = false } = {}) {
    if (typeof testSnapshotProvider === 'function') {
        return testSnapshotProvider({ includeQueries });
    }

    const meminfo = readLinuxMeminfo();
    const nodeMemory = process.memoryUsage();
    const pythonStatus = getPythonEngineStatus();
    const pythonRssMb = getProcessRssMb(pythonStatus.pid);
    const postgres = await readPostgresStats({ includeQueries });

    const snapshot = {
        sampledAt: new Date().toISOString(),
        budgetMb: getTcaMemoryThresholds(),
        system: {
            totalMb: toMb(meminfo.totalBytes),
            freeMb: toMb(meminfo.freeBytes),
            availableMb: toMb(meminfo.availableBytes),
            loadAvg1m: Number((os.loadavg?.()[0] || 0).toFixed(2)),
            swapFreeMb: toMb(meminfo.swapFreeBytes),
        },
        node: {
            pid: process.pid,
            rssMb: toMb(nodeMemory.rss),
            heapUsedMb: toMb(nodeMemory.heapUsed),
            heapTotalMb: toMb(nodeMemory.heapTotal),
            externalMb: toMb(nodeMemory.external),
            uptimeSec: Number(process.uptime().toFixed(1)),
        },
        python: {
            pid: pythonStatus.pid,
            running: pythonStatus.running,
            rssMb: pythonRssMb,
            restartAttempt: pythonStatus.restartAttempt,
        },
        postgres,
    };

    const combinedLocalRssMb = [
        snapshot.node.rssMb,
        snapshot.python.rssMb,
        snapshot.postgres.localRssMb,
    ].filter((value) => Number.isFinite(value)).reduce((sum, value) => sum + value, 0);

    snapshot.combinedLocalRssMb = Number(combinedLocalRssMb.toFixed(1));
    snapshot.memoryPressure = {
        warn: snapshot.combinedLocalRssMb >= snapshot.budgetMb.warn,
        critical: snapshot.combinedLocalRssMb >= snapshot.budgetMb.critical,
        availableBelowFloor: Number(snapshot.system.availableMb || 0) < snapshot.budgetMb.minAvailable,
    };
    return snapshot;
}

export function __setRuntimeMemorySnapshotProviderForTests(provider) {
    testSnapshotProvider = provider;
}

export function __resetRuntimeMemorySnapshotProviderForTests() {
    testSnapshotProvider = null;
}
