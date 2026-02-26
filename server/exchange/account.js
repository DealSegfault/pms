// exchange/account: account/position/order-history read operations (signed REST).
import { toRawSymbol } from './helpers.js';

export async function getOpenOrders(exchange, symbol) {
    try {
        const params = {};
        if (symbol) params.symbol = toRawSymbol(symbol);
        const orders = await exchange._signedRequest('GET', '/fapi/v1/openOrders', params);
        return orders.map(o => ({
            id: String(o.orderId),
            clientOrderId: o.clientOrderId,
            symbol: exchange._rawToSymbol[o.symbol] || o.symbol,
            side: o.side?.toLowerCase(),
            type: o.type?.toLowerCase(),
            price: parseFloat(o.price),
            amount: parseFloat(o.origQty),
            filled: parseFloat(o.executedQty),
            remaining: parseFloat(o.origQty) - parseFloat(o.executedQty),
            status: o.status?.toLowerCase(),
            timestamp: o.time,
            info: o,
        }));
    } catch (err) {
        console.error('[Exchange] Fetch open orders failed:', err.message);
        return [];
    }
}

export async function fetchPositions(exchange) {
    const positions = await exchange._signedRequest('GET', '/fapi/v2/positionRisk');
    return positions
        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
        .map(p => ({
            symbol: exchange._rawToSymbol[p.symbol] || p.symbol,
            contracts: parseFloat(p.positionAmt),
            side: parseFloat(p.positionAmt) > 0 ? 'long' : 'short',
            entryPrice: parseFloat(p.entryPrice),
            markPrice: parseFloat(p.markPrice),
            unrealizedPnl: parseFloat(p.unRealizedProfit),
            leverage: parseFloat(p.leverage),
            liquidationPrice: parseFloat(p.liquidationPrice),
            marginType: p.marginType,
            info: p,
        }));
}

export async function fetchBalance(exchange) {
    const balances = await exchange._signedRequest('GET', '/fapi/v2/balance');
    const usdt = balances.find(b => b.asset === 'USDT') || {};
    return {
        total: parseFloat(usdt.balance) || 0,
        free: parseFloat(usdt.availableBalance) || 0,
        used: (parseFloat(usdt.balance) || 0) - (parseFloat(usdt.availableBalance) || 0),
    };
}

export async function fetchOrderTrades(exchange, orderId, symbol) {
    const raw = toRawSymbol(symbol);
    const trades = await exchange._signedRequest('GET', '/fapi/v1/userTrades', { symbol: raw, orderId });
    return (trades || []).map(t => ({
        id: String(t.id),
        order: String(t.orderId),
        symbol: exchange._rawToSymbol[t.symbol] || t.symbol,
        side: t.side?.toLowerCase(),
        price: parseFloat(t.price),
        amount: parseFloat(t.qty),
        fee: { cost: parseFloat(t.commission), currency: t.commissionAsset },
        timestamp: t.time,
    }));
}

export async function fetchOrders(exchange, symbol, since, limit = 500) {
    const raw = toRawSymbol(symbol);
    const params = { symbol: raw, limit };
    if (since) params.startTime = since;
    const orders = await exchange._signedRequest('GET', '/fapi/v1/allOrders', params);
    return (orders || []).map(o => ({
        id: String(o.orderId),
        clientOrderId: o.clientOrderId,
        symbol: exchange._rawToSymbol[o.symbol] || o.symbol,
        side: o.side?.toLowerCase(),
        type: o.type?.toLowerCase(),
        price: parseFloat(o.price),
        average: parseFloat(o.avgPrice) || null,
        amount: parseFloat(o.origQty),
        filled: parseFloat(o.executedQty),
        remaining: parseFloat(o.origQty) - parseFloat(o.executedQty),
        status: o.status?.toLowerCase(),
        reduceOnly: o.reduceOnly,
        fee: { cost: 0 },
        timestamp: o.time,
    }));
}

export async function fetchMyTrades(exchange, symbol, since, limit = 500) {
    const raw = toRawSymbol(symbol);
    const params = { symbol: raw, limit };
    if (since) params.startTime = since;
    const trades = await exchange._signedRequest('GET', '/fapi/v1/userTrades', params);
    return (trades || []).map(t => ({
        id: String(t.id),
        order: String(t.orderId),
        symbol: exchange._rawToSymbol[t.symbol] || t.symbol,
        side: t.side?.toLowerCase(),
        type: t.maker ? 'limit' : 'market',
        price: parseFloat(t.price),
        amount: parseFloat(t.qty),
        fee: { cost: parseFloat(t.commission), currency: t.commissionAsset },
        timestamp: t.time,
    }));
}
