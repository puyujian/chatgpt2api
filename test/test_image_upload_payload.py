from __future__ import annotations

from services.image_service import _upload_input_image
from services.utils import InputImage


class _FakeResponse:
    def __init__(self, *, ok: bool = True, payload: dict | None = None, text: str = "", status_code: int = 200):
        self.ok = ok
        self._payload = payload or {}
        self.text = text
        self.status_code = status_code

    def json(self) -> dict:
        return self._payload


class _FakeSession:
    def __init__(self) -> None:
        self.post_calls: list[tuple[str, dict]] = []
        self.put_calls: list[tuple[str, bytes, dict]] = []

    def post(self, url: str, *, headers: dict, json: dict, timeout: int):
        self.post_calls.append((url, json))
        if url.endswith("/backend-api/files"):
            return _FakeResponse(payload={"file_id": "file_123", "upload_url": "https://upload.example.com/file_123"})
        if url.endswith("/backend-api/files/process_upload_stream"):
            return _FakeResponse(payload={"ok": True})
        raise AssertionError(f"unexpected post url: {url}")

    def put(self, url: str, *, headers: dict, data: bytes, timeout: int):
        self.put_calls.append((url, data, headers))
        return _FakeResponse()


def test_upload_input_image_includes_index_for_retrieval() -> None:
    session = _FakeSession()
    image = InputImage(
        name="source.png",
        mime_type="image/png",
        data=b"fake-image-bytes",
        width=128,
        height=128,
    )

    uploaded = _upload_input_image(session, "token", "device-id", image)

    assert uploaded.file_id == "file_123"
    assert len(session.post_calls) == 2
    assert session.post_calls[0][1]["reset_rate_limits"] is False
    assert session.post_calls[1][1]["index_for_retrieval"] is False
    assert session.put_calls[0][0] == "https://upload.example.com/file_123"
