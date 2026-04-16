from src.utils import parse_uuid_from_url, slugify


def test_parse_uuid_from_query() -> None:
    url = "https://www.bniconnectglobal.com/web/member?uuid=123e4567-e89b-12d3-a456-426614174000"
    assert parse_uuid_from_url(url) == "123e4567-e89b-12d3-a456-426614174000"


def test_slugify() -> None:
    assert slugify("Advertising & Marketing - Advertising Agency") == "advertising-marketing-advertising-agency"
