#!/usr/bin/env node
/**
 * One-shot SQLite → PostgreSQL data migration.
 *
 * Reads every row from the old SQLite database and inserts it into
 * the PostgreSQL database via Prisma.  Run once after `prisma migrate dev`.
 *
 * Usage:
 *   node server/scripts/migrate-sqlite-to-pg.js [path-to-sqlite.db]
 *
 * Defaults to prisma/pms.db
 */

import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.argv[2] || resolve(__dirname, '../../prisma/pms.db');

const sqlite = new Database(DB_PATH, { readonly: true });
const prisma = new PrismaClient();

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Convert SQLite integer booleans (0/1) to JS booleans */
const bool = (v) => v === 1 || v === true;

/** Convert SQLite date strings / epoch-ms to JS Date objects */
function toDate(v) {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(v);
    return new Date(v);
}

/** Chunk an array into batches of `size` */
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/* ------------------------------------------------------------------ */
/*  Table migration functions (dependency order)                      */
/* ------------------------------------------------------------------ */

async function migrateUsers() {
    const rows = sqlite.prepare('SELECT * FROM users').all();
    for (const batch of chunk(rows, 100)) {
        await prisma.user.createMany({
            data: batch.map((r) => ({
                id: r.id,
                username: r.username,
                passwordHash: r.password_hash,
                role: r.role,
                status: r.status,
                apiKey: r.api_key ?? null,
                currentChallenge: r.current_challenge ?? null,
                createdAt: toDate(r.created_at),
                updatedAt: toDate(r.updated_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateSubAccounts() {
    const rows = sqlite.prepare('SELECT * FROM sub_accounts').all();
    for (const batch of chunk(rows, 100)) {
        await prisma.subAccount.createMany({
            data: batch.map((r) => ({
                id: r.id,
                userId: r.user_id ?? null,
                name: r.name,
                type: r.type,
                initialBalance: r.initial_balance,
                currentBalance: r.current_balance,
                status: r.status,
                liquidationMode: r.liquidation_mode,
                maintenanceRate: r.maintenance_rate,
                createdAt: toDate(r.created_at),
                updatedAt: toDate(r.updated_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateRiskRules() {
    const rows = sqlite.prepare('SELECT * FROM risk_rules').all();
    for (const batch of chunk(rows, 100)) {
        await prisma.riskRule.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id ?? null,
                isGlobal: bool(r.is_global),
                maxLeverage: r.max_leverage,
                maxNotionalPerTrade: r.max_notional_per_trade,
                maxTotalExposure: r.max_total_exposure,
                liquidationThreshold: r.liquidation_threshold,
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateBotConfigs() {
    const rows = sqlite.prepare('SELECT * FROM bot_configs').all();
    for (const batch of chunk(rows, 100)) {
        await prisma.botConfig.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id,
                enabled: bool(r.enabled),
                babysitterEnabled: bool(r.babysitter_enabled),
                tpMode: r.tp_mode,
                maxNotional: r.max_notional,
                maxLayers: r.max_layers,
                maxExposure: r.max_exposure,
                volFilterEnabled: bool(r.vol_filter_enabled),
                minSpreadBps: r.min_spread_bps,
                maxSpreadBps: r.max_spread_bps,
                minHoldSec: r.min_hold_sec,
                minProfitBps: r.min_profit_bps,
                tpDecayEnabled: bool(r.tp_decay_enabled),
                tpDecayHalfLife: r.tp_decay_half_life,
                trailingStopEnabled: bool(r.trailing_stop_enabled),
                trailingStopBps: r.trailing_stop_bps,
                inverseTPEnabled: bool(r.inverse_tp_enabled),
                inverseTPMinLayers: r.inverse_tp_min_layers,
                scaledExitEnabled: bool(r.scaled_exit_enabled),
                maxLossBps: r.max_loss_bps,
                lossCooldownSec: r.loss_cooldown_sec,
                symbols: r.symbols ?? '',
                blacklist: r.blacklist ?? '',
                createdAt: toDate(r.created_at),
                updatedAt: toDate(r.updated_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateWebAuthnCredentials() {
    const rows = sqlite.prepare('SELECT * FROM webauthn_credentials').all();
    for (const batch of chunk(rows, 100)) {
        await prisma.webAuthnCredential.createMany({
            data: batch.map((r) => ({
                id: r.id,
                userId: r.user_id,
                credentialId: r.credential_id,
                publicKey: r.public_key,
                counter: r.counter,
                deviceType: r.device_type ?? 'unknown',
                backedUp: bool(r.backed_up),
                transports: r.transports ?? '',
                createdAt: toDate(r.created_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateVirtualPositions() {
    const rows = sqlite.prepare('SELECT * FROM virtual_positions').all();
    for (const batch of chunk(rows, 200)) {
        await prisma.virtualPosition.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id,
                symbol: r.symbol,
                side: r.side,
                entryPrice: r.entry_price,
                quantity: r.quantity,
                notional: r.notional,
                leverage: r.leverage,
                margin: r.margin,
                liquidationPrice: r.liquidation_price,
                status: r.status,
                realizedPnl: r.realized_pnl ?? null,
                babysitterExcluded: bool(r.babysitter_excluded),
                takenOver: bool(r.taken_over),
                takenOverBy: r.taken_over_by ?? null,
                takenOverAt: toDate(r.taken_over_at),
                openedAt: toDate(r.opened_at),
                closedAt: toDate(r.closed_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateTradeExecutions() {
    const rows = sqlite.prepare('SELECT * FROM trade_executions').all();
    for (const batch of chunk(rows, 200)) {
        await prisma.tradeExecution.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id,
                positionId: r.position_id ?? null,
                exchangeOrderId: r.exchange_order_id ?? null,
                clientOrderId: r.client_order_id ?? null,
                symbol: r.symbol,
                side: r.side,
                type: r.type,
                price: r.price,
                quantity: r.quantity,
                notional: r.notional,
                fee: r.fee ?? 0,
                realizedPnl: r.realized_pnl ?? null,
                action: r.action,
                originType: r.origin_type ?? 'MANUAL',
                status: r.status,
                signature: r.signature,
                timestamp: toDate(r.timestamp),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateBalanceLogs() {
    const rows = sqlite.prepare('SELECT * FROM balance_logs').all();
    for (const batch of chunk(rows, 200)) {
        await prisma.balanceLog.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id,
                balanceBefore: r.balance_before,
                balanceAfter: r.balance_after,
                changeAmount: r.change_amount,
                reason: r.reason,
                tradeId: r.trade_id ?? null,
                timestamp: toDate(r.timestamp),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migratePendingOrders() {
    const rows = sqlite.prepare('SELECT * FROM pending_orders').all();
    for (const batch of chunk(rows, 200)) {
        await prisma.pendingOrder.createMany({
            data: batch.map((r) => ({
                id: r.id,
                subAccountId: r.sub_account_id,
                symbol: r.symbol,
                side: r.side,
                type: r.type,
                price: r.price,
                quantity: r.quantity,
                leverage: r.leverage,
                exchangeOrderId: r.exchange_order_id ?? null,
                status: r.status,
                createdAt: toDate(r.created_at),
                filledAt: toDate(r.filled_at),
                cancelledAt: toDate(r.cancelled_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

async function migrateTcaEvents() {
    const rows = sqlite.prepare('SELECT * FROM tca_events').all();
    for (const batch of chunk(rows, 200)) {
        await prisma.tcaEvent.createMany({
            data: batch.map((r) => ({
                id: r.id,
                type: r.type,
                symbol: r.symbol ?? null,
                data: r.data,
                createdAt: toDate(r.created_at),
            })),
            skipDuplicates: true,
        });
    }
    return rows.length;
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const TABLES = [
    ['users', migrateUsers],
    ['sub_accounts', migrateSubAccounts],
    ['risk_rules', migrateRiskRules],
    ['bot_configs', migrateBotConfigs],
    ['webauthn_credentials', migrateWebAuthnCredentials],
    ['virtual_positions', migrateVirtualPositions],
    ['trade_executions', migrateTradeExecutions],
    ['balance_logs', migrateBalanceLogs],
    ['pending_orders', migratePendingOrders],
    ['tca_events', migrateTcaEvents],
];

async function main() {
    console.log(`\n📦  SQLite source: ${DB_PATH}`);
    console.log(`🐘  PostgreSQL target: ${process.env.DATABASE_URL}\n`);

    const results = [];
    for (const [table, fn] of TABLES) {
        const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
        try {
            const migrated = await fn();
            const pgCount = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "${table}"`);
            const pg = pgCount[0]?.c ?? '?';
            const ok = Number(pg) === sqliteCount;
            results.push({ table, sqlite: sqliteCount, migrated, pg, ok });
            console.log(`  ${ok ? '✅' : '⚠️ '}  ${table.padEnd(24)} SQLite: ${String(sqliteCount).padStart(5)}  →  PG: ${String(pg).padStart(5)}`);
        } catch (err) {
            results.push({ table, sqlite: sqliteCount, migrated: 0, pg: '?', ok: false });
            console.error(`  ❌  ${table.padEnd(24)} FAILED: ${err.message}`);
        }
    }

    const allOk = results.every((r) => r.ok);
    console.log(`\n${allOk ? '🎉  All tables migrated successfully!' : '⚠️   Some tables had issues — check above.'}\n`);

    sqlite.close();
    await prisma.$disconnect();
    process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
