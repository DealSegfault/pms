// exchange/orders-batch: Binance batch order placement + cancel operations.
import { sign, toRawSymbol } from './helpers.js';

function resolveErrorCode(err) {
    return err?.code || err?.message?.match(/-\d+/)?.[0] || null;
}

function recordLatency(getTca, payload) {
    const tca = typeof getTca === 'function' ? getTca() : null;
    if (tca) tca.recordExchangeLatency(payload);
}

export async function createBatchLimitOrders(exchange, getTca, orders) {
    if (!orders || orders.length === 0) return [];
    if (orders.length > 5) throw new Error('Binance batch limit is 5 orders per call');

    await exchange._acquireOrderSlot();

    const tcaStart = Date.now();
    let tcaSuccess = true;
    let tcaErrorCode = null;

    try {
        exchange._restCallCount++;

        const batchOrders = orders.map(o => {
            const resolvedSymbol = exchange.normalizeSymbol(o.symbol);
            const raw = toRawSymbol(resolvedSymbol);
            let qty = String(o.quantity);
            let px = String(o.price);
            try {
                const qtyMode = o?.params?.reduceOnly ? 'down' : 'nearest';
                qty = exchange.amountToPrecisionCached(resolvedSymbol, o.quantity, { mode: qtyMode });
                px = exchange.priceToPrecisionCached(resolvedSymbol, o.price, { mode: 'nearest' });
            } catch {
                // keep raw qty/price
            }

            const entry = {
                symbol: raw,
                side: o.side.toUpperCase(),
                type: 'LIMIT',
                timeInForce: 'GTC',
                quantity: qty,
                price: px,
            };
            if (o.params?.reduceOnly) entry.reduceOnly = 'true';
            if (o.params?.newClientOrderId) entry.newClientOrderId = o.params.newClientOrderId;
            return entry;
        });

        const timestamp = Date.now();
        const queryString = `batchOrders=${encodeURIComponent(JSON.stringify(batchOrders))}&timestamp=${timestamp}`;
        const signature = sign(exchange._apiSecret, queryString);
        const url = `${exchange._fapi}/fapi/v1/batchOrders?${queryString}&signature=${signature}`;

        const fetchRes = await fetch(url, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': exchange._apiKey },
        });
        const response = await fetchRes.json();

        if (!fetchRes.ok && !Array.isArray(response)) {
            const errMsg = response?.msg || response?.message || `HTTP ${fetchRes.status}`;
            throw new Error(`Batch API error: ${errMsg}`);
        }
        if (!response || !Array.isArray(response)) {
            throw new Error('Batch order returned non-array response');
        }

        const results = response.map((r, idx) => {
            const original = orders[idx];
            if (r.code && r.code !== 200) {
                console.error(`[Exchange-Batch] Order ${idx} failed: ${r.msg || r.code}`);
                return {
                    orderId: null,
                    symbol: original.symbol,
                    side: original.side,
                    price: original.price,
                    quantity: original.quantity,
                    status: 'error',
                    error: r.msg || `Error code ${r.code}`,
                };
            }
            const orderId = String(r.orderId || r.clientOrderId);
            console.log(`[Exchange-Batch] Limit ${original.side} ${original.quantity} ${original.symbol} @ $${original.price} → ID: ${orderId}`);
            return {
                orderId,
                symbol: original.symbol,
                side: original.side,
                price: r.price ? parseFloat(r.price) : original.price,
                quantity: r.origQty ? parseFloat(r.origQty) : original.quantity,
                fee: 0,
                status: r.status || 'NEW',
                timestamp: r.updateTime || Date.now(),
                error: null,
            };
        });

        const successCount = results.filter(r => !r.error).length;
        console.log(`[Exchange-Batch] Placed ${successCount}/${orders.length} orders in single call`);
        return results;
    } catch (err) {
        tcaSuccess = false;
        tcaErrorCode = resolveErrorCode(err);
        console.error('[Exchange-Batch] Batch order failed:', err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
        recordLatency(getTca, {
            method: 'createBatchLimitOrders',
            symbol: orders[0]?.symbol,
            durationMs: Date.now() - tcaStart,
            success: tcaSuccess,
            errorCode: tcaErrorCode,
        });
    }
}

export async function cancelBatchOrders(exchange, symbol, orderIds) {
    if (!orderIds || orderIds.length === 0) return [];
    if (orderIds.length > 10) throw new Error('Binance batch cancel limit is 10 orders per call');

    if (!exchange._checkCircuitBreaker()) {
        throw new Error(`[CIRCUIT_BREAKER_OPEN] Exchange circuit breaker is open — rejecting batch cancel ${symbol}`);
    }

    await exchange._acquireOrderSlot();
    try {
        exchange._restCallCount++;
        const raw = toRawSymbol(symbol);
        const timestamp = Date.now();
        const queryString = `symbol=${raw}&orderIdList=${encodeURIComponent(JSON.stringify(orderIds.map(id => Number(id))))}&timestamp=${timestamp}&recvWindow=5000`;
        const signature = sign(exchange._apiSecret, queryString);
        const url = `${exchange._fapi}/fapi/v1/batchOrders?${queryString}&signature=${signature}`;

        const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'X-MBX-APIKEY': exchange._apiKey },
        });
        const response = await res.json();

        const results = (Array.isArray(response) ? response : []).map((r, idx) => {
            if (r.code && r.code !== 200) {
                return { orderId: String(orderIds[idx]), status: 'error', error: r.msg || `Error code ${r.code}` };
            }
            return { orderId: String(r.orderId || orderIds[idx]), status: r.status || 'CANCELED', error: null };
        });

        const successCount = results.filter(r => !r.error).length;
        console.log(`[Exchange-Batch] Cancelled ${successCount}/${orderIds.length} orders for ${symbol}`);
        exchange._recordCbSuccess();
        return results;
    } catch (err) {
        exchange._recordCbFailure(err);
        console.error(`[Exchange-Batch] Batch cancel failed for ${symbol}:`, err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
    }
}
