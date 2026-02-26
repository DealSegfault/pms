import redis
import json
import time
from config import REDIS_HOST, REDIS_PORT, REDIS_DB

def convert_orderbook(orderbook):
    """Converts the order book to a dictionary."""
    return {
        'bids': {str(k): str(v) for k, v in orderbook["bids"]},
        'asks': {str(k): str(v) for k, v in orderbook["asks"]},
        "timestamp": time.time()
    }

class OrderBookRedisStore:
    CHANNEL_PREFIX = "updates:orderbook"  # Channel prefix for Pub/Sub
    INDEX_CHANNEL_PREFIX = "updates:index"  # Channel prefix for Index Pub/Sub
    
    def __init__(self, host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB):
        self.redis_client = redis.StrictRedis(host=host, port=port, db=db)
        self.redis_client.flushdb()
        
    def store_orderbook(self, exchange, symbol, orderbook):
        key = f"orderbook:{exchange}:{symbol}"
        channel = f"{self.CHANNEL_PREFIX}:{exchange}:{symbol}"
        converted_orderbook = convert_orderbook(orderbook)
        serialized_data = json.dumps(converted_orderbook)
        # print(f"\n[DEBUG] Publishing to channel: {channel}")
        # print(f"[DEBUG] Data being published: {serialized_data}")
        # Store data and publish update
        self.redis_client.set(key, serialized_data)
        result = self.redis_client.publish(channel, serialized_data)
        # print(f"[DEBUG] Publish result (number of clients received): {result}")
        # Verify data was stored
        stored_data = self.redis_client.get(key)
        # print(f"[DEBUG] Stored data in Redis: {stored_data}\n")
    
    def get_orderbook(self, exchange, symbol):
        key = f"orderbook:{exchange}:{symbol}"
        data = self.redis_client.get(key)
        if data:
            return json.loads(data)
        else:
            return None

    def subscribe_to_orderbook(self, exchange, symbol, callback):
        """
        Subscribe to orderbook updates for a specific exchange and symbol.
        callback: function that will be called with the updated orderbook data
        """
        channel = f"{self.CHANNEL_PREFIX}:{exchange}:{symbol}"
        pubsub = self.redis_client.pubsub()
        pubsub.subscribe(**{channel: lambda message: callback(json.loads(message['data']))})
        pubsub.run_in_thread(daemon=True)
        return pubsub

    def store_index(self, exchange, symbol, index_data):
        """
        Store index price data in Redis and publish update
        """
        key = f"index:{exchange}:{symbol}"
        channel = f"{self.INDEX_CHANNEL_PREFIX}:{exchange}:{symbol}"
        serialized_data = json.dumps(index_data)
        
        # Store data and publish update
        self.redis_client.set(key, serialized_data)
        self.redis_client.publish(channel, serialized_data)
        
        # Verify data was stored
        stored_data = self.redis_client.get(key)
        if not stored_data:
            raise Exception(f"Failed to store index data for {exchange}:{symbol}")

    def get_index(self, exchange, symbol):
        """
        Retrieve index price data for a specific exchange and symbol
        """
        key = f"index:{exchange}:{symbol}"
        data = self.redis_client.get(key)
        if data:
            return json.loads(data)
        return None

    def subscribe_to_index(self, exchange, symbol, callback):
        """
        Subscribe to index price updates for a specific exchange and symbol.
        callback: function that will be called with the updated index data
        """
        channel = f"{self.INDEX_CHANNEL_PREFIX}:{exchange}:{symbol}"
        pubsub = self.redis_client.pubsub()
        pubsub.subscribe(**{channel: lambda message: callback(json.loads(message['data']))})
        pubsub.run_in_thread(daemon=True)
        return pubsub