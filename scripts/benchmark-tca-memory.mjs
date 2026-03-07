import fs from 'fs/promises';
import path from 'path';

const PROFILES = new Set([
    'modal-combined-current',
    'modal-detail-then-timeseries',
    'timeseries-15m',
    'timeseries-full',
    'strategy-page',
]);

function parseArgs(argv = []) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith('--')) {
            args[key] = '1';
            continue;
        }
        args[key] = next;
        index += 1;
    }
    return args;
}

function requireArg(args, key) {
    const value = String(args[key] || '').trim();
    if (!value) {
        throw new Error(`Missing required argument --${key}`);
    }
    return value;
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(raw) {
    return String(raw || '').replace(/\/+$/, '');
}

function percentile(values = [], ratio = 0.5) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return Number(sorted[index].toFixed(2));
}

function isoNow() {
    return new Date().toISOString();
}

function buildHeaders({ cookie = '', token = '' } = {}) {
    const headers = {
        Accept: 'application/json',
    };
    if (cookie) headers.Cookie = cookie;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function fetchJson(baseUrl, routePath, { cookie = '', token = '', signal } = {}) {
    const response = await fetch(`${baseUrl}${routePath}`, {
        headers: buildHeaders({ cookie, token }),
        cache: 'no-store',
        signal,
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message = payload?.message || payload?.error?.message || payload?.error || response.statusText;
        const error = new Error(message || 'Request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function buildTimeseriesPath({
    subAccountId,
    strategySessionId,
    from,
    to,
    maxPoints,
}) {
    const params = new URLSearchParams({
        series: 'pnl,params,quality,exposure',
        maxPoints: String(maxPoints),
        eventsPageSize: '8',
    });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return `/api/trade/tca/strategy-session-timeseries/${subAccountId}/${strategySessionId}?${params.toString()}`;
}

async function resolveFullWindowStart(baseUrl, { subAccountId, strategySessionId, cookie, token }) {
    const detail = await fetchJson(
        baseUrl,
        `/api/trade/tca/strategy-session/${subAccountId}/${strategySessionId}?includeLineage=0`,
        { cookie, token },
    );
    const startedAt = detail?.strategySession?.startedAt;
    return startedAt ? new Date(startedAt).toISOString() : null;
}

async function executeProfile(baseUrl, options, workerIndex) {
    const now = new Date();
    const nowIso = now.toISOString();
    const recentWindowIso = new Date(now.getTime() - (15 * 60 * 1000)).toISOString();
    const result = {
        workerIndex,
        startedAt: isoNow(),
        steps: [],
    };

    const runStep = async (name, routePath) => {
        const started = performance.now();
        try {
            await fetchJson(baseUrl, routePath, { cookie: options.cookie, token: options.token });
            result.steps.push({
                name,
                routePath,
                status: 200,
                durationMs: Number((performance.now() - started).toFixed(2)),
            });
        } catch (error) {
            result.steps.push({
                name,
                routePath,
                status: Number(error.status || 0),
                durationMs: Number((performance.now() - started).toFixed(2)),
                error: error.message,
                code: error.payload?.errorCode || error.payload?.error?.code || null,
            });
        }
    };

    if (options.profile === 'modal-combined-current') {
        const params = new URLSearchParams({
            maxPoints: String(options.maxPoints),
            eventsPageSize: '8',
        });
        await runStep(
            'modal-combined-current',
            `/api/trade/tca/strategy-modal-payload/${options.subAccountId}/${options.strategySessionId}?${params.toString()}`,
        );
    } else if (options.profile === 'modal-detail-then-timeseries') {
        await runStep(
            'modal-detail',
            `/api/trade/tca/strategy-modal-payload/${options.subAccountId}/${options.strategySessionId}?sections=detail`,
        );
        const params = new URLSearchParams({
            sections: 'timeseries',
            from: recentWindowIso,
            to: nowIso,
            maxPoints: String(options.maxPoints),
            eventsPageSize: '8',
        });
        await runStep(
            'modal-timeseries',
            `/api/trade/tca/strategy-modal-payload/${options.subAccountId}/${options.strategySessionId}?${params.toString()}`,
        );
    } else if (options.profile === 'timeseries-15m') {
        await runStep(
            'timeseries-15m',
            buildTimeseriesPath({
                subAccountId: options.subAccountId,
                strategySessionId: options.strategySessionId,
                from: recentWindowIso,
                to: nowIso,
                maxPoints: options.maxPoints,
            }),
        );
    } else if (options.profile === 'timeseries-full') {
        const from = await resolveFullWindowStart(baseUrl, options);
        await runStep(
            'timeseries-full',
            buildTimeseriesPath({
                subAccountId: options.subAccountId,
                strategySessionId: options.strategySessionId,
                from,
                to: nowIso,
                maxPoints: options.maxPoints,
            }),
        );
    } else if (options.profile === 'strategy-page') {
        const params = new URLSearchParams({
            page: '1',
            pageSize: '25',
            strategySortBy: 'updatedAt',
            strategySortDir: 'desc',
        });
        await runStep(
            'strategy-page',
            `/api/trade/tca/strategy-sessions-page/${options.subAccountId}?${params.toString()}`,
        );
    } else {
        throw new Error(`Unsupported profile: ${options.profile}`);
    }

    result.endedAt = isoNow();
    return result;
}

async function sampleRuntimeMemory(baseUrl, auth, samples, stopFlag, sampleIntervalMs) {
    while (!stopFlag.done) {
        try {
            const snapshot = await fetchJson(baseUrl, '/api/admin/runtime/memory', auth);
            samples.push(snapshot);
        } catch (error) {
            samples.push({
                sampledAt: isoNow(),
                error: error.message,
                status: Number(error.status || 0),
            });
        }
        await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
}

function summarizeSamples(samples = []) {
    const usable = samples.filter((sample) => sample && !sample.error);
    const availableValues = usable
        .map((sample) => Number(sample?.system?.availableMb))
        .filter((value) => Number.isFinite(value));
    const combinedValues = usable
        .map((sample) => Number(sample?.combinedLocalRssMb))
        .filter((value) => Number.isFinite(value));
    const nodeValues = usable
        .map((sample) => Number(sample?.node?.rssMb))
        .filter((value) => Number.isFinite(value));
    const pythonValues = usable
        .map((sample) => Number(sample?.python?.rssMb))
        .filter((value) => Number.isFinite(value));
    const postgresValues = usable
        .map((sample) => Number(sample?.postgres?.localRssMb))
        .filter((value) => Number.isFinite(value));

    return {
        sampleCount: samples.length,
        peakCombinedLocalRssMb: combinedValues.length ? Math.max(...combinedValues) : null,
        peakNodeRssMb: nodeValues.length ? Math.max(...nodeValues) : null,
        peakPythonRssMb: pythonValues.length ? Math.max(...pythonValues) : null,
        peakPostgresLocalRssMb: postgresValues.length ? Math.max(...postgresValues) : null,
        lowestAvailableMb: availableValues.length ? Math.min(...availableValues) : null,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const baseUrl = normalizeBaseUrl(requireArg(args, 'base-url'));
    const profile = requireArg(args, 'profile');
    if (!PROFILES.has(profile)) {
        throw new Error(`Unsupported profile "${profile}". Expected one of: ${Array.from(PROFILES).join(', ')}`);
    }

    const options = {
        baseUrl,
        profile,
        cookie: String(args.cookie || ''),
        token: String(args.token || ''),
        subAccountId: requireArg(args, 'sub-account-id'),
        strategySessionId: String(args['strategy-session-id'] || ''),
        iterations: toPositiveInt(args.iterations, 1),
        concurrency: toPositiveInt(args.concurrency, 1),
        sampleIntervalMs: toPositiveInt(args['sample-interval-ms'], 1000),
        maxPoints: Math.min(500, toPositiveInt(args['max-points'], 120)),
    };

    if (profile !== 'strategy-page' && !options.strategySessionId) {
        throw new Error('--strategy-session-id is required for modal and timeseries profiles');
    }

    const report = {
        generatedAt: isoNow(),
        config: options,
        runs: [],
    };

    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
        const samples = [];
        const stopFlag = { done: false };
        const samplerPromise = sampleRuntimeMemory(
            baseUrl,
            { cookie: options.cookie, token: options.token },
            samples,
            stopFlag,
            options.sampleIntervalMs,
        );

        const requestResults = await Promise.all(
            Array.from({ length: options.concurrency }, (_, index) => executeProfile(baseUrl, options, index)),
        );

        stopFlag.done = true;
        await samplerPromise;

        const latencies = requestResults
            .flatMap((result) => result.steps.map((step) => step.durationMs))
            .filter((value) => Number.isFinite(value));
        const statuses = requestResults.flatMap((result) => result.steps.map((step) => step.status));
        report.runs.push({
            iteration: iteration + 1,
            startedAt: requestResults[0]?.startedAt || isoNow(),
            endedAt: requestResults[requestResults.length - 1]?.endedAt || isoNow(),
            requestResults,
            statusCodes: statuses,
            latencyMs: {
                p50: percentile(latencies, 0.5),
                p95: percentile(latencies, 0.95),
                max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : null,
            },
            memory: summarizeSamples(samples),
            samples,
        });
    }

    const outDir = path.join(process.cwd(), 'tmp', 'benchmarks');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(
        outDir,
        `tca-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(outPath);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
