from __future__ import annotations

import asyncio
import csv
import logging
from pathlib import Path
import shutil
from typing import Iterable

from playwright.async_api import Error, Locator, Page

from .auth import ensure_authenticated, is_logged_in, require_login
from .browser import BrowserManager
from .category_resolver import resolve_category_name
from .config import Settings
from .exporters import append_csv_row, append_jsonl, write_json
from .member_indexer import run_index_category
from .models import MemberIndexRecord, ProfileRecord
from .resume import ResumeState
from .search_page import dump_page_debug
from .selectors import PROFILE_COMPANY, PROFILE_DETAIL_BLOCKS, PROFILE_NAME
from .utils import (
    clean_text,
    extract_first_email,
    extract_phone_candidates,
    format_category_for_ui,
    humanize_category_label,
    looks_like_cloudflare_block,
    normalize_phone,
    normalize_website,
    parse_uuid_from_url,
    random_delay,
    safe_filename_from_parts,
    slugify,
    utc_now_iso,
)


PROFILE_FIELDNAMES = [
    "profile_url",
    "name",
    "company",
    "email",
    "phone_1",
    "phone_2",
    "website",
    "city",
    "country",
    "chapter",
    "professional_details",
]


def _normalize_multiline_text(value: str | None) -> str:
    if not value:
        return ""
    lines = [clean_text(line) for line in value.splitlines()]
    return "\n".join(line for line in lines if line)


async def _get_first_text(page: Page, selectors: list[str]) -> str:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if await locator.is_visible():
                return clean_text(await locator.text_content())
        except Exception:  # noqa: BLE001
            continue
    return ""


async def _extract_links(page: Page) -> tuple[str, str, str]:
    email = ""
    website = ""
    phone_links: list[str] = []
    links = page.locator("a")
    count = await links.count()
    for idx in range(count):
        link = links.nth(idx)
        try:
            href = await link.get_attribute("href")
            text = clean_text(await link.text_content())
        except Exception:  # noqa: BLE001
            continue
        if not href and not text:
            continue
        href = href or ""
        if href.startswith("mailto:") and not email:
            email = href.replace("mailto:", "").strip()
        elif href.startswith("tel:"):
            phone_links.append(href.replace("tel:", "").strip())
        elif ("http://" in href or "https://" in href) and "bniconnectglobal.com" not in href and not website:
            website = href
        elif text and "." in text and not website:
            website = text
    return email, normalize_website(website), ",".join(phone_links)


def _parse_labeled_value(raw_text: str, labels: Iterable[str]) -> str:
    lines = [clean_text(line) for line in raw_text.splitlines() if clean_text(line)]
    lowered = [line.lower() for line in lines]
    for label in labels:
        label_lower = label.lower()
        for idx, line in enumerate(lowered):
            if line.startswith(label_lower):
                original = lines[idx]
                remainder = clean_text(original[len(label):].lstrip(":"))
                if remainder:
                    return remainder
                if idx + 1 < len(lines):
                    return lines[idx + 1]
    return ""


async def _extract_professional_details_block(page: Page) -> str:
    text = await page.evaluate(
        """() => {
            const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
            const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,div,span,strong,b")];
            const match = headings.find((el) => clean(el.innerText).toLowerCase() === "professional details");
            if (!match) return "";

            let container = match.parentElement;
            for (let depth = 0; depth < 8 && container; depth += 1) {
                const textLines = (container.innerText || "")
                    .split(/\\n+/)
                    .map((line) => clean(line))
                    .filter(Boolean);
                const start = textLines.findIndex((line) => line.toLowerCase() === "professional details");
                if (start >= 0 && textLines.length > start + 1) {
                    const tail = textLines.slice(start + 1);
                    return tail.join(" | ");
                }
                container = container.parentElement;
            }

            let sibling = match.parentElement ? match.parentElement.nextElementSibling : null;
            const parts = [];
            for (let i = 0; i < 6 && sibling; i += 1) {
                const siblingText = clean(sibling.innerText);
                if (!siblingText) {
                    sibling = sibling.nextElementSibling;
                    continue;
                }
                if (["contact details", "chapter", "general details", "personal details", "biography"].includes(siblingText.toLowerCase())) {
                    break;
                }
                parts.push(siblingText);
                sibling = sibling.nextElementSibling;
            }
            if (parts.length) return parts.join(" | ");
            return "";
        }"""
    )
    return clean_text(text)


