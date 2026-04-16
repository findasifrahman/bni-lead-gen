from __future__ import annotations

from difflib import SequenceMatcher, get_close_matches
import logging
import re

from .category_discovery import ensure_categories_available
from .config import Settings
from .models import CategoryRecord


def _normalize_category_text(value: str) -> str:
    value = value.strip().lower()
    value = value.replace("&", " and ")
    value = re.sub(r"([a-z])([A-Z])", r"\1 \2", value)
    value = re.sub(r"(?<=\S)(advertising|branding|consultant|writer|content|marketing)", r" \1", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    value = re.sub(r"\bz\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _score_category(query: str, candidate: str) -> float:
    query_norm = _normalize_category_text(query)
    candidate_norm = _normalize_category_text(candidate)
    if query_norm == candidate_norm:
        return 1.0
    if query_norm and query_norm in candidate_norm:
        return 0.98
    if candidate_norm and candidate_norm in query_norm:
        return 0.96
    return SequenceMatcher(None, query_norm, candidate_norm).ratio()


async def resolve_category_name(
    settings: Settings,
    logger: logging.Logger,
    requested_category: str,
) -> str:
    categories = await ensure_categories_available(settings, logger)
    if not requested_category:
        raise ValueError("Category is required")

    exact_map = {_normalize_category_text(item.label): item.label for item in categories}
    requested_norm = _normalize_category_text(requested_category)
    if requested_norm in exact_map:
        resolved = exact_map[requested_norm]
        if resolved != requested_category:
            logger.info("Resolved category '%s' to discovered value '%s'", requested_category, resolved)
        return resolved

    scored = sorted(
        ((item.label, _score_category(requested_category, item.label)) for item in categories),
        key=lambda item: item[1],
        reverse=True,
    )
    best_label, best_score = scored[0]
    if best_score >= 0.72:
        logger.info(
            "Resolved category '%s' to closest discovered value '%s' (score %.3f)",
            requested_category,
            best_label,
            best_score,
        )
        return best_label

    suggestions = get_close_matches(
        requested_norm,
        [_normalize_category_text(item.label) for item in categories],
        n=5,
        cutoff=0.55,
    )
    raise ValueError(
        "Unable to resolve category "
        f"'{requested_category}'. Close matches: {suggestions or 'none'}"
    )
