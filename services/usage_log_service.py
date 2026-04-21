from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any


MAX_RETAIN = 2000


class UsageLogService:
    """Persisted ring-buffer log of image-generation attempts.

    KISS: single JSON file, no DB. Entries are append-only up to MAX_RETAIN;
    older items drop off the front.
    """

    def __init__(self, store_file: Path, max_retain: int = MAX_RETAIN):
        self.store_file = store_file
        self._max_retain = max(1, int(max_retain))
        self._lock = Lock()
        self._logs = self._load()

    @staticmethod
    def _clean(value: Any) -> str:
        return str(value or "").strip()

    @staticmethod
    def _mask_token(token: str) -> str:
        token = str(token or "").strip()
        if not token:
            return "—"
        if len(token) <= 18:
            return token
        return f"{token[:12]}...{token[-6:]}"

    def _load(self) -> list[dict[str, Any]]:
        if not self.store_file.exists():
            return []
        try:
            data = json.loads(self.store_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    def _save(self) -> None:
        self.store_file.parent.mkdir(parents=True, exist_ok=True)
        self.store_file.write_text(
            json.dumps(self._logs, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def append(
        self,
        *,
        access_token: str,
        source: str,
        model: str,
        prompt: str,
        success: bool,
        duration_ms: int,
        error: str | None = None,
        account_email: str | None = None,
        account_type: str | None = None,
        upstream_model: str | None = None,
        has_reference_image: bool = False,
    ) -> dict[str, Any]:
        entry = {
            "id": uuid.uuid4().hex[:16],
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "token_mask": self._mask_token(access_token),
            "source": self._clean(source) or "pool",
            "model": self._clean(model) or "gpt-image-1",
            "upstream_model": self._clean(upstream_model) or None,
            "prompt": self._clean(prompt)[:500],
            "success": bool(success),
            "duration_ms": int(max(0, duration_ms)),
            "error": self._clean(error) or None if not success else None,
            "account_email": self._clean(account_email) or None,
            "account_type": self._clean(account_type) or None,
            "has_reference_image": bool(has_reference_image),
        }
        with self._lock:
            self._logs.append(entry)
            overflow = len(self._logs) - self._max_retain
            if overflow > 0:
                self._logs = self._logs[overflow:]
            self._save()
        return dict(entry)

    def list_logs(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        status: str | None = None,
        source: str | None = None,
        query: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(500, int(limit or 100)))
        offset = max(0, int(offset or 0))
        status = (status or "").strip().lower()
        source_filter = (source or "").strip().lower()
        keyword = (query or "").strip().lower()

        with self._lock:
            ordered = list(reversed(self._logs))

        filtered = []
        for item in ordered:
            if status == "success" and not item.get("success"):
                continue
            if status == "fail" and item.get("success"):
                continue
            if source_filter and self._clean(item.get("source")).lower() != source_filter:
                continue
            if keyword:
                haystack = " ".join(
                    [
                        self._clean(item.get("prompt")),
                        self._clean(item.get("token_mask")),
                        self._clean(item.get("account_email")),
                        self._clean(item.get("error")),
                    ]
                ).lower()
                if keyword not in haystack:
                    continue
            filtered.append(item)

        total = len(filtered)
        window = filtered[offset : offset + limit]

        summary = self._summarize(ordered)
        return {
            "items": window,
            "total": total,
            "limit": limit,
            "offset": offset,
            "summary": summary,
        }

    def _summarize(self, ordered: list[dict[str, Any]]) -> dict[str, int]:
        total = len(ordered)
        success = sum(1 for item in ordered if item.get("success"))
        fail = total - success
        return {"total": total, "success": success, "fail": fail}

    def clear(self) -> int:
        with self._lock:
            removed = len(self._logs)
            self._logs = []
            self._save()
        return removed


def _resolve_store_file() -> Path:
    from services.config import DATA_DIR

    return DATA_DIR / "usage_logs.json"


usage_log_service = UsageLogService(_resolve_store_file())
