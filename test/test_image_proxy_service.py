from __future__ import annotations

from pathlib import Path

import services.image_proxy_service as image_proxy_service


def test_proxy_store_persists_registered_refs(tmp_path: Path) -> None:
    store_path = tmp_path / "public_image_refs.json"
    store = image_proxy_service._ProxyImageStore(store_path, max_retain=10)

    image_id = store.register(
        image_proxy_service.ProxyImageRef(
            access_token="token-123",
            device_id="device-123",
            conversation_id="conv_123",
            file_id="file_123",
        )
    )

    reloaded = image_proxy_service._ProxyImageStore(store_path, max_retain=10)
    item = reloaded.get(image_id)

    assert item is not None
    assert item.access_token == "token-123"
    assert item.device_id == "device-123"
    assert item.conversation_id == "conv_123"
    assert item.file_id == "file_123"


def test_proxy_store_keeps_only_recent_refs(tmp_path: Path) -> None:
    store_path = tmp_path / "public_image_refs.json"
    store = image_proxy_service._ProxyImageStore(store_path, max_retain=2)

    first = store.register(
        image_proxy_service.ProxyImageRef(
            access_token="token-1",
            device_id="device-1",
            conversation_id="conv-1",
            file_id="file-1",
        )
    )
    second = store.register(
        image_proxy_service.ProxyImageRef(
            access_token="token-2",
            device_id="device-2",
            conversation_id="conv-2",
            file_id="file-2",
        )
    )
    third = store.register(
        image_proxy_service.ProxyImageRef(
            access_token="token-3",
            device_id="device-3",
            conversation_id="conv-3",
            file_id="file-3",
        )
    )

    reloaded = image_proxy_service._ProxyImageStore(store_path, max_retain=2)

    assert reloaded.get(first) is None
    assert reloaded.get(second) is not None
    assert reloaded.get(third) is not None
