import asyncio
from unittest.mock import patch

from trading_engine_python import main as main_module


class _FakeClientError(Exception):
    def __init__(self, message: str, error_code: int):
        super().__init__(message)
        self.error_code = error_code


def test_classify_startup_error_marks_invalid_binance_credentials_as_fatal():
    error = _FakeClientError(
        "(401, -2015, 'Invalid API-key, IP, or permissions for action, request ip: 79.127.224.106', {})",
        -2015,
    )

    message, exit_code, include_traceback = main_module._classify_startup_error(error)

    assert exit_code == main_module.EXIT_FATAL_STARTUP
    assert include_traceback is False
    assert "Binance rejected the API credentials" in message
    assert "79.127.224.106" in message


def test_classify_startup_error_marks_one_way_requirement_as_fatal():
    message, exit_code, include_traceback = main_module._classify_startup_error(
        RuntimeError(
            "Binance position mode must be one-way (dualSidePosition=false) "
            "for the net-position virtual model."
        )
    )

    assert exit_code == main_module.EXIT_FATAL_STARTUP
    assert include_traceback is False
    assert "one-way mode" in message


def test_cleanup_tolerates_missing_resources():
    asyncio.run(main_module._cleanup(None, None, None, None))


def test_parent_watchdog_sets_shutdown_when_parent_changes():
    async def run():
        shutdown_event = asyncio.Event()
        with patch("trading_engine_python.main.os.getppid", side_effect=[100, 200]):
            await main_module._parent_watchdog(shutdown_event, parent_pid=100, interval=0)
        assert shutdown_event.is_set()

    asyncio.run(run())
