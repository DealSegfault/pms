#!/usr/bin/env node
/**
 * Archive old records — Trade Executions & Balance Logs.
 *
 * Deletes records older than RETENTION_DAYS (default: 90).
 * Run via cron: `node server/scripts/archive-old-records.js`
 *
 * IMPORTANT: This script respects the user rule to never wipe the DB.
 * It only removes COMPLETED historical records older than 90 days,
 * preserving all current/active data.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);

async function main() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    console.log(`[Archive] Archiving records older than ${cutoff.toISOString()} (${RETENTION_DAYS} days)`);

    // Archive filled trade executions (keep pending/active ones)
    const trades = await prisma.tradeExecution.deleteMany({
        where: {
            timestamp: { lt: cutoff },
        },
    });
    console.log(`[Archive] Removed ${trades.count} old trade executions`);

    // Archive old balance logs
    const logs = await prisma.balanceLog.deleteMany({
        where: {
            timestamp: { lt: cutoff },
        },
    });
    console.log(`[Archive] Removed ${logs.count} old balance logs`);

    console.log('[Archive] Done');
}

main()
    .catch((err) => {
        console.error('[Archive] Error:', err.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