def _extract_section_after_heading(raw_text: str, heading: str, stop_headings: list[str]) -> str:
    lines = [clean_text(line) for line in raw_text.splitlines() if clean_text(line)]
    heading_lower = heading.lower()
    stop_set = {item.lower() for item in stop_headings}
    start_idx = -1
    for idx, line in enumerate(lines):
        if line.lower() == heading_lower:
            start_idx = idx + 1
            break
    if start_idx < 0:
        return ""

    collected: list[str] = []
    for line in lines[start_idx:]:
        if line.lower() in stop_set:
            break
        collected.append(line)
    return " | ".join(collected)


async def scrape_profile_page(
    page: Page,
    settings: Settings,
    logger: logging.Logger,
    member: MemberIndexRecord,
) -> ProfileRecord:
    async def _open_profile() -> None:
        await page.goto(member.profile_url, wait_until="domcontentloaded")
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:  # noqa: BLE001
            logger.info("Network idle timeout on %s; continuing with visible DOM", member.profile_url)

    await _open_profile()
    if not await _looks_like_profile_page(page, member):
        logger.info(
            "Profile page not accessible for %s. Re-authenticating and retrying profile open.",
            member.profile_url,
        )
        current_url = clean_text(page.url).lower()
        if "/login" in current_url:
            await require_login(page, settings, logger)
            await page.context.storage_state(path=str(settings.storage_state_path))
        else:
            await ensure_authenticated(page, settings, logger)
        await _open_profile()
    if not await _looks_like_profile_page(page, member):
        raise RuntimeError(
            f"Profile page did not open successfully for {member.profile_url}. Current URL: {clean_text(page.url)}"
        )
    await random_delay(settings.request_delay_min, settings.request_delay_max)

    name = await _get_first_text(page, PROFILE_NAME.css)
    company = await _get_first_text(page, PROFILE_COMPANY.css)
    if normalize_website(name).lower() == "profile" or clean_text(name).lower() == "profile":
        name = ""

    detail_texts: list[str] = []
    for css in PROFILE_DETAIL_BLOCKS.css:
        block = page.locator(css).first
        try:
            if await block.count() and await block.is_visible():
                detail_texts.append(_normalize_multiline_text(await block.inner_text()))
        except Exception:  # noqa: BLE001
            continue
    raw_text = "\n".join(part for part in detail_texts if part)
    if not raw_text:
        raw_text = _normalize_multiline_text(await page.locator("body").inner_text())

    email_from_links, website, linked_phones = await _extract_links(page)
    email = email_from_links or extract_first_email(raw_text)
    phone_candidates = []
    if linked_phones:
        phone_candidates.extend([normalize_phone(item) for item in linked_phones.split(",") if item.strip()])
    phone_candidates.extend(extract_phone_candidates(raw_text))
    phones = []
    for phone in phone_candidates:
        if phone and phone not in phones:
            phones.append(phone)

    city = _parse_labeled_value(raw_text, ["City", "Town/City"])
    country = _parse_labeled_value(raw_text, ["Country"])
    chapter = _parse_labeled_value(raw_text, ["Chapter"])
    professional_details = await _extract_professional_details_block(page)
    if not professional_details:
        professional_details = _parse_labeled_value(
            raw_text,
            ["Professional Details", "Professional detail", "Details", "Business Description"],
        )
    if not professional_details:
        professional_details = _extract_section_after_heading(
            raw_text,
            "Professional Details",
            [
                "Contact Details",
                "Chapter",
                "General Details",
                "Personal Details",
                "Biography",
                "Tyfcb Details",
            ],
        )

    if not company:
        company = _parse_labeled_value(raw_text, ["Company", "Company Name"])

    uuid = member.uuid or parse_uuid_from_url(page.url)

    record = ProfileRecord(
        uuid=uuid,
        profile_url=member.profile_url or page.url,
        name=member.name or name,
        company=company or member.company,
        email=email,
        phone_1=phones[0] if len(phones) > 0 else "",
        phone_2=phones[1] if len(phones) > 1 else "",
        website=website,
        city=city or member.city,
        country=country or member.source_country_filter,
        chapter=chapter,
        professional_details=professional_details,
        search_category=member.source_category_filter,
        source_country_filter=member.source_country_filter,
        scraped_at=utc_now_iso(),
        raw_text_debug=raw_text,
    )
    logger.info("Scraped profile %s", record.uuid or record.profile_url)
    return record


