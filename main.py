from __future__ import annotations

import argparse
import asyncio
import csv
import json
from pathlib import Path
import sys

try:
    from src.category_discovery import run_category_discovery
    from src.config import load_settings
    from src.logger import setup_logging
    from src.member_indexer import run_index_category
    from src.merge import merge_country_profiles
    from src.profile_scraper import run_scrape_category, run_test_profile
except ModuleNotFoundError as exc:
    if exc.name == "playwright" or (exc.name and exc.name.startswith("playwright")):
        sys.stderr.write(
            "Missing Python dependency: playwright.\n"
            "Install the scraper environment with:\n"
            "  python3 -m venv .venv\n"
            "  . .venv/bin/activate\n"
            "  pip install -r requirements.txt\n"
            "  python -m playwright install chromium\n"
            "Then point PYTHON_BIN to the virtualenv python, for example:\n"
            "  PYTHON_BIN=/opt/bni-lead-gen/.venv/bin/python\n"
        )
        raise SystemExit(1) from exc
    raise

ZERO_WIDTH_CHARS = {
    "\u200b",
    "\u200c",
    "\u200d",
    "\u2060",
    "\ufeff",
}


def strip_zero_width(value):
    if isinstance(value, str):
        return "".join(char for char in value if char not in ZERO_WIDTH_CHARS)
    if isinstance(value, list):
        return [strip_zero_width(item) for item in value]
    if isinstance(value, dict):
        return {key: strip_zero_width(item) for key, item in value.items()}
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BNI Connect Global scraper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list-categories", help="Discover and export all categories")

    index_parser = subparsers.add_parser("index-category", help="Index members for one category")
    index_parser.add_argument("--country", help="Country filter")
    index_parser.add_argument("--category", help="Category filter")
    index_parser.add_argument("--keyword", default="", help="Keyword filter")

    test_parser = subparsers.add_parser("test-profile", help="Scrape one profile for debugging")
    test_parser.add_argument("--country", help="Country filter")
    test_parser.add_argument("--category", help="Category filter")
    test_parser.add_argument("--keyword", default="", help="Keyword filter")

    scrape_parser = subparsers.add_parser("scrape-category", help="Scrape all profiles for one category")
    scrape_parser.add_argument("--country", help="Country filter")
    scrape_parser.add_argument("--category", help="Category filter")
    scrape_parser.add_argument("--keyword", default="", help="Keyword filter")
    scrape_parser.add_argument(
        "--resume-mode",
        choices=["start-from-last", "start-new"],
        default="start-from-last",
        help="Resume previous scraper state or start fresh for this target",
    )

    country_parser = subparsers.add_parser("scrape-country", help="Scrape all categories for one country")
    country_parser.add_argument("--country", help="Country filter")
    country_parser.add_argument("--keyword", default="", help="Keyword filter")
    country_parser.add_argument(
        "--resume-mode",
        choices=["start-from-last", "start-new"],
        default="start-from-last",
        help="Resume previous country-wide scraper state or start fresh",
    )

    export_parser = subparsers.add_parser("export-csv-rows", help="Export CSV rows as JSON for database persistence")
    export_parser.add_argument("--input", required=True, help="Path to a CSV file to export")

    return parser


async def async_main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    settings = load_settings()
    logger = setup_logging()

    if args.command == "list-categories":
        await run_category_discovery(settings, logger)
        return 0

    if args.command == "export-csv-rows":
        input_path = Path(args.input)
        if not input_path.exists() or input_path.stat().st_size == 0:
            sys.stdout.buffer.write(b"[]")
            return 0
        with input_path.open("r", newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        payload = json.dumps(strip_zero_width(rows), ensure_ascii=False)
        sys.stdout.buffer.write(payload.encode("utf-8"))
        return 0

    country = args.country or settings.target_country
    if not country:
        parser.error("Country must be provided with --country or set TARGET_COUNTRY")

    if args.command == "index-category":
        category = args.category or settings.target_category or ""
        await run_index_category(settings, logger, country=country, category=category, keyword=args.keyword or "")
        return 0

    if args.command == "test-profile":
        category = args.category or settings.target_category or ""
        await run_test_profile(settings, logger, country=country, category=category, keyword=args.keyword or "")
        return 0

    if args.command == "scrape-category":
        category = args.category or settings.target_category
        if not category:
            await run_scrape_category(
                settings,
                logger,
                country=country,
                category="",
                keyword=args.keyword or "",
                resume_mode=args.resume_mode,
            )
            return 0
        await run_scrape_category(
            settings,
            logger,
            country=country,
            category=category,
            keyword=args.keyword or "",
            resume_mode=args.resume_mode,
        )
        return 0

    if args.command == "scrape-country":
        await run_scrape_category(
            settings,
            logger,
            country=country,
            category="",
            keyword=args.keyword or "",
            resume_mode=args.resume_mode,
        )
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 1


def main() -> int:
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
