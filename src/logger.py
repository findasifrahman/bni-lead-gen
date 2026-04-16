from __future__ import annotations

import logging


def setup_logging() -> logging.Logger:
    logger = logging.getLogger("bni_scraper")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
    logger.addHandler(handler)
    return logger
