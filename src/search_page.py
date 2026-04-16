from __future__ import annotations

import logging
from pathlib import Path

from playwright.async_api import Locator, Page

from .selectors import (
    FILTER_BUTTON,
    CATEGORY_MENU_OPTIONS,
    RESULTS_CONTAINER,
    RESULT_ROW,
    SEARCH_BUTTON,
    SEARCH_CATEGORY_INPUT,
    SEARCH_COUNTRY_INPUT,
    SEARCH_KEYWORD_INPUT,
    SelectorSet,
)
from .utils import clean_text, random_delay, retry_async
from .utils import humanize_category_label, normalize_for_match


async def first_visible(page: Page, selector_set: SelectorSet) -> Locator | None:
    from .auth import first_visible_locator

    return await first_visible_locator(page, selector_set)


async def find_input_by_label(page: Page, label_text: str) -> Locator | None:
    label_candidates = page.locator("label, span, div")
    try:
        count = await label_candidates.count()
    except Exception:  # noqa: BLE001
        return None

    needle = label_text.strip().lower()
    for idx in range(min(count, 400)):
        node = label_candidates.nth(idx)
        try:
            text = clean_text(await node.text_content())
        except Exception:  # noqa: BLE001
            continue
        if text.lower() != needle:
            continue

        for relative in [
            "xpath=following::input[1]",
            "xpath=following::*[@role='combobox'][1]",
            "xpath=ancestor::*[1]//input[1]",
            "xpath=ancestor::*[1]//*[@role='combobox'][1]",
            "xpath=ancestor::*[2]//input[1]",
            "xpath=ancestor::*[2]//*[@role='combobox'][1]",
        ]:
            locator = node.locator(relative).first
            try:
                if await locator.count() and await locator.is_visible():
                    return locator
            except Exception:  # noqa: BLE001
                continue
    return None


async def find_search_filter_input(page: Page, selector_set: SelectorSet, label_text: str) -> Locator | None:
    locator = await first_visible(page, selector_set)
    if locator:
        return locator
    locator = await find_input_by_label(page, label_text)
    if locator:
        return locator

    # Some search pages expose the country field as a plain visible search box
    # without a stable label/placeholder. That control still needs to be used
    # for country-only indexing, so we fall back to the first visible text-like
    # input when looking for the country filter specifically.
    if label_text in {"Country", "Keyword"}:
        generic_inputs = page.locator(
            'input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]), '
            '[role="combobox"], textarea'
        )
        try:
            count = await generic_inputs.count()
        except Exception:  # noqa: BLE001
            count = 0

        for idx in range(count):
            candidate = generic_inputs.nth(idx)
            try:
                if await candidate.is_visible():
                    return candidate
            except Exception:  # noqa: BLE001
                continue

    return None


async def dump_page_debug(page: Page, html_path: Path) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(await page.content(), encoding="utf-8")
    screenshot_path = html_path.with_suffix(".png")
    await page.screenshot(path=str(screenshot_path), full_page=True)


async def click_search(page: Page) -> None:
    button = await first_visible(page, SEARCH_BUTTON)
    if not button:
        raise RuntimeError("Search button not found")
    await button.click()


async def open_filters(page: Page) -> None:
    button = await first_visible(page, FILTER_BUTTON)
    if not button:
        return
    await button.click()
    await page.wait_for_timeout(1200)


