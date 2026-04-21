from __future__ import annotations

from services.utils import (
    extract_chat_prompt_and_images,
    extract_generation_images,
    extract_response_prompt_and_images,
)


PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+W9QAAAAASUVORK5CYII="
)


def test_extract_generation_images_from_data_url() -> None:
    images = extract_generation_images(
        {
            "images": [
                {
                    "name": "reference.png",
                    "image_url": PNG_DATA_URL,
                }
            ]
        },
        require_image=True,
    )

    assert len(images) == 1
    image = images[0]
    assert image.name == "reference.png"
    assert image.mime_type == "image/png"
    assert image.width == 1
    assert image.height == 1
    assert image.size_bytes > 0


def test_extract_chat_prompt_and_images() -> None:
    prompt, images = extract_chat_prompt_and_images(
        {
            "model": "gpt-image-1",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "把它改成油画风格"},
                        {"type": "image_url", "image_url": {"url": PNG_DATA_URL}},
                    ],
                }
            ],
        }
    )

    assert prompt == "把它改成油画风格"
    assert len(images) == 1
    assert images[0].mime_type == "image/png"


def test_extract_response_prompt_and_images() -> None:
    prompt, images = extract_response_prompt_and_images(
        [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "保留构图，改成插画"},
                    {"type": "input_image", "image_url": PNG_DATA_URL},
                ],
            }
        ]
    )

    assert prompt == "保留构图，改成插画"
    assert len(images) == 1
    assert images[0].mime_type == "image/png"
