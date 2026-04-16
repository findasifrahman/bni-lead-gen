from __future__ import annotations

import logging

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright

from .config import Settings


class BrowserManager:
    def __init__(self, settings: Settings, logger: logging.Logger) -> None:
        self.settings = settings
        self.logger = logger
        self._playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None

    async def __aenter__(self) -> "BrowserManager":
        self._playwright = await async_playwright().start()
        self.browser = await self._playwright.chromium.launch(
            headless=self.settings.headless,
            slow_mo=self.settings.slow_mo,
        )
        context_kwargs = {}
        if self.settings.storage_state_path.exists():
            context_kwargs["storage_state"] = str(self.settings.storage_state_path)
        self.context = await self.browser.new_context(**context_kwargs)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.context:
            try:
                await self.context.close()
            except Exception as close_exc:  # noqa: BLE001
                self.logger.warning("Ignoring browser-context close error: %s", close_exc)
        if self.browser:
            try:
                await self.browser.close()
            except Exception as close_exc:  # noqa: BLE001
                self.logger.warning("Ignoring browser close error: %s", close_exc)
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception as stop_exc:  # noqa: BLE001
                self.logger.warning("Ignoring Playwright stop error: %s", stop_exc)

    async def new_page(self) -> Page:
        if not self.context:
            raise RuntimeError("Browser context not initialized")
        page = await self.context.new_page()
        page.set_default_timeout(30000)
        return page

    async def save_storage_state(self) -> None:
        if not self.context:
            raise RuntimeError("Browser context not initialized")
        await self.context.storage_state(path=str(self.settings.storage_state_path))
