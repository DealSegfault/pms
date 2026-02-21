export const state = {
    currentAccount: null,
    accounts: [],
    ws: null,
    prices: {},
    user: null, // { id, username, role, status, token }
    botSymbolState: {}, // subAccountId -> { SYMBOL: { depth, realizedUsd } }
    recentPositionCloseTs: {}, // `${subAccountId}:${SYMBOL}` -> ms ts (dedupe real/synthetic close events)
};
