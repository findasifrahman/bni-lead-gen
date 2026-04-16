from __future__ import annotations

import logging
from pathlib import Path

from playwright.async_api import Page

from .auth import ensure_authenticated
from .browser import BrowserManager
from .config import Settings
from .exporters import write_csv, write_json
from .models import CategoryRecord
from .search_page import dump_page_debug, first_visible, open_filters
from .selectors import CATEGORY_MENU_OPTIONS, SEARCH_CATEGORY_INPUT
from .utils import clean_text, humanize_category_label, unique_by_key


async def _discover_categories(page: Page, logger: logging.Logger) -> list[CategoryRecord]:
    from .search_page import find_search_filter_input

    await open_filters(page)
    category_input = await find_search_filter_input(page, SEARCH_CATEGORY_INPUT, "Category")
    if not category_input:
        raise RuntimeError("Category input not found on search page")

    await category_input.click()
    await page.wait_for_timeout(1500)

    categories: list[CategoryRecord] = []
    for css in CATEGORY_MENU_OPTIONS.css:
        locator = page.locator(css)
        try:
            count = await locator.count()
        except Exception:  # noqa: BLE001
            continue

        for idx in range(count):
            option = locator.nth(idx)
            text = clean_text(await option.text_content())
            if not text:
                continue
            categories.append(CategoryRecord(label=humanize_category_label(text), raw={"selector": css}))

    categories = unique_by_key(categories, key_fn=lambda item: item.label.lower())
    logger.info("Discovered %s unique categories", len(categories))
    return categories


async def run_category_discovery(settings: Settings, logger: logging.Logger) -> list[CategoryRecord]:
    async with BrowserManager(settings, logger) as manager:
        page = await manager.new_page()
        await ensure_authenticated(page, settings, logger)
        await manager.save_storage_state()
        try:
            categories = await _discover_categories(page, logger)
        except Exception:
            await dump_page_debug(page, settings.debug_dir / "categories_page_failure.html")
            raise
        await manager.save_storage_state()

        csv_path = settings.output_dir / "categories.csv"
        json_path = settings.output_dir / "categories.json"
        debug_html = settings.debug_dir / "categories_page.html"
        await dump_page_debug(page, debug_html)

        rows = [item.to_dict() for item in categories]
        write_csv(csv_path, rows)
        write_json(json_path, rows)
        logger.info("Saved categories to %s and %s", csv_path, json_path)
        return categories


async def ensure_categories_available(settings: Settings, logger: logging.Logger) -> list[CategoryRecord]:
    json_path = settings.output_dir / "categories.json"
    if json_path.exists() and json_path.stat().st_size > 0:
        import json

        data = json.loads(json_path.read_text(encoding="utf-8"))
        return [CategoryRecord(label=humanize_category_label(row.get("label", "")), value=clean_text(row.get("value", "")), raw=row.get("raw", {})) for row in data]
    return await run_category_discovery(settings, logger)
