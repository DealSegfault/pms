from exchanges.exchange_base import ExchangeBase
import json
import time
from decimal import Decimal
import asyncio
import aiohttp
from collections import deque
from exchanges.reddis_store import OrderBookRedisStore
from exchanges.exceptions import FeedCorrupted

class BinanceFutures(ExchangeBase):
    def __init__(self, symbol):
        # Convert symbol to lowercase for Binance requirements
        formatted_symbol = symbol.replace('USDT', 'usdt').lower()
        formatted_symbol = symbol.replace('USDC', 'usdc').lower()

        super().__init__(formatted_symbol)
        
        # Basic state tracking
        self.snapshot_received = False
        self.last_update_time = None
        self.last_update_id = None
        self.last_heartbeat_time = time.time()
        
        # Configuration
        self.HEARTBEAT_INTERVAL = 10  # seconds
        self.QUEUE_SIZE = 1000  # Maximum number of updates to queue
        
        # Initialize Redis store and queue
        self.redis_store = OrderBookRedisStore()
        self.update_queue = asyncio.Queue(maxsize=self.QUEUE_SIZE)
        
        # Set up logging
        self.logger.setLevel('WARNING')
        
        # Start the queue processor
        self.queue_processor_task = None

         # New buffer for updates
        self.update_buffer = deque()
        self.buffer_size_limit = 5000  # Maximum number of updates to buffer
        
        # Sequence mismatch tracking
        self.sequence_mismatch_count = 0
        self.MAX_SEQUENCE_MISMATCHES = 20  # Threshold for considering feed corrupted
        
        # Flag to track initial warm-up phase
        self.is_warmed_up = False

    def get_websocket_url(self):
        """
        Format the WebSocket URL according to Binance Futures requirements
        {symbol}@depth@100ms means real-time depth updates with 100ms frequency
        """
        return f"wss://fstream.binance.com/ws/{self.symbol}@depth@100ms"

    async def start_queue_processor(self):
        """Start the queue processor if it's not already running"""
        if not self.queue_processor_task or self.queue_processor_task.done():
            self.queue_processor_task = asyncio.create_task(self.process_queue())

    async def process_queue(self):
        """Continuously process updates from the queue"""
        while True:
            try:
                data = await self.update_queue.get()
                await self.process_orderbook_update(data)
                self.update_queue.task_done()
                
                # Short sleep to allow other tasks to run
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error processing queue item: {e}")
                await asyncio.sleep(1)  # Wait before retrying on error

    async def on_message(self, message):
        """Handle incoming websocket messages"""
        try:
            data = json.loads(message)
            
            if 'e' in data and data['e'] == 'depthUpdate':
                if not self.snapshot_received:
                    # Buffer updates and use sliding buffer logic
                    if len(self.update_buffer) >= self.buffer_size_limit:
                        self.update_buffer.popleft()  # Remove oldest update
                    self.update_buffer.append(data)
                    self.logger.debug(f"Buffered update for {self.symbol}: buffer size {len(self.update_buffer)}")
                    return
                
                # Process update if snapshot is received
                await self.process_orderbook_update(data)

        except json.JSONDecodeError as e:
            self.logger.error(f"JSON decode error: {e}")
        except Exception as e:
            self.logger.exception(f"Error in message handler: {e}")

    async def fetch_orderbook_snapshot(self):
        """Fetch the full orderbook snapshot from Binance REST API"""
        try:
            url = f"https://fapi.binance.com/fapi/v1/depth?symbol={self.symbol.upper()}&limit=100"
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as response:
                    snapshot = await response.json()
                    # Populate the order book with snapshot data
                    for bid in snapshot.get('bids', []):
                        self.orderbook.update('bid', Decimal(bid[0]), Decimal(bid[1]))
                    for ask in snapshot.get('asks', []):
                        self.orderbook.update('ask', Decimal(ask[0]), Decimal(ask[1]))
                    self.last_update_id = snapshot['lastUpdateId']
                    self.snapshot_received = True
                    self.logger.info(f"Snapshot fetched for {self.symbol}")
                     # Replay buffered updates in batches
                    while self.update_buffer:
                        batch = [self.update_buffer.popleft() for _ in range(min(100, len(self.update_buffer)))]
                        for data in batch:
                            await self.process_orderbook_update(data)
        except Exception as e:
            self.logger.error(f"Error fetching orderbook snapshot: {e}")
            raise

    async def process_orderbook_update(self, data):
        """Process a single orderbook update"""
        try:
            # Ignore updates until the snapshot is received
            if not self.snapshot_received:
                self.logger.warning(f"Received update before snapshot for {self.symbol}")
                return

            # Warm up the orderbook
            if self.last_update_id is None:
                self.last_update_id = data['u']
                return
                
            # Validate the update sequence
            if data['pu'] != self.last_update_id:
                # Special handling for the first update after initialization
                if not self.is_warmed_up:
                    self.logger.info(f"Initial sequence mismatch during warm-up for {self.symbol}. Expected {self.last_update_id}, got {data['pu']}. Ignoring as this is normal during initialization.")
                    self.last_update_id = data['u']
                    self.is_warmed_up = True  # Mark as warmed up after processing first update
                    return
                    
                self.sequence_mismatch_count += 1
                self.logger.warning(f"Out-of-sequence update detected for {self.symbol}. Expected {self.last_update_id}, got {data['pu']}. Mismatches: {self.sequence_mismatch_count}/{self.MAX_SEQUENCE_MISMATCHES}")
                
                # Only raise exception if we've seen too many consecutive mismatches
                if self.sequence_mismatch_count >= self.MAX_SEQUENCE_MISMATCHES:
                    raise FeedCorrupted(f"Too many sequence mismatches for {self.symbol} ({self.sequence_mismatch_count})")
                
                # Use the new sequence ID to try to recover
                self.last_update_id = data['u']
                return
            else:
                # If this is our first good update, mark as warmed up
                if not self.is_warmed_up:
                    self.is_warmed_up = True
                    
                # Reset mismatch counter when we get a good update
                if self.sequence_mismatch_count > 0:
                    self.logger.info(f"Sequence recovered for {self.symbol} after {self.sequence_mismatch_count} mismatches")
                    self.sequence_mismatch_count = 0

            # Apply incremental updates
            for bid in data.get('b', []):
                price = Decimal(bid[0])
                quantity = Decimal(bid[1])
                self.orderbook.update('bid', price, quantity)
            for ask in data.get('a', []):
                price = Decimal(ask[0])
                quantity = Decimal(ask[1])
                self.orderbook.update('ask', price, quantity)

            # Update the last update ID
            self.last_update_id = data['u']
            self.last_update_time = time.time()

            # Validate orderbook state
            best_bid, _ = self.orderbook.get_best_bid()
            best_ask, _ = self.orderbook.get_best_ask()
            if best_bid and best_ask and best_bid >= best_ask:
                self.logger.warning(f"Invalid orderbook state detected for {self.symbol}, bid={best_bid}, ask={best_ask}")
                
                # For minor crossed books, just skip storing this update but don't crash the feed
                if (best_bid - best_ask) / best_ask > 0.005:  # Only consider severely crossed books (>0.5%) as fatal
                    raise FeedCorrupted(f"Severely crossed book detected for {self.symbol}: bid={best_bid}, ask={best_ask}")
                return  # Skip this update but continue processing

            # Store in Redis
            self.redis_store.store_orderbook('binance', self.symbol.upper(), {
                'bids': list(self.orderbook.bids.items()),
                'asks': list(self.orderbook.asks.items())
            })

        except FeedCorrupted:
            # Re-raise FeedCorrupted exceptions to trigger supervision
            raise
        except Exception as e:
            self.logger.exception(f"Error processing orderbook update: {e}")
            raise FeedCorrupted(f"Failed to process update: {e}")

    async def on_open(self):
        """Handle websocket connection open"""
        self.logger.info(f"Binance WebSocket connection opened for {self.symbol}")
        await self.fetch_orderbook_snapshot()  # Start fetching snapshot immediately
        # Start the queue processor when connection opens
        await self.start_queue_processor()

    async def send_heartbeat(self):
        """Send heartbeat ping"""
        try:
            await self.ws.ping()
            self.last_heartbeat_time = time.time()
        except Exception as e:
            self.logger.error(f"Error sending heartbeat: {e}")

    async def close(self):
        """Clean up resources when closing"""
        # Cancel queue processor
        if self.queue_processor_task:
            self.queue_processor_task.cancel()
            try:
                await self.queue_processor_task
            except asyncio.CancelledError:
                pass
        
        # Close websocket connection
        await super().close()

    async def run(self):
        """Main execution method that runs until an error occurs"""
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._watchdog())
            tg.create_task(self._process_messages())
            tg.create_task(self._send_periodic_heartbeats())
    
    async def _watchdog(self):
        """Monitor the health of the feed and raise exceptions when unhealthy"""
        stale_update_count = 0
        missed_heartbeat_count = 0
        MAX_STALE_UPDATES = 3  # Only raise after multiple consecutive checks
        MAX_MISSED_HEARTBEATS = 2  # Allow for some heartbeat misses

        while True:
            await asyncio.sleep(3)
            now = time.time()
            
            # Check for stale updates - with tolerance
            if self.last_update_time and now - self.last_update_time > 5:
                stale_update_count += 1
                self.logger.warning(f"No updates received for {self.symbol} in {now - self.last_update_time:.1f} seconds (count: {stale_update_count}/{MAX_STALE_UPDATES})")
                if stale_update_count >= MAX_STALE_UPDATES:
                    raise FeedCorrupted(f"No updates received for {self.symbol} in {now - self.last_update_time:.1f} seconds")
            else:
                stale_update_count = 0  # Reset counter if we get updates
            
            # Check for missed heartbeats - with tolerance
            if now - self.last_heartbeat_time > self.HEARTBEAT_INTERVAL * 2:
                missed_heartbeat_count += 1
                self.logger.warning(f"Missed heartbeat for {self.symbol}, last was {now - self.last_heartbeat_time:.1f} seconds ago (count: {missed_heartbeat_count}/{MAX_MISSED_HEARTBEATS})")
                if missed_heartbeat_count >= MAX_MISSED_HEARTBEATS:
                    raise FeedCorrupted(f"Missed multiple heartbeats for {self.symbol}")
            else:
                missed_heartbeat_count = 0  # Reset counter if we get heartbeats

    async def _process_messages(self):
        """Process messages from the websocket - called by run()"""
        async for message in self.ws:
            await self.on_message(message)

    async def _send_periodic_heartbeats(self):
        """Send periodic pings to keep the connection alive"""
        while True:
            try:
                # Send ping every HEARTBEAT_INTERVAL/2 seconds to avoid timeouts
                await asyncio.sleep(self.HEARTBEAT_INTERVAL / 2)
                if self.ws and self.is_connected:
                    await self.ws.ping()
                    self.last_heartbeat_time = time.time()
                    self.logger.debug(f"Sent heartbeat ping for {self.symbol}")
            except Exception as e:
                self.logger.warning(f"Failed to send heartbeat: {e}")
                # Don't raise here, let the watchdog handle it if the connection is truly dead