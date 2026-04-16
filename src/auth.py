from __future__ import annotations

import asyncio
import logging

from playwright.async_api import Locator, Page

from .config import Settings
from .selectors import (
    LOGGED_IN_SENTINELS,
    LOGIN_PASSWORD,
    LOGIN_SUBMIT,
    LOGIN_USERNAME,
    SelectorSet,
)
from .utils import clean_text


async def _candidate_locators(page: Page, selector_set: SelectorSet) -> list[Locator]:
    locators: list[Locator] = []
    for css in selector_set.css:
        locators.append(page.locator(css))
    for role_name, role_text in selector_set.role:
        locators.append(page.get_by_role(role_name, name=role_text, exact=False))
    for text in selector_set.text:
        locators.append(page.get_by_text(text, exact=False))
    for xpath in selector_set.xpath:
        locators.append(page.locator(f"xpath={xpath}"))
    return locators


async def first_visible_locator(page: Page, selector_set: SelectorSet) -> Locator | None:
    for locator in await _candidate_locators(page, selector_set):
        try:
            if await locator.first.is_visible():
                return locator.first
        except Exception:  # noqa: BLE001
            continue
    return None


async def is_logged_in(page: Page) -> bool:
    current_url = page.url
    if "/login" in current_url:
        return False
    if "/web/dashboard" in current_url or "/web/member" in current_url:
        return True
    sentinel = await first_visible_locator(page, LOGGED_IN_SENTINELS)
    if sentinel is not None:
        return True
    return await has_auth_markers(page)


async def has_auth_markers(page: Page) -> bool:
    try:
        cookies = await page.context.cookies()
    except Exception:  # noqa: BLE001
        cookies = []

    auth_cookie_names = ("jwt", "token", "session", "refresh", "access", "auth")
    if any(any(marker in cookie["name"].lower() for marker in auth_cookie_names) for cookie in cookies):
        return True

    storage_state = await page.evaluate(
        """() => ({
            localKeys: Object.keys(window.localStorage || {}),
            sessionKeys: Object.keys(window.sessionStorage || {}),
            bodyText: document.body ? document.body.innerText : ""
        })"""
    )
    storage_keys = [key.lower() for key in storage_state.get("localKeys", []) + storage_state.get("sessionKeys", [])]
    if any(any(marker in key for marker in auth_cookie_names) for key in storage_keys):
        return True

    body_text = clean_text(storage_state.get("bodyText", "")).lower()
    return "login successful" in body_text


