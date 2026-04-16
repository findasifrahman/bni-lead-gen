import fs from "fs";
import path from "path";
import { repoPath } from "../lib/env";

type CategoryJsonRow = {
  label: string;
  value?: string;
  raw?: Record<string, unknown>;
};

const WORLD_COUNTRIES = [
  "Albania",
  "Algeria",
  "Andorra",
  "Angola",
  "Antigua and Barbuda",
  "Argentina",
  "Armenia",
  "Australia",
  "Austria",
  "Bahamas",
  "Bahrain",
  "Bangladesh",
  "Barbados",
  "Belarus",
  "Belgium",
  "Belize",
  "Benin",
  "Bhutan",
  "Bolivia",
  "Bosnia and Herzegovina",
  "Botswana",
  "Brazil",
  "Brunei",
  "Bulgaria",
  "Burkina Faso",
  "Burundi",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Cape Verde",
  "Central African Republic",
  "Chad",
  "Chile",
  "China",
  "Colombia",
  "Comoros",
  "Congo",
  "Costa Rica",
  "Croatia",
  "Cuba",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Djibouti",
  "Dominica",
  "Dominican Republic",
  "Ecuador",
  "Egypt",
  "El Salvador",
  "Equatorial Guinea",
  "Eritrea",
  "Estonia",
  "Eswatini",
  "Ethiopia",
  "Fiji",
  "Finland",
  "France",
  "Gabon",
  "Gambia",
  "Georgia",
  "Germany",
  "Ghana",
  "Greece",
  "Grenada",
  "Guatemala",
  "Guinea",
  "Guinea-Bissau",
  "Guyana",
  "Haiti",
  "Honduras",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Ivory Coast",
  "Jamaica",
  "Japan",
  "Kazakhstan",
  "Kenya",
  "Kiribati",
  "Kuwait",
  "Kyrgyzstan",
  "Laos",
  "Latvia",
  "Lebanon",
  "Lesotho",
  "Liberia",
  "Libya",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Madagascar",
  "Malawi",
  "Malaysia",
  "Maldives",
  "Mali",
  "Malta",
  "Marshall Islands",
  "Mauritania",
  "Mauritius",
  "Mexico",
  "Micronesia",
  "Moldova",
  "Monaco",
  "Mongolia",
  "Montenegro",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nauru",
  "Nepal",
  "Netherlands",
  "New Zealand",
  "Nicaragua",
  "Niger",
  "Nigeria",
  "North Korea",
  "North Macedonia",
  "Norway",
  "Oman",
  "Pakistan",
  "Palau",
  "Palestine",
  "Panama",
  "Papua New Guinea",
  "Paraguay",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Qatar",
  "Romania",
  "Russia",
  "Rwanda",
  "Saint Kitts and Nevis",
  "Saint Lucia",
  "Saint Vincent and the Grenadines",
  "Samoa",
  "San Marino",
  "Sao Tome and Principe",
  "Saudi Arabia",
  "Senegal",
  "Serbia",
  "Seychelles",
  "Sierra Leone",
  "Singapore",
  "Slovakia",
  "Slovenia",
  "Solomon Islands",
  "Somalia",
  "South Africa",
  "South Korea",
  "South Sudan",
  "Spain",
  "Sri Lanka",
  "Sudan",
  "Suriname",
  "Sweden",
  "Switzerland",
  "Syria",
  "Taiwan",
  "Tajikistan",
  "Tanzania",
  "Thailand",
  "Togo",
  "Tonga",
  "Trinidad and Tobago",
  "Tunisia",
  "Turkey",
  "Turkmenistan",
  "Tuvalu",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Uruguay",
  "Uzbekistan",
  "Vanuatu",
  "Vatican City",
  "Venezuela",
  "Vietnam",
  "Yemen",
  "Zambia",
  "Zimbabwe",
].sort((a, b) => a.localeCompare(b));

