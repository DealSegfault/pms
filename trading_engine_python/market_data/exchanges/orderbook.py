import sortedcontainers
from decimal import Decimal

class OrderBook:
    def __init__(self):
        self.bids = sortedcontainers.SortedDict(lambda x: -x)
        self.asks = sortedcontainers.SortedDict()

    def update(self, side, price, amount):
        book = self.bids if side == 'bid' else self.asks
        if amount == 0:
            book.pop(price, None)
        else:
           book[price] = Decimal(amount)
        # print(f"OrderBook updated: {side} {price} {amount}")  # Debug print

    def get_best_bid(self):
        return next(iter(self.bids.items())) if self.bids else (None, None)

    def get_best_ask(self):
        return next(iter(self.asks.items())) if self.asks else (None, None)

    def get_depth_price(self, side, depth_usd):
        book = self.bids if side == 'bid' else self.asks
        total_volume = 0
        for price, size in book.items():
            total_volume += Decimal(price) * Decimal(size)
            if total_volume >= depth_usd:
                return price
        return None

    def get_mean_price(self):
        best_bid, _ = self.get_best_bid()
        best_ask, _ = self.get_best_ask()
        if best_bid is None or best_ask is None:
            return None
        return (Decimal(best_bid) + Decimal(best_ask)) / Decimal('2')
