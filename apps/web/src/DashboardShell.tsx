import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { apiBaseUrl, apiRequest } from "./lib/api";
import type { CreditApplication, LeadRequest, MailCampaign, MailRecipient, PublicUser } from "./types";
import { SendMailTab } from "./SendMailTab";

type DashboardTab = "home" | "leads" | "send-mail" | "account" | "settings" | "admin";

type DashboardSummary = {
  user: PublicUser;
  activeLeadRequest: LeadRequest | null;
  lastLeadRequest: LeadRequest | null;
};

type AccountResponse = {
  user: PublicUser;
  applications: CreditApplication[];
};

type SettingsResponse = {
  settings: {
    bniUsername: string;
    bniPassword: string;
    hasBniPassword: boolean;
    sendingEmail: string;
    sendingAppPassword: string;
    hasSendingAppPassword: boolean;
    maxProfileConcurrency: number;
    maxCountryProfiles: number;
    requestDelayMin: number;
    requestDelayMax: number;
    headless: boolean;
  };
};

type AdminUsersResponse = {
  items: Array<
    PublicUser & {
      currentLeadRequestId: string | null;
      createdAt: string;
    }
  >;
};

type AdminCreditApplicationsResponse = {
  items: Array<
    CreditApplication & {
      user: PublicUser;
    }
  >;
};

type AdminDashboardResponse = {
  users: AdminUsersResponse["items"];
  applications: AdminCreditApplicationsResponse["items"];
};

type MailCampaignsResponse = {
  items: MailCampaign[];
};

type ReferenceItem = string | {
  label: string;
  value?: string;
};

type NormalizedReferenceItem = {
  label: string;
  value: string;
};

type FilterForm = {
  keyword: string;
  country: string;
  category: string;
};

type PreflightEstimate = {
  totalLeads: number;
  requiredCredits: number;
  estimatedMinutes: number;
};

const defaultFilterForm: FilterForm = {
  keyword: "",
  country: "",
  category: "",
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

function leadStatusLabel(status: LeadRequest["status"]) {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "COMPLETED":
      return "Completed";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed";
    default:
      return status;
  }
}

function statusTone(status: LeadRequest["status"] | string) {
  switch (status) {
    case "QUEUED":
      return "warning";
    case "COMPLETED":
      return "success";
    case "RUNNING":
      return "warning";
    case "FAILED":
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

function currencyLike(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function shortRequestMessage(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const clean = value.trim();
  if (!clean) return fallback;
  if (clean.includes("Traceback (most recent call last):")) {
    const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lastMeaningful = [...lines].reverse().find((line) => !line.startsWith("File ") && !line.startsWith("^") && !line.startsWith("Traceback"));
    return lastMeaningful || fallback;
  }
  if (clean.length > 220) {
    return clean.slice(0, 220).trimEnd() + "...";
  }
  return clean;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    spark: <path d="M13 3l1.7 5.3L20 10l-5.3 1.7L13 17l-1.7-5.3L6 10l5.3-1.7L13 3z" />,
    search: <path d="M11 4a7 7 0 105.29 12.29l3.71 3.71 1.41-1.41-3.71-3.71A7 7 0 0011 4zm0 2a5 5 0 110 10 5 5 0 010-10z" />,
    filter: <path d="M3 5h18v2l-7 7v5l-4 2v-7L3 7V5z" />,
    menu: <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />,
    home: <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z" />,
    leads: <path d="M6 4h12v2H6V4zm0 4h12v2H6V8zm0 4h8v2H6v-2zm0 4h8v2H6v-2z" />,
    account: <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 1114 0H5z" />,
    settings: <path d="M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm8 3.5l-2.2-.4a6.9 6.9 0 00-.6-1.5l1.4-1.7-2.1-2.1-1.7 1.4a6.9 6.9 0 00-1.5-.6L13.5 4h-3l-.4 2.2c-.5.1-1 .3-1.5.6L6.9 5.4 4.8 7.5l1.4 1.7c-.3.5-.5 1-.6 1.5L3.4 12l.2 3 2.2.4c.1.5.3 1 .6 1.5L5 18.6l2.1 2.1 1.7-1.4c.5.3 1 .5 1.5.6l.4 2.2h3l.4-2.2c.5-.1 1-.3 1.5-.6l1.7 1.4 2.1-2.1-1.4-1.7c.3-.5.5-1 .6-1.5l2.2-.4v-3z" />,
    admin: <path d="M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6l9-4zm0 4.3L6 8v4c0 3.7 2.5 6.7 6 7.7 3.5-1 6-4 6-7.7V8l-6-1.7z" />,
    logout: <path d="M10 17l1.4-1.4L8.8 13H20v-2H8.8l2.6-2.6L10 7l-5 5 5 5zM4 5h8V3H4a2 2 0 00-2 2v14a2 2 0 002 2h8v-2H4V5z" />,
    eye: <path d="M12 5c5.5 0 9.8 3.4 11.7 7.5C21.8 16.6 17.5 20 12 20S2.2 16.6.3 12.5C2.2 8.4 6.5 5 12 5zm0 2C7.8 7 4.3 9.6 2.7 12.5 4.3 15.4 7.8 18 12 18s7.7-2.6 9.3-5.5C19.7 9.6 16.2 7 12 7zm0 2.5a3 3 0 110 6 3 3 0 010-6z" />,
    "eye-off": <path d="M2.2 3.8L1 5l3 3C2.5 10 1.3 11.9.3 12.5 2.2 16.6 6.5 20 12 20c1.6 0 3.1-.2 4.4-.7l2.5 2.5 1.2-1.2-18-18zM12 7c1 0 2 .3 2.8.8l-1.6 1.6A3 3 0 0012 9a3 3 0 00-3 3c0 .3 0 .6.1.8L7.5 14.4A4.9 4.9 0 017 12a5 5 0 015-5zm9.7 5.5C19.7 9.6 16.2 7 12 7c-.6 0-1.2 0-1.7.1l1.7 1.7c0 .1 0 .1 0 .2a3 3 0 013 3c0 .1 0 .3-.1.4l2 2C17.8 13.8 19 12.9 21.7 12.5z" />,
    download: <path d="M12 3v10m0 0l4-4m-4 4l-4-4M5 19h14v2H5z" />,
    wallet: <path d="M4 7a3 3 0 013-3h13v4h-4a2 2 0 000 4h4v8H7a3 3 0 01-3-3V7zm16 7h-3a1 1 0 010-2h3v2z" />,
    shield: <path d="M12 2l8 3v6c0 5.2-3.5 9.4-8 11-4.5-1.6-8-5.8-8-11V5l8-3zm0 4L6 8v3.2c0 3.8 2.4 6.8 6 8 3.6-1.2 6-4.2 6-8V8l-6-2z" />,
    clock: <path d="M11 6h2v6l5 3-1 1.7-6-3.7V6zm1-4a10 10 0 100 20 10 10 0 000-20z" />,
    check: <path d="M9 16.2l-3.5-3.6L4 14.1l5 5 11-11-1.4-1.4z" />,
    close: <path d="M6.4 5l-.9.9L11.1 11l-5.6 5.6.9.9L12 11.9l5.6 5.6.9-.9L12.9 11 18.5 5.4l-.9-.9L12 10.1z" />,
    mail: <path d="M4 6h16v12H4V6zm2 2v.3l6 4.2 6-4.2V8l-6 4.2L6 8zm0 8V10.6l6 4.2 6-4.2V16H6z" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name] ?? <circle cx="12" cy="12" r="10" />}
    </svg>
  );
}

