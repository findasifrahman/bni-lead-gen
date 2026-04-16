from __future__ import annotations

import logging

from playwright.async_api import Locator, Page

from .auth import ensure_authenticated
from .browser import BrowserManager
from .category_resolver import resolve_category_name
from .config import Settings
from .exporters import write_csv, write_json
from .models import MemberIndexRecord
from .search_page import apply_filters, dump_page_debug, scroll_results_until_stable
from .selectors import RESULT_PROFILE_LINK
from .utils import (
    clean_text,
    ensure_absolute_url,
    format_category_for_ui,
    humanize_category_label,
    normalize_for_match,
    parse_uuid_from_url,
    safe_filename_from_parts,
    slugify,
    unique_by_key,
)


async def _extract_row_text(locator: Locator) -> str:
    try:
        return clean_text(await locator.inner_text())
    except Exception:  # noqa: BLE001
        return ""


async def _extract_profile_url(row: Locator, base_url: str) -> str:
    for css in RESULT_PROFILE_LINK.css:
        link = row.locator(css).first
        try:
            href = await link.get_attribute("href")
        except Exception:  # noqa: BLE001
            continue
        if href:
            return ensure_absolute_url(base_url, href)
    return ""


async def _extract_layout_rows(page: Page) -> list[list[str]]:
    rows = await page.evaluate(
        """() => {
            const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
            const isVisible = (el) => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const header = [...document.querySelectorAll("*")]
                .find((el) => clean(el.innerText) === "Search Results");
            const startY = header ? header.getBoundingClientRect().bottom + 5 : 180;
            const candidates = [];
            for (const el of document.querySelectorAll("a, button, span, p, div")) {
                if (!isVisible(el)) continue;
                const text = clean(el.innerText);
                if (!text) continue;
                const rect = el.getBoundingClientRect();
                if (rect.top < startY || rect.bottom > window.innerHeight + 20) continue;
                if (rect.left < 80) continue;
                candidates.push({
                    text,
                    x: rect.left,
                    y: rect.top + rect.height / 2,
                    width: rect.width,
                    height: rect.height,
                });
            }
            candidates.sort((a, b) => a.y - b.y || a.x - b.x);
            const groups = [];
            for (const item of candidates) {
                let group = groups.find((g) => Math.abs(g.y - item.y) <= 18);
                if (!group) {
                    group = { y: item.y, items: [] };
                    groups.push(group);
                }
                group.items.push(item);
            }
            const ignored = new Set(["Search Results", "Name", "Chapter", "Company", "City", "Profession and Specialty", "Connect"]);
            return groups
                .map((group) => {
                    const items = group.items
                        .sort((a, b) => a.x - b.x)
                        .filter((item, idx, arr) => {
                            if (ignored.has(item.text)) return false;
                            if (idx > 0 && item.text === arr[idx - 1].text && Math.abs(item.x - arr[idx - 1].x) < 6) return false;
                            return true;
                        });
                    const texts = items.map((item) => item.text);
                    return texts;
                })
                .filter((texts) => texts.length >= 4 && texts.some((text) => text.includes(">")));
        }"""
    )
    return [[clean_text(item) for item in row if clean_text(item)] for row in rows]


def _split_row_text(row_text: str) -> tuple[str, str, str, str]:
    parts = [part.strip() for part in row_text.split("\n") if clean_text(part)]
    name = parts[0] if parts else ""
    company = parts[1] if len(parts) > 1 else ""
    city = ""
    category_text = ""

    for part in parts[2:]:
        if not city and "," in part:
            city = part
            continue
        if not category_text:
            category_text = part
    return name, company, city, category_text


async def _get_row_cells(row: Locator) -> list[str]:
    for selector in ("td", '[role="cell"]'):
        cells = row.locator(selector)
        try:
            count = await cells.count()
        except Exception:  # noqa: BLE001
            continue
        if count == 0:
            continue
        values: list[str] = []
        for idx in range(count):
            values.append(clean_text(await cells.nth(idx).inner_text()))
        if any(values):
            return values
    return []


def _split_row_lines(row_text: str) -> list[str]:
    parts = [clean_text(part) for part in row_text.split("\n") if clean_text(part)]
    return [part for part in parts if part != "+"]


def _parse_row_parts(parts: list[str]) -> tuple[str, str, str, str]:
    name = parts[0] if len(parts) > 0 else ""
    company = parts[2] if len(parts) > 2 else ""
    city = parts[3] if len(parts) > 3 else ""
    category_text = parts[4] if len(parts) > 4 else ""
    return name, company, city, category_text


