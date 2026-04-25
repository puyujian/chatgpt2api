from __future__ import annotations

import json
from contextlib import asynccontextmanager
from json import JSONDecodeError
from pathlib import Path
from threading import Event, Thread

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from services.account_service import account_service
from services.chatgpt_service import ChatGPTService
from services.config import config
from services.cpa_service import cpa_config, cpa_service, fetch_pool_status, fetch_tokens_for_pool
from services.image_proxy_service import fetch_public_image
from services.image_service import ImageGenerationError
from services.image_task_service import ImageTaskService
from services.usage_log_service import usage_log_service
from services.utils import InputImage, build_input_image_from_bytes
from services.version import get_app_version

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"
IMAGE_FORM_FIELD_NAMES = {"image", "images", "image[]", "images[]"}
MASK_FORM_FIELD_NAMES = {"mask", "mask[]"}


class ImageGenerationRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-1"
    n: int = Field(default=1, ge=1, le=4)
    response_format: str = "b64_json"
    history_disabled: bool = True
    image: object | None = None
    images: list[object] | None = None


class ImageTaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    task_id: str | None = None
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-1"
    n: int = Field(default=1, ge=1, le=10)
    response_format: str = "b64_json"
    image: object | None = None
    images: list[object] | None = None


class AccountCreateRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class AccountDeleteRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class AccountRefreshRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)


class AccountUpdateRequest(BaseModel):
    access_token: str = Field(default="")
    type: str | None = None
    status: str | None = None
    quota: int | None = None


class CPAPoolCreateRequest(BaseModel):
    name: str = ""
    base_url: str = ""
    secret_key: str = ""
    enabled: bool = True


class CPAPoolUpdateRequest(BaseModel):
    name: str | None = None
    base_url: str | None = None
    secret_key: str | None = None
    enabled: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


def build_model_item(model_id: str) -> dict[str, object]:
    return {
        "id": model_id,
        "object": "model",
        "created": 0,
        "owned_by": "chatgpt2api",
    }


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def require_auth_key(authorization: str | None) -> None:
    if extract_bearer_token(authorization) != str(config.auth_key or "").strip():
        raise HTTPException(status_code=401, detail={"error": "authorization is invalid"})


def _sanitize_validation_value(value: object) -> object:
    if isinstance(value, bytes):
        preview = value[:32].hex()
        suffix = "..." if len(value) > 32 else ""
        return f"<bytes len={len(value)} hex={preview}{suffix}>"
    if isinstance(value, bytearray):
        return _sanitize_validation_value(bytes(value))
    if isinstance(value, dict):
        return {str(key): _sanitize_validation_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_validation_value(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_validation_value(item) for item in value]
    return value


def sanitize_validation_errors(errors: list[object]) -> list[object]:
    return [_sanitize_validation_value(error) for error in errors]


def _encode_sse(data: str) -> bytes:
    return f"data: {data}\n\n".encode("utf-8")


def _iter_text_chunks(text: str, *, chunk_size: int = 4096):
    normalized = str(text or "")
    if not normalized:
        return
    for start in range(0, len(normalized), chunk_size):
        yield normalized[start : start + chunk_size]


def _build_chat_completion_stream_response(payload: dict[str, object]) -> StreamingResponse:
    completion_id = str(payload.get("id") or "")
    created = int(payload.get("created") or 0)
    model = str(payload.get("model") or "")

    message: dict[str, object] = {}
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        candidate_message = choices[0].get("message")
        if isinstance(candidate_message, dict):
            message = candidate_message

    content = str(message.get("content") or "")
    image_items = message.get("images")
    image_count = len(image_items) if isinstance(image_items, list) else 0
    print(f"[chat-completion] stream success model={model} images={image_count}")

    async def event_stream():
        yield _encode_sse(
            json.dumps(
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant"},
                            "finish_reason": None,
                        }
                    ],
                },
                ensure_ascii=False,
            )
        )
        for part in _iter_text_chunks(content):
            yield _encode_sse(
                json.dumps(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": part},
                                "finish_reason": None,
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
            )
        yield _encode_sse(
            json.dumps(
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": "stop",
                        }
                    ],
                },
                ensure_ascii=False,
            )
        )
        yield _encode_sse("[DONE]")

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _is_upload_file(value: object) -> bool:
    return isinstance(value, UploadFile) or (
        hasattr(value, "filename")
        and callable(getattr(value, "read", None))
    )


async def _upload_file_to_input_image(upload: UploadFile) -> InputImage:
    data = await upload.read()
    return build_input_image_from_bytes(
        data,
        declared_mime_type=upload.content_type,
        name=upload.filename,
        source="local",
    )


