from __future__ import annotations

import asyncio
import base64
import json
import time
from threading import Event

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from starlette.requests import Request

import services.api as api_module
from services.api import create_app, sanitize_validation_errors
from services.chatgpt_service import ChatGPTService
from services.config import config


PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+W9QAAAAASUVORK5CYII="
)


class _DummyThread:
    def join(self, timeout: float | None = None) -> None:
        return None


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.auth_key}"}


def _wait_for_image_task(client: TestClient, task_id: str) -> dict[str, object]:
    deadline = time.time() + 3
    payload: dict[str, object] = {}
    while time.time() < deadline:
        response = client.get(f"/api/image-tasks/{task_id}", headers=_auth_headers())
        assert response.status_code == 200
        payload = response.json()
        if payload["status"] in {"success", "error"}:
            return payload
        time.sleep(0.05)
    raise AssertionError(f"image task did not finish: {payload}")


def test_image_task_route_runs_generation_in_background(monkeypatch) -> None:
    gate = Event()
    calls: list[dict[str, object]] = []

    def fake_create_image_generation(self, body, *, require_input_images=False):
        calls.append(dict(body))
        gate.wait(timeout=2)
        return {
            "created": 10,
            "data": [
                {
                    "b64_json": f"ZmFrZQ{len(calls)}==",
                    "revised_prompt": body["prompt"],
                }
            ],
        }

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "create_image_generation", fake_create_image_generation)

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/image-tasks",
            headers=_auth_headers(),
            json={
                "task_id": "task-background",
                "prompt": "生成两张海报",
                "model": "gpt-image-2",
                "n": 2,
            },
        )

        assert response.status_code == 200
        created = response.json()
        assert created["id"] == "task-background"
        assert created["status"] == "queued"
        assert [image["status"] for image in created["images"]] == ["loading", "loading"]

        status_response = client.get("/api/image-tasks/task-background", headers=_auth_headers())
        assert status_response.status_code == 200
        assert status_response.json()["status"] in {"queued", "generating"}

        gate.set()
        payload = _wait_for_image_task(client, "task-background")

    assert payload["status"] == "success"
    assert [image["status"] for image in payload["images"]] == ["success", "success"]
    assert [call["n"] for call in calls] == [1, 1]
    assert calls[0]["model"] == "gpt-image-2"


def test_image_task_route_keeps_partial_failures(monkeypatch) -> None:
    calls = 0

    def fake_create_image_generation(self, body, *, require_input_images=False):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise HTTPException(status_code=502, detail={"error": "upstream failed"})
        return {
            "created": 10,
            "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": body["prompt"]}],
        }

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "create_image_generation", fake_create_image_generation)

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/image-tasks",
            headers=_auth_headers(),
            json={
                "task_id": "task-partial",
                "prompt": "生成两张海报",
                "n": 2,
            },
        )

        assert response.status_code == 200
        payload = _wait_for_image_task(client, "task-partial")

    assert payload["status"] == "error"
    assert payload["error"] == "其中 1 张生成失败"
    assert [image["status"] for image in payload["images"]] == ["success", "error"]
    assert payload["images"][1]["error"] == "upstream failed"


def test_images_edits_route_passes_reference_images(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["n"] = n
        captured["input_images"] = input_images or []
        return {"created": 1, "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": prompt}]}

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/images/edits",
            headers=_auth_headers(),
            json={
                "prompt": "把这张图改成电影质感",
                "model": "gpt-image-1",
                "images": [{"image_url": PNG_DATA_URL, "name": "source.png"}],
            },
        )

    assert response.status_code == 200
    assert captured["prompt"] == "把这张图改成电影质感"
    assert captured["model"] == "gpt-image-1"
    assert captured["n"] == 1
    assert len(captured["input_images"]) == 1


