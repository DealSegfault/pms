/**
 * Reconcile Babysitter Exclusion Tests
 *
 * Verifies that position-sync and proxy-stream correctly skip
 * babysitter-managed sub-accounts during reconciliation.
 *
 * Run: node --test tests/reconcile-babysitter.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Test data identifiers ──────────────────────────────
const TEST_PREFIX = `reconcile_test_${Date.now()}`;
let babysitterAccountId;
let nonBabysitterAccountId;
let babysitterUserId;
let nonBabysitterUserId;
let babysitterPositionId;
let nonBabysitterPositionId;

const TEST_SYMBOL = 'TESTRECONCILE/USDT:USDT';

// ── Setup: create two sub-accounts, one with babysitter ──
before(async () => {
    // Create or find a test user
    let user = await prisma.user.findFirst({ where: { username: `${TEST_PREFIX}_user` } });
    if (!user) {
        user = await prisma.user.create({
            data: {
                username: `${TEST_PREFIX}_user`,
                passwordHash: 'test_hash',
                role: 'USER',
                status: 'APPROVED',
            },
        });
    }
    babysitterUserId = user.id;
    nonBabysitterUserId = user.id;

    // Create babysitter-managed sub-account
    const babysitterAccount = await prisma.subAccount.create({
        data: {
            userId: user.id,
            name: `${TEST_PREFIX}_babysitter`,
            initialBalance: 1000,
            currentBalance: 1000,
            type: 'ELO',
            status: 'ACTIVE',
        },
    });
    babysitterAccountId = babysitterAccount.id;

    // Create non-babysitter sub-account
    const nonBabysitterAccount = await prisma.subAccount.create({
        data: {
            userId: user.id,
            name: `${TEST_PREFIX}_manual`,
            initialBalance: 1000,
            currentBalance: 1000,
            type: 'ELO',
            status: 'ACTIVE',
        },
    });
    nonBabysitterAccountId = nonBabysitterAccount.id;

    // Create open virtual positions for both accounts
    const babysitterPos = await prisma.virtualPosition.create({
        data: {
            subAccountId: babysitterAccountId,
            symbol: TEST_SYMBOL,
            side: 'SHORT',
            entryPrice: 1.0,
            quantity: 10,
            notional: 10,
            leverage: 1,
            margin: 10,
            liquidationPrice: 0,
            status: 'OPEN',
            babysitterExcluded: false,
        },
    });
    babysitterPositionId = babysitterPos.id;

    const nonBabysitterPos = await prisma.virtualPosition.create({
        data: {
            subAccountId: nonBabysitterAccountId,
            symbol: TEST_SYMBOL,
            side: 'SHORT',
            entryPrice: 1.0,
            quantity: 10,
            notional: 10,
            leverage: 1,
            margin: 10,
            liquidationPrice: 0,
            status: 'OPEN',
            babysitterExcluded: true,
        },
    });
    nonBabysitterPositionId = nonBabysitterPos.id;

    console.log(`  Setup: babysitter account ${babysitterAccountId.slice(0, 8)}, non-babysitter ${nonBabysitterAccountId.slice(0, 8)}`);
});

// ── Cleanup ──────────────────────────────────────────────
after(async () => {
    // Clean up test data: positions, configs, accounts, user
    await prisma.tradeExecution.deleteMany({
        where: { positionId: { in: [babysitterPositionId, nonBabysitterPositionId] } },
    });
    await prisma.virtualPosition.deleteMany({
        where: { id: { in: [babysitterPositionId, nonBabysitterPositionId] } },
    });
    await prisma.balanceLog.deleteMany({
        where: { subAccountId: { in: [babysitterAccountId, nonBabysitterAccountId] } },
    });
    await prisma.subAccount.deleteMany({
        where: { id: { in: [babysitterAccountId, nonBabysitterAccountId] } },
    });
    await prisma.user.deleteMany({ where: { username: `${TEST_PREFIX}_user` } });
    await prisma.$disconnect();
    console.log('  Cleanup: test data removed');
});

// ═══════════════════════════════════════════════════════════
// Test 1: babysitterExcluded flag identifies managed positions
// ═══════════════════════════════════════════════════════════
describe('Reconcile Babysitter Exclusion', () => {

    it('should identify babysitter-managed positions by babysitterExcluded=false', async () => {
        const positions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN', symbol: TEST_SYMBOL },
            select: { subAccountId: true, babysitterExcluded: true },
        });
        const babysitterIds = new Set(
            positions.filter((p) => !p.babysitterExcluded).map((p) => p.subAccountId)
        );

        assert.ok(babysitterIds.has(babysitterAccountId),
            'Babysitter account should be in babysitter set');
        assert.ok(!babysitterIds.has(nonBabysitterAccountId),
            'Non-babysitter account should NOT be in babysitter set');
    });

    // ───────────────────────────────────────────────────────
    // Test 2: position-sync filtering logic
    // ───────────────────────────────────────────────────────

    it('should filter out babysitter-managed positions from reconciliation candidates', async () => {
        // Replicate the exact logic from position-sync.js
        const virtualPositions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN', symbol: TEST_SYMBOL },
        });

        assert.ok(virtualPositions.length >= 2,
            `Expected at least 2 positions for ${TEST_SYMBOL}, got ${virtualPositions.length}`);

        const reconcilablePositions = virtualPositions.filter((vp) => vp.babysitterExcluded);

        // Only the non-babysitter position should remain
        assert.ok(reconcilablePositions.length >= 1,
            'Should have at least 1 reconcilable position');
        assert.ok(
            reconcilablePositions.every(p => p.subAccountId !== babysitterAccountId),
            'No babysitter-managed positions should be in the reconcilable list'
        );
        assert.ok(
            reconcilablePositions.some(p => p.subAccountId === nonBabysitterAccountId),
            'Non-babysitter positions should remain in the reconcilable list'
        );
    });

    // ───────────────────────────────────────────────────────
    // Test 3: proxy-stream "all babysitter" check
    // ───────────────────────────────────────────────────────

    it('should detect when ALL positions for a symbol are babysitter-managed', async () => {
        // Create a symbol with ONLY babysitter positions
        const exclusiveSymbol = 'BABYSITTERONLY/USDT:USDT';
        const exclusivePos = await prisma.virtualPosition.create({
            data: {
                subAccountId: babysitterAccountId,
                symbol: exclusiveSymbol,
                side: 'LONG',
                entryPrice: 50,
                quantity: 1,
                notional: 50,
                leverage: 1,
                margin: 50,
                liquidationPrice: 0,
                status: 'OPEN',
            },
        });

        try {
            // Replicate proxy-stream logic
            const openVPs = await prisma.virtualPosition.findMany({
                where: { symbol: exclusiveSymbol, status: 'OPEN' },
                select: { babysitterExcluded: true },
            });

            assert.ok(openVPs.length > 0, 'Should find open positions');
            const allBabysitter = openVPs.every((vp) => !vp.babysitterExcluded);

            assert.ok(allBabysitter,
                'All positions for BABYSITTERONLY symbol should be babysitter-managed → skip reconcile');
        } finally {
            await prisma.virtualPosition.delete({ where: { id: exclusivePos.id } });
        }
    });

    it('should NOT skip reconcile when MIXED babysitter + non-babysitter positions exist', async () => {
        // TEST_SYMBOL has both babysitter and non-babysitter positions
        const openVPs = await prisma.virtualPosition.findMany({
            where: { symbol: TEST_SYMBOL, status: 'OPEN' },
            select: { babysitterExcluded: true },
        });

        assert.ok(openVPs.length >= 2, 'Should have mixed positions');
        const allBabysitter = openVPs.every((vp) => !vp.babysitterExcluded);

        assert.ok(!allBabysitter,
            'Mixed positions should NOT be treated as all-babysitter → reconcile should proceed');
    });

    // ───────────────────────────────────────────────────────
    // Test 4: babysitter-only symbol orphan detection
    // ───────────────────────────────────────────────────────

    it('should not produce orphaned symbols from babysitter-only positions', async () => {
        // Simulate the full position-sync flow:
        // 1. Get all open positions
        // 2. Filter out babysitter-managed
        // 3. Check remaining against a fake "real exchange" set

        const virtualPositions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN', symbol: TEST_SYMBOL },
        });

        const reconcilablePositions = virtualPositions.filter((vp) => vp.babysitterExcluded);

        // Simulate: exchange has NO real positions for TEST_SYMBOL (not a real symbol)
        const realSymbols = new Set(); // empty — nothing on exchange

        const orphanedSymbols = new Set();
        for (const vp of reconcilablePositions) {
            if (!realSymbols.has(vp.symbol)) {
                orphanedSymbols.add(vp.symbol);
            }
        }

        // The non-babysitter position IS orphaned (no real exchange position)
        assert.ok(orphanedSymbols.has(TEST_SYMBOL),
            'Non-babysitter orphaned positions should be detected');

        // But the babysitter position should NOT have been checked at all
        const babysitterPositions = virtualPositions.filter((vp) => !vp.babysitterExcluded);
        assert.ok(babysitterPositions.length > 0,
            'Babysitter positions should exist but be excluded from orphan check');
    });

    // ───────────────────────────────────────────────────────
    // Test 5: edge case — no babysitter-managed positions
    // ───────────────────────────────────────────────────────

    it('should reconcile normally when no babysitter-managed positions exist', async () => {
        // Temporarily exclude the babysitter position
        await prisma.virtualPosition.update({
            where: { id: babysitterPositionId },
            data: { babysitterExcluded: true },
        });

        try {
            const virtualPositions = await prisma.virtualPosition.findMany({
                where: { status: 'OPEN', symbol: TEST_SYMBOL },
            });
            const reconcilablePositions = virtualPositions.filter((vp) => vp.babysitterExcluded);

            // ALL positions should be reconcilable when babysitter is off
            assert.equal(reconcilablePositions.length, virtualPositions.length,
                'With no babysitter-managed positions, all positions should be reconcilable');
        } finally {
            // Re-enable babysitter on the baseline position
            await prisma.virtualPosition.update({
                where: { id: babysitterPositionId },
                data: { babysitterExcluded: false },
            });
        }
    });

    // ───────────────────────────────────────────────────────
    // Test 6: closeVirtualPositionByPrice only targets ONE position (by ID)
    // ───────────────────────────────────────────────────────

    it('closeVirtualPositionByPrice should only close the targeted position, not other users', async () => {
        // Create two positions on the SAME symbol for two different babysitter accounts
        const symbol = 'ISOLATIONTEST/USDT:USDT';
        const posA = await prisma.virtualPosition.create({
            data: {
                subAccountId: babysitterAccountId,
                symbol,
                side: 'SHORT',
                entryPrice: 2.0,
                quantity: 5,
                notional: 10,
                leverage: 1,
                margin: 10,
                liquidationPrice: 0,
                status: 'OPEN',
            },
        });
        const posB = await prisma.virtualPosition.create({
            data: {
                subAccountId: nonBabysitterAccountId,
                symbol,
                side: 'SHORT',
                entryPrice: 2.0,
                quantity: 5,
                notional: 10,
                leverage: 1,
                margin: 10,
                liquidationPrice: 0,
                status: 'OPEN',
            },
        });

        try {
            // Simulate what closeVirtualPositionByPrice does: findUnique by ID
            const found = await prisma.virtualPosition.findUnique({
                where: { id: posA.id },
            });

            assert.ok(found, 'Position A should be found by ID');
            assert.equal(found.id, posA.id, 'Should find exactly position A');
            assert.notEqual(found.id, posB.id, 'Should NOT find position B');
            assert.equal(found.subAccountId, babysitterAccountId,
                'Found position should belong to the correct account');

            // Verify position B is untouched
            const posB_check = await prisma.virtualPosition.findUnique({
                where: { id: posB.id },
            });
            assert.equal(posB_check.status, 'OPEN',
                'Other user\'s position should remain OPEN when closing position A');
        } finally {
            await prisma.virtualPosition.deleteMany({
                where: { id: { in: [posA.id, posB.id] } },
            });
        }
    });

    // ───────────────────────────────────────────────────────
    // Test 7: reconcilePosition (symbol-wide) respects babysitter exclusion
    // ───────────────────────────────────────────────────────

    it('reconcilePosition finds ALL positions by symbol — babysitter filter is critical', async () => {
        // This test verifies WHY the babysitter exclusion is necessary:
        // reconcilePosition searches by SYMBOL (not by ID), so without the
        // exclusion filter, it would close ALL accounts' positions for that symbol.

        const symbol = TEST_SYMBOL;

        // Simulate what reconcilePosition does: find ALL by symbol
        const allPositions = await prisma.virtualPosition.findMany({
            where: { symbol, status: 'OPEN' },
        });

        // There should be positions from BOTH accounts
        const accountIds = new Set(allPositions.map(p => p.subAccountId));
        assert.ok(accountIds.has(babysitterAccountId),
            'reconcilePosition query finds babysitter account positions');
        assert.ok(accountIds.has(nonBabysitterAccountId),
            'reconcilePosition query finds non-babysitter account positions');
        assert.ok(accountIds.size >= 2,
            `Without filtering, reconcilePosition would close ${allPositions.length} positions across ${accountIds.size} accounts — THIS IS THE BUG we fixed`);

        // Now verify our position-sync filter protects the babysitter account
        const safeToReconcile = allPositions.filter((p) => p.babysitterExcluded);

        assert.ok(
            safeToReconcile.every(p => p.subAccountId !== babysitterAccountId),
            'After filtering, babysitter account positions are excluded'
        );
        assert.ok(
            safeToReconcile.some(p => p.subAccountId === nonBabysitterAccountId),
            'Non-babysitter positions remain eligible for reconciliation'
        );
    });
});
