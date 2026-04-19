import fs from "fs";
import path from "path";
import { repoPath } from "../lib/env";

type CategoryJsonRow = {
  label: string;
  value?: string;
  raw?: Record<string, unknown>;
};

const WORLD_COUNTRIES = [
  "Argentina",
  "Australia",
  "Austria",
  "Bahamas",
  "Bahrain",
  "Barbados",
  "Belgium",
  "Bosnia and Herzegovina",
  "Brazil",
  "Brunei",
  "Bulgaria",
  "Cambodia",
  "Canada",
  "Chile",
  "Mainland China",
  "Hong Kong, China",
  "Macau, China",
  "Taiwan, China",
  "Colombia",
  "Costa Rica",
  "Croatia",
  "Cyprus",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Ghana",
  "Greece",
  "Guatemala",
  "Hungary",
  "India",
  "Indonesia",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Kenya",
  "Laos",
  "Latvia",
  "Lebanon",
  "Lesotho",
  "Liberia",
  "Libya",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Malaysia",
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
  "Nigeria",
  "North Macedonia",
  "Norway",
  "Oman",
  "Panama",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Qatar",
  "Romania",
  "Russia Central District",
  "Saudi Arabia",
  "Singapore",
  "Slovakia",
  "Slovenia",
  "South Africa",
  "South Korea",
  "Spain (CNM)",
  "Sri Lanka",
  "Suriname",
  "Sweden",
  "Switzerland",
  "Taiwan, China",
  "Tanzania",
  "Thailand",
  "Turkey",
  "Uganda",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Vietnam",
  "Zimbabwe",
].sort((a, b) => a.localeCompare(b));

const EXTRA_COUNTRIES_AND_TERRITORIES = [
  "Antarctica"
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
    const splitBeforeKnownWords = withSpacedAmpersand
      .replace(/([a-z])([A-Z][a-z])/g, "$1 - $2")
      .replace(/([a-zA-Z])([A-Z]{2,})(?=[a-z])/g, "$1 - $2");
    const cleaned = splitBeforeKnownWords
      .replace(/Marketing([A-Z])/g, "Marketing - $1")
      .replace(/Services([A-Z])/g, "Services - $1")
      .replace(/\s+-\s+/g, " - ");
    return cleaned;
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
