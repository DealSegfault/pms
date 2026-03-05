import { deriveRoutingPrefix } from '../routing-prefix.js';

export function planRoutingPrefixBackfill(rows = []) {
    const updates = [];
    const seen = new Map();

    for (const row of rows) {
        const id = String(row?.id || '').trim();
        if (!id) continue;

        const persisted = String(row?.routing_prefix || row?.routingPrefix || '').trim().toLowerCase();
        const routingPrefix = persisted || deriveRoutingPrefix(id);
        const owner = seen.get(routingPrefix);

        if (owner && owner !== id) {
            throw new Error(`routing prefix collision for ${routingPrefix}: ${owner} vs ${id}`);
        }

        seen.set(routingPrefix, id);
        if (!persisted) {
            updates.push({ id, routingPrefix });
        }
    }

    return updates;
}

export async function ensureSubAccountRoutingPrefixes(prisma) {
    await prisma.$executeRawUnsafe(`
        ALTER TABLE sub_accounts
        ADD COLUMN IF NOT EXISTS routing_prefix TEXT
    `);
    await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS sub_accounts_routing_prefix_key
        ON sub_accounts (routing_prefix)
    `);

    const rows = await prisma.$queryRawUnsafe(`
        SELECT id, routing_prefix
        FROM sub_accounts
    `);
    const updates = planRoutingPrefixBackfill(rows);

    for (const update of updates) {
        await prisma.$executeRaw`
            UPDATE sub_accounts
            SET routing_prefix = ${update.routingPrefix}
            WHERE id = ${update.id}
        `;
    }

    return {
        scannedCount: rows.length,
        updatedCount: updates.length,
    };
}
