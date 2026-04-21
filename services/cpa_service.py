from __future__ import annotations

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from typing import Any

from curl_cffi.requests import Session

from services.config import DATA_DIR, config


CPA_CONFIG_FILE = DATA_DIR / "cpa_config.json"
CPA_CACHE_TTL_SECONDS = 300


def _new_pool_id() -> str:
    return uuid.uuid4().hex[:12]


def _normalize_pool(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(raw.get("id") or _new_pool_id()).strip(),
        "name": str(raw.get("name") or "").strip(),
        "base_url": str(raw.get("base_url") or "").strip(),
        "secret_key": str(raw.get("secret_key") or "").strip(),
        "enabled": bool(raw.get("enabled", True)),
    }


def _is_pool_usable(pool: dict[str, Any]) -> bool:
    return bool(pool.get("enabled") and pool.get("base_url") and pool.get("secret_key"))


def _management_headers(secret_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {secret_key}",
        "Accept": "application/json",
    }


def _extract_access_token(auth_file: dict[str, Any]) -> str | None:
    for key in ("access_token", "token", "accessToken", "access-token"):
        value = str(auth_file.get(key) or "").strip()
        if value:
            return value

    for wrapper_key in ("data", "content", "credential", "auth", "credentials"):
        nested = auth_file.get(wrapper_key)
        if isinstance(nested, dict):
            for key in ("access_token", "token", "accessToken", "access-token"):
                value = str(nested.get(key) or "").strip()
                if value:
                    return value

    for value in auth_file.values():
        if isinstance(value, str):
            cleaned_value = value.strip()
            if cleaned_value.startswith("eyJ") and len(cleaned_value) > 100:
                return cleaned_value

    return None


def _resolve_file_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("files", "auth_files", "auth-files", "data", "items"):
            candidate = payload.get(key)
            if isinstance(candidate, list):
                return [item for item in candidate if isinstance(item, dict)]
        return [payload]
    return []


