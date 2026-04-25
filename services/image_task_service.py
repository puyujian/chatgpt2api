from __future__ import annotations

import copy
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Lock
from typing import Literal

from fastapi import HTTPException

from services.chatgpt_service import ChatGPTService


ImageTaskStatus = Literal["queued", "generating", "success", "error"]
ImageTaskItemStatus = Literal["loading", "success", "error"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_task_id(value: object) -> str:
    raw_value = str(value or "").strip()
    if raw_value and len(raw_value) <= 100 and all(ch.isalnum() or ch in "-_:" for ch in raw_value):
        return raw_value
    return uuid.uuid4().hex


def _exception_message(exc: BaseException) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            message = detail.get("error") or detail.get("message")
            if message:
                return str(message)
        if isinstance(detail, str) and detail:
            return detail
    return str(exc) or "生成图片失败"


@dataclass
class ImageTaskItem:
    id: str
    status: ImageTaskItemStatus = "loading"
    b64_json: str | None = None
    revised_prompt: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "id": self.id,
            "status": self.status,
        }
        if self.b64_json:
            data["b64_json"] = self.b64_json
        if self.revised_prompt:
            data["revised_prompt"] = self.revised_prompt
        if self.error:
            data["error"] = self.error
        return data


@dataclass
class ImageTask:
    id: str
    prompt: str
    model: str
    count: int
    request_body: dict[str, object]
    require_input_images: bool
    status: ImageTaskStatus = "queued"
    images: list[ImageTaskItem] = field(default_factory=list)
    error: str | None = None
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "id": self.id,
            "status": self.status,
            "prompt": self.prompt,
            "model": self.model,
            "count": self.count,
            "images": [image.to_dict() for image in self.images],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.error:
            data["error"] = self.error
        return data


class ImageTaskService:
    def __init__(
        self,
        chatgpt_service: ChatGPTService,
        *,
        max_workers: int = 4,
        max_tasks: int = 200,
    ) -> None:
        self._chatgpt_service = chatgpt_service
        self._executor = ThreadPoolExecutor(max_workers=max(1, max_workers), thread_name_prefix="image-task")
        self._max_tasks = max(1, max_tasks)
        self._lock = Lock()
        self._tasks: dict[str, ImageTask] = {}

    @staticmethod
    def _parse_count(raw_value: object) -> int:
        try:
            count = int(raw_value or 1)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail={"error": "n must be an integer"}) from exc
        if count < 1 or count > 10:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 10"})
        return count

    @staticmethod
    def _normalize_request_body(body: dict[str, object]) -> tuple[dict[str, object], str, str, int, bool]:
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})

        model = str(body.get("model") or "gpt-image-1").strip() or "gpt-image-1"
        count = ImageTaskService._parse_count(body.get("n"))
        response_format = str(body.get("response_format") or "b64_json").strip().lower() or "b64_json"
        if response_format != "b64_json":
            raise HTTPException(status_code=400, detail={"error": "background image tasks require b64_json"})

        request_body = copy.deepcopy(body)
        request_body["prompt"] = prompt
        request_body["model"] = model
        request_body["n"] = 1
        request_body["response_format"] = "b64_json"
        require_input_images = bool(request_body.get("image") or request_body.get("images"))
        return request_body, prompt, model, count, require_input_images

    def _prune_locked(self) -> None:
        overflow = len(self._tasks) - self._max_tasks
        if overflow <= 0:
            return
        removable_ids = [
            task.id
            for task in sorted(self._tasks.values(), key=lambda item: item.created_at)
            if task.status in {"success", "error"}
        ][:overflow]
        for task_id in removable_ids:
            self._tasks.pop(task_id, None)

    def create_task(self, body: dict[str, object], *, task_id: object | None = None) -> dict[str, object]:
        normalized_task_id = _normalize_task_id(task_id)
        request_body, prompt, model, count, require_input_images = self._normalize_request_body(body)

        with self._lock:
            existing = self._tasks.get(normalized_task_id)
            if existing is not None:
                return existing.to_dict()

            task = ImageTask(
                id=normalized_task_id,
                prompt=prompt,
                model=model,
                count=count,
                request_body=request_body,
                require_input_images=require_input_images,
                images=[
                    ImageTaskItem(id=f"{normalized_task_id}-{index}")
                    for index in range(count)
                ],
            )
            self._tasks[normalized_task_id] = task
            self._prune_locked()
            snapshot = task.to_dict()

        self._executor.submit(self._run_task, normalized_task_id)
        return snapshot

    def get_task(self, task_id: str) -> dict[str, object]:
        with self._lock:
            task = self._tasks.get(str(task_id or "").strip())
            if task is None:
                raise HTTPException(status_code=404, detail={"error": "image task not found"})
            return task.to_dict()

    def _set_task_status(self, task_id: str, status: ImageTaskStatus, error: str | None = None) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            task.status = status
            task.error = error
            task.updated_at = _now_iso()

    def _set_image_success(
        self,
        task_id: str,
        index: int,
        *,
        b64_json: str,
        revised_prompt: str | None,
    ) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or index >= len(task.images):
                return
            task.images[index].status = "success"
            task.images[index].b64_json = b64_json
            task.images[index].revised_prompt = revised_prompt
            task.images[index].error = None
            task.updated_at = _now_iso()

    def _set_image_error(self, task_id: str, index: int, error: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or index >= len(task.images):
                return
            task.images[index].status = "error"
            task.images[index].error = error
            task.updated_at = _now_iso()

    def _run_task(self, task_id: str) -> None:
        self._set_task_status(task_id, "generating")
        success_count = 0
        failure_count = 0
        last_error = ""

        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            count = task.count
            request_body = copy.deepcopy(task.request_body)
            require_input_images = task.require_input_images

        for index in range(count):
            try:
                result = self._chatgpt_service.create_image_generation(
                    copy.deepcopy(request_body),
                    require_input_images=require_input_images,
                )
                items = result.get("data") if isinstance(result, dict) else None
                first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else None
                b64_json = str(first.get("b64_json") or "").strip() if first else ""
                if not b64_json:
                    raise RuntimeError(f"第 {index + 1} 张没有返回图片数据")
                revised_prompt = str(first.get("revised_prompt") or "").strip() or None
                self._set_image_success(task_id, index, b64_json=b64_json, revised_prompt=revised_prompt)
                success_count += 1
            except Exception as exc:
                last_error = _exception_message(exc)
                self._set_image_error(task_id, index, last_error)
                failure_count += 1

        if failure_count:
            message = last_error if success_count == 0 else f"其中 {failure_count} 张生成失败"
            self._set_task_status(task_id, "error", message)
            return
        self._set_task_status(task_id, "success")

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)
