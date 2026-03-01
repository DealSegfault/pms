#!/usr/bin/env python
import logging
from binance.um_futures import UMFutures
from binance.lib.utils import config_logging
from binance.error import ClientError
import os
import time

# Proxy config — read from env vars instead of config module
HTTP_PROXY = os.getenv("HTTP_PROXY", "")
HTTPS_PROXY = os.getenv("HTTPS_PROXY", "")

# ── ANSI colors for terminal order logs ──────────────────────────────
_C = {
    "R": "\033[0m",       # reset
    "DIM": "\033[2m",     # dim
    "BOLD": "\033[1m",    # bold
    "GREEN": "\033[92m",  # bright green
    "YELLOW": "\033[93m", # bright yellow
    "CYAN": "\033[96m",   # bright cyan
    "MAGENTA": "\033[95m",# bright magenta
    "RED": "\033[91m",    # bright red
    "BLUE": "\033[94m",   # bright blue
    "WHITE": "\033[97m",  # bright white
}

_STATUS_STYLE = {
    "NEW":              ("GREEN",   "✚"),
    "PARTIALLY_FILLED": ("MAGENTA", "◐"),
    "FILLED":           ("CYAN",    "✔"),
    "CANCELED":         ("YELLOW",  "✖"),
    "REJECTED":         ("RED",     "✘"),
    "EXPIRED":          ("RED",     "⏱"),
    "NEW_INSURANCE":    ("BLUE",    "🛡"),
    "NEW_ADL":          ("RED",     "⚠"),
}

def _fmt_order(label: str, r: dict) -> str:
    """One-line compact colored order log."""
    status = r.get("status", "?")
    color_key, icon = _STATUS_STYLE.get(status, ("WHITE", "?"))
    c = _C[color_key]
    d, rst, b = _C["DIM"], _C["R"], _C["BOLD"]

    side = r.get("side", "?")
    side_c = _C["GREEN"] if side == "BUY" else _C["RED"]

    sym = r.get("symbol", "?")
    otype = r.get("origType", r.get("type", "?"))
    qty = r.get("origQty", r.get("quantity", "?"))
    exec_qty = r.get("executedQty", "0")
    price = r.get("price", "?")
    avg = r.get("avgPrice", None)
    oid = r.get("orderId", "?")
    cid = r.get("clientOrderId", "")
    # shorten clientOrderId to last 6 chars for readability
    cid_short = cid[-6:] if cid else ""

    # Build compact line:  ✚ NEW BUY STEEMUSDT LMT 122 @ 0.06723 | oid=123 cid=..ab12
    parts = [
        f"{c}{b}{icon} {status}{rst}",
        f"{side_c}{b}{side}{rst}",
        f"{b}{sym}{rst}",
        f"{d}{otype}{rst}",
        f"{qty}",
    ]
    # price info
    if price and price != "0" and price != "0.00000000":
        parts.append(f"@ {price}")
    # filled info
    if exec_qty and exec_qty != "0":
        avg_str = f" avg {avg}" if avg and avg != "0.00" and avg != "0" else ""
        parts.append(f"{d}filled {exec_qty}{avg_str}{rst}")
    # ids
    parts.append(f"{d}oid={oid}{rst}")
    if cid_short:
        parts.append(f"{d}cid=..{cid_short}{rst}")

    return f"{label}: {' '.join(parts)}"