async def fill_filter_input(page: Page, selector_set: SelectorSet, value: str, logger: logging.Logger) -> bool:
    label_text = "Country" if selector_set is SEARCH_COUNTRY_INPUT else "Category"
    input_locator = await find_search_filter_input(page, selector_set, label_text)
    if not input_locator:
        raise RuntimeError(f"Filter input not found for value: {value}")

    candidate_values = [clean_text(value)]
    humanized = humanize_category_label(value)
    if humanized and humanized not in candidate_values:
        candidate_values.append(humanized)
    if label_text == "Category":
        compact = clean_text(humanized.replace("(", "").replace(")", "")) if humanized else ""
        if compact and compact not in candidate_values:
            candidate_values.append(compact)

    async def _collect_option_texts() -> list[tuple[str, str]]:
        collected: list[tuple[str, str]] = []
        for css in CATEGORY_MENU_OPTIONS.css:
            locator = page.locator(css)
            try:
                count = await locator.count()
            except Exception:  # noqa: BLE001
                continue
            for idx in range(min(count, 80)):
                option = locator.nth(idx)
                try:
                    text = clean_text(await option.text_content())
                except Exception:  # noqa: BLE001
                    continue
                if text:
                    collected.append((css, text))
        return collected

    for candidate_value in candidate_values:
        await input_locator.click()
        await input_locator.fill("")
        await input_locator.fill(candidate_value)
        await page.wait_for_timeout(1000)

        options = []
        for css in CATEGORY_MENU_OPTIONS.css:
            locator = page.locator(css)
            try:
                count = await locator.count()
            except Exception:  # noqa: BLE001
                continue
            if count > 0:
                options.append(locator)

        normalized_target = normalize_for_match(candidate_value)
        best_option: Locator | None = None
        best_score = -1
        best_text = ""

        for option_group in options:
            count = await option_group.count()
            for idx in range(count):
                option = option_group.nth(idx)
                text = clean_text(await option.text_content())
                normalized_option = normalize_for_match(text)
                if not normalized_option:
                    continue
                score = 0
                if normalized_option == normalized_target:
                    score = 1000
                elif normalized_target in normalized_option or normalized_option in normalized_target:
                    score = min(len(normalized_option), len(normalized_target))
                if score > best_score:
                    best_score = score
                    best_option = option
                    best_text = text

        if best_option is not None and best_score > 0:
            logger.info(
                "%s filter candidate '%s' matched dropdown option '%s' (score=%s)",
                label_text,
                candidate_value,
                best_text,
                best_score,
            )
            await best_option.click()
            await page.wait_for_timeout(700)
            return True

        visible_options = await _collect_option_texts()
        option_preview = ", ".join(sorted({text for _, text in visible_options})[:12])
        logger.info(
            "%s filter candidate '%s' did not match dropdown options. Visible options sample: %s",
            label_text,
            candidate_value,
            option_preview or "<none>",
        )

    for key in ("ArrowDown", "Enter"):
        await input_locator.press(key)
        await page.wait_for_timeout(300)

    try:
        input_value = await input_locator.input_value()
    except Exception:  # noqa: BLE001
        input_value = ""
    logger.info(
        "No dropdown option matched for %s='%s'. Final input value before Enter fallback: '%s'",
        label_text,
        value,
        clean_text(input_value),
    )
    await input_locator.press("Enter")
    return False


async def fill_keyword_input(page: Page, value: str, logger: logging.Logger) -> bool:
    input_locator = await find_search_filter_input(page, SEARCH_KEYWORD_INPUT, "Keyword")
    if not input_locator:
        raise RuntimeError(f"Keyword input not found for value: {value}")

    await input_locator.click()
    await input_locator.fill("")
    await input_locator.fill(clean_text(value))
    await page.wait_for_timeout(500)
    await input_locator.press("Enter")
    logger.info("Filled keyword filter with '%s'", clean_text(value))
    return True


async def apply_filters(page: Page, country: str, category: str, keyword: str, logger: logging.Logger) -> None:
    await open_filters(page)
    if keyword.strip():
        await retry_async(
            lambda: fill_keyword_input(page, keyword, logger),
            retries=2,
            delay_seconds=1,
        )
        await random_delay(0.3, 0.7)
    country_matched = await retry_async(
        lambda: fill_filter_input(page, SEARCH_COUNTRY_INPUT, country, logger),
        retries=2,
        delay_seconds=1,
    )
    await random_delay(0.4, 0.9)
    if not country_matched:
        # Some site variants accept the typed country directly after Enter even
        # when they do not expose any dropdown suggestion. Treat that as a
        # recoverable case rather than aborting the whole scrape.
        logger.warning(
            "Country filter for '%s' did not expose a dropdown match; continuing with typed value fallback.",
            country,
        )
    if category:
        category_matched = await retry_async(
            lambda: fill_filter_input(page, SEARCH_CATEGORY_INPUT, category, logger),
            retries=2,
            delay_seconds=1,
        )
        if not category_matched:
            raise RuntimeError(f"Category filter could not be matched in dropdown: {category}")
    await random_delay(0.4, 0.9)
    await click_search(page)
    await page.wait_for_load_state("networkidle")
    body_text = clean_text(await page.locator("body").inner_text())
    logger.info(
        "Applied search with country='%s' and category='%s'. Page markers: Search Results=%s, Search Members=%s",
        country,
        category,
        "Search Results" in body_text,
        "Search Members" in body_text,
    )