async def _find_clickable_name(row: Locator, name: str) -> Locator | None:
    selectors = [
        "td:first-child a",
        '[role="cell"]:first-child a',
        "td:first-child button",
        '[role="cell"]:first-child button',
        "a",
        "button",
    ]
    normalized_name = normalize_for_match(name)
    for selector in selectors:
        locator = row.locator(selector)
        try:
            count = await locator.count()
        except Exception:  # noqa: BLE001
            continue
        for idx in range(count):
            candidate = locator.nth(idx)
            try:
                if not await candidate.is_visible():
                    continue
                text = clean_text(await candidate.inner_text())
            except Exception:  # noqa: BLE001
                continue
            if not normalized_name or normalize_for_match(text) == normalized_name:
                return candidate
    return None


async def _capture_profile_url_from_click(page: Page, row: Locator, name: str, logger: logging.Logger) -> str:
    clickable = await _find_clickable_name(row, name)
    if clickable is None:
        return ""

    original_url = page.url
    try:
        await clickable.click()
    except Exception:  # noqa: BLE001
        logger.exception("Failed clicking member row for '%s'", name)
        return ""

    await page.wait_for_timeout(2000)
    current_url = page.url
    if current_url != original_url and "/web/member" in current_url:
        return current_url

    member_link = page.locator('a[href*="/web/member"], a[href*="uuid="]').first
    try:
        if await member_link.count():
            href = await member_link.get_attribute("href")
            if href:
                return ensure_absolute_url(page.url, href)
    except Exception:  # noqa: BLE001
        pass

    try:
        await page.go_back(wait_until="domcontentloaded")
        await page.wait_for_load_state("networkidle")
    except Exception:  # noqa: BLE001
        pass
    return ""


async def _capture_profile_url_by_name(page: Page, settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str, name: str) -> str:
    original_url = page.url
    target = page.get_by_text(name, exact=True).first
    try:
        await target.click()
        await page.wait_for_timeout(2000)
    except Exception:  # noqa: BLE001
        logger.exception("Failed clicking visible name '%s'", name)
        return ""

    current_url = page.url
    if current_url != original_url and "/web/member" in current_url:
        return current_url

    try:
        await page.go_back(wait_until="domcontentloaded")
        await page.wait_for_load_state("networkidle")
        await apply_filters(page, country=country, category=category, keyword=keyword, logger=logger)
        await scroll_results_until_stable(page, logger, max_rounds=8, stable_rounds_required=2)
    except Exception:  # noqa: BLE001
        pass
    return ""


async def _find_visual_row_for_link(link: Locator) -> Locator | None:
    try:
        link_text = clean_text(await link.inner_text())
    except Exception:  # noqa: BLE001
        link_text = ""
    for level in range(1, 9):
        candidate = link.locator(f"xpath=ancestor::div[{level}]").first
        try:
            if not await candidate.count() or not await candidate.is_visible():
                continue
            text = clean_text(await candidate.inner_text())
        except Exception:  # noqa: BLE001
            continue
        if not text:
            continue
        if link_text and link_text not in text:
            continue
        if ">" in text and len(text) > len(link_text) + 10:
            return candidate
    return None


async def _extract_records_from_profile_links(page: Page, logger: logging.Logger, country: str, category: str) -> list[MemberIndexRecord]:
    rows = await page.evaluate(
        """() => {
            const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };

            const anchors = [...document.querySelectorAll('a[href*="/web/secure/networkHome?userId="]')].filter(isVisible);
            return anchors.map((anchor) => {
                let row = anchor;
                for (let depth = 0; depth < 10 && row; depth += 1) {
                    const directFlexChildren = [...(row.children || [])].filter((child) => child.hasAttribute && child.hasAttribute("flexbasis"));
                    if (directFlexChildren.length >= 3) {
                        const values = directFlexChildren.map((child) => clean(child.innerText)).filter(Boolean);
                        return {
                            name: clean(anchor.innerText),
                            profile_url: anchor.href || "",
                            chapter: values[0] || "",
                            company: values[1] || "",
                            city: values[2] || "",
                            category_text: values[3] || "",
                        };
                    }
                    row = row.parentElement;
                }

                return {
                    name: clean(anchor.innerText),
                    profile_url: anchor.href || "",
                    chapter: "",
                    company: "",
                    city: "",
                    category_text: "",
                };
            });
        }"""
    )

    records = [
        MemberIndexRecord(
            uuid=parse_uuid_from_url(item.get("profile_url", "")),
            profile_url=item.get("profile_url", ""),
            name=clean_text(item.get("name", "")),
            company=clean_text(item.get("company", "")),
            city=clean_text(item.get("city", "")),
            category_text=clean_text(item.get("category_text", "")) or category,
            source_country_filter=country,
            source_category_filter=category,
        )
        for item in rows
        if clean_text(item.get("name", "")) or clean_text(item.get("profile_url", ""))
    ]
    deduped = unique_by_key(records, key_fn=lambda item: item.profile_url or item.name.lower())
    logger.info("Direct profile-link extraction produced %s candidate records", len(deduped))
    for idx, item in enumerate(deduped[:5], start=1):
        logger.info(
            "Direct record %s: name='%s' company='%s' city='%s' profile_url='%s'",
            idx,
            item.name,
            item.company,
            item.city,
            item.profile_url,
        )
    return deduped