def test_images_edits_route_accepts_multipart_file(monkeypatch) -> None:
    captured: dict[str, object] = {}
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89"
        b"\x00\x00\x00\x0bIDATx\x9cc\xf8\xff\x1f\x00\x03\x03\x02\x00\xee\xfe[\xd4"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )

    def fake_generate_with_pool(self, prompt, model, n, input_images=None, response_format="b64_json"):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["n"] = n
        captured["input_images"] = input_images or []
        captured["response_format"] = response_format
        return {"created": 5, "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": prompt, "url": "https://example.com/image.png"}]}

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/images/edits",
            headers=_auth_headers(),
            data={
                "prompt": "保留主体，改成电影海报",
                "model": "gpt-image-2",
                "response_format": "url",
            },
            files=[("image", ("source.png", png_bytes, "image/png"))],
        )

    payload = response.json()
    assert response.status_code == 200
    assert captured["prompt"] == "保留主体，改成电影海报"
    assert captured["model"] == "gpt-image-2"
    assert captured["n"] == 1
    assert len(captured["input_images"]) == 1
    assert captured["response_format"] == "url"
    assert payload["data"][0]["url"] == "https://example.com/image.png"
    assert "b64_json" not in payload["data"][0]


def test_images_generation_route_honors_url_response_format(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None, response_format="b64_json"):
        captured["response_format"] = response_format
        return {
            "created": 6,
            "data": [
                {
                    "b64_json": "ZmFrZQ==",
                    "revised_prompt": prompt,
                    "url": "https://example.com/generated.png",
                }
            ],
        }

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/images/generations",
            headers=_auth_headers(),
            json={
                "prompt": "生成一张电影海报",
                "model": "gpt-image-2",
                "response_format": "url",
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert captured["response_format"] == "url"
    assert payload["data"][0]["url"] == "https://example.com/generated.png"
    assert "b64_json" not in payload["data"][0]


def test_chat_completions_accepts_image_inputs(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["input_images"] = input_images or []
        return {
            "created": 2,
            "data": [
                {
                    "b64_json": "ZmFrZQ==",
                    "revised_prompt": prompt,
                    "url": "https://example.com/image.png",
                }
            ],
        }

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "model": "gpt-image-1",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "参考这张图，改成漫画"},
                            {"type": "image_url", "image_url": {"url": PNG_DATA_URL}},
                        ],
                    }
                ],
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert captured["prompt"] == "参考这张图，改成漫画"
    assert captured["model"] == "gpt-image-1"
    assert len(captured["input_images"]) == 1
    assert payload["choices"][0]["message"]["images"][0]["b64_json"] == "ZmFrZQ=="
    assert payload["choices"][0]["message"]["images"][0]["url"] == "https://example.com/image.png"
    assert "https://example.com/image.png" in payload["choices"][0]["message"]["content"]


def test_chat_completions_streams_sse_for_image_requests(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["input_images"] = input_images or []
        return {
            "created": 7,
            "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": prompt, "url": "https://example.com/stream.png"}],
        }

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "model": "gpt-image-2",
                "stream": True,
                "size": "3:4",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "保留主体，改成电影海报"},
                            {"type": "image_url", "image_url": {"url": PNG_DATA_URL}},
                        ],
                    }
                ],
            },
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert captured["prompt"] == "保留主体，改成电影海报"
    assert captured["model"] == "gpt-image-2"
    assert len(captured["input_images"]) == 1
    events = [line.removeprefix("data: ") for line in response.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == "[DONE]"

    first_chunk = json.loads(events[0])
    assert first_chunk["model"] == "gpt-image-2"
    assert first_chunk["choices"][0]["delta"]["role"] == "assistant"

    content = "".join(
        json.loads(item)["choices"][0]["delta"].get("content", "")
        for item in events[1:-1]
        if item != "[DONE]"
    )
    assert "https://example.com/stream.png" in content

    finish_chunk = json.loads(events[-2])
    assert finish_chunk["choices"][0]["finish_reason"] == "stop"


def test_chat_completions_rewrites_images_to_public_proxy_url(monkeypatch) -> None:
    captured: dict[str, object] = {}
    png_bytes = base64.b64decode(PNG_DATA_URL.split(",", 1)[1])

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        return {
            "created": 8,
            "data": [
                {
                    "b64_json": "ZmFrZQ==",
                    "revised_prompt": prompt,
                    "url": "https://chatgpt.com/backend-api/estuary/content?id=file_123",
                    "_public_image_ref": {
                        "access_token": "token-123",
                        "device_id": "device-123",
                        "conversation_id": "conv_123",
                        "file_id": "file_123",
                        "download_url": "https://chatgpt.com/backend-api/estuary/content?id=file_123",
                    },
                }
            ],
        }

    def fake_fetch_public_image(image_id: str):
        captured["image_id"] = image_id
        return png_bytes, "image/png"

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)
    monkeypatch.setattr(api_module, "fetch_public_image", fake_fetch_public_image)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "model": "gpt-image-2",
                "messages": [
                    {
                        "role": "user",
                        "content": "猫猫",
                    }
                ],
            },
        )

        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        public_url = payload["choices"][0]["message"]["images"][0]["url"]
        image_response = client.get(public_url.removeprefix("http://testserver"))

    assert response.status_code == 200
    assert public_url.startswith("http://testserver/public-images/")
    assert public_url in content
    assert image_response.status_code == 200
    assert image_response.headers["content-type"] == "image/png"
    assert image_response.content == png_bytes
    assert captured["image_id"]


