# Exchange API credentials
#You can enable or disable exchange by commenting or uncommenting the line
EXCHANGE_FORMATS = {
    'Binance': "{ticker}USDT",   # Binance format: "btcusdt", "ethusdt", etc.
}

MYTICKERS = ["BTC", "ETH"]  # You can extend this array with more tickers


def build_trading_pairs(tickers, exchange_formats):
    trading_pairs = {}
    for exchange, ticker_formats in exchange_formats.items():
        # Ensure ticker_formats is a list
        if isinstance(ticker_formats, str):
            ticker_formats = [ticker_formats]
        
        pairs = []
        for tformat in ticker_formats:
            pairs.extend([tformat.format(ticker=t) for t in tickers])
        trading_pairs[exchange] = pairs
    
    return trading_pairs

# Generate trading pairs dynamically
# TRADING_PAIRS = build_trading_pairs(MYTICKERS, EXCHANGE_FORMATS)
# Generate trading pairs dynamically
TRADING_PAIRS = build_trading_pairs(MYTICKERS, EXCHANGE_FORMATS)
