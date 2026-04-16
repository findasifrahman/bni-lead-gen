from src.merge import merge_profile_rows


def test_merge_profile_rows_deduplicates_by_uuid_then_url() -> None:
    rows = [
        {"uuid": "u1", "profile_url": "a", "name": "First"},
        {"uuid": "u1", "profile_url": "b", "name": "Duplicate"},
        {"uuid": "", "profile_url": "c", "name": "No UUID"},
        {"uuid": "", "profile_url": "c", "name": "Duplicate URL"},
    ]

    merged = merge_profile_rows(rows)

    assert len(merged) == 2
    assert merged[0]["name"] == "First"
    assert merged[1]["name"] == "No UUID"
