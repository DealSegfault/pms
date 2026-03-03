// ── Trading Page – Order Book & Trade Tape ───────────────────
import { formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { recordLatency } from './perf-metrics.js';

const ORDERBOOK_ROWS = 20;
const TAPE_ROWS = 30;
const IMPACT_SIZES = [1, 10, 100, 1_000, 10_000, 100_000];

let orderBookRenderScheduled = false;
let tradeTapeRenderScheduled = false;
let pendingOrderBookTickTs = 0;
let pendingTradeTickTs = 0;
let activeObView = 'book'; // 'book' | 'impact'

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

const impactDom = {
    rowsEl: null,
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

function _createImpactRow() {
    const row = document.createElement('div');
    row.className = 'si-row';

    const size = document.createElement('span');
    size.className = 'si-size';

    const buySlip = document.createElement('span');
    buySlip.className = 'si-slip';

    const sellSlip = document.createElement('span');
    sellSlip.className = 'si-slip';

    row.appendChild(size);
    row.appendChild(buySlip);
    row.appendChild(sellSlip);

    return { row, size, buySlip, sellSlip };
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

function _ensureImpactDom() {
    const rowsEl = document.getElementById('si-rows');
    if (!rowsEl) return false;

    if (impactDom.rowsEl !== rowsEl) {
        impactDom.rowsEl = rowsEl;
        impactDom.rows = [];
        rowsEl.innerHTML = '';
        for (let i = 0; i < IMPACT_SIZES.length; i += 1) {
            const refs = _createImpactRow();
            rowsEl.appendChild(refs.row);
            impactDom.rows.push(refs);
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

/**
 * Calculate VWAP slippage for a given notional size walking orderbook levels.
 * @param {Array<[number,number]>} levels - sorted [price, qty] pairs (best first)
 * @param {number} targetNotional - target size in USDT
 * @param {number} mid - mid price
 * @param {'buy'|'sell'} side
 * @returns {{ bps: number, sufficient: boolean }}
 */
function _calcSlippage(levels, targetNotional, mid, side) {
    if (!levels.length || mid <= 0) return { bps: 0, sufficient: false };

    let filledNotional = 0;
    let filledQty = 0;

    for (let i = 0; i < levels.length; i += 1) {
        const price = levels[i][0];
        const qty = levels[i][1];
        const levelNotional = price * qty;
        const remaining = targetNotional - filledNotional;

        if (levelNotional >= remaining) {
            const partialQty = remaining / price;
            filledQty += partialQty;
            filledNotional += remaining;
            break;
        } else {
            filledQty += qty;
            filledNotional += levelNotional;
        }
    }

    if (filledNotional < targetNotional * 0.99) {
        return { bps: 0, sufficient: false };
    }

    const vwap = filledNotional / filledQty;
    const slip = side === 'buy'
        ? ((vwap - mid) / mid) * 10000
        : ((mid - vwap) / mid) * 10000;

    return { bps: Math.max(0, slip), sufficient: true };
}

function _slipClass(bps) {
    if (bps < 5) return 'si-slip-green';
    if (bps < 20) return 'si-slip-yellow';
    return 'si-slip-red';
}

function _formatSize(n) {
    if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
    return `$${n}`;
}

function _renderSpreadImpactNow() {
    if (!_ensureImpactDom()) return;

    const asks = S.orderBookAsks;
    const bids = S.orderBookBids;
    const bestAsk = asks[0]?.[0] || 0;
    const bestBid = bids[0]?.[0] || 0;
    const mid = (bestAsk + bestBid) / 2;

    for (let i = 0; i < IMPACT_SIZES.length; i += 1) {
        const refs = impactDom.rows[i];
        const size = IMPACT_SIZES[i];

        refs.size.textContent = _formatSize(size);

        if (mid <= 0) {
            refs.buySlip.textContent = '—';
            refs.buySlip.className = 'si-slip';
            refs.sellSlip.textContent = '—';
            refs.sellSlip.className = 'si-slip';
            continue;
        }

        // Buy side — walk asks
        const buy = _calcSlippage(asks, size, mid, 'buy');
        if (buy.sufficient) {
            const bpsStr = buy.bps.toFixed(1);
            refs.buySlip.textContent = `${bpsStr} bps`;
            refs.buySlip.className = `si-slip ${_slipClass(buy.bps)}`;
        } else {
            refs.buySlip.textContent = '—';
            refs.buySlip.className = 'si-slip si-slip-muted';
        }

        // Sell side — walk bids
        const sell = _calcSlippage(bids, size, mid, 'sell');
        if (sell.sufficient) {
            const bpsStr = sell.bps.toFixed(1);
            refs.sellSlip.textContent = `${bpsStr} bps`;
            refs.sellSlip.className = `si-slip ${_slipClass(sell.bps)}`;
        } else {
            refs.sellSlip.textContent = '—';
            refs.sellSlip.className = 'si-slip si-slip-muted';
        }
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

        if (activeObView === 'book') {
            _renderOrderBookNow();
        } else {
            _renderSpreadImpactNow();
        }

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

/**
 * Wire up the Book / Spread Impact tab toggle.
 * Call once after the trading DOM is mounted.
 */
export function initOrderBookTabs() {
    const tabs = document.querySelectorAll('.ob-tab');
    const bookView = document.getElementById('ob-book-view');
    const impactView = document.getElementById('ob-impact-view');
    if (!bookView || !impactView) return;

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.obView;
            if (view === activeObView) return;
            activeObView = view;

            tabs.forEach(t => t.classList.toggle('active', t === tab));

            if (view === 'book') {
                bookView.style.display = '';
                impactView.style.display = 'none';
                _renderOrderBookNow();
            } else {
                bookView.style.display = 'none';
                impactView.style.display = '';
                _renderSpreadImpactNow();
            }
        });
    });
}
