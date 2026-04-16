from __future__ import annotations

import csv
import logging
from pathlib import Path
import shutil

from .category_discovery import ensure_categories_available
from .config import Settings
from .member_indexer import run_index_category
from .profile_scraper import run_scrape_category
from .resume import ResumeState
from .utils import slugify


def merge_profile_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        key = row.get("uuid") or row.get("profile_url") or ""
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(row)
    return merged


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open("r", newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


async def merge_country_profiles(
    settings: Settings,
    logger: logging.Logger,
    country: str,
    scrape_missing: bool = False,
    resume_mode: str = "start-from-last",
) -> Path:
    categories = await ensure_categories_available(settings, logger)
    country_slug = slugify(country)
    country_dir = settings.output_dir / country_slug
    country_resume_path = country_dir / "country_resume.json"

    if resume_mode == "start-new" and country_dir.exists():
        shutil.rmtree(country_dir)
        logger.info("Cleared prior country output for fresh start: %s", country_dir)

    country_dir.mkdir(parents=True, exist_ok=True)
    country_resume = ResumeState.load(country_resume_path)

    if scrape_missing:
        total_categories = len(categories)
        logger.info("Bulk country mode active for %s: %s categories queued", country, total_categories)
        for index, category in enumerate(categories, start=1):
            category_key = category.label.strip().lower()
            if resume_mode == "start-from-last" and country_resume.is_done(category_key):
                logger.info(
                    "Skipping previously completed country category %s/%s: %s",
                    index,
                    total_categories,
                    category.label,
                )
                continue
            logger.info(
                "Country bulk category %s/%s: %s",
                index,
                total_categories,
                category.label,
            )
            try:
                records = await run_index_category(settings, logger, country=country, category=category.label)
                if not records:
                    logger.info("Skipping category with zero members: %s", category.label)
                    country_resume.mark_done(category_key)
                    country_resume.save(country_resume_path)
                    continue
                await run_scrape_category(
                    settings,
                    logger,
                    country=country,
                    category=category.label,
                    resume_mode=resume_mode,
                )
                country_resume.mark_done(category_key)
                country_resume.save(country_resume_path)
                logger.info(
                    "Finished country bulk category %s/%s: %s",
                    index,
                    total_categories,
                    category.label,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Category processing failed for %s: %s", category.label, exc)
                continue

    all_rows: list[dict[str, str]] = []
    for csv_path in country_dir.glob("*/profiles.csv"):
        all_rows.extend(read_csv_rows(csv_path))

    deduped = merge_profile_rows(all_rows)
    if settings.max_country_profiles > 0:
        deduped = deduped[: settings.max_country_profiles]
    output_path = country_dir / "all_categories_profiles.csv"
    final_output_path = country_dir / "final_profiles.csv"
    if deduped:
        with output_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(deduped[0].keys()))
            writer.writeheader()
            writer.writerows(deduped)
        with final_output_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(deduped[0].keys()))
            writer.writeheader()
            writer.writerows(deduped)
    else:
        output_path.write_text("", encoding="utf-8")
        final_output_path.write_text("", encoding="utf-8")

    logger.info("Merged %s profile rows into %s and %s", len(deduped), output_path, final_output_path)
    return final_output_path
