import websockets
import json
import threading
import time
from exchanges.orderbook import OrderBook
import logging
import asyncio
from exchanges.exceptions import FeedCorrupted

class ExchangeBase:
    HEARTBEAT_INTERVAL = 30  # seconds
    MAX_RECONNECT_ATTEMPTS = 5
    RECONNECT_DELAY = 5  # seconds

    def __init__(self, symbol):
        self.symbol = symbol
        self.orderbook = OrderBook()
        self.ws = None
        self.is_connected = False
        self.ws_lock = threading.Lock()
        self.reconnect_attempts = 0
        self.should_reconnect = True
        
        # Initialize a logger for each exchange instance
        self.logger = logging.getLogger(f"{self.__class__.__name__}_{self.symbol}")
        self.logger.setLevel(logging.INFO)  # Set to DEBUG for detailed logs
        if not self.logger.hasHandlers():
            handler = logging.StreamHandler()
            formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)

    async def connect(self):
        try:
            url = self.get_websocket_url()
            self.ws = await websockets.connect(url)
            self.is_connected = True
            self.reconnect_attempts = 0  # Reset reconnection attempts on successful connection
            await self.on_open()
            await self.receive_messages()
        except Exception as e:
            self.is_connected = False
            # Don't log the full traceback
            self.logger.error(f"Failed to connect: {self.symbol} - {type(e).__name__}: {str(e)}")
            # Re-raise to let the supervisor handle it
            raise FeedCorrupted(f"Connection failed: {type(e).__name__}")

    async def handle_connection_failure(self):
        if self.reconnect_attempts < self.MAX_RECONNECT_ATTEMPTS:
            self.reconnect_attempts += 1
            delay = self.RECONNECT_DELAY * (2 ** (self.reconnect_attempts - 1))  # Exponential backoff
            self.logger.warning(f"Attempting to reconnect in {delay} seconds (attempt {self.reconnect_attempts})")
            await asyncio.sleep(delay)
            await self.connect()
        else:
            self.logger.error("Max reconnection attempts reached. Giving up.")
            self.should_reconnect = False

    async def receive_messages(self):
        while self.should_reconnect:
            try:
                async for message in self.ws:
                    await self.on_message(message)
            except websockets.ConnectionClosedError as e:
                self.is_connected = False
                # Log only the error type, not the full traceback
                self.logger.warning(f"WebSocket connection closed for {self.symbol}: {type(e).__name__}")
                await self.cleanup_connection()
                
                # Instead of trying to reconnect here, propagate the error to the supervisor
                raise FeedCorrupted(f"WebSocket connection closed: {type(e).__name__}")
                
            except websockets.ConnectionClosedOK:
                self.is_connected = False
                self.logger.info(f"WebSocket connection closed normally for {self.symbol}")
                await self.cleanup_connection()
                
                # Normal close, still raise to allow supervisor to restart if needed
                raise FeedCorrupted("WebSocket connection closed normally")
                
            except Exception as e:
                self.is_connected = False
                # Log the exception type and message but not the full traceback
                self.logger.error(f"Error receiving messages for {self.symbol}: {type(e).__name__}: {str(e)}")
                await self.cleanup_connection()
                
                # Propagate the error to the supervisor
                raise FeedCorrupted(f"WebSocket error: {type(e).__name__}")

    async def cleanup_connection(self):
        """Clean up the existing connection before attempting to reconnect"""
        self.is_connected = False
        try:
            await self.ws.close()
        except:
            pass  # Ignore errors during cleanup

    def get_websocket_url(self):
        raise NotImplementedError("Subclass must implement abstract method")

    async def on_open(self):
        raise NotImplementedError("Subclass must implement abstract method")

    async def on_message(self, message):
        raise NotImplementedError("Subclass must implement abstract method")

    def on_error(self, ws, error):
        self.logger.error(f"{self.__class__.__name__} WebSocket error: {error}")

    async def close(self):
        self.should_reconnect = False
        self.is_connected = False
        if self.ws:
            await self.ws.close()
        self.logger.info(f"WebSocket connection closed for {self.symbol}")

    def process_orderbook_update(self, data):
        raise NotImplementedError("Subclass must implement abstract method")

    async def run(self):
        """
        Main execution method that runs until an error occurs.
        Subclasses should override this to implement feed-specific logic.
        This method should block until a fatal error occurs.
        """
        raise NotImplementedError("Subclasses must implement run()")