def _is_profile_auth_failure(exc: Exception) -> bool:
    message = clean_text(str(exc)).lower()
    return (
        "profile page did not open successfully" in message
        or "profile page not accessible" in message
        or "current url: https://www.bniconnectglobal.com/login" in message
        or "current url: https://www.bniconnectglobal.com/web/dashboard" in message
        or "target page, context or browser has been closed" in message
    )


async def _page_has_cloudflare_block(page: Page) -> bool:
    try:
        body_text = clean_text(await page.locator("body").inner_text())
    except Exception:  # noqa: BLE001
        return False
    return looks_like_cloudflare_block(body_text)


async def _looks_like_profile_page(page: Page, member: MemberIndexRecord) -> bool:
    current_url = clean_text(page.url).lower()
    if "/web/secure/networkhome" in current_url:
        return True
    if "/login" in current_url or "/web/dashboard" in current_url:
        return False
    try:
        body_text = clean_text(await page.locator("body").inner_text())
    except Exception:  # noqa: BLE001
        return False
    body_lower = body_text.lower()
    if "professional details" in body_lower or "contact details" in body_lower:
        return True
    if member.name and member.name.lower() in body_lower:
        return True
    return False


def _load_member_index(path: Path) -> list[MemberIndexRecord]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open("r", newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return [MemberIndexRecord(**row) for row in reader]


def _resolve_target_dir(settings: Settings, country: str, category: str, keyword: str) -> Path:
    country_slug = slugify(country)
    category_label = format_category_for_ui(category) if category else ""
    category_slug = slugify(category_label) if category_label else "country_only"
    target_dir = settings.output_dir / country_slug / category_slug
    keyword_slug = slugify(keyword) if keyword else ""
    if keyword_slug:
        target_dir = target_dir / keyword_slug
    return target_dir


def _count_csv_rows(path: Path) -> int:
    if not path.exists() or path.stat().st_size == 0:
        return 0
    with path.open("r", newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return sum(1 for _ in reader)


def _emit_progress(total_leads: int) -> None:
    print(f"PROGRESS:{total_leads}", flush=True)


def _refresh_country_final_csv(settings: Settings, country: str, logger: logging.Logger) -> Path:
    country_slug = slugify(country)
    country_dir = settings.output_dir / country_slug
    final_output_path = country_dir / "final_profiles.csv"

    all_rows: list[dict[str, str]] = []
    for csv_path in country_dir.rglob("profiles.csv"):
        if not csv_path.exists() or csv_path.stat().st_size == 0:
            continue
        with csv_path.open("r", newline="", encoding="utf-8") as fh:
            all_rows.extend(list(csv.DictReader(fh)))

    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in all_rows:
        key = row.get("profile_url") or row.get("email") or ""
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    if settings.max_country_profiles > 0:
        deduped = deduped[: settings.max_country_profiles]

    final_output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if deduped:
            with final_output_path.open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=list(deduped[0].keys()))
                writer.writeheader()
                writer.writerows(deduped)
        else:
            final_output_path.write_text("", encoding="utf-8")
    except PermissionError as exc:
        logger.warning("Could not refresh %s because it is open elsewhere: %s", final_output_path, exc)
        return final_output_path

    logger.info("Refreshed country final CSV at %s with %s rows", final_output_path, len(deduped))
    return final_output_path


def _clear_category_outputs(settings: Settings, country: str, category: str, logger: logging.Logger) -> Path:
    country_slug = slugify(country)
    category_label = format_category_for_ui(category) if category else ""
    category_slug = slugify(category_label) if category_label else "country_only"
    target_dir = settings.output_dir / country_slug / category_slug
    if target_dir.exists():
        shutil.rmtree(target_dir)
        logger.info("Cleared prior category output for fresh start: %s", target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir


async def _ensure_member_index(
    settings: Settings,
    logger: logging.Logger,
    country: str,
    category: str,
    keyword: str,
) -> list[MemberIndexRecord]:
    search_category = format_category_for_ui(category) if category else ""
    index_path = _resolve_target_dir(settings, country, search_category, keyword) / "members_index.csv"
    records = _load_member_index(index_path)
    if records:
        return records
    if not search_category:
        logger.info("Using country-only member index for '%s' with no category filter", country)
        return await run_index_category(settings, logger, country=country, category="", keyword=keyword)
    resolved_category = await resolve_category_name(settings, logger, category)
    logger.info(
        "Using requested category label '%s' for member index; discovered match is '%s'",
        search_category,
        resolved_category,
    )
    return await run_index_category(settings, logger, country=country, category=search_category, keyword=keyword)


async def run_test_profile(settings: Settings, logger: logging.Logger, country: str, category: str, keyword: str = "") -> ProfileRecord:
    members = await _ensure_member_index(settings, logger, country, category, keyword)
    if not members:
        raise RuntimeError("No indexed members available to test profile scraping")
    member = members[0]

    async with BrowserManager(settings, logger) as manager:
        page = await manager.new_page()
        await ensure_authenticated(page, settings, logger)
        record = await scrape_profile_page(page, settings, logger, member)
        await manager.save_storage_state()

        debug_key = f"{category}_{keyword}" if keyword else category
        base_name = safe_filename_from_parts(country, debug_key, suffix="_test_profile")
        screenshot_path = settings.debug_dir / f"{base_name}.png"
        json_path = settings.debug_dir / f"{base_name}.json"
        html_path = settings.debug_dir / f"{safe_filename_from_parts(country, debug_key, suffix='_profile.html')}"

        await page.screenshot(path=str(screenshot_path), full_page=True)
        await dump_page_debug(page, html_path)
        write_json(json_path, record.to_dict())
        logger.info("Saved test profile debug artifacts to %s", settings.debug_dir)
        return record


async def run_scrape_category(
    settings: Settings,
    logger: logging.Logger,
    country: str,
    category: str,
    keyword: str = "",
    resume_mode: str = "start-from-last",
) -> Path:
    if resume_mode == "start-new":
        _clear_category_outputs(settings, country, category, logger)

    members = await _ensure_member_index(settings, logger, country, category, keyword)
    if not members:
        target_dir = _resolve_target_dir(settings, country, category, keyword)
        target_dir.mkdir(parents=True, exist_ok=True)
        profiles_csv = target_dir / "profiles.csv"
        profiles_jsonl = target_dir / "profiles.jsonl"
        resume_path = target_dir / "resume_state.json"
        if not profiles_csv.exists():
            profiles_csv.write_text("", encoding="utf-8")
        if not profiles_jsonl.exists():
            profiles_jsonl.write_text("", encoding="utf-8")
        ResumeState.load(resume_path).save(resume_path)
        logger.info("No indexed members found for %s / %s. Skipping category scrape.", country, category)
        return profiles_csv

    target_dir = _resolve_target_dir(settings, country, category, keyword)
    resume_path = target_dir / "resume_state.json"
    profiles_csv = target_dir / "profiles.csv"
    profiles_jsonl = target_dir / "profiles.jsonl"

    resume_state = ResumeState.load(resume_path)
    written_count = _count_csv_rows(profiles_csv)
    pending_members = [member for member in members if not resume_state.is_done(member.uuid or member.profile_url)]

    logger.info(
        "Category scrape queue for %s / %s: %s pending of %s",
        country,
        category,
        len(pending_members),
        len(members),
    )

    async with BrowserManager(settings, logger) as manager:
        page = await manager.new_page()
        await ensure_authenticated(page, settings, logger)
        await manager.save_storage_state()

        effective_delay_min = max(settings.request_delay_min, 2.5)
        effective_delay_max = max(settings.request_delay_max, 5.0)
        logger.info(
            "Using sequential profile scraping with polite pacing %.1f-%.1fs between profiles",
            effective_delay_min,
            effective_delay_max,
        )

        for index, member in enumerate(pending_members, start=1):
            key = member.uuid or member.profile_url
            logger.info("Scraping profile %s/%s: %s", index, len(pending_members), member.profile_url)
            retry_once = False
            try:
                await random_delay(effective_delay_min, effective_delay_max)
                record = await scrape_profile_page(page, settings, logger, member)

                if await _page_has_cloudflare_block(page):
                    raise RuntimeError(f"Cloudflare challenge detected on {member.profile_url}")

                if not record.email:
                    logger.info(
                        "Skipping profile without email: %s",
                        record.profile_url or member.profile_url,
                    )
                else:
                    append_csv_row(profiles_csv, record.to_export_dict(), PROFILE_FIELDNAMES)
                    append_jsonl(profiles_jsonl, record.to_export_dict())
                    _refresh_country_final_csv(settings, country, logger)
                    written_count += 1
                    _emit_progress(written_count)

                resume_state.mark_done(key)
                resume_state.save(resume_path)
                await manager.save_storage_state()
            except Exception as exc:  # noqa: BLE001
                if _is_profile_auth_failure(exc) and not retry_once:
                    logger.warning(
                        "Profile %s hit an auth/session failure; recreating the page and retrying once.",
                        member.profile_url,
                    )
                    retry_once = True
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    page = await manager.new_page()
                    try:
                        await ensure_authenticated(page, settings, logger)
                        await manager.save_storage_state()
                        await random_delay(effective_delay_min, effective_delay_max)
                        record = await scrape_profile_page(page, settings, logger, member)
                        if not record.email:
                            logger.info(
                                "Skipping profile without email: %s",
                                record.profile_url or member.profile_url,
                            )
                        else:
                            append_csv_row(profiles_csv, record.to_export_dict(), PROFILE_FIELDNAMES)
                            append_jsonl(profiles_jsonl, record.to_export_dict())
                            _refresh_country_final_csv(settings, country, logger)
                            written_count += 1
                            _emit_progress(written_count)
                        resume_state.mark_done(key)
                        resume_state.save(resume_path)
                        await manager.save_storage_state()
                        continue
                    except Exception as retry_exc:  # noqa: BLE001
                        logger.exception("Retry after auth failure also failed for %s: %s", member.profile_url, retry_exc)
                        exc = retry_exc

                logger.exception("Failed to scrape profile %s: %s", member.profile_url, exc)
                try:
                    if await _page_has_cloudflare_block(page):
                        logger.error("Stopping category scrape early because a Cloudflare/rate-limit page was detected")
                        break
                except Error:
                    break

    try:
        await page.close()
    except Error:
        pass

    profiles_csv.parent.mkdir(parents=True, exist_ok=True)
    if not profiles_csv.exists():
        profiles_csv.write_text("", encoding="utf-8")
    if not profiles_jsonl.exists():
        profiles_jsonl.write_text("", encoding="utf-8")

    logger.info("Completed category scrape export at %s", profiles_csv)
    return profiles_csv
