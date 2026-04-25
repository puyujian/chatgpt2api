from __future__ import annotations

import json
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from services.config import DATA_DIR
from services.image_service import fetch_generated_image_bytes

PUBLIC_IMAGE_REFS_FILE = DATA_DIR / "public_image_refs.json"
PUBLIC_IMAGE_REFS_MAX_RETAIN = 5000


@dataclass(frozen=True)
class ProxyImageRef:
    access_token: str
    device_id: str
    conversation_id: str
    file_id: str
    created_at: float = 0.0


class _ProxyImageStore:
    def __init__(self, store_file: Path, max_retain: int = PUBLIC_IMAGE_REFS_MAX_RETAIN) -> None:
        self._store_file = store_file
        self._max_retain = max(1, int(max_retain))
        self._lock = Lock()
        self._items = self._load()

    def _normalize_item(self, value: Any) -> ProxyImageRef | None:
        if not isinstance(value, dict):
            return None
        access_token = str(value.get("access_token") or "").strip()
        device_id = str(value.get("device_id") or "").strip()
        conversation_id = str(value.get("conversation_id") or "").strip()
        file_id = str(value.get("file_id") or "").strip()
        if not access_token or not device_id or not file_id:
            return None
        try:
            created_at = float(value.get("created_at") or 0.0)
        except (TypeError, ValueError):
            created_at = 0.0
        return ProxyImageRef(
            access_token=access_token,
            device_id=device_id,
            conversation_id=conversation_id,
            file_id=file_id,
            created_at=max(0.0, created_at),
        )

    def _load(self) -> OrderedDict[str, ProxyImageRef]:
        if not self._store_file.exists():
            return OrderedDict()
        try:
            raw = json.loads(self._store_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return OrderedDict()
        if not isinstance(raw, dict):
            return OrderedDict()

        items: OrderedDict[str, ProxyImageRef] = OrderedDict()
        for image_id, value in raw.items():
            clean_image_id = str(image_id or "").strip()
            item = self._normalize_item(value)
            if clean_image_id and item is not None:
                items[clean_image_id] = item
        while len(items) > self._max_retain:
            items.popitem(last=False)
        return items

    def _save_locked(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {image_id: asdict(item) for image_id, item in self._items.items()}
        self._store_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def register(self, ref: ProxyImageRef) -> str:
        image_id = uuid.uuid4().hex
        item = ProxyImageRef(
            access_token=ref.access_token,
            device_id=ref.device_id,
            conversation_id=ref.conversation_id,
            file_id=ref.file_id,
            created_at=time.time(),
        )
        with self._lock:
            self._items[image_id] = item
            while len(self._items) > self._max_retain:
                self._items.popitem(last=False)
            self._save_locked()
        return image_id

    def get(self, image_id: str) -> ProxyImageRef | None:
        clean_image_id = str(image_id or "").strip()
        if not clean_image_id:
            return None
        with self._lock:
            item = self._items.get(clean_image_id)
            return item


_proxy_store = _ProxyImageStore(PUBLIC_IMAGE_REFS_FILE)


def build_public_image_url(public_base_url: str, image_id: str) -> str:
    return f"{public_base_url.rstrip('/')}/public-images/{image_id}"


def register_public_image_ref(public_base_url: str, raw_ref: dict[str, object]) -> str | None:
    access_token = str(raw_ref.get("access_token") or "").strip()
    device_id = str(raw_ref.get("device_id") or "").strip()
    conversation_id = str(raw_ref.get("conversation_id") or "").strip()
    file_id = str(raw_ref.get("file_id") or "").strip()
    if not access_token or not device_id or not file_id:
        return None

    image_id = _proxy_store.register(
        ProxyImageRef(
            access_token=access_token,
            device_id=device_id,
            conversation_id=conversation_id,
            file_id=file_id,
        )
    )
    return build_public_image_url(public_base_url, image_id)


def fetch_public_image(image_id: str) -> tuple[bytes, str] | None:
    ref = _proxy_store.get(image_id)
    if ref is None:
        return None
    return fetch_generated_image_bytes(
        ref.access_token,
        ref.device_id,
        ref.conversation_id,
        ref.file_id,
    )
