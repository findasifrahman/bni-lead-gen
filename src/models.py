from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class CategoryRecord:
    label: str
    value: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class MemberIndexRecord:
    uuid: str
    profile_url: str
    name: str = ""
    company: str = ""
    city: str = ""
    category_text: str = ""
    source_country_filter: str = ""
    source_category_filter: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ProfileRecord:
    uuid: str
    profile_url: str
    name: str = ""
    company: str = ""
    email: str = ""
    phone_1: str = ""
    phone_2: str = ""
    website: str = ""
    city: str = ""
    country: str = ""
    chapter: str = ""
    professional_details: str = ""
    search_category: str = ""
    source_country_filter: str = ""
    scraped_at: str = ""
    raw_text_debug: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_export_dict(self) -> dict[str, Any]:
        return {
            "profile_url": self.profile_url,
            "name": self.name,
            "company": self.company,
            "email": self.email,
            "phone_1": self.phone_1,
            "phone_2": self.phone_2,
            "website": self.website,
            "city": self.city,
            "country": self.country,
            "chapter": self.chapter,
            "professional_details": self.professional_details,
        }