function Button({
  children,
  variant = "primary",
  disabled,
  onClick,
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button type={type} className={`btn btn-${variant} ${className}`.trim()} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Card({
  title,
  subtitle,
  icon,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  icon?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || subtitle) && (
        <div className="card-head">
          <div>
            {title && <h2>{icon ? <><Icon name={icon} /> {title}</> : title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Badge({ tone, children }: { tone: "success" | "warning" | "danger" | "neutral"; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function resolveReferenceLabel(value: string, options: ReferenceItem[]) {
  if (!value) return "";
  const match = options.find((item) => {
    if (typeof item === "string") return item === value;
    return (item.value ?? item.label) === value;
  });
  if (!match) return value;
  return typeof match === "string" ? match : match.label;
}

function normalizeReferenceItems(options: ReferenceItem[]) {
  return options
    .map((item) => {
      if (typeof item === "string") {
        const value = item.trim();
        return value ? { label: value, value } : null;
      }
      const label = item.label?.trim() ?? "";
      const value = item.value?.trim() || label;
      return label ? { label, value } : null;
    })
    .filter((item): item is NormalizedReferenceItem => Boolean(item))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.label === item.label) === index);
}

function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string;
  value: string;
  onClear: () => void;
}) {
  return (
    <span className="filter-chip">
      <span className="filter-chip-label">{label}</span>
      <span className="filter-chip-value">{value}</span>
      <button type="button" className="filter-chip-clear" onClick={onClear} aria-label={`Clear ${label}`}>
        <Icon name="close" />
      </button>
    </span>
  );
}

function FilterChips({
  keyword,
  country,
  category,
  countryOptions,
  categoryOptions,
  onClearKeyword,
  onClearCountry,
  onClearCategory,
  onClearAll,
}: {
  keyword: string;
  country: string;
  category: string;
  countryOptions: ReferenceItem[];
  categoryOptions: ReferenceItem[];
  onClearKeyword: () => void;
  onClearCountry: () => void;
  onClearCategory: () => void;
  onClearAll: () => void;
}) {
  const chips = [
    keyword.trim()
      ? {
          label: "Keyword",
          value: keyword.trim(),
          onClear: onClearKeyword,
        }
      : null,
    country.trim()
      ? {
          label: "Country",
          value: resolveReferenceLabel(country.trim(), countryOptions),
          onClear: onClearCountry,
        }
      : null,
    category.trim()
      ? {
          label: "Category",
          value: resolveReferenceLabel(category.trim(), categoryOptions),
          onClear: onClearCategory,
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string; onClear: () => void }>;

  if (!chips.length) return null;

  return (
    <div className="filter-chip-bar">
      <div className="filter-chip-row">
        {chips.map((chip) => (
          <FilterChip key={`${chip.label}:${chip.value}`} label={chip.label} value={chip.value} onClear={chip.onClear} />
        ))}
      </div>
      <button type="button" className="link-button filter-clear-all" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}

function ComboBox({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReferenceItem[];
  placeholder?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const filtered = useMemo(() => {
    const normalized = normalizeReferenceItems(options);
    const query = value.trim().toLowerCase();
    if (showAll || !query) return normalized;
    return normalized.filter((item) => item.label.toLowerCase().includes(query));
  }, [options, value, showAll]);

  return (
    <label className={`field combo-field ${open ? "combo-open" : ""}`}>
      <span className="field-label">{label}</span>
      <div className="combo-shell">
        <input
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            setShowAll(false);
            onChange(event.target.value);
          }}
          onFocus={() => {
            setOpen(true);
            setShowAll(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="input"
          autoComplete="off"
          spellCheck={false}
        />
        <div className={`combo-menu ${open ? "open" : ""}`}>
          {filtered.length ? (
            filtered.map((item, index) => (
              <button
                key={`${label}-${item.value ?? item.label}-${index}`}
                type="button"
                className="combo-item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setShowAll(true);
                  onChange(item.value ?? item.label);
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            ))
          ) : (
            <div className="combo-empty">No matches found.</div>
          )}
        </div>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function StatTile({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  icon?: string;
  tone?: "neutral" | "accent";
}) {
  return (
    <div className={`stat-tile ${tone === "accent" ? "accent" : ""}`}>
      <div className="stat-icon">{icon ? <Icon name={icon} /> : <Icon name="spark" />}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

type DashboardShellProps = {
  token: string;
  user: PublicUser;
  onLogout: () => void;
};

export function DashboardShell({ token, user, onLogout }: DashboardShellProps) {
  const isAdmin = user.role === "ADMIN";
  const [activeTab, setActiveTab] = useState<DashboardTab>(isAdmin ? "admin" : "home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");
  const [countryOptions, setCountryOptions] = useState<ReferenceItem[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<ReferenceItem[]>([]);
  const [leadRequests, setLeadRequests] = useState<LeadRequest[]>([]);
  const [mailCampaigns, setMailCampaigns] = useState<MailCampaign[]>([]);
  const [leadSearch, setLeadSearch] = useState("");
  const [leadFrom, setLeadFrom] = useState("");
  const [leadTo, setLeadTo] = useState("");
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse["settings"] | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUsersResponse["items"]>([]);
  const [adminCreditApplications, setAdminCreditApplications] = useState<AdminCreditApplicationsResponse["items"]>([]);
  const [loadingTab, setLoadingTab] = useState(false);

  const loadSummary = async () => {
    setSummaryError("");
    const result = await apiRequest<DashboardSummary>("/api/dashboard/summary", { token });
    setSummary(result);
  };

  const loadReferenceData = async () => {
    const [countries, categories] = await Promise.all([
      apiRequest<{ items: ReferenceItem[] }>("/reference/countries", { token }),
      apiRequest<{ items: ReferenceItem[] }>("/reference/categories", { token }),
    ]);
    setCountryOptions(countries.items);
    setCategoryOptions(categories.items);
  };

  const loadLeads = async () => {
    const query = new URLSearchParams();
    if (leadSearch.trim()) query.set("search", leadSearch.trim());
    if (leadFrom) query.set("from", leadFrom);
    if (leadTo) query.set("to", leadTo);
    const result = await apiRequest<{ items: LeadRequest[] }>(`/api/lead-requests?${query.toString()}`, { token });
    setLeadRequests(result.items.filter((item) => item.status === "COMPLETED"));
  };

  const loadMailCampaigns = async () => {
    const result = await apiRequest<MailCampaignsResponse>("/api/mail-campaigns", { token });
    setMailCampaigns(result.items);
  };

  const hasActiveMailCampaign = useMemo(
    () => mailCampaigns.some((campaign) => campaign.status === "QUEUED" || campaign.status === "RUNNING"),
    [mailCampaigns]
  );

  const deleteLead = async (id: string) => {
    await apiRequest<{ message: string }>(`/api/generated-leads/${id}`, {
      method: "DELETE",
      token,
    });
    await loadLeads();
  };

  const downloadLead = async (row: LeadRequest) => {
    const response = await fetch(`${apiBaseUrl()}/api/generated-leads/${row.id}/download`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(payload || "Unable to download file");
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = row.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  };

  const loadAccount = async () => {
    const result = await apiRequest<AccountResponse>("/api/account", { token });
    setAccount(result);
  };

  const loadSettings = async () => {
    const result = await apiRequest<SettingsResponse>("/api/settings", { token });
    setSettings(result.settings);
  };

  const loadAdmin = async () => {
    const [users, applications] = await Promise.all([
      apiRequest<AdminUsersResponse>("/api/admin/users", { token }),
      apiRequest<AdminCreditApplicationsResponse>("/api/admin/credit-applications", { token }),
    ]);
    setAdminUsers(users.items);
    setAdminCreditApplications(applications.items);
  };

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      try {
        setSummaryLoading(true);
        await loadSummary();
        if (!mounted) return;
        await loadReferenceData();
      } catch (err) {
        if (!mounted) return;
        setSummaryError(err instanceof Error ? err.message : "Unable to load dashboard");
      } finally {
        if (mounted) setSummaryLoading(false);
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [token]);

  useEffect(() => {
    if (!summary?.activeLeadRequest || ["COMPLETED", "FAILED", "CANCELLED"].includes(summary.activeLeadRequest.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadSummary().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [summary?.activeLeadRequest?.id, summary?.activeLeadRequest?.status, token]);

  useEffect(() => {
    if (!hasActiveMailCampaign) return;
    const timer = window.setInterval(() => {
      void loadMailCampaigns().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveMailCampaign, token]);

  useEffect(() => {
    const load = async () => {
      try {
        setLoadingTab(true);
        if (activeTab === "leads" || activeTab === "send-mail") await loadLeads();
        if (activeTab === "send-mail") await loadMailCampaigns();
        if (activeTab === "account") await loadAccount();
        if (activeTab === "settings") await loadSettings();
        if (activeTab === "admin" && user.role === "ADMIN") await loadAdmin();
      } finally {
        setLoadingTab(false);
      }
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user.role, token]);

  const currentLeadRequest = summary?.activeLeadRequest ?? null;
  const isRunning = Boolean(currentLeadRequest && (currentLeadRequest.status === "RUNNING" || currentLeadRequest.status === "QUEUED"));
  const isQueued = Boolean(currentLeadRequest && currentLeadRequest.status === "QUEUED");
  const canCancel = isRunning || isQueued;

  const sidebarItems: Array<{ id: DashboardTab; label: string; icon: string }> = isAdmin
    ? [{ id: "admin", label: "Admin", icon: "admin" }]
    : [
        { id: "home", label: "Home", icon: "home" },
        { id: "leads", label: "View Generated Leads", icon: "leads" },
        { id: "send-mail", label: "Send Mail", icon: "mail" },
        { id: "account", label: "Account", icon: "wallet" },
        { id: "settings", label: "Settings", icon: "settings" },
      ];

  const closeMobileNav = () => setMobileNavOpen(false);

  return (
    <div className="app-shell">
      {mobileNavOpen && <button type="button" className="sidebar-overlay" aria-label="Close menu" onClick={closeMobileNav} />}
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div>
          <div className="sidebar-brand">
            <div className="sidebar-brand-row">
              <div className="brand-mark">
                <span className="brand-dot" />
                <span>BNI Lead Gen</span>
              </div>
              <button type="button" className="icon-button sidebar-close" onClick={closeMobileNav} aria-label="Close navigation">
                <Icon name="close" />
              </button>
            </div>
            <p>Deliverable credit-based lead generation.</p>
          </div>
          <nav className="side-nav">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activeTab === item.id ? "active" : ""}`}
                onClick={() => {
                  setActiveTab(item.id);
                  closeMobileNav();
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="side-user">
            <strong>{user.fullName || user.email}</strong>
            <span>{user.role}</span>
          </div>
          <Button variant="ghost" onClick={onLogout}>
            <Icon name="logout" /> Sign out
          </Button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="topbar-copy">
            <div className="topbar-row">
              <button
                type="button"
                className="icon-button menu-button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation"
              >
                <Icon name="menu" />
              </button>
              <div>
                <p className="eyebrow">Premium BNI lead dashboard</p>
                <h1>Welcome back, {user.fullName || user.email}</h1>
              </div>
            </div>
            <p className="subtle">
              Secure, credit-driven scraping with organized CSV delivery and PostgreSQL-backed history.
            </p>
          </div>
          <div className="topbar-actions">
            {!isAdmin && (
              <div className="topbar-stats">
                <StatTile label="Credits available" value={summary?.user.creditsAvailable ?? user.creditsAvailable} icon="wallet" />
                <StatTile
                  label="Current job"
                  value={currentLeadRequest ? leadStatusLabel(currentLeadRequest.status) : "Idle"}
                  icon="clock"
                  tone="accent"
                />
              </div>
            )}
            <Button variant="ghost" onClick={onLogout} className="signout-button">
              <Icon name="logout" /> Sign out
            </Button>
          </div>
        </header>

        {summaryLoading && <div className="loading-banner">Loading your workspace...</div>}
        {summaryError && <div className="alert alert-error">{summaryError}</div>}

        {activeTab === "home" && (
          <HomeTab
            token={token}
            user={summary?.user ?? user}
            currentLeadRequest={currentLeadRequest}
            lastLeadRequest={summary?.lastLeadRequest ?? null}
            isRunning={isRunning}
            canCancel={canCancel}
            countryOptions={countryOptions}
            categoryOptions={categoryOptions}
            onReload={loadSummary}
          />
        )}

        {activeTab === "leads" && (
          <LeadsTab
            rows={leadRequests}
            loading={loadingTab}
            search={leadSearch}
            from={leadFrom}
            to={leadTo}
            onSearchChange={setLeadSearch}
            onFromChange={setLeadFrom}
            onToChange={setLeadTo}
            onRefresh={loadLeads}
            onDelete={deleteLead}
            onDownload={downloadLead}
          />
        )}

        {activeTab === "send-mail" && (
          <SendMailTab
            token={token}
            user={summary?.user ?? user}
            leadRequests={leadRequests}
            campaigns={mailCampaigns}
            onRefresh={loadMailCampaigns}
          />
        )}

        {activeTab === "account" && (
          <AccountTab
            token={token}
            account={account}
            onRefresh={loadAccount}
            user={summary?.user ?? user}
          />
        )}

        {activeTab === "settings" && (
          <SettingsTab
            token={token}
            settings={settings}
            onRefresh={loadSettings}
          />
        )}

        {activeTab === "admin" && user.role === "ADMIN" && (
          <AdminTab
            token={token}
            users={adminUsers}
            applications={adminCreditApplications}
            onRefresh={loadAdmin}
          />
        )}

        <footer className="footer">
          <div className="footer-brand">
            <strong>BNI Lead Gen</strong>
            <p>Creating lead with precision.</p>
          </div>
          <div className="footer-links">
            <a href="#">Website</a>
            <a href="#">Docs</a>
            <a href="#">Support</a>
          </div>
          <div className="footer-meta">
            <p>Developer info: asifrahman.</p>
            <p>Contact: info@malishagroup.com</p>
          </div>
        </footer>
      </main>
    </div>
  );
}

function HomeTab({
  token,
  user,
  currentLeadRequest,
  lastLeadRequest,
  isRunning,
  canCancel,
  countryOptions,
  categoryOptions,
  onReload,
}: {
  token: string;
  user: PublicUser;
  currentLeadRequest: LeadRequest | null;
  lastLeadRequest: LeadRequest | null;
  isRunning: boolean;
  canCancel: boolean;
  countryOptions: ReferenceItem[];
  categoryOptions: ReferenceItem[];
  onReload: () => Promise<void>;
}) {
  const [form, setForm] = useState<FilterForm>(defaultFilterForm);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preflight, setPreflight] = useState<PreflightEstimate | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const keywordTrimmed = form.keyword.trim();
  const countryTrimmed = form.country.trim();
  const categoryTrimmed = form.category.trim();
  const hasAnyFilter = Boolean(keywordTrimmed || countryTrimmed || categoryTrimmed);
  const hasInvalidKeyword = Boolean(keywordTrimmed && keywordTrimmed.length < 2);
  const visibleRequest = currentLeadRequest ?? lastLeadRequest;
  const hasPreflightMatches = Boolean(preflight && preflight.totalLeads > 0);
  const isCompleted = Boolean(visibleRequest && visibleRequest.status === "COMPLETED");
  const creditsLabel = isCompleted ? "Credits charged" : "Maximum reserved";
  const creditsValue = visibleRequest?.requiredCredits ?? preflight?.requiredCredits ?? null;
  const isFiltering = preflightLoading || submitting;

  useEffect(() => {
    if (!visibleRequest) {
      setMessage("");
      return;
    }
    if (visibleRequest.status === "COMPLETED" && visibleRequest.totalLeads === 0) {
      setMessage(
        shortRequestMessage(
          visibleRequest.errorMessage,
          "No matching profiles were found for the selected filters."
        )
      );
      return;
    }
    if (visibleRequest.status === "FAILED" && !currentLeadRequest) {
      setMessage(shortRequestMessage(visibleRequest.errorMessage, "Last request failed."));
      return;
    }
    setMessage(`Current request is ${leadStatusLabel(visibleRequest.status)}.`);
  }, [visibleRequest, currentLeadRequest]);

  const runPreflight = async () => {
    if (!hasAnyFilter) {
      setError("Select at least one filter: keyword, country, or category.");
      return;
    }
    if (hasInvalidKeyword) {
      setError("Keyword must be empty or at least 2 characters.");
      return;
    }
    setPreflightLoading(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest<{ estimate: PreflightEstimate; message: string }>("/api/lead-requests/preflight", {
        method: "POST",
        token,
        body: JSON.stringify(form),
      });
      setPreflight(result.estimate);
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to estimate generation");
    } finally {
      setPreflightLoading(false);
    }
  };

  const confirmStart = async () => {
    if (!hasAnyFilter || !preflight || preflight.totalLeads <= 0) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await apiRequest<{ item: LeadRequest; message: string }>("/api/lead-requests", {
        method: "POST",
        token,
        body: JSON.stringify(form),
      });
      setMessage(result.message);
      setPreflight(null);
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start generation");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRequest = async () => {
    if (!visibleRequest) return;
    setSubmitting(true);
    setError("");
    try {
      await apiRequest<{ message: string }>("/api/lead-requests/" + visibleRequest.id + "/cancel", {
        method: "POST",
        token,
      });
      setPreflight(null);
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel request");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="page-grid">
      <Card
        title="How the flow works"
        subtitle="Choose filters, then generation starts and updates live."
        icon="spark"
        className="hero-card"
      >
        <ol className="steps">
          <li>Enter a keyword, country, and category.</li>
          <li>Click Filter to start lead generation.</li>
          <li>Watch the total leads and credits update as profiles with emails are written.</li>
          <li>Download the finished CSV from View Generated Leads.</li>
        </ol>
        <div className="hero-metrics">
          <StatTile label="Credits available" value={currencyLike(user.creditsAvailable)} icon="wallet" tone="accent" />
          <StatTile label="Active status" value={currentLeadRequest ? leadStatusLabel(currentLeadRequest.status) : "Ready"} icon="shield" />
        </div>
      </Card>

      <Card title="Lead generator" subtitle="Use the same filters as BNI Connect." icon="filter">
        <FilterChips
          keyword={form.keyword}
          country={form.country}
          category={form.category}
          countryOptions={countryOptions}
          categoryOptions={categoryOptions}
          onClearKeyword={() => setForm((prev) => ({ ...prev, keyword: "" }))}
          onClearCountry={() => setForm((prev) => ({ ...prev, country: "" }))}
          onClearCategory={() => setForm((prev) => ({ ...prev, category: "" }))}
          onClearAll={() => setForm(defaultFilterForm)}
        />
        <div className="form-grid">
          <Field label="Keyword" hint="Optional search term.">
            <input
              className="input"
              value={form.keyword}
              onChange={(event) => setForm((prev) => ({ ...prev, keyword: event.target.value }))}
              placeholder="Enter a keyword"
            />
          </Field>
          <ComboBox
            label="Country"
            value={form.country}
            onChange={(value) => setForm((prev) => ({ ...prev, country: value }))}
            options={countryOptions}
            placeholder="Select or type a country"
            hint="Country names are searchable and editable."
          />
          <ComboBox
            label="By category"
            value={form.category}
            onChange={(value) => setForm((prev) => ({ ...prev, category: value }))}
            options={categoryOptions}
            placeholder="Select or type a category"
            hint="Matches the BNI Connect category list."
          />
        </div>

        <div className="action-row">
          <Button variant="secondary" disabled={isRunning || preflightLoading || submitting} onClick={runPreflight}>
            {isFiltering ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="filter" />}{" "}
            {preflightLoading ? "Filtering..." : "Filter"}
          </Button>
          <Button variant="danger" disabled={!canCancel || submitting || preflightLoading} onClick={cancelRequest}>
            <Icon name="close" /> Cancel
          </Button>
          <Button variant="ghost" disabled={isFiltering} onClick={() => void onReload()}>
            <Icon name="clock" /> Reload
          </Button>
        </div>

        {preflight && (
          <div className="empty-state-card warning">
            {hasPreflightMatches ? (
              <>
                <div>
                  <strong>Review before starting</strong>
                  <p>
                    Maximum reserved: {currencyLike(preflight.requiredCredits)} credits. We found {currencyLike(preflight.totalLeads)} profile
                    matches that can be extracted into the final CSV.
                  </p>
                  <p>Estimated completion: ~{preflight.estimatedMinutes} min.</p>
                </div>
                <div className="action-row">
                  <Button variant="primary" disabled={submitting} onClick={confirmStart}>
                    <Icon name="check" /> OK, start now
                  </Button>
                  <Button variant="ghost" disabled={submitting} onClick={() => setPreflight(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <strong>No matching profiles found</strong>
                  <p>No matching member rows were found for the selected filters, so nothing will be deducted.</p>
                </div>
                <Button variant="ghost" disabled={submitting} onClick={() => setPreflight(null)}>
                  Close
                </Button>
              </>
            )}
          </div>
        )}

        {visibleRequest && visibleRequest.status === "COMPLETED" && visibleRequest.totalLeads === 0 && (
          <div className="empty-state-card warning">
            <strong>No email profiles found</strong>
            <p>{visibleRequest.errorMessage || "The selected filters did not return any usable email profiles."}</p>
          </div>
        )}

        {message && <div className="alert alert-success">{message}</div>}
        {error && <div className="alert alert-error">{error}</div>}

        <div className="result-panel">
          <div>
            <span className="field-hint">Queue status</span>
            <Badge tone={currentLeadRequest ? statusTone(currentLeadRequest.status) : "neutral"}>
              {currentLeadRequest ? leadStatusLabel(currentLeadRequest.status) : "Idle"}
            </Badge>
          </div>
          <div>
            <span className="field-hint">Current request</span>
            <strong>{currentLeadRequest ? currentLeadRequest.filename : "No request running"}</strong>
          </div>
          <div>
            <span className="field-hint">Total leads found</span>
            <strong>{currentLeadRequest ? currencyLike(currentLeadRequest.totalLeads) : "-"}</strong>
          </div>
          <div>
            <span className="field-hint">{creditsLabel}</span>
            <strong>{creditsValue != null ? currencyLike(creditsValue) : "-"}</strong>
          </div>
          <div>
            <span className="field-hint">Estimated completion</span>
            <strong>
              {currentLeadRequest && currentLeadRequest.estimatedMinutes
                ? `~${currentLeadRequest.estimatedMinutes} min`
                : "-"}
            </strong>
          </div>
        </div>

        <div className="info-callout">
          <Icon name="shield" />
          <p>
            While a request is running, new requests stay blocked. You can cancel an active request at any time.
          </p>
        </div>
      </Card>
    </div>
  );
}

function LeadsTab({
  rows,
  loading,
  search,
  from,
  to,
  onSearchChange,
  onFromChange,
  onToChange,
  onRefresh,
  onDelete,
  onDownload,
}: {
  rows: LeadRequest[];
  loading: boolean;
  search: string;
  from: string;
  to: string;
  onSearchChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDownload: (row: LeadRequest) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState("");

  const runSearch = async () => {
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (id: string) => {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId("");
    }
  };

  const downloadRow = async (row: LeadRequest) => {
    setBusy(true);
    try {
      await onDownload(row);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="View generated leads" subtitle="Search by filename and date range." icon="leads">
      <div className="toolbar">
        <Field label="Filename or keyword">
          <input className="input" value={search} onChange={(event) => onSearchChange(event.target.value)} />
        </Field>
        <Field label="From date">
          <input className="input" type="date" value={from} onChange={(event) => onFromChange(event.target.value)} />
        </Field>
        <Field label="To date">
          <input className="input" type="date" value={to} onChange={(event) => onToChange(event.target.value)} />
        </Field>
        <Button variant="secondary" onClick={runSearch} disabled={busy || loading}>
          <Icon name="search" /> Search
        </Button>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Filename</th>
              <th>Country</th>
              <th>Category</th>
              <th>Leads</th>
              <th>Credits</th>
              <th>Download</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.completedAt || row.requestedAt)}</td>
                <td>{row.filename}</td>
                <td>{row.country}</td>
                <td>{row.category || "-"}</td>
                <td>{currencyLike(row.totalLeads)}</td>
                <td>{currencyLike(row.requiredCredits)}</td>
                <td>
                  <Button variant="ghost" disabled={busy} onClick={() => downloadRow(row)}>
                    <Icon name="download" /> CSV
                  </Button>
                </td>
                <td>
                  <Button variant="ghost" disabled={deletingId === row.id} onClick={() => deleteRow(row.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8}>{loading ? "Loading generated leads..." : "No completed CSV files yet."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AccountTab({
  token,
  account,
  onRefresh,
  user,
}: {
  token: string;
  account: AccountResponse | null;
  onRefresh: () => Promise<void>;
  user: PublicUser;
}) {
  const [requestedCredits, setRequestedCredits] = useState(200);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await apiRequest<{ application: CreditApplication; message: string }>(
        "/api/account/credit-applications",
        {
          method: "POST",
          token,
          body: JSON.stringify({ requestedCredits, note }),
        }
      );
      setMessage(result.message);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to apply for credit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-grid">
      <Card title="Credits remaining" subtitle="Every 1 credit equals 2 lead generations." icon="wallet">
        <div className="hero-metrics">
          <StatTile label="Available" value={currencyLike(account?.user.creditsAvailable ?? user.creditsAvailable)} icon="wallet" tone="accent" />
          <StatTile label="Reserved" value={currencyLike(account?.user.creditsReserved ?? user.creditsReserved)} icon="shield" />
          <StatTile label="Balance" value={currencyLike(account?.user.creditsBalance ?? user.creditsBalance)} icon="spark" />
        </div>
      </Card>

      <Card title="Apply for credit" subtitle="Minimum 200 and maximum 5000 per request." icon="mail">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Requested credits">
            <input
              className="input"
              type="number"
              min={200}
              max={5000}
              value={requestedCredits}
              onChange={(event) => setRequestedCredits(Number(event.target.value))}
            />
          </Field>
          <Field label="Request note" hint="Tell the admin why you need more credits.">
            <textarea className="input textarea" value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {message && <div className="alert alert-success">{message}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          <Button type="submit" disabled={saving}>
            Apply now
          </Button>
        </form>
      </Card>

      <Card title="Credit requests" subtitle="Your submitted applications appear here." icon="leads">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Credits</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(account?.applications ?? []).map((item) => (
                <tr key={item.id}>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td>{currencyLike(item.requestedCredits)}</td>
                  <td>
                    <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                  </td>
                  <td>{item.note || "-"}</td>
                </tr>
              ))}
              {!account?.applications?.length && (
                <tr>
                  <td colSpan={4}>No credit applications yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SettingsTab({
  token,
  settings,
  onRefresh,
}: {
  token: string;
  settings: SettingsResponse["settings"] | null;
  onRefresh: () => Promise<void>;
}) {
  const [bniUsername, setBniUsername] = useState("");
  const [bniPassword, setBniPassword] = useState("");
  const [showBniPassword, setShowBniPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [sendingEmail, setSendingEmail] = useState("");
  const [sendingAppPassword, setSendingAppPassword] = useState("");
  const [showSendingAppPassword, setShowSendingAppPassword] = useState(false);
  const [sendingPasswordLoading, setSendingPasswordLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setBniUsername(settings.bniUsername);
      setSendingEmail(settings.sendingEmail);
      setBniPassword("");
      setSendingAppPassword("");
      setShowBniPassword(false);
      setShowSendingAppPassword(false);
    }
  }, [settings]);

  const revealBniPassword = async () => {
    if (showBniPassword) {
      setShowBniPassword(false);
      return;
    }
    setPasswordLoading(true);
    setError("");
    try {
      const result = await apiRequest<SettingsResponse>("/api/settings?revealPassword=true", { token });
      setBniPassword(result.settings.bniPassword);
      setShowBniPassword(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reveal password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const revealSendingAppPassword = async () => {
    if (showSendingAppPassword) {
      setShowSendingAppPassword(false);
      return;
    }
    setSendingPasswordLoading(true);
    setError("");
    try {
      const result = await apiRequest<SettingsResponse>("/api/settings?revealMailPassword=true", { token });
      setSendingAppPassword(result.settings.sendingAppPassword);
      setShowSendingAppPassword(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reveal password");
    } finally {
      setSendingPasswordLoading(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await apiRequest<{ message: string }>("/api/settings", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          bniUsername,
          bniPassword,
          sendingEmail,
          sendingAppPassword,
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      setMessage(result.message);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setBniPassword("");
      setSendingAppPassword("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-grid">
      <Card title="Saved BNI credentials" subtitle="These credentials are used by the scraper on your behalf." icon="shield">
        <form className="form-grid" onSubmit={submit}>
          <Field label="BNI username">
            <input className="input" value={bniUsername} onChange={(event) => setBniUsername(event.target.value)} />
          </Field>
          <label className="field">
            <span className="field-label">BNI password</span>
            <div className="password-field">
              <input
                className="input"
                type={showBniPassword ? "text" : "password"}
                value={bniPassword}
                onChange={(event) => setBniPassword(event.target.value)}
                placeholder={settings?.hasBniPassword ? "••••••••" : "Set your BNI password"}
                readOnly={!showBniPassword && Boolean(settings?.hasBniPassword)}
              />
              <button
                type="button"
                className="icon-button password-toggle"
                onClick={revealBniPassword}
                disabled={passwordLoading}
                aria-label={showBniPassword ? "Hide password" : "Reveal password"}
              >
                <Icon name={showBniPassword ? "eye-off" : "eye"} />
              </button>
            </div>
            <span className="field-hint">
              {settings?.hasBniPassword ? "Click the eye to reveal or hide the saved password." : "No BNI password saved yet."}
            </span>
          </label>
          {message && <div className="alert alert-success">{message}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          <Button type="submit" disabled={saving}>
            Save credentials
          </Button>
        </form>
      </Card>

      <Card
        title="Mail sender credentials"
        subtitle="Used for outbound outreach emails. Add the Gmail address and an app password from your Google account security settings."
        icon="mail"
      >
        <form className="form-grid" onSubmit={submit}>
          <Field label="Sending email" hint="This address will be used as the From address.">
            <input className="input" type="email" value={sendingEmail} onChange={(event) => setSendingEmail(event.target.value)} />
          </Field>
          <label className="field">
            <span className="field-label">App password</span>
            <div className="password-field">
              <input
                className="input"
                type={showSendingAppPassword ? "text" : "password"}
                value={sendingAppPassword}
                onChange={(event) => setSendingAppPassword(event.target.value)}
                placeholder={settings?.hasSendingAppPassword ? "••••••••" : "Set your app password"}
                readOnly={!showSendingAppPassword && Boolean(settings?.hasSendingAppPassword)}
              />
              <button
                type="button"
                className="icon-button password-toggle"
                onClick={revealSendingAppPassword}
                disabled={sendingPasswordLoading}
                aria-label={showSendingAppPassword ? "Hide app password" : "Reveal app password"}
              >
                <Icon name={showSendingAppPassword ? "eye-off" : "eye"} />
              </button>
            </div>
            <span className="field-hint">
              Google app passwords are created in your Google Account security settings after enabling 2-step verification.
            </span>
          </label>
          <div className="settings-actions">
            <Button type="submit" disabled={saving}>
              Save sender credentials
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Change login password" subtitle="Update the account password that protects the dashboard." icon="mail">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Current password" hint="Required only when changing your password.">
            <input className="input" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          </Field>
          <Field label="New password" hint="Must include uppercase, lowercase, number, and 8+ characters.">
            <input className="input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </Field>
          <div className="settings-actions">
            <Button type="submit" disabled={saving}>
              Update password
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Server defaults" subtitle="These values are locked on the hosted server." icon="settings">
        <div className="settings-lock-grid">
          <div className="lock-item">
            <span>MAX_PROFILE_CONCURRENCY</span>
            <strong>{settings?.maxProfileConcurrency ?? 1}</strong>
          </div>
          <div className="lock-item">
            <span>MAX_COUNTRY_PROFILES</span>
            <strong>{settings?.maxCountryProfiles ?? 360}</strong>
          </div>
          <div className="lock-item">
            <span>REQUEST_DELAY_MIN</span>
            <strong>{settings?.requestDelayMin ?? 3.5}</strong>
          </div>
          <div className="lock-item">
            <span>REQUEST_DELAY_MAX</span>
            <strong>{settings?.requestDelayMax ?? 6.5}</strong>
          </div>
          <div className="lock-item">
            <span>HEADLESS</span>
            <strong>{String(settings?.headless ?? true)}</strong>
          </div>
          <div className="lock-item">
            <span>OUTPUT_DIR</span>
            <strong>Server managed</strong>
          </div>
        </div>
      </Card>
    </div>
  );
}

function AdminTab({
  token,
  users,
  applications,
  onRefresh,
}: {
  token: string;
  users: AdminUsersResponse["items"];
  applications: AdminCreditApplicationsResponse["items"];
  onRefresh: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [creditAmounts, setCreditAmounts] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const updateUserCredits = async (userId: string) => {
    const amount = Number(creditAmounts[userId] ?? "0");
    if (!Number.isFinite(amount) || amount === 0) {
      setError("Enter a credit amount to grant or deduct.");
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await apiRequest(`/api/admin/users/${userId}/credits`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ amount }),
      });
      setMessage("User credits updated.");
      setCreditAmounts((current) => ({ ...current, [userId]: "" }));
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update credits");
    } finally {
      setSaving(false);
    }
  };

  const reviewApplication = async (applicationId: string, status: "APPROVED" | "REJECTED") => {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await apiRequest(`/api/admin/credit-applications/${applicationId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          status,
          adminNote: reviewNotes[applicationId] ?? "",
        }),
      });
      setMessage(`Application ${status.toLowerCase()}.`);
      setReviewNotes((current) => ({ ...current, [applicationId]: "" }));
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update application");
    } finally {
      setSaving(false);
    }
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await apiRequest("/api/admin/users", {
        method: "POST",
        token,
        body: JSON.stringify({ email, fullName, password, role }),
      });
      setMessage("User created successfully.");
      setEmail("");
      setFullName("");
      setPassword("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-grid">
      <Card title="Create user" subtitle="Add administrators or regular users." icon="admin">
        <form className="form-grid" onSubmit={createUser}>
          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Full name">
            <input className="input" value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </Field>
          <Field label="Password">
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label="Role">
            <select className="input" value={role} onChange={(event) => setRole(event.target.value as "USER" | "ADMIN")}>
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
            </select>
          </Field>
          {message && <div className="alert alert-success">{message}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          <Button type="submit" disabled={saving}>
            Create account
          </Button>
        </form>
      </Card>

      <Card title="Credit applications" subtitle="Review pending requests from users." icon="wallet">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Requested</th>
                <th>Note</th>
                <th>Status</th>
                <th>Admin note</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.user.fullName || item.user.email}</strong>
                    <div className="subtle">{item.user.email}</div>
                  </td>
                  <td>{item.requestedCredits}</td>
                  <td>{item.note || "-"}</td>
                  <td><Badge tone={item.status === "PENDING" ? "warning" : item.status === "APPROVED" ? "success" : "danger"}>{item.status}</Badge></td>
                  <td>
                    <input
                      className="input"
                      value={reviewNotes[item.id] ?? item.adminNote ?? ""}
                      onChange={(event) =>
                        setReviewNotes((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      placeholder="Optional note"
                    />
                  </td>
                  <td className="table-actions">
                    <Button variant="secondary" disabled={saving || item.status !== "PENDING"} onClick={() => void reviewApplication(item.id, "APPROVED")}>
                      Approve
                    </Button>
                    <Button variant="danger" disabled={saving || item.status !== "PENDING"} onClick={() => void reviewApplication(item.id, "REJECTED")}>
                      Reject
                    </Button>
                  </td>
                </tr>
              ))}
              {!applications.length && (
                <tr>
                  <td colSpan={6}>No credit applications yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="User directory" subtitle="Create and review user accounts from one place." icon="leads">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Credits</th>
                <th>Created</th>
                <th>Grant</th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.fullName || item.email}</strong>
                    <div className="subtle">{item.email}</div>
                  </td>
                  <td>{item.role}</td>
                  <td>{currencyLike(item.creditsAvailable)}</td>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td className="table-actions">
                    <input
                      className="input"
                      type="number"
                      min={-5000}
                      max={5000}
                      value={creditAmounts[item.id] ?? ""}
                      onChange={(event) =>
                        setCreditAmounts((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      placeholder="Amount"
                    />
                    <Button disabled={saving} onClick={() => void updateUserCredits(item.id)}>
                      Apply
                    </Button>
                  </td>
                </tr>
              ))}
              {!users.length && (
                <tr>
                  <td colSpan={5}>No users found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