async def parse_image_generation_request(request: Request) -> dict[str, object]:
    content_type = str(request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        body: dict[str, object] = {}
        input_images: list[InputImage] = []
        string_images: list[object] = []

        for key, value in form.multi_items():
            normalized_key = str(key or "").strip().lower()
            if normalized_key in MASK_FORM_FIELD_NAMES:
                raise HTTPException(status_code=400, detail={"error": "mask is not supported"})

            if normalized_key in IMAGE_FORM_FIELD_NAMES:
                if _is_upload_file(value):
                    input_images.append(await _upload_file_to_input_image(value))
                else:
                    normalized = str(value or "").strip()
                    if normalized:
                        string_images.append(normalized)
                continue

            if _is_upload_file(value):
                raise HTTPException(status_code=400, detail={"error": f"unsupported file field: {key}"})

            body[str(key)] = str(value)

        if string_images:
            body["images"] = string_images
        try:
            validated = ImageGenerationRequest.model_validate(body).model_dump(mode="python")
        except ValidationError as exc:
            raise RequestValidationError(exc.errors()) from exc
        if input_images:
            validated["_input_images"] = input_images
        return validated

    try:
        payload = await request.json()
    except JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid json body"}) from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail={"error": "request body must be an object"})

    try:
        return ImageGenerationRequest.model_validate(payload).model_dump(mode="python")
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc


def start_limited_account_watcher(stop_event: Event) -> Thread:
    interval_seconds = config.refresh_account_interval_minute * 60

    def worker() -> None:
        while not stop_event.is_set():
            try:
                limited_tokens = account_service.list_limited_tokens()
                if limited_tokens:
                    print(f"[account-limited-watcher] checking {len(limited_tokens)} limited accounts")
                    account_service.refresh_accounts(limited_tokens)
            except Exception as exc:
                print(f"[account-limited-watcher] fail {exc}")
            stop_event.wait(interval_seconds)

    thread = Thread(target=worker, name="limited-account-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None

    clean_path = requested_path.strip("/")
    if not clean_path:
        candidates = [WEB_DIST_DIR / "index.html"]
    else:
        relative_path = Path(clean_path)
        candidates = [WEB_DIST_DIR / relative_path, WEB_DIST_DIR / relative_path / "index.html", WEB_DIST_DIR / f"{clean_path}.html"]

    for candidate in candidates:
        try:
            candidate.relative_to(WEB_DIST_DIR)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate

    return None


def create_app() -> FastAPI:
    chatgpt_service = ChatGPTService(account_service)
    image_task_service = ImageTaskService(chatgpt_service)
    app_version = get_app_version()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        try:
            yield
        finally:
            image_task_service.shutdown()
            stop_event.set()
            thread.join(timeout=1)

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation_error(_, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={"detail": sanitize_validation_errors(exc.errors())},
        )

    router = APIRouter()

    @router.get("/v1/models")
    async def list_models():
        return {"object": "list", "data": [build_model_item("gpt-image-1"), build_model_item("gpt-image-2")]}

    @router.post("/auth/login")
    async def login(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"ok": True, "version": app_version}

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/accounts")
    async def get_accounts(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"items": account_service.list_accounts()}

    @router.post("/api/accounts")
    async def create_accounts(body: AccountCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        tokens = [str(token or "").strip() for token in body.tokens if str(token or "").strip()]
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "tokens is required"})
        result = account_service.add_accounts(tokens)
        refresh_result = account_service.refresh_accounts(tokens)
        return {**result, "refreshed": refresh_result.get("refreshed", 0), "errors": refresh_result.get("errors", []), "items": refresh_result.get("items", result.get("items", []))}

    @router.delete("/api/accounts")
    async def delete_accounts(body: AccountDeleteRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        tokens = [str(token or "").strip() for token in body.tokens if str(token or "").strip()]
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "tokens is required"})
        return account_service.delete_accounts(tokens)

    @router.post("/api/accounts/refresh")
    async def refresh_accounts(body: AccountRefreshRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        access_tokens = [str(token or "").strip() for token in body.access_tokens if str(token or "").strip()]
        if not access_tokens:
            access_tokens = account_service.list_tokens()
        if not access_tokens:
            raise HTTPException(status_code=400, detail={"error": "access_tokens is required"})
        return account_service.refresh_accounts(access_tokens)

    @router.post("/api/accounts/update")
    async def update_account(body: AccountUpdateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        access_token = str(body.access_token or "").strip()
        if not access_token:
            raise HTTPException(status_code=400, detail={"error": "access_token is required"})

        updates = {key: value for key, value in {"type": body.type, "status": body.status, "quota": body.quota}.items() if value is not None}
        if not updates:
            raise HTTPException(status_code=400, detail={"error": "no updates provided"})

        account = account_service.update_account(access_token, updates)
        if account is None:
            raise HTTPException(status_code=404, detail={"error": "account not found"})
        return {"item": account, "items": account_service.list_accounts()}

    @router.post("/api/image-tasks")
    async def create_image_task(body: ImageTaskCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        payload = body.model_dump(mode="python", exclude_none=True)
        task_id = payload.pop("task_id", None)
        return image_task_service.create_task(payload, task_id=task_id)

    @router.get("/api/image-tasks/{task_id}")
    async def get_image_task(task_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return image_task_service.get_task(task_id)

    @router.post("/v1/images/generations")
    async def generate_images(request: Request, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        body = await parse_image_generation_request(request)
        return await run_in_threadpool(chatgpt_service.create_image_generation, body)

    @router.post("/v1/images/edits")
    async def edit_images(request: Request, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        body = await parse_image_generation_request(request)
        return await run_in_threadpool(
            chatgpt_service.create_image_generation,
            body,
            require_input_images=True,
        )

    @router.post("/v1/chat/completions")
    async def create_chat_completion(
        body: ChatCompletionRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        payload = body.model_dump(mode="python")
        stream = bool(payload.get("stream"))
        completion = await run_in_threadpool(
            chatgpt_service.create_image_completion,
            payload,
            public_base_url=str(request.base_url),
        )
        if stream:
            return _build_chat_completion_stream_response(completion)
        return completion

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return await run_in_threadpool(chatgpt_service.create_response, body.model_dump(mode="python"))

    @router.get("/api/cpa/pools")
    async def list_cpa_pools(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"pools": cpa_config.list_pools()}

    @router.post("/api/cpa/pools")
    async def create_cpa_pool(body: CPAPoolCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        if not body.base_url.strip():
            raise HTTPException(status_code=400, detail={"error": "base_url is required"})
        if not body.secret_key.strip():
            raise HTTPException(status_code=400, detail={"error": "secret_key is required"})
        pool = cpa_config.add_pool(
            name=body.name,
            base_url=body.base_url,
            secret_key=body.secret_key,
            enabled=body.enabled,
        )
        cpa_service.invalidate_cache()
        return {"pool": pool, "pools": cpa_config.list_pools()}

    @router.post("/api/cpa/pools/{pool_id}")
    async def update_cpa_pool(
        pool_id: str,
        body: CPAPoolUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        pool = cpa_config.update_pool(pool_id, body.model_dump(exclude_none=True))
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        cpa_service.invalidate_cache()
        return {"pool": pool, "pools": cpa_config.list_pools()}

    @router.delete("/api/cpa/pools/{pool_id}")
    async def delete_cpa_pool(pool_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        if not cpa_config.delete_pool(pool_id):
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        cpa_service.invalidate_cache()
        return {"pools": cpa_config.list_pools()}

    @router.get("/api/cpa/pools/{pool_id}/status")
    async def cpa_pool_status(pool_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        pool = cpa_config.get_pool(pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        return await run_in_threadpool(fetch_pool_status, pool)

    @router.post("/api/cpa/pools/{pool_id}/sync")
    async def cpa_pool_sync(pool_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        pool = cpa_config.get_pool(pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        tokens = await run_in_threadpool(fetch_tokens_for_pool, pool)
        if not tokens:
            raise HTTPException(status_code=502, detail={"error": "No tokens returned from CPA"})
        result = account_service.add_accounts(tokens)
        refresh_result = account_service.refresh_accounts(tokens)
        return {
            **result,
            "refreshed": refresh_result.get("refreshed", 0),
            "errors": refresh_result.get("errors", []),
            "items": refresh_result.get("items", result.get("items", [])),
        }

    @router.get("/api/cpa/status")
    async def cpa_global_status(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        if not cpa_config.has_usable:
            return {"enabled": False, "pools": 0, "tokens": 0}
        tokens = await run_in_threadpool(cpa_service.fetch_all_tokens)
        return {"enabled": True, "pools": len(cpa_config.usable_pools()), "tokens": len(tokens)}

    @router.get("/api/usage-logs")
    async def list_usage_logs(
        authorization: str | None = Header(default=None),
        limit: int = 100,
        offset: int = 0,
        status: str | None = None,
        source: str | None = None,
        query: str | None = None,
    ):
        require_auth_key(authorization)
        return usage_log_service.list_logs(
            limit=limit,
            offset=offset,
            status=status,
            source=source,
            query=query,
        )

    @router.delete("/api/usage-logs")
    async def clear_usage_logs(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        removed = usage_log_service.clear()
        return {"removed": removed}

    @router.get("/public-images/{image_id}")
    async def get_public_image(image_id: str):
        try:
            result = await run_in_threadpool(fetch_public_image, image_id)
        except ImageGenerationError as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
        if result is None:
            raise HTTPException(status_code=404, detail={"error": "image link is unavailable"})
        content, content_type = result
        return Response(
            content=content,
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    app.include_router(router)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)

        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")

        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
