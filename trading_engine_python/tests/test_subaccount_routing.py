import asyncio
from unittest.mock import AsyncMock, MagicMock

from trading_engine_python.orders.manager import OrderManager
from trading_engine_python.orders.state import (
    derive_legacy_routing_prefix,
    derive_routing_prefix,
    generate_client_order_id,
)


def test_derive_routing_prefix_is_stable_and_longer_than_uuid_slice():
    sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"

    prefix = derive_routing_prefix(sub_account_id)

    assert prefix == derive_routing_prefix(sub_account_id)
    assert len(prefix) == 12
    assert prefix != sub_account_id[:8]
    assert prefix.isalnum()
    assert prefix.lower() == prefix


def test_generate_client_order_id_uses_routing_prefix():
    sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"

    client_order_id = generate_client_order_id(sub_account_id, "LMT")

    assert client_order_id.startswith(f"PMS{derive_routing_prefix(sub_account_id)}_LMT_")
    assert len(client_order_id) <= 36


def test_resolve_sub_account_prefers_book_routing_prefix():
    sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"
    prefix = derive_routing_prefix(sub_account_id)

    risk = MagicMock()
    risk.position_book = None
    risk._book = MagicMock()
    risk._book._entries = {sub_account_id: {}}
    risk._book.get_account.return_value = {"routingPrefix": prefix}

    manager = OrderManager(exchange_client=MagicMock(), redis_client=MagicMock(), risk_engine=risk)

    assert manager._resolve_sub_account(prefix) == sub_account_id
    assert manager._sub_account_cache[prefix] == sub_account_id


def test_resolve_sub_account_async_scans_active_accounts_for_routing_prefix():
    async def run():
        sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"
        prefix = derive_routing_prefix(sub_account_id)
        db = MagicMock()
        db.fetch_all = AsyncMock(return_value=[
            {
                "id": "other-account-id",
                "status": "ACTIVE",
            },
            {
                "id": sub_account_id,
                "status": "ACTIVE",
            },
        ])
        manager = OrderManager(exchange_client=MagicMock(), redis_client=MagicMock(), db=db)

        resolved = await manager._resolve_sub_account_async(prefix)

        assert resolved == sub_account_id
        assert manager._sub_account_cache[prefix] == sub_account_id
        db.fetch_all.assert_awaited_once_with(
            "SELECT * FROM sub_accounts WHERE status = ?",
            ("ACTIVE",),
        )

    asyncio.run(run())


def test_set_managed_accounts_clears_ignored_prefixes_and_resolution_cache():
    manager = OrderManager(exchange_client=MagicMock(), redis_client=MagicMock())
    manager._ignored_prefixes.add("deadbeefcafe")
    manager._sub_account_cache["feedfacebeef"] = "sub-1"

    manager.set_managed_accounts({"sub-2"})

    assert manager._ignored_prefixes == set()
    assert manager._sub_account_cache == {}


def test_resolve_sub_account_accepts_legacy_uuid_slice_prefix():
    sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"
    legacy_prefix = derive_legacy_routing_prefix(sub_account_id)

    risk = MagicMock()
    risk.position_book = None
    risk._book = MagicMock()
    risk._book._entries = {sub_account_id: {}}
    risk._book.get_account.return_value = {"routingPrefix": derive_routing_prefix(sub_account_id)}

    manager = OrderManager(exchange_client=MagicMock(), redis_client=MagicMock(), risk_engine=risk)

    assert manager._resolve_sub_account(legacy_prefix) == sub_account_id
