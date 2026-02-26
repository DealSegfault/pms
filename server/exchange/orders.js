// exchange/orders: single-order lifecycle operations (market/limit/fetch/cancel).
import { toRawSymbol } from './helpers.js';

function resolveErrorCode(err) {
    return err?.code || err?.message?.match(/-\d+/)?.[0] || null;
}

function recordLatency(getTca, payload) {
    const tca = typeof getTca === 'function' ? getTca() : null;
    if (tca) tca.recordExchangeLatency(payload);
}

export async function createMarketOrder(exchange, getTca, symbol, side, quantity, params = {}) {
    if (!exchange._checkCircuitBreaker()) {
        throw new Error(`[CIRCUIT_BREAKER_OPEN] Exchange circuit breaker is open — rejecting ${side} ${symbol}. Resets in ${Math.ceil((exchange._cbOpenUntil - Date.now()) / 1000)}s`);
    }

    await exchange._acquireOrderSlot();

    const tcaStart = Date.now();
    let tcaSuccess = true;
    let tcaErrorCode = null;

    try {
        const safeParams = (params && typeof params === 'object') ? { ...params } : {};
        const resolvedSymbol = exchange.normalizeSymbol(symbol);
        const raw = toRawSymbol(resolvedSymbol);
        const reduceOnly = safeParams.reduceOnly === true || safeParams.reduceOnly === 'true';
        const qtyMode = reduceOnly ? 'down' : 'nearest';
        const safeQuantity = Number.parseFloat(exchange.amountToPrecisionCached(resolvedSymbol, quantity, { mode: qtyMode }));
        if (!Number.isFinite(safeQuantity) || safeQuantity <= 0) {
            throw new Error(`Invalid quantity after precision normalization: ${quantity} → ${safeQuantity}`);
        }

        const fastAck = safeParams.__fastAck === true;
        const fallbackPriceRaw = Number(safeParams.__fallbackPrice);
        const fallbackPrice = Number.isFinite(fallbackPriceRaw) && fallbackPriceRaw > 0
            ? Number.parseFloat(exchange.priceToPrecisionCached(resolvedSymbol, fallbackPriceRaw))
            : null;

        const orderParams = {
            symbol: raw,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: String(safeQuantity),
            newOrderRespType: fastAck ? 'ACK' : 'RESULT',
        };
        if (reduceOnly) orderParams.reduceOnly = 'true';
        if (safeParams.newClientOrderId) orderParams.newClientOrderId = safeParams.newClientOrderId;

        const order = await exchange._signedRequest('POST', '/fapi/v1/order', orderParams);
        console.log(`[Exchange] Market ${side} ${safeQuantity} ${resolvedSymbol} → Order ID: ${order.orderId}`);

        let fee = 0;
        let filledPrice = parseFloat(order.avgPrice) || null;
        let filledQty = parseFloat(order.executedQty) || parseFloat(order.origQty) || safeQuantity;

        if (fastAck) {
            if (!filledPrice && !fallbackPrice && order.orderId) {
                try {
                    await new Promise(r => setTimeout(r, 300));
                    const fetched = await exchange._signedRequest('GET', '/fapi/v1/order', { symbol: raw, orderId: order.orderId });
                    filledPrice = parseFloat(fetched.avgPrice) || null;
                    filledQty = parseFloat(fetched.executedQty) || filledQty;
                } catch {
                    // best-effort
                }
            }

            if (!filledPrice && fallbackPrice) filledPrice = fallbackPrice;
            if (!filledQty && safeQuantity > 0) filledQty = safeQuantity;
            if (!fee && filledPrice && filledQty) fee = filledPrice * filledQty * 0.0005;

            return {
                orderId: String(order.orderId),
                symbol: resolvedSymbol,
                side: order.side?.toLowerCase() || side,
                price: filledPrice,
                quantity: filledQty,
                fee,
                status: order.status,
                timestamp: order.updateTime || Date.now(),
            };
        }

        if (!filledPrice && order.orderId) {
            try {
                await new Promise(r => setTimeout(r, 200));
                const fetched = await exchange._signedRequest('GET', '/fapi/v1/order', { symbol: raw, orderId: order.orderId });
                if (!filledPrice) filledPrice = parseFloat(fetched.avgPrice) || null;
                if (!filledQty) filledQty = parseFloat(fetched.executedQty) || filledQty;
            } catch (err) {
                console.warn(`[Exchange] Failed to re-fetch order ${order.orderId}: ${err.message}`);
            }
        }

        if (!fee && filledPrice && filledQty) fee = filledPrice * filledQty * 0.0005;

        exchange._recordCbSuccess();
        return {
            orderId: String(order.orderId),
            symbol: resolvedSymbol,
            side: order.side?.toLowerCase() || side,
            price: filledPrice,
            quantity: filledQty,
            fee,
            status: order.status,
            timestamp: order.updateTime || Date.now(),
        };
    } catch (err) {
        tcaSuccess = false;
        tcaErrorCode = resolveErrorCode(err);
        exchange._recordCbFailure(err);
        console.error('[Exchange] Order failed:', err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
        recordLatency(getTca, {
            method: 'createMarketOrder',
            symbol,
            durationMs: Date.now() - tcaStart,
            success: tcaSuccess,
            errorCode: tcaErrorCode,
        });
    }
}

export async function createLimitOrder(exchange, getTca, symbol, side, quantity, price, params = {}) {
    if (!exchange._checkCircuitBreaker()) {
        throw new Error(`[CIRCUIT_BREAKER_OPEN] Exchange circuit breaker is open — rejecting limit ${side} ${symbol}. Resets in ${Math.ceil((exchange._cbOpenUntil - Date.now()) / 1000)}s`);
    }

    await exchange._acquireOrderSlot();

    const tcaStart = Date.now();
    let tcaSuccess = true;
    let tcaErrorCode = null;

    try {
        const resolvedSymbol = exchange.normalizeSymbol(symbol);
        const raw = toRawSymbol(resolvedSymbol);
        const safeParams = (params && typeof params === 'object') ? { ...params } : {};
        const reduceOnly = safeParams.reduceOnly === true || safeParams.reduceOnly === 'true';
        const qtyMode = reduceOnly ? 'down' : 'nearest';
        const safeQuantity = Number.parseFloat(exchange.amountToPrecisionCached(resolvedSymbol, quantity, { mode: qtyMode }));
        const safePrice = Number.parseFloat(exchange.priceToPrecisionCached(resolvedSymbol, price, { mode: 'nearest' }));

        if (!Number.isFinite(safeQuantity) || safeQuantity <= 0) {
            throw new Error(`Invalid quantity after precision normalization: ${quantity} → ${safeQuantity}`);
        }
        if (!Number.isFinite(safePrice) || safePrice <= 0) {
            throw new Error(`Invalid price after precision normalization: ${price} → ${safePrice}`);
        }

        const orderParams = {
            symbol: raw,
            side: side.toUpperCase(),
            type: 'LIMIT',
            timeInForce: safeParams.timeInForce || 'GTC',
            quantity: String(safeQuantity),
            price: String(safePrice),
        };
        if (reduceOnly) orderParams.reduceOnly = 'true';
        if (safeParams.newClientOrderId) orderParams.newClientOrderId = safeParams.newClientOrderId;
        if (safeParams.postOnly) orderParams.timeInForce = 'GTX';

        const order = await exchange._signedRequest('POST', '/fapi/v1/order', orderParams);
        console.log(`[Exchange] Limit ${side} ${safeQuantity} ${resolvedSymbol} @ $${safePrice} → Order ID: ${order.orderId}`);

        return {
            orderId: String(order.orderId),
            symbol: resolvedSymbol,
            side: order.side?.toLowerCase() || side,
            price: parseFloat(order.price) || safePrice,
            quantity: parseFloat(order.origQty) || safeQuantity,
            fee: 0,
            status: order.status,
            timestamp: order.updateTime || Date.now(),
        };
    } catch (err) {
        tcaSuccess = false;
        tcaErrorCode = resolveErrorCode(err);
        console.error('[Exchange] Limit order failed:', err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
        recordLatency(getTca, {
            method: 'createLimitOrder',
            symbol,
            durationMs: Date.now() - tcaStart,
            success: tcaSuccess,
            errorCode: tcaErrorCode,
        });
    }
}

export async function fetchOrder(exchange, symbol, orderId) {
    await exchange._acquireOrderSlot();
    try {
        const raw = toRawSymbol(symbol);
        const order = await exchange._signedRequest('GET', '/fapi/v1/order', { symbol: raw, orderId });
        return {
            orderId: String(order.orderId),
            symbol: exchange.normalizeSymbol(symbol),
            side: order.side?.toLowerCase(),
            type: order.type?.toLowerCase(),
            price: parseFloat(order.price),
            average: parseFloat(order.avgPrice) || null,
            amount: parseFloat(order.origQty),
            filled: parseFloat(order.executedQty),
            remaining: parseFloat(order.origQty) - parseFloat(order.executedQty),
            status: order.status?.toLowerCase(),
            fee: 0,
            timestamp: order.time,
        };
    } catch (err) {
        console.error('[Exchange] Fetch order failed:', err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
    }
}

export async function cancelOrder(exchange, getTca, symbol, orderId) {
    await exchange._acquireOrderSlot();

    const tcaStart = Date.now();
    let tcaSuccess = true;
    let tcaErrorCode = null;

    try {
        const raw = toRawSymbol(symbol);
        const result = await exchange._signedRequest('DELETE', '/fapi/v1/order', { symbol: raw, orderId });
        console.log(`[Exchange] Cancelled order ${orderId} for ${symbol}`);
        return result;
    } catch (err) {
        tcaSuccess = false;
        tcaErrorCode = resolveErrorCode(err);
        console.error('[Exchange] Cancel order failed:', err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
        recordLatency(getTca, {
            method: 'cancelOrder',
            symbol,
            durationMs: Date.now() - tcaStart,
            success: tcaSuccess,
            errorCode: tcaErrorCode,
        });
    }
}

export async function cancelAllOrders(exchange, symbol) {
    if (!exchange._checkCircuitBreaker()) {
        throw new Error(`[CIRCUIT_BREAKER_OPEN] Exchange circuit breaker is open — rejecting cancelAll ${symbol}`);
    }

    await exchange._acquireOrderSlot();
    try {
        const raw = toRawSymbol(symbol);
        const result = await exchange._signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: raw });
        console.log(`[Exchange] Bulk cancelled all orders for ${symbol}`);
        exchange._recordCbSuccess();
        return result;
    } catch (err) {
        exchange._recordCbFailure(err);
        console.error(`[Exchange] Bulk cancel failed for ${symbol}:`, err.message);
        throw err;
    } finally {
        exchange._releaseOrderSlot();
    }
}
