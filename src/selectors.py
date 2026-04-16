from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class SelectorSet:
    css: list[str] = field(default_factory=list)
    text: list[str] = field(default_factory=list)
    role: list[tuple[str, str]] = field(default_factory=list)
    xpath: list[str] = field(default_factory=list)


# TODO: Adjust these candidate lists after the first live run using debug HTML/screenshots.
LOGIN_USERNAME = SelectorSet(
    css=[
        'input[name="username"]',
        'input[name="userName"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[type="text"]',
        'input:not([type="hidden"]):not([type="password"])',
        'input[id*="user"]',
    ],
    role=[("textbox", "username"), ("textbox", "email")],
)

LOGIN_PASSWORD = SelectorSet(
    css=[
        'input[name="password"]',
        'input[type="password"]',
    ],
)

LOGIN_SUBMIT = SelectorSet(
    css=[
        'button[type="submit"]',
        'input[type="submit"]',
        'input[type="button"]',
        'button.login',
    ],
    text=["Log In", "Login", "Sign In"],
    role=[("button", "log in"), ("button", "login"), ("button", "sign in")],
)

LOGGED_IN_SENTINELS = SelectorSet(
    css=[
        'a[href*="/web/dashboard/search"]',
        '[data-testid="dashboard-search"]',
        'nav a[href*="/dashboard"]',
    ],
    text=["Search", "Dashboard"],
)

SEARCH_COUNTRY_INPUT = SelectorSet(
    css=[
        'input[placeholder*="Country"]',
        'input[aria-label*="Country"]',
        'input[name*="country"]',
        'input[id*="country"]',
        '[aria-label*="country"] input',
        '[data-testid*="country"] input',
        '[role="combobox"][aria-label*="country"]',
        '[id*="country"] [role="combobox"]',
    ],
    text=["Country"],
    role=[("combobox", "country"), ("textbox", "country")],
)

SEARCH_KEYWORD_INPUT = SelectorSet(
    css=[
        'input[placeholder*="Keyword"]',
        'input[aria-label*="Keyword"]',
        'input[name*="keyword"]',
        'input[id*="keyword"]',
        '[aria-label*="keyword"] input',
        '[data-testid*="keyword"] input',
        '[role="combobox"][aria-label*="keyword"]',
        '[id*="keyword"] [role="combobox"]',
    ],
    text=["Keyword"],
    role=[("textbox", "keyword"), ("combobox", "keyword")],
)

SEARCH_CATEGORY_INPUT = SelectorSet(
    css=[
        'input[placeholder*="Category"]',
        'input[aria-label*="Category"]',
        'input[name*="category"]',
        'input[id*="category"]',
        '[aria-label*="category"] input',
        '[data-testid*="category"] input',
        '[role="combobox"][aria-label*="category"]',
        '[id*="category"] [role="combobox"]',
    ],
    text=["Category"],
    role=[("combobox", "category"), ("textbox", "category")],
)

CATEGORY_MENU_OPTIONS = SelectorSet(
    css=[
        '[role="option"]',
        'li[id*="option"]',
        'ul[role="listbox"] li',
        'li[role="option"]',
        '.select-option',
        '.dropdown-item',
        '.ng-option',
    ],
)

SEARCH_BUTTON = SelectorSet(
    css=[
        'button[type="submit"]',
        'button.search',
        '[data-testid*="search"]',
    ],
    text=["Search", "Apply", "Find Members"],
    role=[("button", "search"), ("button", "find members")],
)

FILTER_BUTTON = SelectorSet(
    css=[
        'button[id*="filter"]',
        '[data-testid*="filter"]',
    ],
    text=["Filter"],
    role=[("button", "filter")],
)

RESULTS_CONTAINER = SelectorSet(
    css=[
        '[role="table"]',
        '[role="grid"]',
        '.MuiTableContainer-root',
        '.MuiTable-root',
        '[data-testid*="result"]',
        '.search-results',
        '.result-list',
        '.results-list',
        '.infinite-scroll-component',
        'table tbody',
    ],
)

RESULT_ROW = SelectorSet(
    css=[
        '.MuiTableBody-root .MuiTableRow-root',
        'tr.MuiTableRow-root',
        '[role="rowgroup"] [role="row"]',
        '[role="row"]',
        '[data-testid*="member-row"]',
        '.search-result-row',
        '.member-row',
        '.result-row',
        'table tbody tr',
        '.card',
    ],
)

RESULT_PROFILE_LINK = SelectorSet(
    css=[
        'td a',
        '[role="cell"] a',
        'a[href*="/web/member"]',
        'a[href*="uuid="]',
        'a[href*="/member"]',
    ],
)

PROFILE_NAME = SelectorSet(
    css=[
        'h1',
        '.member-name',
        '[data-testid*="member-name"]',
    ],
)

PROFILE_COMPANY = SelectorSet(
    css=[
        '.company-name',
        '[data-testid*="company"]',
        'h2',
    ],
)

PROFILE_DETAIL_BLOCKS = SelectorSet(
    css=[
        '.profile-details',
        '.member-profile',
        '.profile-panel',
        '.panel-body',
        'main',
    ],
)
