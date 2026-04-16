from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
import os


BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(slots=True)
class Settings:
    username: str
    password: str
    target_country: str
    target_category: str
    headless: bool
    slow_mo: int
    max_profile_concurrency: int
    max_country_profiles: int
    request_delay_min: float
    request_delay_max: float
    output_dir: Path
    debug_dir: Path
    storage_state_path: Path
    base_url: str = "https://www.bniconnectglobal.com"
    search_url: str = "https://www.bniconnectglobal.com/web/dashboard/search"
    login_url: str = "https://www.bniconnectglobal.com/login"


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def load_settings() -> Settings:
    # Load the project .env explicitly, then allow a local cwd .env as a fallback.
    # `override=True` ensures the checked-in/project .env wins over any stale
    # environment variables inherited from the shell or IDE run configuration.
    load_dotenv(BASE_DIR / ".env", override=True)
    load_dotenv(override=False)

    output_dir = BASE_DIR / os.getenv("OUTPUT_DIR", "output")
    debug_dir = BASE_DIR / "debug"

    output_dir.mkdir(parents=True, exist_ok=True)
    debug_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        username=os.getenv("BNI_USERNAME", "").strip(),
        password=os.getenv("BNI_PASSWORD", "").strip(),
        target_country=os.getenv("TARGET_COUNTRY", "").strip(),
        target_category=os.getenv("TARGET_CATEGORY", "").strip(),
        headless=_get_bool("HEADLESS", False),
        slow_mo=int(os.getenv("SLOW_MO", "100")),
        max_profile_concurrency=int(os.getenv("MAX_PROFILE_CONCURRENCY", "3")),
        max_country_profiles=int(os.getenv("MAX_COUNTRY_PROFILES", "360")),
        request_delay_min=float(os.getenv("REQUEST_DELAY_MIN", "0.8")),
        request_delay_max=float(os.getenv("REQUEST_DELAY_MAX", "1.6")),
        output_dir=output_dir,
        debug_dir=debug_dir,
        storage_state_path=debug_dir / "storage_state.json",
    )