const EXTRA_COUNTRIES_AND_TERRITORIES = [
  "Aland Islands",
  "American Samoa",
  "Anguilla",
  "Antarctica",
  "Aruba",
  "Bermuda",
  "Bonaire, Sint Eustatius and Saba",
  "British Indian Ocean Territory",
  "British Virgin Islands",
  "Cayman Islands",
  "Christmas Island",
  "Cocos Islands",
  "Cook Islands",
  "Curacao",
  "Falkland Islands",
  "Faroe Islands",
  "French Guiana",
  "French Polynesia",
  "French Southern Territories",
  "Gibraltar",
  "Greenland",
  "Guadeloupe",
  "Guam",
  "Guernsey",
  "Hong Kong",
  "Isle of Man",
  "Jersey",
  "Kosovo",
  "Macau",
  "Martinique",
  "Mayotte",
  "Montserrat",
  "New Caledonia",
  "Niue",
  "Norfolk Island",
  "Northern Mariana Islands",
  "Pitcairn Islands",
  "Puerto Rico",
  "Reunion",
  "Saint Barthelemy",
  "Saint Helena",
  "Saint Martin",
  "Saint Pierre and Miquelon",
  "Sint Maarten",
  "Tokelau",
  "Turks and Caicos Islands",
  "U.S. Virgin Islands",
  "Wallis and Futuna",
  "Western Sahara",
];

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function getCountries(query = ""): string[] {
  const outputDir = repoPath("output");
  const countries = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name.replace(/-/g, " "))
    : [];

  const normalizeCountryLabel = (value: string) => value.trim().replace(/\s+/g, " ");
  const preference = new Map<string, string>();
  for (const country of [...WORLD_COUNTRIES, ...EXTRA_COUNTRIES_AND_TERRITORIES, ...countries]) {
    const normalized = normalizeCountryLabel(country);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!preference.has(key)) {
      preference.set(key, normalized);
    }
  }

  const merged = Array.from(preference.values()).sort((a, b) => a.localeCompare(b));
  if (!query.trim()) return merged.sort((a, b) => a.localeCompare(b));
  const needle = query.trim().toLowerCase();
  return merged.filter((country) => country.toLowerCase().includes(needle)).sort((a, b) => a.localeCompare(b));
}

export function getCountryItems(query = ""): CategoryJsonRow[] {
  return getCountries(query)
    .map((label) => ({ label, value: label }))
    .filter((item) => item.label.trim().length > 0);
}

export function getCategories(query = ""): CategoryJsonRow[] {
  const categoriesPath = repoPath("output", "categories.json");
  const rows = safeReadJson<CategoryJsonRow[]>(categoriesPath, []);
  const normalizeLabel = (label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return "";
    if (trimmed.includes(" - ")) return trimmed;
    const withSpacedAmpersand = trimmed.replace(/\s*&\s*/g, " & ");
    const glued = withSpacedAmpersand.replace(/([a-z])([A-Z])/g, "$1 - $2");
    if (glued.includes(" - ")) return glued.replace(/\s+-\s+/g, " - ");
    return withSpacedAmpersand;
  };
  const normalized = (rows.length
    ? rows
    : [
        { label: "Advertising & Marketing - Advertising Agency" },
        { label: "Advertising & Marketing - Branding" },
        { label: "Advertising & Marketing - Copywriter/Writer" },
      ]
  )
    .map((item) => ({
      label: normalizeLabel(item.label ?? ""),
      value: normalizeLabel(item.value?.trim() || item.label?.trim() || ""),
    }))
  .filter((item) => item.label.length > 0)
  .filter((item, index, array) => array.findIndex((candidate) => candidate.label === item.label) === index);

  if (!query.trim()) return normalized;
  const needle = query.trim().toLowerCase();
  return normalized.filter((item) => item.label.toLowerCase().includes(needle));
}

export function makeLeadFilename(userId: string, country: string, category: string, keyword: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const bits = [userId, country, category || "country-only", keyword || "keyword"];
  const safe = bits
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean)
    .join("_");
  return `${stamp}_${safe || "lead-generation"}.csv`;
}