async def find_results_container(page: Page) -> Locator:
    container = await first_visible(page, RESULTS_CONTAINER)
    if not container:
        return page.locator("body")
    return container


async def count_result_rows(page: Page) -> int:
    for css in RESULT_ROW.css:
        locator = page.locator(css)
        try:
            count = await locator.count()
        except Exception:  # noqa: BLE001
            continue
        if count > 0:
            if "[role=\"row\"]" in css:
                return max(count - 1, 0)
            return count
    role_rows = page.get_by_role("row")
    try:
        count = await role_rows.count()
    except Exception:  # noqa: BLE001
        count = 0
    count = max(count - 1, 0)
    if count > 0:
        return count

    member_links = page.locator('a[href*="/web/secure/networkHome?userId="]')
    try:
        member_count = await member_links.count()
    except Exception:  # noqa: BLE001
        member_count = 0
    if member_count > 0:
        return member_count
    return 0


async def scroll_results_until_stable(
    page: Page,
    logger: logging.Logger,
    max_rounds: int = 50,
    stable_rounds_required: int = 3,
) -> int:
    container = await find_results_container(page)
    previous_count = -1
    stable_rounds = 0

    for round_idx in range(1, max_rounds + 1):
        current_count = await count_result_rows(page)
        logger.info("Lazy-load scan round %s: %s rows visible", round_idx, current_count)

        if current_count == previous_count:
            stable_rounds += 1
        else:
            stable_rounds = 0

        if stable_rounds >= stable_rounds_required:
            return current_count

        previous_count = current_count
        await _advance_results_scroll(page, container, logger)
        await page.wait_for_timeout(1400)

    return await count_result_rows(page)


async def _advance_results_scroll(page: Page, container: Locator, logger: logging.Logger) -> None:
    scrolled = await page.evaluate(
        """() => {
            const describe = (el) => {
                if (!el) return "<none>";
                const testId = el.getAttribute("data-testid");
                if (testId) return `[data-testid="${testId}"]`;
                if (el.id) return `#${el.id}`;
                const cls = (el.className || "").toString().trim().replace(/\\s+/g, ".");
                return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
            };
            const isScrollable = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                return (
                    (style.overflowY === "auto" || style.overflowY === "scroll") &&
                    el.scrollHeight > el.clientHeight + 20
                );
            };

            const candidates = [];
            for (const el of document.querySelectorAll("*")) {
                if (!isScrollable(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 200 || rect.height < 150) continue;
                candidates.push({
                    el,
                    rectTop: rect.top,
                    rectHeight: rect.height,
                    scrollTop: el.scrollTop,
                    scrollHeight: el.scrollHeight,
                    clientHeight: el.clientHeight,
                    desc: describe(el),
                });
            }

            candidates.sort((a, b) => {
                const aScore = Math.min(a.rectHeight, window.innerHeight) - Math.abs(a.rectTop);
                const bScore = Math.min(b.rectHeight, window.innerHeight) - Math.abs(b.rectTop);
                return bScore - aScore;
            });

            const touched = [];
            for (const item of candidates.slice(0, 4)) {
                const nextTop = Math.min(item.scrollTop + Math.max(500, Math.floor(item.clientHeight * 0.9)), item.scrollHeight);
                item.el.scrollTo({ top: nextTop, behavior: "auto" });
                touched.push(`${item.desc} (${item.scrollTop} -> ${item.el.scrollTop})`);
            }

            window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.8)));
            return touched;
        }"""
    )

    if scrolled:
        logger.info("Scroll step touched containers: %s", "; ".join(scrolled[:3]))

    member_links = page.locator('a[href*="/web/secure/networkHome?userId="]')
    try:
        count = await member_links.count()
    except Exception:  # noqa: BLE001
        count = 0

    if count > 0:
        last_link = member_links.nth(count - 1)
        try:
            await last_link.scroll_into_view_if_needed()
            await page.wait_for_timeout(250)
        except Exception:  # noqa: BLE001
            pass

    try:
        await container.hover()
        await page.mouse.wheel(0, 2500)
    except Exception:  # noqa: BLE001
        await page.mouse.wheel(0, 2500)
