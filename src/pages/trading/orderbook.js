// ── Trading Page – Order Book & Trade Tape ───────────────────
import { formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { recordLatency } from './perf-metrics.js';

const ORDERBOOK_ROWS = 12;
const TAPE_ROWS = 30;

let orderBookRenderScheduled = false;
let tradeTapeRenderScheduled = false;
let pendingOrderBookTickTs = 0;
let pendingTradeTickTs = 0;

const orderBookDom = {
    asksEl: null,
    bidsEl: null,
    midEl: null,
    midValueEl: null,
    midSpreadEl: null,
    spreadEl: null,
    askRows: [],
    bidRows: [],
};

const tapeDom = {
    listEl: null,
    rows: [],
};

function _createOrderBookRow(isAsk) {
    const row = document.createElement('div');
    row.className = `ob-row ${isAsk ? 'ob-ask' : 'ob-bid'}`;
    row.style.cursor = 'pointer';

    const bar = document.createElement('div');
    bar.className = `ob-bar ${isAsk ? 'ob-bar-ask' : 'ob-bar-bid'}`;

    const price = document.createElement('span');
    price.className = 'ob-price';

    const qty = document.createElement('span');
    qty.className = 'ob-qty';

    const total = document.createElement('span');
    total.className = 'ob-total';

    row.appendChild(bar);
    row.appendChild(price);
    row.appendChild(qty);
    row.appendChild(total);

    return { row, bar, price, qty, total };
}

function _createTapeRow() {
    const row = document.createElement('div');
    row.className = 'tape-row tape-buy';

    const price = document.createElement('span');
    price.className = 'tape-price';

    const qty = document.createElement('span');
    qty.className = 'tape-qty';

    const time = document.createElement('span');
    time.className = 'tape-time';

    row.appendChild(price);
    row.appendChild(qty);
    row.appendChild(time);

    return { row, price, qty, time };
}

function _ensureOrderBookDom() {
    const asksEl = document.getElementById('ob-asks');
    const bidsEl = document.getElementById('ob-bids');
    const midEl = document.getElementById('ob-mid-price');
    const spreadEl = document.getElementById('ob-spread');
    const midSpreadEl = document.getElementById('ob-mid-spread');

    if (!asksEl || !bidsEl || !midEl || !spreadEl) return false;

    if (orderBookDom.asksEl !== asksEl) {
        orderBookDom.asksEl = asksEl;
        orderBookDom.askRows = [];
        asksEl.innerHTML = '';
        for (let i = 0; i < ORDERBOOK_ROWS; i += 1) {
            const refs = _createOrderBookRow(true);
            asksEl.appendChild(refs.row);
            orderBookDom.askRows.push(refs);
        }
    }

    if (orderBookDom.bidsEl !== bidsEl) {
        orderBookDom.bidsEl = bidsEl;
        orderBookDom.bidRows = [];
        bidsEl.innerHTML = '';
        for (let i = 0; i < ORDERBOOK_ROWS; i += 1) {
            const refs = _createOrderBookRow(false);
            bidsEl.appendChild(refs.row);
            orderBookDom.bidRows.push(refs);
        }
    }

    orderBookDom.midEl = midEl;
    orderBookDom.midValueEl = midEl.querySelector('.ob-mid-value');
    orderBookDom.midSpreadEl = midSpreadEl;
    orderBookDom.spreadEl = spreadEl;
    return true;
}

function _ensureTapeDom() {
    const listEl = document.getElementById('trade-tape');
    if (!listEl) return false;

    if (tapeDom.listEl !== listEl) {
        tapeDom.listEl = listEl;
        tapeDom.rows = [];
        listEl.innerHTML = '';
        for (let i = 0; i < TAPE_ROWS; i += 1) {
            const refs = _createTapeRow();
            listEl.appendChild(refs.row);
            tapeDom.rows.push(refs);
        }
    }

    return true;
}

function _updateBookSide(rows, levels, isAsk) {
    let runningTotal = 0;
    const maxQty = Math.max(...levels.map((lvl) => lvl[1]), 0.001);

    for (let i = 0; i < rows.length; i += 1) {
        const refs = rows[i];
        const level = levels[i];

        if (!level) {
            refs.row.style.display = 'none';
            refs.row.dataset.price = '';
            continue;
        }

        const price = level[0];
        const qty = level[1];
        runningTotal += qty;

        refs.row.style.display = '';
        refs.row.dataset.price = String(price);
        refs.bar.style.width = `${((qty / maxQty) * 100).toFixed(1)}%`;
        refs.price.textContent = formatPrice(price);
        refs.qty.textContent = formatQty(qty);
        refs.total.textContent = formatQty(runningTotal);

        // Keep side-specific row class stable if this row was reused after remount.
        refs.row.className = `ob-row ${isAsk ? 'ob-ask' : 'ob-bid'}`;
    }
}

function _renderOrderBookNow() {
    if (!_ensureOrderBookDom()) return;

    const asks = S.orderBookAsks.slice(0, ORDERBOOK_ROWS).reverse();
    const bids = S.orderBookBids.slice(0, ORDERBOOK_ROWS);

    _updateBookSide(orderBookDom.askRows, asks, true);
    _updateBookSide(orderBookDom.bidRows, bids, false);

    if (asks.length && bids.length) {
        const bestAsk = S.orderBookAsks[0]?.[0] || 0;
        const bestBid = S.orderBookBids[0]?.[0] || 0;
        const mid = (bestAsk + bestBid) / 2;
        const spread = bestAsk - bestBid;
        const spreadBps = mid > 0 ? ((spread / mid) * 10000).toFixed(1) : '—';

        // Mid-price value
        if (orderBookDom.midValueEl) {
            orderBookDom.midValueEl.textContent = formatPrice(mid);
        } else {
            orderBookDom.midEl.textContent = formatPrice(mid);
        }

        // Spread in the mid separator
        if (orderBookDom.midSpreadEl) {
            orderBookDom.midSpreadEl.textContent = `${formatPrice(spread)} · ${spreadBps} bps`;
        }

        // Header spread
        orderBookDom.spreadEl.textContent = `${formatPrice(spread)} (${spreadBps} bps)`;
    } else {
        if (orderBookDom.midValueEl) {
            orderBookDom.midValueEl.textContent = '—';
        } else {
            orderBookDom.midEl.textContent = '—';
        }
        if (orderBookDom.midSpreadEl) {
            orderBookDom.midSpreadEl.textContent = '';
        }
        orderBookDom.spreadEl.textContent = 'Spread: —';
    }
}

function _renderTradeTapeNow() {
    if (!_ensureTapeDom()) return;

    const trades = S.recentTrades.slice(0, TAPE_ROWS);

    for (let i = 0; i < TAPE_ROWS; i += 1) {
        const refs = tapeDom.rows[i];
        const trade = trades[i];

        if (!trade) {
            refs.row.style.display = 'none';
            continue;
        }

        const time = new Date(trade.time);
        const hh = time.getHours().toString().padStart(2, '0');
        const mm = time.getMinutes().toString().padStart(2, '0');
        const ss = time.getSeconds().toString().padStart(2, '0');
        const side = trade.isBuyerMaker ? 'sell' : 'buy';

        refs.row.style.display = '';
        refs.row.className = `tape-row tape-${side}`;
        refs.price.textContent = formatPrice(trade.price);
        refs.qty.textContent = formatQty(trade.qty);
        refs.time.textContent = `${hh}:${mm}:${ss}`;
    }
}

export function formatQty(n) {
    if (n >= 1000) return n.toFixed(1);
    if (n >= 1) return n.toFixed(3);
    if (n >= 0.001) return n.toFixed(5);
    return n.toFixed(8);
}

export function scheduleOrderBookRender(tickTs = 0) {
    if (tickTs > pendingOrderBookTickTs) pendingOrderBookTickTs = tickTs;
    if (orderBookRenderScheduled) return;

    orderBookRenderScheduled = true;
    requestAnimationFrame(() => {
        orderBookRenderScheduled = false;
        _renderOrderBookNow();

        if (pendingOrderBookTickTs) {
            recordLatency('depth_tick_to_paint_ms', Math.max(0, Date.now() - pendingOrderBookTickTs));
            pendingOrderBookTickTs = 0;
        }
    });
}

export function scheduleTradeTapeRender(tickTs = 0) {
    if (tickTs > pendingTradeTickTs) pendingTradeTickTs = tickTs;
    if (tradeTapeRenderScheduled) return;

    tradeTapeRenderScheduled = true;
    requestAnimationFrame(() => {
        tradeTapeRenderScheduled = false;
        _renderTradeTapeNow();

        if (pendingTradeTickTs) {
            recordLatency('trade_tick_to_paint_ms', Math.max(0, Date.now() - pendingTradeTickTs));
            pendingTradeTickTs = 0;
        }
    });
}

export function renderOrderBook() {
    _renderOrderBookNow();
}

export function renderTradeTape() {
    _renderTradeTapeNow();
}
