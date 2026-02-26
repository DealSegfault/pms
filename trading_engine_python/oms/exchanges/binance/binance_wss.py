import asyncio
import json
import time
import hmac
import hashlib
import requests
from urllib.parse import urlencode

import redis.asyncio as aioredis
from typing import Dict, List, Optional, Union
import websockets

# Import from central config file
from config import REDIS_HOST, REDIS_PORT, REDIS_DB, BINANCE_API_KEY, BINANCE_API_SECRET, HTTP_PROXY, HTTPS_PROXY

# NOTE: websockets library does not natively support proxies the same way.
# If you need a proxy, you may need to establish a tunnel or use a socks proxy via a custom connector.
# For demonstration, proxy settings are omitted.

class BinanceWebsocket:
    def __init__(self, api_key: str, api_secret: str, testnet: bool = False):
        self.api_key = api_key
        self.api_secret = api_secret
        self.redis = aioredis.from_url(f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}", decode_responses=True)
        
        # Set base URLs based on testnet flag
        if testnet:
            self.base_url = "https://testnet.binancefuture.com"
        else:
            self.base_url = "https://fapi.binance.com"
        
        # Add proxy configuration
        self.proxies = None
        if HTTP_PROXY or HTTPS_PROXY:
            self.proxies = {
                'http': HTTP_PROXY,
                'https': HTTPS_PROXY
            }
        
        self.listen_key = None
        self.running = False
        self.ws = None
        self.keepalive_task = None

    def _generate_signature(self, params: Dict) -> str:
        """Generate signature for authenticated requests"""
        query_string = urlencode(params)
        return hmac.new(
            self.api_secret.encode('utf-8'),
            query_string.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()

    def _send_request(self, method: str, endpoint: str, params: Dict = None, signed: bool = False) -> Dict:
        """Send HTTP request to Binance API"""
        endpoint = endpoint.lstrip('/')
        url = f"{self.base_url}/{endpoint}"
        headers = {'X-MBX-APIKEY': self.api_key}
        
        if params is None:
            params = {}

        if signed:
            params['timestamp'] = int(time.time() * 1000)
            params['signature'] = self._generate_signature(params)

        try:
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                proxies=self.proxies,
                verify=True
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Error in API request: {e}")
            raise

    def get_open_orders(self, symbol: str = None) -> List[Dict]:
        """Get all open orders or open orders for a specific symbol"""
        params = {}
        if symbol:
            params['symbol'] = symbol
        
        return self._send_request('GET', 'fapi/v1/openOrders', params, signed=True)

    def get_position_risk(self, symbol: str = None) -> List[Dict]:
        """
        Get current position information (v3)
        Only symbols with positions or open orders will be returned
        
        Args:
            symbol (str, optional): Trading pair symbol
            
        Returns:
            List[Dict]: List of position information
        """
        params = {}
        if symbol:
            params['symbol'] = symbol
        
        return self._send_request('GET', 'fapi/v3/positionRisk', params, signed=True)

    def create_listen_key(self) -> str:
        """Create a listen key for user data stream"""
        response = self._send_request('POST', '/fapi/v1/listenKey')
        return response['listenKey']

    def keep_alive_listen_key(self, listen_key: str) -> Dict:
        """Keep-alive a listen key"""
        params = {'listenKey': listen_key}
        return self._send_request('PUT', '/fapi/v1/listenKey', params)

    def delete_listen_key(self, listen_key: str) -> Dict:
        """Delete a listen key"""
        params = {'listenKey': listen_key}
        return self._send_request('DELETE', '/fapi/v1/listenKey', params)

    async def start(self):
        # Acquire a listen key
        self.listen_key = self.create_listen_key()
        print(f"Listen Key: {self.listen_key}")

        # Initialize state in Redis
        await self.init_state()

        # Binance futures websocket endpoint
        ws_url = f"wss://fstream.binance.com/ws/{self.listen_key}"

        self.running = True

        # Start the keep-alive task in the background
        self.keepalive_task = asyncio.create_task(self.keepalive_listen_key_async())

        # Connect to the WebSocket and handle messages
        while self.running:
            try:
                async with websockets.connect(ws_url) as websocket:
                    print("WebSocket connection opened")
                    self.ws = websocket
                    await self.handle_messages()
            except Exception as e:
                print(f"WebSocket connection error: {e}")
                await asyncio.sleep(5)  # reconnect after a delay

    async def init_state(self):
        # Get open orders and positions
        open_orders = self.get_open_orders()
        for order_data in open_orders:
            order = self.map_order_data(order_data)
            key = f"order:binance:{order['symbol']}:{order['order_id']}"
            await self.redis.set(key, json.dumps(order))

        positions = self.get_position_risk()
        for pos_data in positions:
            if float(pos_data.get('positionAmt', 0)) != 0:
                position = self.map_position_data(pos_data)
                print("Adding: ", position['symbol'])
                await self.redis.set(f"position:binance:{position['symbol']}", json.dumps(position))

    async def keepalive_listen_key_async(self):
        while self.running:
            await asyncio.sleep(1800)  # 30 minutes
            try:
                # Keep the listen key alive
                self.keep_alive_listen_key(self.listen_key)
                print("Sent keep-alive for listen key")
            except Exception as e:
                print(f"Error sending keep-alive: {e}")

    async def handle_messages(self):
        # Continuously read messages from the WebSocket
        async for message in self.ws:
            data = json.loads(message)
            event_type = data.get('e')

            if event_type == 'ACCOUNT_UPDATE':
                await self.handle_account_update(data)
            elif event_type == 'ORDER_TRADE_UPDATE':
                await self.handle_order_trade_update(data)
            elif event_type == 'TRADE_LITE':
                await self.handle_trade_lite_update(data)
            else:
                print(f"Unhandled event type: {event_type}")

        # If we exit the loop, the connection is closed
        print("WebSocket closed")

    async def handle_account_update(self, message: Dict):
        data = message.get('a', {})        
        positions = data.get('P', [])
        for pos_data in positions:
            if float(pos_data.get('pa', 0)) != 0:
                position = self.map_position_data_ws(pos_data, message)
                key = f"position:binance:{position['symbol']}"
                await self.redis.set(key, json.dumps(position))
                # Publish position update event
                await self.redis.publish(f"position_updates:binance:{position['symbol']}", json.dumps(position))

    async def handle_order_trade_update(self, message: Dict):
        order_data = message.get('o', {})
        order = self.map_order_data_ws(order_data, message)
        key = f"order:binance:{order['symbol']}:{order['order_id']}"

        # Map WS status to numeric code (if needed)
        status_code = self._map_order_status(order_data.get("X", "NEW"))

        # For NEW or PARTIALLY_FILLED
        if status_code in [0, 2]:
            await self.redis.set(key, json.dumps(order))
        else:
            # Filled, canceled, or other terminal states
            await self.redis.delete(key)
            
        # Publish order update event
        await self.redis.publish(f"order_updates:binance:{order['symbol']}", json.dumps(order))

    def map_order_data(self, order_data: Dict) -> Dict:
        order = {
            "exchange": "binance",
            "order_id": str(order_data.get("orderId")),
            "client_order_id": order_data.get("clientOrderId"),
            "symbol": order_data.get("symbol"),
            "quantity": float(order_data.get("origQty", 0)),
            "price": float(order_data.get("price", 0)),
            "side": 1 if order_data.get("side") == "BUY" else -1,
            "type": 1 if order_data.get("type") == "LIMIT" else 0,
            "status": self._map_order_status(order_data.get("status", "")),
            "filled_quantity": float(order_data.get("executedQty", 0)),
            "remaining_quantity": float(order_data.get("origQty", 0)) - float(order_data.get("executedQty", 0)),
            "average_price": float(order_data.get("avgPrice", 0)),
            "leverage": float(order_data.get("leverage", 20)),
            "reduce_only": order_data.get("reduceOnly", False)
        }
        return order

    def map_position_data(self, pos_data: Dict) -> Dict:
        size = float(pos_data.get("positionAmt", 0))
        entry_price = float(pos_data.get("entryPrice", 0))
        mark_price = float(pos_data.get("markPrice", 0))

        roi = 0
        if entry_price != 0 and size != 0:
            price_diff = mark_price - entry_price
            roi = (price_diff / entry_price) * 100 * (1 if size > 0 else -1)

        position = {
            "exchange": "binance",
            "symbol": pos_data.get("symbol"),
            "size": abs(size),
            "side": 1 if size > 0 else -1,
            "entry_price": entry_price,
            "mark_price": mark_price,
            "liquidation_price": float(pos_data.get("liquidationPrice", 0)),
            "unrealized_pnl": float(pos_data.get("unRealizedProfit", 0)),
            "margin": float(pos_data.get("initialMargin", 0)),
            "leverage": float(pos_data.get("leverage", 20)),
            "roi": roi
        }
        return position

    def _map_order_status(self, status: str) -> int:
        status_map = {
            "NEW": 0,
            "FILLED": 1,
            "PARTIALLY_FILLED": 2,
            "CANCELED": 3,
            "REJECTED": 6,
            "EXPIRED": 3,  # Map EXPIRED to canceled
        }
        return status_map.get(status, 0)

    def map_order_data_ws(self, order_data: Dict, message: Dict) -> Dict:
        order = {
            "order_id": str(order_data.get("i")),
            "client_order_id": order_data.get("c"),
            "symbol": order_data.get("s"),
            "quantity": float(order_data.get("q", 0)),
            "price": float(order_data.get("p", 0)),
            "side": 1 if order_data.get("S") == "BUY" else -1,
            "type": order_data.get("o"),
            "status": order_data.get("X"),
            "filled_quantity": float(order_data.get("z", 0)),
            "remaining_quantity": float(order_data.get("q", 0)) - float(order_data.get("z", 0)),
            "average_price": float(order_data.get("ap", 0)),
            "reduce_only": order_data.get("R", False),
            "created_time": order_data.get("T"),
            "updated_time": order_data.get("T"),
        }
        return order

    def map_position_data_ws(self, pos_data: Dict, message: Dict) -> Dict:
        # WebSocket data for positions is slightly different
        position = {
            "symbol": pos_data.get("s"),
            "position_side": pos_data.get("ps"),
            "size": float(pos_data.get("pa", 0)),
            "side": 1 if float(pos_data.get("pa", 0)) > 0 else -1,
            "entry_price": float(pos_data.get("ep", 0)),
            "mark_price": float(pos_data.get("mp", 0)),
            "unrealized_pnl": float(pos_data.get("up", 0)),
            "liquidation_price": None,  # Not provided
            "margin": float(pos_data.get("im", 0)),
            "isolated_wallet": float(pos_data.get("iw", 0)),
            "adl": int(pos_data.get("adl", 0)),
            "update_time": message.get('E', 0)
        }
        return position

    def map_order_data_lite_ws(self, data: Dict) -> Dict:
        """Map TRADE_LITE event data to standardized order format
        
        Args:
            data (Dict): TRADE_LITE event data
            
        Returns:
            Dict: Standardized order data
        """
        order = {
            "exchange": "binance",
            "order_id": str(data.get("i")),
            "client_order_id": data.get("c"),
            "symbol": data.get("s"),
            "quantity": float(data.get("q", 0)),
            "price": float(data.get("p", 0)),
            "side": 1 if data.get("S") == "BUY" else -1,
            "status": "FILLED",  # TRADE_LITE only reports filled trades
            "filled_quantity": float(data.get("l", 0)),
            "last_filled_price": float(data.get("L", 0)),
            "is_maker": data.get("m", False),
            "trade_id": data.get("t"),
            "transaction_time": data.get("T"),
            "event_time": data.get("E"),
        }
        return order
        
    async def handle_trade_lite_update(self, data: Dict):
        """Handle TRADE_LITE event data
        
        Args:
            data (Dict): TRADE_LITE event data
        """
        order = self.map_order_data_lite_ws(data)
        key = f"order:binance:{order['symbol']}:{order['order_id']}"
        
        # Since TRADE_LITE only reports trades (fills), we may not need to 
        # store the order in Redis, but we publish the update
        # If partial fill, update the order
        if float(data.get("l", 0)) < float(data.get("q", 0)):
            # Get existing order if it exists
            existing_order = await self.redis.get(key)
            if existing_order:
                existing_order = json.loads(existing_order)
                existing_order["filled_quantity"] = float(existing_order.get("filled_quantity", 0)) + float(data.get("l", 0))
                existing_order["remaining_quantity"] = float(existing_order.get("quantity", 0)) - float(existing_order.get("filled_quantity", 0))
                await self.redis.set(key, json.dumps(existing_order))
        else:
            # Completely filled, remove from open orders
            await self.redis.delete(key)
            
        # Publish order update event
        await self.redis.publish(f"order_updates:binance:{order['symbol']}", json.dumps(order))

    async def stop(self):
        self.running = False
        if self.keepalive_task:
            self.keepalive_task.cancel()
        if self.ws:
            await self.ws.close()
        await self.redis.close()

if __name__ == "__main__":
    async def main():
        binance_ws = BinanceWebsocket(BINANCE_API_KEY, BINANCE_API_SECRET)
        await binance_ws.start()

    asyncio.run(main())
