import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiBaseUrl, apiRequest } from "./lib/api";
import { useAuth } from "./lib/auth";
import type { CreditApplication, LeadRequest, PublicUser } from "./types";
import { DashboardShell } from "./DashboardShell";

type AuthScreen = "login" | "forgot" | "reset";
type DashboardTab = "home" | "leads" | "account" | "settings" | "admin";

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

type AdminApplicationsResponse = {
  items: Array<
    CreditApplication & {
      user: {
        id: string;
        email: string;
        fullName: string | null;
      };
    }
  >;
};

type ReferenceItem = {
  label: string;
  value?: string;
};

type FilterForm = {
  keyword: string;
  country: string;
  category: string;
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

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    spark: <path d="M13 3l1.7 5.3L20 10l-5.3 1.7L13 17l-1.7-5.3L6 10l5.3-1.7L13 3z" />,
    search: <path d="M11 4a7 7 0 105.29 12.29l3.71 3.71 1.41-1.41-3.71-3.71A7 7 0 0011 4zm0 2a5 5 0 110 10 5 5 0 010-10z" />,
    filter: <path d="M3 5h18v2l-7 7v5l-4 2v-7L3 7V5z" />,
    home: <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z" />,
    leads: <path d="M6 4h12v2H6V4zm0 4h12v2H6V8zm0 4h8v2H6v-2zm0 4h8v2H6v-2z" />,
    account: <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 1114 0H5z" />,
    settings: <path d="M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm8 3.5l-2.2-.4a6.9 6.9 0 00-.6-1.5l1.4-1.7-2.1-2.1-1.7 1.4a6.9 6.9 0 00-1.5-.6L13.5 4h-3l-.4 2.2c-.5.1-1 .3-1.5.6L6.9 5.4 4.8 7.5l1.4 1.7c-.3.5-.5 1-.6 1.5L3.4 12l.2 3 2.2.4c.1.5.3 1 .6 1.5L5 18.6l2.1 2.1 1.7-1.4c.5.3 1 .5 1.5.6l.4 2.2h3l.4-2.2c.5-.1 1-.3 1.5-.6l1.7 1.4 2.1-2.1-1.4-1.7c.3-.5.5-1 .6-1.5l2.2-.4v-3z" />,
    admin: <path d="M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6l9-4zm0 4.3L6 8v4c0 3.7 2.5 6.7 6 7.7 3.5-1 6-4 6-7.7V8l-6-1.7z" />,
    logout: <path d="M10 17l1.4-1.4L8.8 13H20v-2H8.8l2.6-2.6L10 7l-5 5 5 5zM4 5h8V3H4a2 2 0 00-2 2v14a2 2 0 002 2h8v-2H4V5z" />,
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
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} disabled={disabled} onClick={onClick}>
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
  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return options.slice(0, 14);
    return options.filter((item) => item.label.toLowerCase().includes(query)).slice(0, 14);
  }, [options, value]);

  return (
    <label className="field combo-field">
      <span className="field-label">{label}</span>
      <div className="combo-shell">
        <input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="input"
          list={`${label}-list`}
        />
        <div className={`combo-menu ${open && filtered.length ? "open" : ""}`}>
          {filtered.map((item) => (
            <button
              key={item.value ?? item.label}
              type="button"
              className="combo-item"
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(item.value ?? item.label);
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <datalist id={`${label}-list`}>
          {options.map((item) => (
            <option key={item.value ?? item.label} value={item.value ?? item.label}>
              {item.label}
            </option>
          ))}
        </datalist>
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

function LoginScreen({
  onLoginSuccess,
  onForgot,
}: {
  onLoginSuccess: (token: string, user: PublicUser) => void;
  onForgot: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await apiRequest<{ token: string; user: PublicUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, rememberMe }),
      });
      onLoginSuccess(result.token, result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-glow auth-glow-one" />
      <div className="auth-glow auth-glow-two" />
      <div className="auth-card">
        <div className="brand-panel">
          <div className="brand-mark">
            <span className="brand-dot" />
            <span>BNI Lead Gen</span>
          </div>
          <h3>Premium lead generation for your organization.</h3>
          <p>Secure login, password reset, credit billing, and organized CSV output in one polished dashboard.</p>
          <div className="brand-badges">
            <span>AI generated email with simple interface</span>
            <span>Premium scraping</span>
          </div>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <div className="form-head">
            <h2>Sign in</h2>
            <p>Use your email and password to access the dashboard.</p>
          </div>

          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>

          <Field label="Password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <div className="inline-row">
            <label className="checkbox">
              <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
              <span>Remember me</span>
            </label>
            <button type="button" className="link-button" onClick={onForgot}>
              Forgot password?
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <Button type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>

          <p className="auth-footer-note">
            Enhanced Security
          </p>
        </form>
      </div>
    </div>
  );
}

function ForgotScreen({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setError("");
    try {
      const result = await apiRequest<{ message: string }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to request reset");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card reset-card">
        <form className="auth-form" onSubmit={submit}>
          <div className="form-head">
            <h2>Reset your password</h2>
            <p>We will email you a secure reset link.</p>
          </div>
          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          {message && <div className="alert alert-success">{message}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          <div className="inline-row">
            <Button type="submit" disabled={loading}>
              {loading ? "Sending..." : "Send reset link"}
            </Button>
            <button type="button" className="link-button" onClick={onBack}>
              Back to login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setMessage("");
    setError("");
    try {
      await apiRequest<{ message: string }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      setMessage("Password updated successfully. You can sign in now.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card reset-card">
        <form className="auth-form" onSubmit={submit}>
          <div className="form-head">
            <h2>Create a new password</h2>
            <p>Use at least 8 characters with uppercase, lowercase, and a number.</p>
          </div>
          <Field label="New password">
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label="Confirm password">
            <input
              className="input"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          {message && <div className="alert alert-success">{message}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          <div className="inline-row">
            <Button type="submit" disabled={loading}>
              {loading ? "Updating..." : "Update password"}
            </Button>
            <button type="button" className="link-button" onClick={onBack}>
              Back to login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// DASHBOARD_PLACEHOLDER

function App() {
  const { token, user, loading, login, logout } = useAuth();
  const [searchParams] = useSearchParams();
  const [screen, setScreen] = useState<AuthScreen>(searchParams.get("token") ? "reset" : "login");

  useEffect(() => {
    if (searchParams.get("token")) {
      setScreen("reset");
    }
  }, [searchParams]);

  if (loading) {
    return (
      <div className="loading-page">
        <div className="loading-card">Preparing your workspace...</div>
      </div>
    );
  }

  if (!token || !user) {
    if (screen === "forgot") {
      return <ForgotScreen onBack={() => setScreen("login")} />;
    }
    if (screen === "reset") {
      const resetToken = searchParams.get("token") || "";
      return <ResetScreen token={resetToken} onBack={() => setScreen("login")} />;
    }
    return <LoginScreen onLoginSuccess={login} onForgot={() => setScreen("forgot")} />;
  }

  return <DashboardShell token={token} user={user} onLogout={logout} />;
}

export default App;