async def _fallback_records_from_name_links(page: Page, settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str) -> list[MemberIndexRecord]:
    records: list[MemberIndexRecord] = []
    links = page.locator("a")
    try:
        count = await links.count()
    except Exception:  # noqa: BLE001
        count = 0

    logger.info("Falling back to visible member-name links. Total anchors on page: %s", count)
    candidate_names: list[str] = []
    for idx in range(count):
        link = links.nth(idx)
        try:
            if not await link.is_visible():
                continue
            name = clean_text(await link.inner_text())
        except Exception:  # noqa: BLE001
            continue
        if not name or len(name) < 4:
            continue
        if name in {"Search Members", "Filter", "Help", "Info"}:
            continue
        if name in candidate_names:
            continue
        candidate_names.append(name)
        if len(candidate_names) <= 10:
            logger.info("Visible anchor candidate %s: %s", len(candidate_names), name)

    for idx, name in enumerate(candidate_names, start=1):
        logger.info("Opening member candidate %s/%s: %s", idx, len(candidate_names), name)
        profile_url = await _capture_profile_url_by_name(page, settings, logger, country, category, keyword, name)
        uuid = parse_uuid_from_url(profile_url)
        records.append(
            MemberIndexRecord(
                uuid=uuid,
                profile_url=profile_url,
                name=name,
                company="",
                city="",
                category_text=category,
                source_country_filter=country,
                source_category_filter=category,
            )
        )

    deduped = unique_by_key(records, key_fn=lambda item: item.uuid or item.profile_url or item.name.lower())
    logger.info("Fallback name-link extraction produced %s candidate records", len(deduped))
    return deduped


async def _fallback_records_from_layout(page: Page, settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str) -> list[MemberIndexRecord]:
    layout_rows = await _extract_layout_rows(page)
    logger.info("Layout-based extraction found %s visible row groups", len(layout_rows))
    records: list[MemberIndexRecord] = []
    for parts in layout_rows:
        if len(parts) == 1:
            continue
        name, company, city, category_text = _parse_row_parts(parts)
        if not name:
            continue
        profile_url = await _capture_profile_url_by_name(page, settings, logger, country, category, keyword, name)
        records.append(
            MemberIndexRecord(
                uuid=parse_uuid_from_url(profile_url),
                profile_url=profile_url,
                name=name,
                company=company,
                city=city,
                category_text=category_text,
                source_country_filter=country,
                source_category_filter=category,
            )
        )
    deduped = unique_by_key(records, key_fn=lambda item: item.uuid or item.profile_url or item.name.lower())
    logger.info("Layout-based extraction produced %s candidate records", len(deduped))
    return deduped


async def _result_row_locators(page: Page) -> tuple[Locator, int]:
    selector_candidates = [
        ".MuiTableBody-root .MuiTableRow-root",
        "tr.MuiTableRow-root",
        "table tbody tr",
        '[role="rowgroup"] [role="row"]',
        '[role="row"]',
    ]
    for css in selector_candidates:
        rows = page.locator(css)
        try:
            count = await rows.count()
        except Exception:  # noqa: BLE001
            continue
        if count == 0:
            continue
        if css == '[role="row"]':
            filtered = []
            for idx in range(count):
                row = rows.nth(idx)
                text = clean_text(await row.inner_text())
                if not text or "Name Chapter Company City Profession and Specialty Connect" in text:
                    continue
                filtered.append(idx)
            if filtered:
                return rows, count
            continue
        return rows, count
    return page.locator("table tbody tr"), 0


def _resolve_output_dir(settings: Settings, country: str, category: str, keyword: str) -> Path:
    country_slug = slugify(country)
    category_slug = slugify(category) if category else "country_only"
    target_dir = settings.output_dir / country_slug / category_slug
    keyword_slug = slugify(keyword) if keyword else ""
    if keyword_slug:
        target_dir = target_dir / keyword_slug
    return target_dir