class BinanceFutures:
    def __init__(self, api_key="", api_secret="", testnet=False):
        """Initialize Binance Futures client
        
        Args:
            api_key (str): Binance API key
            api_secret (str): Binance API secret
            testnet (bool): Use testnet if True
        """
        # Proxy config — explicitly disable to avoid system env vars
        # (HTTP_PROXY / HTTPS_PROXY) causing SSL errors.
        # If a proxy IS needed, set these to the correct http:// URLs.
        self.proxies = {}
        self.client = UMFutures(key=api_key, secret=api_secret, proxies=self.proxies)
        config_logging(logging, logging.INFO)
        self.logger = logging.getLogger(__name__)

        # ── Time sync: compute offset from Binance server ──
        # Binance rejects requests with -1021 if local clock drifts >1s.
        # We fetch server time once, compute the delta, and patch
        # sign_request to use corrected timestamps + a 10s recvWindow.
        self._time_offset_ms = 0
        try:
            local_before = int(time.time() * 1000)
            server_data = self.client.time()
            local_after = int(time.time() * 1000)
            server_time = server_data.get("serverTime", 0)
            local_mid = (local_before + local_after) // 2
            self._time_offset_ms = server_time - local_mid
            if abs(self._time_offset_ms) > 500:
                self.logger.warning(
                    "Clock drift detected: local is %+dms vs Binance. Auto-correcting.",
                    -self._time_offset_ms,
                )
        except Exception as e:
            self.logger.warning("Failed to sync time with Binance: %s — using local clock", e)

        # Monkey-patch sign_request to inject corrected timestamp + recvWindow
        _original_sign = self.client.sign_request
        _offset = self._time_offset_ms

        def _patched_sign_request(http_method, url_path, payload=None, special=False):
            if payload is None:
                payload = {}
            payload["timestamp"] = int(time.time() * 1000) + _offset
            payload["recvWindow"] = 10000  # 10s window (default is 5s)
            from binance.lib.utils import cleanNoneValue
            query_string = self.client._prepare_params(payload, special)
            payload["signature"] = self.client._get_sign(query_string)
            return self.client.send_request(http_method, url_path, payload, special)

        self.client.sign_request = _patched_sign_request
    
    # ===== Market Data Methods =====
    
    def get_server_time(self):
        """Get Binance server time"""
        return self.client.time()
    
    def get_exchange_info(self):
        """Get exchange information"""
        return self.client.exchange_info()
    
    def get_symbol_info(self, symbol):
        """Get information for a specific symbol
        
        Args:
            symbol (str): Trading pair symbol (e.g., "BTCUSDT")
        """
        return self.client.exchange_info(symbol=symbol)
    
    def get_orderbook(self, symbol, limit=50):
        """Get order book for a symbol
        
        Args:
            symbol (str): Trading pair symbol
            limit (int): Limit of results (default: 50)
        """
        return self.client.depth(symbol=symbol, limit=limit)
    
    def get_recent_trades(self, symbol, limit=500):
        """Get recent trades for a symbol
        
        Args:
            symbol (str): Trading pair symbol
            limit (int): Limit of results (default: 500)
        """
        return self.client.trades(symbol=symbol, limit=limit)
    
    def get_historical_trades(self, symbol, limit=500, fromId=None):
        """Get historical trades
        
        Args:
            symbol (str): Trading pair symbol
            limit (int): Limit of results (default: 500)
            fromId (int, optional): Trade ID to fetch from
        """
        return self.client.historical_trades(symbol=symbol, limit=limit, fromId=fromId)
    
    def get_aggregate_trades(self, symbol, **kwargs):
        """Get aggregate trades for a symbol
        
        Args:
            symbol (str): Trading pair symbol
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 500)
        """
        return self.client.agg_trades(symbol=symbol, **kwargs)
    
    def get_klines(self, symbol, interval, **kwargs):
        """Get kline/candlestick data
        
        Args:
            symbol (str): Trading pair symbol
            interval (str): Kline interval (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M)
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 500)
        """
        return self.client.klines(symbol=symbol, interval=interval, **kwargs)
    
    def get_continuous_klines(self, pair, contractType, interval, **kwargs):
        """Get continuous kline/candlestick data
        
        Args:
            pair (str): Trading pair (e.g., "BTCUSDT")
            contractType (str): Contract type (e.g., "PERPETUAL")
            interval (str): Kline interval
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 500)
        """
        return self.client.continuous_klines(pair=pair, contractType=contractType, interval=interval, **kwargs)
    
    def get_mark_price(self, symbol=None):
        """Get mark price for a symbol or all symbols
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.mark_price(symbol=symbol)
    
    def get_funding_rate(self, symbol=None, **kwargs):
        """Get funding rate history
        
        Args:
            symbol (str, optional): Trading pair symbol
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 100)
        """
        return self.client.funding_rate(symbol=symbol, **kwargs)
    
    def get_ticker_price(self, symbol=None):
        """Get ticker price for a symbol or all symbols
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.ticker_price(symbol=symbol)
    
    def get_ticker_24h(self, symbol=None):
        """Get 24hr ticker price change statistics
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.ticker_24hr_price_change(symbol=symbol)
    
    # ===== Account Methods =====
    
    def get_account_info(self):
        """Get account information"""
        return self.client.account()
    
    def get_balance(self):
        """Get account balance"""
        return self.client.balance()
    
    def get_position_risk(self, symbol=None):
        """Get position risk
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.get_position_risk(symbol=symbol)
    
    def get_account_trades(self, symbol, **kwargs):
        """Get account trades
        
        Args:
            symbol (str): Trading pair symbol
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            fromId (int, optional): Trade ID to fetch from
            limit (int, optional): Limit of results (default: 500)
        """
        return self.client.get_account_trades(symbol=symbol, **kwargs)
    
    def get_income_history(self, **kwargs):
        """Get income history
        
        Args:
            symbol (str, optional): Trading pair symbol
            incomeType (str, optional): Income type
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 100)
        """
        return self.client.get_income_history(**kwargs)
    
    # ===== Order Methods =====
    
    def create_order(self, symbol, side, orderType, **kwargs):
        """Create a new order
        
        Args:
            symbol (str): Trading pair symbol
            side (str): Order side (BUY or SELL)
            orderType (str): Order type (LIMIT, MARKET, STOP, TAKE_PROFIT, etc.)
            timeInForce (str, optional): Time in force (GTC, IOC, FOK)
            quantity (float, optional): Order quantity
            price (float, optional): Order price
            stopPrice (float, optional): Stop price
            closePosition (bool, optional): Close position
            positionSide (str, optional): Position side (BOTH, LONG, SHORT)
            reduceOnly (bool, optional): Reduce only
        """
        try:
            response = self.client.new_order(
                symbol=symbol,
                side=side,
                type=orderType,
                **kwargs
            )
            self.logger.info(_fmt_order("ORDER", response))
            return response
        except ClientError as error:
            self.logger.error(
                f"Order failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    def create_limit_order(self, symbol, side, quantity, price, timeInForce="GTC", **kwargs):
        """Create a limit order
        
        Args:
            symbol (str): Trading pair symbol
            side (str): Order side (BUY or SELL)
            quantity (float): Order quantity
            price (float): Order price
            timeInForce (str): Time in force (default: GTC)
        """
        return self.create_order(
            symbol=symbol,
            side=side,
            orderType="LIMIT",
            quantity=quantity,
            price=price,
            timeInForce=timeInForce,
            **kwargs
        )
    
    def create_market_order(self, symbol, side, quantity, **kwargs):
        """Create a market order
        
        Args:
            symbol (str): Trading pair symbol
            side (str): Order side (BUY or SELL)
            quantity (float): Order quantity
        """
        return self.create_order(
            symbol=symbol,
            side=side,
            orderType="MARKET",
            quantity=quantity,
            **kwargs
        )
    
    def create_stop_market_order(self, symbol, side, stopPrice, **kwargs):
        """Create a stop market order
        
        Args:
            symbol (str): Trading pair symbol
            side (str): Order side (BUY or SELL)
            stopPrice (float): Stop price
            quantity (float, optional): Order quantity
        """
        return self.create_order(
            symbol=symbol,
            side=side,
            orderType="STOP_MARKET",
            stopPrice=stopPrice,
            **kwargs
        )
    
    def create_take_profit_market_order(self, symbol, side, stopPrice, **kwargs):
        """Create a take profit market order
        
        Args:
            symbol (str): Trading pair symbol
            side (str): Order side (BUY or SELL)
            stopPrice (float): Stop price
            quantity (float, optional): Order quantity
        """
        return self.create_order(
            symbol=symbol,
            side=side,
            orderType="TAKE_PROFIT_MARKET",
            stopPrice=stopPrice,
            **kwargs
        )
    
    def get_order(self, symbol, orderId=None, origClientOrderId=None):
        """Get order details
        
        Args:
            symbol (str): Trading pair symbol
            orderId (int, optional): Order ID
            origClientOrderId (str, optional): Original client order ID
        """
        return self.client.query_order(symbol=symbol, orderId=orderId, origClientOrderId=origClientOrderId)
    
    def get_open_orders(self, symbol=None):
        """Get open orders
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        if symbol:
            return self.client.get_open_orders(symbol=symbol)
        # UMFutures.get_open_orders requires symbol — use get_orders for all-symbols query
        return self.client.get_orders()
    
    def get_all_orders(self, symbol, **kwargs):
        """Get all orders
        
        Args:
            symbol (str): Trading pair symbol
            orderId (int, optional): Order ID
            startTime (int, optional): Start time in milliseconds
            endTime (int, optional): End time in milliseconds
            limit (int, optional): Limit of results (default: 500)
        """
        return self.client.get_all_orders(symbol=symbol, **kwargs)
    
    def cancel_order(self, symbol, orderId=None, origClientOrderId=None):
        """Cancel an order
        
        Args:
            symbol (str): Trading pair symbol
            orderId (int, optional): Order ID
            origClientOrderId (str, optional): Original client order ID
        """
        try:
            response = self.client.cancel_order(
                symbol=symbol, 
                orderId=orderId,
                origClientOrderId=origClientOrderId
            )
            self.logger.info(_fmt_order("ORDER", response))
            return response
        except ClientError as error:
            self.logger.error(
                f"Order cancellation failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    def cancel_all_orders(self, symbol):
        """Cancel all orders for a symbol
        
        Args:
            symbol (str): Trading pair symbol
        """
        try:
            response = self.client.cancel_all_open_orders(symbol=symbol)
            self.logger.info(f"{_C['YELLOW']}{_C['BOLD']}✖ CANCEL ALL{_C['R']} {_C['BOLD']}{symbol}{_C['R']} {_C['DIM']}{response}{_C['R']}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Order cancellation failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise

    def create_batch_orders(self, orders: list) -> list:
        """Place up to 5 orders in a single REST call.
        
        Args:
            orders (list[dict]): List of order parameters, each dict containing:
                symbol, side, type, quantity, price, timeInForce, newClientOrderId, 
                reduceOnly, etc. Maximum 5 orders per call.
        
        Returns:
            list[dict]: List of order responses (same order as input).
                        Failed individual orders have 'code' and 'msg' fields.
        """
        import json
        if len(orders) > 5:
            raise ValueError(f"Batch limit is 5 orders, got {len(orders)}")
        try:
            response = self.client.new_batch_order(batchOrders=json.dumps(orders))
            for r in response:
                if isinstance(r, dict) and 'status' in r:
                    self.logger.info(_fmt_order("BATCH", r))
                elif isinstance(r, dict) and 'code' in r:
                    self.logger.error(f"BATCH order failed: code={r.get('code')} msg={r.get('msg')}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Batch order failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise

    def cancel_batch_orders(self, symbol: str, order_id_list: list = None, 
                            orig_client_order_id_list: list = None) -> list:
        """Cancel up to 5 orders in a single REST call.
        
        Args:
            symbol (str): Trading pair symbol
            order_id_list (list[int], optional): List of exchange order IDs
            orig_client_order_id_list (list[str], optional): List of client order IDs
        
        Returns:
            list[dict]: List of cancel responses.
        """
        import json
        kwargs = {"symbol": symbol}
        if order_id_list:
            kwargs["orderIdList"] = json.dumps(order_id_list)
        if orig_client_order_id_list:
            kwargs["origClientOrderIdList"] = json.dumps(orig_client_order_id_list)
        try:
            response = self.client.cancel_batch_order(**kwargs)
            for r in response:
                if isinstance(r, dict) and 'status' in r:
                    self.logger.info(_fmt_order("BATCH_CANCEL", r))
            return response
        except ClientError as error:
            self.logger.error(
                f"Batch cancel failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    # ===== Position Methods =====
    
    def change_position_mode(self, dualSidePosition):
        """Change position mode
        
        Args:
            dualSidePosition (bool): True for hedge mode, False for one-way mode
        """
        try:
            response = self.client.change_position_mode(dualSidePosition=dualSidePosition)
            self.logger.info(f"Position mode changed: {response}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Position mode change failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    def get_position_mode(self):
        """Get current position mode"""
        return self.client.get_position_mode()
    
    def change_leverage(self, symbol, leverage):
        """Change leverage
        
        Args:
            symbol (str): Trading pair symbol
            leverage (int): Leverage (1-125)
        """
        try:
            response = self.client.change_leverage(symbol=symbol, leverage=leverage)
            self.logger.info(f"Leverage changed for {symbol}: {response}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Leverage change failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    def change_margin_type(self, symbol, marginType):
        """Change margin type
        
        Args:
            symbol (str): Trading pair symbol
            marginType (str): Margin type (ISOLATED, CROSSED)
        """
        try:
            response = self.client.change_margin_type(symbol=symbol, marginType=marginType)
            self.logger.info(f"Margin type changed for {symbol}: {response}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Margin type change failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
            )
            raise
    
    def get_position(self, symbol=None):
        """Get current position
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.get_position_risk(symbol=symbol)
    
    # ===== User Data Stream Methods =====
    
    def start_user_data_stream(self):
        """Start user data stream and return listen key"""
        return self.client.new_listen_key()
    
    def keep_alive_user_data_stream(self, listenKey):
        """Keep user data stream alive
        
        Args:
            listenKey (str): Listen key
        """
        return self.client.renew_listen_key(listenKey=listenKey)
    
    def close_user_data_stream(self, listenKey):
        """Close user data stream
        
        Args:
            listenKey (str): Listen key
        """
        return self.client.close_listen_key(listenKey=listenKey)


# Example usage
if __name__ == "__main__":
    # Initialize client with API keys
    api_key = "your_api_key"
    api_secret = "your_api_secret"
    
    futures = BinanceFutures(api_key=api_key, api_secret=api_secret, testnet=True)
    
    # Get market data
    symbol = "BTCUSDT"
    print(f"Current price of {symbol}:", futures.get_ticker_price(symbol=symbol))
    
    # Set leverage
    futures.change_leverage(symbol=symbol, leverage=5)
    
    # Place a limit order
    try:
        order = futures.create_limit_order(
            symbol=symbol,
            side="BUY",
            quantity=0.001,
            price=40000,
            timeInForce="GTC"
        )
        print("Order placed:", order)
    except Exception as e:
        print("Order failed:", e) 