#!/usr/bin/env python
import logging
from binance.um_futures import UMFutures
from binance.lib.utils import config_logging
from binance.error import ClientError
import os

# Proxy config — read from env vars instead of config module
HTTP_PROXY = os.getenv("HTTP_PROXY", "")
HTTPS_PROXY = os.getenv("HTTPS_PROXY", "")

class BinanceFutures:
    def __init__(self, api_key="", api_secret="", testnet=False):
        """Initialize Binance Futures client
        
        Args:
            api_key (str): Binance API key
            api_secret (str): Binance API secret
            testnet (bool): Use testnet if True
        """
        self.proxies = None
        if HTTP_PROXY or HTTPS_PROXY:
            self.proxies = {
                'http': HTTP_PROXY,
                'https': HTTPS_PROXY
            }
        self.client = UMFutures(key=api_key, secret=api_secret, proxies=self.proxies)
        config_logging(logging, logging.INFO)
        self.logger = logging.getLogger(__name__)
    
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
            self.logger.info(f"Order created: {response}")
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
        return self.client.get_order(symbol=symbol, orderId=orderId, origClientOrderId=origClientOrderId)
    
    def get_open_orders(self, symbol=None):
        """Get open orders
        
        Args:
            symbol (str, optional): Trading pair symbol
        """
        return self.client.get_open_orders(symbol=symbol)
    
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
            self.logger.info(f"Order canceled: {response}")
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
            self.logger.info(f"All orders canceled for {symbol}: {response}")
            return response
        except ClientError as error:
            self.logger.error(
                f"Order cancellation failed. Status: {error.status_code}, Error code: {error.error_code}, Message: {error.error_message}"
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
        return self.client.get_position(symbol=symbol)
    
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