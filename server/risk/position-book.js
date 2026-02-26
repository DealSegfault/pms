/**
 * PositionBook — In-memory position tracking.
 *
 * Pure data structure with zero side effects. No DB calls, no exchange calls,
 * no WebSocket emission. Fully testable with zero mocks.
 *
 * Data shape:
 *   _entries: Map<subAccountId, { account, positions: Map<posId, pos>, rules }>
 *   _symbolAccounts: Map<symbol, Set<subAccountId>>  (reverse index)
 */
export class PositionBook {
    constructor() {
        /** @type {Map<string, {account: Object, positions: Map<string, Object>, rules: Object|null}>} */
        this._entries = new Map();
        /** @type {Map<string, Set<string>>} */
        this._symbolAccounts = new Map();
    }

    // ── Queries ──────────────────────────────────────

    /** Get the book entry for an account (positions + account metadata). */
    getEntry(subAccountId) {
        return this._entries.get(subAccountId) || null;
    }

    /** Get all subAccountIds with positions on a given symbol. */
    getAccountsForSymbol(symbol) {
        return this._symbolAccounts.get(symbol) || null;
    }

    /** Iterate all entries. */
    entries() {
        return this._entries.entries();
    }

    /** Number of tracked accounts. */
    get size() {
        return this._entries.size;
    }

    /** Check if an account exists in the book. */
    has(subAccountId) {
        return this._entries.has(subAccountId);
    }

    /** Find a position by account, symbol, and side. Returns null if not found. */
    getPosition(subAccountId, symbol, side) {
        const entry = this._entries.get(subAccountId);
        if (!entry) return null;
        for (const pos of entry.positions.values()) {
            if (pos.symbol === symbol && pos.side === side) return pos;
        }
        return null;
    }

    /** Delete an account entry entirely. */
    delete(subAccountId) {
        this._entries.delete(subAccountId);
    }

    // ── Mutations ────────────────────────────────────

    /**
     * Bulk-load positions grouped by account.
     * @param {Object} byAccount - { subAccountId: { account, positions: [...], rules } }
     */
    load(byAccount) {
        for (const [subAccountId, { account, positions, rules }] of Object.entries(byAccount)) {
            const posMap = new Map();
            for (const p of positions) {
                posMap.set(p.id, this._toBookPosition(p));
                this._addSymbolIndex(p.symbol, subAccountId);
            }

            this._entries.set(subAccountId, {
                account: this._toBookAccount(account),
                positions: posMap,
                rules: rules || null,
            });
        }
    }

    /**
     * Add a single position to the book.
     * Creates the account entry if it doesn't exist.
     */
    add(position, account) {
        let entry = this._entries.get(account.id);
        if (!entry) {
            entry = {
                account: this._toBookAccount(account),
                positions: new Map(),
                rules: null,
            };
            this._entries.set(account.id, entry);
        }

        entry.positions.set(position.id, this._toBookPosition(position));
        entry.account.currentBalance = account.currentBalance;
        this._addSymbolIndex(position.symbol, account.id);
    }

    /**
     * Remove a position from the book. Cleans up reverse index and
     * removes the account entry if no positions remain.
     */
    remove(positionId, subAccountId) {
        const entry = this._entries.get(subAccountId);
        if (!entry) return;

        const pos = entry.positions.get(positionId);
        if (!pos) return;

        entry.positions.delete(positionId);

        // Clean up reverse index
        const stillHas = [...entry.positions.values()].some(p => p.symbol === pos.symbol);
        if (!stillHas) {
            const accountSet = this._symbolAccounts.get(pos.symbol);
            if (accountSet) {
                accountSet.delete(subAccountId);
                if (accountSet.size === 0) this._symbolAccounts.delete(pos.symbol);
            }
        }

        // Auto-remove empty accounts
        if (entry.positions.size === 0) {
            this._entries.delete(subAccountId);
        }
    }

    /** Update an account's cached balance. */
    updateBalance(subAccountId, newBalance) {
        const entry = this._entries.get(subAccountId);
        if (entry) {
            entry.account.currentBalance = newBalance;
        }
    }

    /** Patch specific fields on a position (e.g. after partial close). */
    updatePosition(positionId, subAccountId, updates) {
        const entry = this._entries.get(subAccountId);
        if (!entry) return;
        const pos = entry.positions.get(positionId);
        if (!pos) return;
        Object.assign(pos, updates);
    }

    /** Update an account's cached status (e.g. after liquidation). */
    updateAccountStatus(subAccountId, status) {
        const entry = this._entries.get(subAccountId);
        if (entry) {
            entry.account.status = status;
        }
    }

    // ── Private helpers ──────────────────────────────

    _toBookPosition(p) {
        return {
            id: p.id, symbol: p.symbol, side: p.side,
            entryPrice: p.entryPrice, quantity: p.quantity,
            notional: p.notional, leverage: p.leverage,
            margin: p.margin, liquidationPrice: p.liquidationPrice,
            babysitterExcluded: p.babysitterExcluded ?? false,
            openedAt: p.openedAt || null,
        };
    }

    _toBookAccount(account) {
        return {
            id: account.id, name: account.name,
            currentBalance: account.currentBalance,
            maintenanceRate: account.maintenanceRate || 0.005,
            liquidationMode: account.liquidationMode || 'ADL_30',
            status: account.status,
        };
    }

    _addSymbolIndex(symbol, subAccountId) {
        if (!this._symbolAccounts.has(symbol)) {
            this._symbolAccounts.set(symbol, new Set());
        }
        this._symbolAccounts.get(symbol).add(subAccountId);
    }
}