def test_chat_completions_accepts_non_image_model_when_message_has_image_inputs(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["input_images"] = input_images or []
        return {"created": 4, "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": prompt}]}

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/chat/completions",
            headers=_auth_headers(),
            json={
                "model": "gpt-4.1",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "按这张图的主体生成新海报"},
                            {"type": "image_url", "image_url": {"url": PNG_DATA_URL}},
                        ],
                    }
                ],
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert captured["prompt"] == "按这张图的主体生成新海报"
    assert captured["model"] == "gpt-image-1"
    assert len(captured["input_images"]) == 1
    assert payload["model"] == "gpt-4.1"
    assert payload["choices"][0]["message"]["images"][0]["b64_json"] == "ZmFrZQ=="


def test_responses_accepts_input_image(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_generate_with_pool(self, prompt, model, n, input_images=None):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["input_images"] = input_images or []
        return {"created": 3, "data": [{"b64_json": "ZmFrZQ==", "revised_prompt": prompt}]}

    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    monkeypatch.setattr(ChatGPTService, "generate_with_pool", fake_generate_with_pool)

    with TestClient(create_app()) as client:
        response = client.post(
            "/v1/responses",
            headers=_auth_headers(),
            json={
                "model": "gpt-5",
                "tools": [{"type": "image_generation"}],
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "让它更像海报"},
                            {"type": "input_image", "image_url": PNG_DATA_URL},
                        ],
                    }
                ],
            },
        )

    assert response.status_code == 200
    assert captured["prompt"] == "让它更像海报"
    assert captured["model"] == "gpt-image-1"
    assert len(captured["input_images"]) == 1


def test_sanitize_validation_errors_replaces_bytes() -> None:
    errors = sanitize_validation_errors(
        [
            {
                "type": "missing",
                "loc": ["body", "image"],
                "msg": "Field required",
                "input": b"\xff\xd8\xffbinary",
            }
        ]
    )

    assert errors[0]["input"] == "<bytes len=9 hex=ffd8ff62696e617279>"


def test_request_validation_error_handler_handles_binary_input(monkeypatch) -> None:
    monkeypatch.setattr(api_module, "start_limited_account_watcher", lambda stop_event: _DummyThread())
    app = create_app()

    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "path": "/v1/images/edits",
        "headers": [],
        "query_string": b"",
        "scheme": "http",
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }
    request = Request(scope)
    exc = RequestValidationError(
        [
            {
                "type": "missing",
                "loc": ("body", "image"),
                "msg": "Field required",
                "input": b"\xff\xd8\xffbinary",
            }
        ]
    )

    response = None
    for exception_class, handler in app.exception_handlers.items():
        if exception_class is RequestValidationError:
            response = asyncio.run(handler(request, exc))
            break

    assert response is not None
    assert response.status_code == 422
    assert b"<bytes len=9 hex=ffd8ff62696e617279>" in response.body