class CPAConfig:
    def __init__(self, store_file):
        self._store_file = store_file
        self._lock = Lock()
        self._pools = self._load()

    def _load(self) -> list[dict[str, Any]]:
        if not self._store_file.exists():
            return []

        try:
            raw = json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return []

        if isinstance(raw, dict) and "base_url" in raw:
            pool = _normalize_pool(raw)
            return [pool] if pool["base_url"] else []

        if isinstance(raw, list):
            return [_normalize_pool(item) for item in raw if isinstance(item, dict)]

        return []

    def _save(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        self._store_file.write_text(
            json.dumps(self._pools, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def list_pools(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(pool) for pool in self._pools]

    def get_pool(self, pool_id: str) -> dict[str, Any] | None:
        with self._lock:
            for pool in self._pools:
                if pool["id"] == pool_id:
                    return dict(pool)
        return None

    def add_pool(self, name: str, base_url: str, secret_key: str, enabled: bool = True) -> dict[str, Any]:
        pool = _normalize_pool(
            {
                "id": _new_pool_id(),
                "name": name,
                "base_url": base_url,
                "secret_key": secret_key,
                "enabled": enabled,
            }
        )
        with self._lock:
            self._pools.append(pool)
            self._save()
        return dict(pool)

    def update_pool(self, pool_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            for index, pool in enumerate(self._pools):
                if pool["id"] != pool_id:
                    continue
                merged = {**pool, **{key: value for key, value in updates.items() if value is not None}, "id": pool_id}
                self._pools[index] = _normalize_pool(merged)
                self._save()
                return dict(self._pools[index])
        return None

    def delete_pool(self, pool_id: str) -> bool:
        with self._lock:
            before = len(self._pools)
            self._pools = [pool for pool in self._pools if pool["id"] != pool_id]
            if len(self._pools) == before:
                return False
            self._save()
            return True

    def usable_pools(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(pool) for pool in self._pools if _is_pool_usable(pool)]

    @property
    def has_usable(self) -> bool:
        with self._lock:
            return any(_is_pool_usable(pool) for pool in self._pools)


def _fetch_file_detail(session: Session, base_url: str, secret_key: str, file_name: str) -> dict[str, Any] | None:
    try:
        response = session.get(
            f"{base_url.rstrip('/')}/v0/management/auth-files/download",
            headers=_management_headers(secret_key),
            params={"name": file_name},
            timeout=15,
        )
        if not response.ok:
            return None
        payload = response.json()
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def fetch_tokens_for_pool(pool: dict[str, Any]) -> list[str]:
    base_url = str(pool.get("base_url") or "").strip()
    secret_key = str(pool.get("secret_key") or "").strip()
    if not base_url or not secret_key:
        return []

    pool_name = str(pool.get("name") or pool.get("id") or "?").strip() or "?"
    session = Session(verify=bool(getattr(config, "tls_verify", True)))
    try:
        response = session.get(
            f"{base_url.rstrip('/')}/v0/management/auth-files",
            headers=_management_headers(secret_key),
            timeout=30,
        )
        if not response.ok:
            print(f"[cpa-service] [{pool_name}] HTTP {response.status_code}")
            return []
        payload = response.json()
        file_entries = _resolve_file_list(payload)
        active_entries = [
            entry
            for entry in file_entries
            if not entry.get("disabled")
            and not entry.get("unavailable")
            and entry.get("status") in (None, "", "active")
            and entry.get("type") in (None, "", "codex")
        ]

        tokens: list[str] = []
        seen: set[str] = set()
        pending_downloads: list[dict[str, Any]] = []

        for entry in active_entries:
            token = _extract_access_token(entry)
            if token and token not in seen:
                seen.add(token)
                tokens.append(token)
            else:
                pending_downloads.append(entry)

        if pending_downloads:
            max_workers = min(10, len(pending_downloads))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_map = {}
                for entry in pending_downloads:
                    file_name = str(entry.get("name") or entry.get("id") or "").strip()
                    if file_name:
                        future_map[executor.submit(_fetch_file_detail, session, base_url, secret_key, file_name)] = file_name

                for future in as_completed(future_map):
                    detail = future.result()
                    if detail is None:
                        continue
                    content = detail.get("content")
                    if isinstance(content, str):
                        try:
                            parsed = json.loads(content)
                        except Exception:
                            parsed = None
                        if isinstance(parsed, dict):
                            detail = {**detail, **parsed}
                    token = _extract_access_token(detail)
                    if token and token not in seen:
                        seen.add(token)
                        tokens.append(token)

        print(f"[cpa-service] [{pool_name}] extracted {len(tokens)} token(s)")
        return tokens
    except Exception as exc:
        print(f"[cpa-service] [{pool_name}] error: {exc}")
        return []
    finally:
        session.close()


def fetch_pool_status(pool: dict[str, Any]) -> dict[str, Any]:
    tokens = fetch_tokens_for_pool(pool)
    return {"pool_id": pool["id"], "tokens": len(tokens)}


class CPAService:
    def __init__(self, cpa_config: CPAConfig):
        self._config = cpa_config
        self._lock = Lock()
        self._tokens: list[str] = []
        self._index = 0
        self._last_refresh = 0.0

    @property
    def enabled(self) -> bool:
        return self._config.has_usable

    def fetch_all_tokens(self) -> list[str]:
        pools = self._config.usable_pools()
        if not pools:
            return []

        tokens: list[str] = []
        seen: set[str] = set()
        max_workers = min(5, len(pools))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(fetch_tokens_for_pool, pool): pool for pool in pools}
            for future in as_completed(future_map):
                try:
                    for token in future.result():
                        if token not in seen:
                            seen.add(token)
                            tokens.append(token)
                except Exception as exc:
                    pool = future_map[future]
                    print(f"[cpa-service] pool {pool.get('name', pool.get('id'))} error: {exc}")

        print(f"[cpa-service] total {len(tokens)} token(s) from {len(pools)} pool(s)")
        return tokens

    def get_token(self, excluded_tokens: set[str] | None = None) -> str | None:
        with self._lock:
            now = time.time()
            if not self._tokens or (now - self._last_refresh) > CPA_CACHE_TTL_SECONDS:
                self._tokens = self.fetch_all_tokens()
                self._last_refresh = now
                if self._tokens:
                    self._index = 0

            excluded = {token for token in (excluded_tokens or set()) if token}
            available = [token for token in self._tokens if token not in excluded]
            if not available:
                return None

            token = available[self._index % len(available)]
            self._index += 1
            return token

    def invalidate_cache(self) -> None:
        with self._lock:
            self._last_refresh = 0


cpa_config = CPAConfig(CPA_CONFIG_FILE)
cpa_service = CPAService(cpa_config)
