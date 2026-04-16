from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .utils import read_json, save_json


@dataclass(slots=True)
class ResumeState:
    processed_ids: set[str] = field(default_factory=set)

    @classmethod
    def load(cls, path: Path) -> "ResumeState":
        raw = read_json(path, {"processed_ids": []})
        return cls(processed_ids=set(raw.get("processed_ids", [])))

    def mark_done(self, key: str) -> None:
        if key:
            self.processed_ids.add(key)

    def is_done(self, key: str) -> bool:
        return bool(key) and key in self.processed_ids

    def save(self, path: Path) -> None:
        save_json(path, {"processed_ids": sorted(self.processed_ids)})
