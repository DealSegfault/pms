import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from trading_engine_python.feeds.user_stream import UserStreamService


class _FakeWebSocketContext:
    def __init__(self):
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def close(self):
        self.closed = True


def test_user_stream_run_keeps_supervisor_alive_after_ws_error():
    async def run():
        service = UserStreamService(
            api_key="key",
            api_secret="secret",
            order_manager=SimpleNamespace(),
        )
        service._create_listen_key = lambda: "listen-key"
        service._init_state = AsyncMock()
        service._keepalive_loop = AsyncMock()
        service._handle_messages = AsyncMock(side_effect=RuntimeError("boom"))

        import trading_engine_python.feeds.user_stream as user_stream_mod
        original_websockets = user_stream_mod.websockets
        user_stream_mod.websockets = SimpleNamespace(connect=lambda url: _FakeWebSocketContext())
        try:
            service._running = True
            try:
                await service._run()
            except RuntimeError as exc:
                assert str(exc) == "boom"
            assert service._running is True
            assert service._ws_connected is False
        finally:
            user_stream_mod.websockets = original_websockets

    asyncio.run(run())
