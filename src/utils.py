from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import random
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, TypeVar
from urllib.parse import parse_qs, urljoin, urlparse


T = TypeVar("T")


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned or "unknown"


def parse_uuid_from_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    query_uuid = parse_qs(parsed.query).get("uuid", [""])[0]
    if query_uuid:
        return query_uuid
    match = re.search(r"/member/([a-fA-F0-9-]{8,})", parsed.path)
    if match:
        return match.group(1)
    return ""


def ensure_absolute_url(base_url: str, maybe_relative: str) -> str:
    if not maybe_relative:
        return ""
    return urljoin(base_url, maybe_relative)


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def normalize_for_match(value: str) -> str:
    value = clean_text(value).lower()
    value = value.replace("&", "and")
    value = re.sub(r"[^a-z0-9]+", "", value)
    return value


def humanize_category_label(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    value = re.sub(r"([a-z&])([A-Z])", r"\1 \2", value)
    value = re.sub(r"([a-z])(\()", r"\1 \2", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def format_category_for_ui(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    if "(" in value and ")" in value:
        return humanize_category_label(value)

    split_match = re.match(r"^(.*[a-z])([A-Z].*)$", value)
    if not split_match:
        return humanize_category_label(value)

    left = humanize_category_label(split_match.group(1))
    right = humanize_category_label(split_match.group(2))
    if not left or not right:
        return humanize_category_label(value)
    return f"{left} ({right})"


def normalize_phone(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    value = re.sub(r"[^\d+()/\-\s]", "", value)
    return re.sub(r"\s{2,}", " ", value).strip()


def normalize_website(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    if value.startswith(("http://", "https://")):
        return value
    if "." in value:
        return f"https://{value}"
    return value


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


async def random_delay(min_seconds: float, max_seconds: float) -> None:
    await asyncio.sleep(random.uniform(min_seconds, max_seconds))


async def retry_async(
    func: Callable[[], Awaitable[T]],
    retries: int = 3,
    delay_seconds: float = 1.0,
) -> T:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            return await func()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt == retries:
                break
            await asyncio.sleep(delay_seconds * attempt)
    raise last_error if last_error else RuntimeError("retry_async failed unexpectedly")


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def unique_by_key(items: Iterable[T], key_fn: Callable[[T], str]) -> list[T]:
    seen: set[str] = set()
    result: list[T] = []
    for item in items:
        key = key_fn(item)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def extract_first_email(text: str) -> str:
    match = re.search(r"([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})", text, re.I)
    return match.group(1) if match else ""


def extract_phone_candidates(text: str) -> list[str]:
    matches = re.findall(r"(\+?\d[\d()\-\s]{6,}\d)", text)
    cleaned = [normalize_phone(match) for match in matches]
    return [value for value in cleaned if value]


def looks_like_cloudflare_block(text: str) -> bool:
    lowered = clean_text(text).lower()
    indicators = [
        "checking your browser",
        "verify you are human",
        "attention required",
        "cloudflare",
        "sorry, you have been blocked",
        "please enable cookies",
    ]
    return any(item in lowered for item in indicators)


def safe_filename_from_parts(*parts: str, suffix: str = "") -> str:
    base = "_".join(slugify(part) for part in parts if part)
    return f"{base}{suffix}" if suffix else base