async def collect_member_index(page: Page, settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str) -> list[MemberIndexRecord]:
    await apply_filters(page, country=country, category=category, keyword=keyword, logger=logger)
    await scroll_results_until_stable(page, logger)

    records: list[MemberIndexRecord] = []
    rows, count = await _result_row_locators(page)
    logger.info("Result row locator returned count=%s for country='%s' category='%s'", count, country, category)
    for idx in range(count):
        row = rows.nth(idx)
        row_text = await _extract_row_text(row)
        if not row_text:
            continue
        if "Name Chapter Company City Profession and Specialty Connect" in row_text:
            continue

        cells = await _get_row_cells(row)
        name = cells[0] if len(cells) > 0 else ""
        company = cells[2] if len(cells) > 2 else ""
        city = cells[3] if len(cells) > 3 else ""
        category_text = cells[4] if len(cells) > 4 else ""
        if not name:
            name, company_from_text, city_from_text, category_from_text = _split_row_text(row_text)
            company = company or company_from_text
            city = city or city_from_text
            category_text = category_text or category_from_text

        profile_url = await _extract_profile_url(row, settings.base_url)
        if not profile_url and name:
            profile_url = await _capture_profile_url_from_click(page, row, name, logger)
            if profile_url:
                await page.goto(settings.search_url, wait_until="domcontentloaded")
                await page.wait_for_load_state("networkidle")
                await apply_filters(page, country=country, category=category, keyword=keyword, logger=logger)
                await scroll_results_until_stable(page, logger, max_rounds=8, stable_rounds_required=2)
                rows, count = await _result_row_locators(page)
                if idx >= count:
                    break
                row = rows.nth(idx)
        uuid = parse_uuid_from_url(profile_url)

        if not profile_url and not name:
            continue

        records.append(
            MemberIndexRecord(
                uuid=uuid,
                profile_url=profile_url,
                name=name,
                company=company,
                city=city,
                category_text=category_text,
                source_country_filter=country,
                source_category_filter=category,
            )
        )

    records = unique_by_key(records, key_fn=lambda item: item.uuid or item.profile_url or item.name.lower())
    if not records:
        preview_text = clean_text(await page.locator("body").inner_text())
        logger.info("No member records extracted. Body text preview: %s", preview_text[:1200])
        records = await _extract_records_from_profile_links(page, logger, country, category)
        records = unique_by_key(records, key_fn=lambda item: item.profile_url or item.uuid or item.name.lower())
    if not records:
        records = await _fallback_records_from_name_links(page, settings, logger, country, category, keyword)
        records = unique_by_key(records, key_fn=lambda item: item.uuid or item.profile_url or item.name.lower())
    if not records:
        records = await _fallback_records_from_layout(page, settings, logger, country, category, keyword)
        records = unique_by_key(records, key_fn=lambda item: item.uuid or item.profile_url or item.name.lower())
    logger.info("Indexed %s unique members for %s / %s", len(records), country, category)
    return records


async def run_index_category(settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str = "") -> list[MemberIndexRecord]:
    resolved_category = ""
    search_category = format_category_for_ui(category) if category else ""
    debug_category_key = f"{search_category}_{keyword}" if keyword else search_category
    target_dir = _resolve_output_dir(settings, country, search_category, keyword)
    target_dir.mkdir(parents=True, exist_ok=True)

    if category:
        resolved_category = await resolve_category_name(settings, logger, category)

    async with BrowserManager(settings, logger) as manager:
        page = await manager.new_page()
        await ensure_authenticated(page, settings, logger)
        if search_category:
            logger.info(
                "Using requested category label '%s' for UI search; discovered match is '%s'",
                search_category,
                resolved_category,
            )
        else:
            logger.info("Using country-only search for '%s' with no category filter", country)
        try:
            records = await collect_member_index(page, settings, logger, country=country, category=search_category, keyword=keyword)
        except RuntimeError as exc:
            if "Filter input not found" not in str(exc):
                raise
            logger.warning(
                "Search filters were not available for %s / %s. Re-authenticating and retrying once.",
                country,
                search_category or "<country-only>",
            )
            await ensure_authenticated(page, settings, logger)
            records = await collect_member_index(page, settings, logger, country=country, category=search_category, keyword=keyword)
        await manager.save_storage_state()

        rows = [record.to_dict() for record in records]
        write_csv(target_dir / "members_index.csv", rows)
        write_json(target_dir / "members_index.json", rows)
        write_csv(
            target_dir / "uuid_list.csv",
            [{"uuid": record.uuid, "profile_url": record.profile_url, "name": record.name} for record in records],
        )
        (target_dir / "uuid_list.txt").write_text(
            "\n".join(record.uuid or record.profile_url for record in records if record.uuid or record.profile_url),
            encoding="utf-8",
        )
        write_json(
            settings.debug_dir / f"{safe_filename_from_parts(country, debug_category_key, suffix='_first10.json')}",
            rows[:10],
        )
        await dump_page_debug(
            page,
            settings.debug_dir / f"{safe_filename_from_parts(country, debug_category_key, suffix='_search.html')}",
        )
        logger.info("Saved member index and UUID list to %s", target_dir)
        return records