async def require_login(page: Page, settings: Settings, logger: logging.Logger) -> None:
    if not settings.username or not settings.password:
        raise ValueError("BNI_USERNAME and BNI_PASSWORD must be set in .env")

    logger.info(
        "Using credentials from settings: username=%s password=%s",
        "set" if settings.username else "missing",
        "set" if settings.password else "missing",
    )

    async def _save_login_debug(tag: str) -> None:
        html_path = settings.debug_dir / f"login_{tag}.html"
        screenshot_path = settings.debug_dir / f"login_{tag}.png"
        storage_path = settings.debug_dir / f"login_{tag}_storage.txt"
        try:
            html_path.write_text(await page.content(), encoding="utf-8")
        except Exception:  # noqa: BLE001
            logger.exception("Failed to write login HTML debug snapshot")
        try:
            await page.screenshot(path=str(screenshot_path), full_page=True)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to write login screenshot debug snapshot")
        try:
            cookies = await page.context.cookies()
            storage_state = await page.evaluate(
                """() => ({
                    localStorage: {...window.localStorage},
                    sessionStorage: {...window.sessionStorage},
                    url: window.location.href,
                    title: document.title
                })"""
            )
            storage_path.write_text(
                f"cookies={cookies}\n\nstorage={storage_state}",
                encoding="utf-8",
            )
        except Exception:  # noqa: BLE001
            logger.exception("Failed to write login storage debug snapshot")

    async def _find_login_fields() -> tuple[Locator | None, Locator | None, Locator | None]:
        user_input = await first_visible_locator(page, LOGIN_USERNAME)
        password_input = await first_visible_locator(page, LOGIN_PASSWORD)
        submit_button = await first_visible_locator(page, LOGIN_SUBMIT)

        if user_input and password_input and submit_button:
            return user_input, password_input, submit_button

        current_url = clean_text(page.url).lower()
        page_text = ""
        try:
            page_text = clean_text(await page.locator("body").inner_text()).lower()
        except Exception:  # noqa: BLE001
            page_text = ""

        looks_like_login_page = any(
            marker in current_url or marker in page_text
            for marker in (
                "/login",
                "sign-in to bni connect",
                "sign in to bni connect",
                "username",
                "password",
            )
        )

        if not looks_like_login_page:
            return None, None, None

        text_inputs = page.locator('input:not([type="hidden"])')
        try:
            input_count = await text_inputs.count()
        except Exception:  # noqa: BLE001
            input_count = 0

        visible_inputs: list[Locator] = []
        for idx in range(input_count):
            candidate = text_inputs.nth(idx)
            try:
                if await candidate.is_visible():
                    visible_inputs.append(candidate)
            except Exception:  # noqa: BLE001
                continue

        if not user_input and visible_inputs:
            user_input = visible_inputs[0]
        if not password_input:
            for candidate in visible_inputs:
                try:
                    input_type = (await candidate.get_attribute("type") or "").lower()
                except Exception:  # noqa: BLE001
                    continue
                if input_type == "password":
                    password_input = candidate
                    break
        if not submit_button:
            submit_button = page.locator("button, input[type='submit'], input[type='button']").first
            try:
                if not await submit_button.is_visible():
                    submit_button = None
            except Exception:  # noqa: BLE001
                submit_button = None

        return user_input, password_input, submit_button

    async def _do_login() -> None:
        candidate_urls = [
            page.url,
            settings.login_url,
            f"{settings.base_url}/web/login",
        ]

        user_input = password_input = submit_button = None
        for candidate_url in candidate_urls:
            if candidate_url:
                await page.goto(candidate_url, wait_until="domcontentloaded")
                await page.wait_for_load_state("networkidle")
            user_input, password_input, submit_button = await _find_login_fields()
            if user_input and password_input and submit_button:
                break

        if not user_input or not password_input or not submit_button:
            logger.error("Unable to locate login form. Final URL: %s | title: %s", page.url, await page.title())
            await _save_login_debug("selector_failure")
            raise RuntimeError("Unable to find login form selectors. Inspect debug output and update selectors.py")

        await user_input.fill(settings.username)
        await password_input.fill(settings.password)
        await submit_button.click()
        await page.wait_for_timeout(2000)

        for _ in range(8):
            if await is_logged_in(page):
                return
            await page.wait_for_timeout(1000)

        logger.info("Login submitted; checking authenticated access via search page")
        await page.goto(settings.search_url, wait_until="domcontentloaded")
        await page.wait_for_timeout(3000)
        await page.wait_for_load_state("networkidle")

        if await is_logged_in(page):
            return

        await _save_login_debug("post_submit")
        raise RuntimeError(f"Login did not appear successful. Current URL: {clean_text(page.url)}")

    logger.info("Logging in to BNI Connect Global")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            await _do_login()
            return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning("BNI login attempt %s/3 failed: %s", attempt, exc)
            if attempt < 3:
                await asyncio.sleep(2 * attempt)

    raise RuntimeError(
        "BNI login failed after 3 attempts. Please check your BNI username and password again."
    ) from last_error


async def ensure_authenticated(page: Page, settings: Settings, logger: logging.Logger) -> None:
    await page.goto(settings.search_url, wait_until="domcontentloaded")
    await page.wait_for_load_state("networkidle")
    if await is_logged_in(page):
        await page.context.storage_state(path=str(settings.storage_state_path))
        return
    logger.info("Stored session not valid, performing fresh login")
    await require_login(page, settings, logger)
    await page.goto(settings.search_url, wait_until="domcontentloaded")
    await page.wait_for_load_state("networkidle")
    await page.context.storage_state(path=str(settings.storage_state_path))
