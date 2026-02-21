#!/usr/bin/env node
/**
 * sanitize-positions.js — Merge duplicate OPEN VirtualPositions per (subAccountId, symbol, side).
 *
 * For each group with more than one OPEN position:
 *   1. Picks the oldest position (by openedAt) as the "survivor".
 *   2. Computes weighted-average entry price, total qty, notional, margin.
 *   3. Re-links TradeExecution records from duplicates → survivor.
 *   4. Marks duplicates as CLOSED (realizedPnl = 0 so no balance impact).
 *   5. Recalculates the survivor's liquidation price using cross-position formula.
 *
 * Usage:
 *   node server/scripts/sanitize-positions.js --dry-run   # preview only
 *   node server/scripts/sanitize-positions.js              # apply changes
 *
 * IMPORTANT: Do NOT wipe the DB. This script only consolidates duplicates.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

// ── Liquidation price formula (mirrors LiquidationEngine.calculateLiquidationPrice) ──
function calcLiqPrice(side, entryPrice, leverage, balance, notional, maintenanceRate = 0.005, threshold = 0.90) {
    const quantity = notional / entryPrice;
    const mm = notional * maintenanceRate;
    const T = (threshold > 0 && threshold <= 1) ? threshold : 0.90;
    const equityFloor = mm / T;
    const availableForLoss = balance - equityFloor;

    if (side === 'LONG') {
        return Math.max(0, entryPrice - availableForLoss / quantity);
    } else {
        return entryPrice + availableForLoss / quantity;
    }
}

async function main() {
    console.log(`\n🧹  Position Sanitizer  ${DRY_RUN ? '(DRY RUN)' : '(LIVE MODE)'}\n${'─'.repeat(60)}`);

    // 1. Find all OPEN positions
    const allOpen = await prisma.virtualPosition.findMany({
        where: { status: 'OPEN' },
        orderBy: { openedAt: 'asc' },
    });

    console.log(`Total OPEN positions: ${allOpen.length}`);

    // 2. Group by (subAccountId, symbol, side)
    const groups = new Map();
    for (const pos of allOpen) {
        const key = `${pos.subAccountId}|${pos.symbol}|${pos.side}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pos);
    }

    // 3. Filter to only groups with duplicates
    const dupGroups = [...groups.entries()].filter(([, positions]) => positions.length > 1);

    if (dupGroups.length === 0) {
        console.log('\n✅  No duplicate groups found — DB is clean!\n');
        await prisma.$disconnect();
        return;
    }

    console.log(`\n⚠️  Found ${dupGroups.length} group(s) with duplicate positions:\n`);

    let totalMerged = 0;
    let totalTradesRelinked = 0;

    for (const [key, positions] of dupGroups) {
        const [subAccountId, symbol, side] = key.split('|');
        console.log(`  📦 ${symbol} ${side} (account: ${subAccountId.slice(0, 8)}…)`);
        console.log(`     ${positions.length} positions → merging into 1`);

        // Pick survivor: oldest by openedAt
        const sorted = positions.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
        const survivor = sorted[0];
        const duplicates = sorted.slice(1);

        // Compute weighted-average entry, total qty
        let totalQty = 0;
        let weightedEntrySum = 0;
        let maxLeverage = 0;

        for (const pos of positions) {
            totalQty += pos.quantity;
            weightedEntrySum += pos.entryPrice * pos.quantity;
            maxLeverage = Math.max(maxLeverage, pos.leverage);
        }

        const avgEntry = totalQty > 0 ? weightedEntrySum / totalQty : survivor.entryPrice;
        const newNotional = avgEntry * totalQty;
        const newMargin = maxLeverage > 0 ? newNotional / maxLeverage : newNotional;

        // Get account balance for liq calculation
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            select: { currentBalance: true, maintenanceRate: true },
        });

        const balance = account?.currentBalance || 0;
        const maintRate = account?.maintenanceRate || 0.005;

        const newLiqPrice = calcLiqPrice(side, avgEntry, maxLeverage, balance, newNotional, maintRate, 0.90);

        console.log(`     Survivor: ${survivor.id.slice(0, 8)}…`);
        console.log(`     Avg entry: $${avgEntry.toFixed(6)}  (was $${survivor.entryPrice.toFixed(6)})`);
        console.log(`     Total qty: ${totalQty.toFixed(8)}  (was ${survivor.quantity.toFixed(8)})`);
        console.log(`     Notional: $${newNotional.toFixed(2)}  Margin: $${newMargin.toFixed(2)}`);
        console.log(`     Liq price: $${newLiqPrice.toFixed(6)}  (was $${survivor.liquidationPrice.toFixed(6)})`);

        // Count trades to relink
        const dupIds = duplicates.map(d => d.id);
        const tradesToRelink = await prisma.tradeExecution.count({
            where: { positionId: { in: dupIds } },
        });

        console.log(`     Trades to relink: ${tradesToRelink}`);
        console.log(`     Duplicates to close: ${duplicates.length} (${dupIds.map(id => id.slice(0, 8) + '…').join(', ')})`);

        if (!DRY_RUN) {
            await prisma.$transaction(async (tx) => {
                // Update survivor
                await tx.virtualPosition.update({
                    where: { id: survivor.id },
                    data: {
                        entryPrice: avgEntry,
                        quantity: totalQty,
                        notional: newNotional,
                        leverage: maxLeverage,
                        margin: newMargin,
                        liquidationPrice: newLiqPrice,
                    },
                });

                // Relink trades
                if (tradesToRelink > 0) {
                    await tx.tradeExecution.updateMany({
                        where: { positionId: { in: dupIds } },
                        data: { positionId: survivor.id },
                    });
                }

                // Close duplicates (no balance impact)
                for (const dup of duplicates) {
                    await tx.virtualPosition.update({
                        where: { id: dup.id },
                        data: {
                            status: 'CLOSED',
                            realizedPnl: 0,
                            closedAt: new Date(),
                        },
                    });
                }
            });

            console.log(`     ✅ Merged!\n`);
        } else {
            console.log(`     🔍 (dry-run — no changes)\n`);
        }

        totalMerged += duplicates.length;
        totalTradesRelinked += tradesToRelink;
    }

    console.log(`${'─'.repeat(60)}`);
    console.log(`Summary: ${dupGroups.length} groups, ${totalMerged} positions merged, ${totalTradesRelinked} trades relinked`);
    console.log(DRY_RUN ? '🔍 DRY RUN — no changes were made\n' : '✅ All done!\n');

    await prisma.$disconnect();
}

main().catch((err) => {
    console.error('❌ Sanitization failed:', err);
    prisma.$disconnect();
    process.exit(1);
});
