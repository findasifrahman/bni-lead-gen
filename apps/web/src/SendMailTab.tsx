import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "./lib/api";
import type { LeadRequest, MailCampaign, MailCampaignChatMessage, MailRecipient, PublicUser } from "./types";
import { type MailCampaignStatus } from "./types";

type PreviewResponse = {
  campaign: MailCampaign;
  invalidRows: Array<{ rowIndex: number; reason: string; sourceLabel?: string }>;
  serviceSummary: string;
  draftEmail: {
    recipientName: string;
    recipientCompany: string | null;
    subject: string;
    body: string;
  } | null;
  validRecipients: number;
  estimatedCredits: number;
  message: string;
};

type MailCampaignsResponse = {
  items: MailCampaign[];
};

type MailDraftMode = "GENERATED_LEADS" | "CUSTOM_UPLOAD" | "COMBINED";

type MailCampaignDetail = MailCampaign & { recipients?: MailRecipient[]; messages?: MailCampaignChatMessage[] };

type Props = {
  token: string;
  user: PublicUser;
  leadRequests: LeadRequest[];
  campaigns: MailCampaign[];
  onRefresh: () => Promise<void>;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusTone(status: MailCampaignStatus) {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "RUNNING":
    case "QUEUED":
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

function describeCampaignSource(sourceType: MailCampaign["sourceType"], inputFileName?: string | null) {
  switch (sourceType) {
    case "GENERATED_LEADS":
      return "Generated leads";
    case "CUSTOM_UPLOAD":
      return inputFileName || "Custom upload";
    case "COMBINED":
      return "Generated leads + custom upload";
    default:
      return inputFileName || "Campaign batch";
  }
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    check: <path d="M9 16.2l-3.5-3.6L4 14.1l5 5 11-11-1.4-1.4z" />,
    close: <path d="M6.4 5l-.9.9L11.1 11l-5.6 5.6.9.9L12 11.9l5.6 5.6.9-.9L12.9 11 18.5 5.4l-.9-.9L12 10.1z" />,
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
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
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

export function SendMailTab({ token, user, leadRequests, campaigns, onRefresh }: Props) {
  const [mode, setMode] = useState<MailDraftMode>("GENERATED_LEADS");
  const [selectedLeadRequestId, setSelectedLeadRequestId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [companyWebsitePrimary, setCompanyWebsitePrimary] = useState("");
  const [companyWebsiteSecondary, setCompanyWebsiteSecondary] = useState("");
  const [companyWebsiteTertiary, setCompanyWebsiteTertiary] = useState("");
  const [socialLinkedIn, setSocialLinkedIn] = useState("");
  const [socialInstagram, setSocialInstagram] = useState("");
  const [socialFacebook, setSocialFacebook] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCampaignId, setSendingCampaignId] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [campaignDetail, setCampaignDetail] = useState<MailCampaignDetail | null>(null);
  const [campaignDetailLoading, setCampaignDetailLoading] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [chatPrompt, setChatPrompt] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [campaignPage, setCampaignPage] = useState(1);
  const [restoreNotice, setRestoreNotice] = useState("");
  const campaignPageSize = 5;
  const hydratedCampaignId = useRef("");
  const isSendingCurrentCampaign = Boolean(
    campaignDetail && (loading || sendingCampaignId === campaignDetail.id)
  );

  const completedLeadRequests = useMemo(
    () => leadRequests.filter((item) => item.status === "COMPLETED" && item.totalLeads > 0),
    [leadRequests]
  );

  const hasActiveCampaign = useMemo(
    () => campaigns.some((campaign) => campaign.status === "QUEUED" || campaign.status === "RUNNING"),
    [campaigns]
  );

  useEffect(() => {
    if (!hasActiveCampaign) return;
    const timer = window.setInterval(() => {
      void onRefresh().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveCampaign, onRefresh]);

  const resetDraft = () => {
    setPreview(null);
    setMessage("");
    setError("");
  };

  const refreshCampaignDetail = async (campaignId: string, showLoading = false) => {
    if (showLoading) {
      setCampaignDetailLoading(true);
    }
    setError("");
    try {
      const result = await apiRequest<{ item: MailCampaignDetail }>(`/api/mail-campaigns/${campaignId}`, {
        method: "GET",
        token,
      });
      setCampaignDetail(result.item);
      setSelectedCampaignId(campaignId);
      setDraftSubject(result.item.draftSubject || result.item.messages?.find((message) => message.role === "ASSISTANT")?.draftSubject || "");
      setDraftBody(result.item.draftBody || result.item.messages?.find((message) => message.role === "ASSISTANT")?.draftBody || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load campaign details");
      if (showLoading) {
        setCampaignDetail(null);
      }
    } finally {
      if (showLoading) {
        setCampaignDetailLoading(false);
      }
    }
  };

  const openCampaignDetail = async (campaignId: string) => {
    await refreshCampaignDetail(campaignId, true);
  };

  const closeCampaignDetail = () => {
    setSelectedCampaignId("");
    setCampaignDetail(null);
    setCampaignDetailLoading(false);
    setDraftSubject("");
    setDraftBody("");
  };

  useEffect(() => {
    if (!campaignDetail) return;
    setDraftSubject(campaignDetail.draftSubject || campaignDetail.messages?.find((message) => message.role === "ASSISTANT")?.draftSubject || "");
    setDraftBody(campaignDetail.draftBody || campaignDetail.messages?.find((message) => message.role === "ASSISTANT")?.draftBody || "");
  }, [campaignDetail]);

  useEffect(() => {
    if (!selectedCampaignId || !campaignDetail) return;
    if (campaignDetail.status !== "QUEUED" && campaignDetail.status !== "RUNNING") return;
    const timer = window.setInterval(() => {
      void refreshCampaignDetail(selectedCampaignId).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedCampaignId, campaignDetail?.status]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(campaigns.length / campaignPageSize));
    if (campaignPage > maxPage) {
      setCampaignPage(maxPage);
    }
  }, [campaigns.length, campaignPage, campaignPageSize]);

  useEffect(() => {
    if (!campaigns.length) return;
    const latest = campaigns[0];
    if (!latest || hydratedCampaignId.current === latest.id) return;
    hydratedCampaignId.current = latest.id;
    setMode(latest.sourceType);
    setSelectedLeadRequestId(latest.leadRequestId || "");
    setCompanyWebsitePrimary(latest.companyWebsitePrimary || "");
    setCompanyWebsiteSecondary(latest.companyWebsiteSecondary || "");
    setCompanyWebsiteTertiary(latest.companyWebsiteTertiary || "");
    setSocialLinkedIn(latest.socialLinkedIn || "");
    setSocialInstagram(latest.socialInstagram || "");
    setSocialFacebook(latest.socialFacebook || "");
    setPhoneNumber(latest.phoneNumber || "");
    setCustomInstructions(latest.customInstructions || "");
    setRestoreNotice("Restored from your last campaign.");
  }, [campaigns]);

  const validateAndDraft = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    setPreview(null);
    try {
      if ((mode === "GENERATED_LEADS" || mode === "COMBINED") && !selectedLeadRequestId) {
        throw new Error("Select a completed generated lead request.");
      }
      if ((mode === "CUSTOM_UPLOAD" || mode === "COMBINED") && !file) {
        throw new Error("Upload a CSV or Excel file first.");
      }
      const formData = new FormData();
      formData.set("sourceType", mode);
      formData.set("leadRequestId", selectedLeadRequestId);
      formData.set("companyWebsitePrimary", companyWebsitePrimary);
      formData.set("companyWebsiteSecondary", companyWebsiteSecondary);
      formData.set("companyWebsiteTertiary", companyWebsiteTertiary);
      formData.set("socialLinkedIn", socialLinkedIn);
      formData.set("socialInstagram", socialInstagram);
      formData.set("socialFacebook", socialFacebook);
      formData.set("phoneNumber", phoneNumber);
      formData.set("customInstructions", customInstructions);
      if (file) {
        formData.set("file", file);
      }
      const result = await apiRequest<PreviewResponse>("/api/mail-campaigns/preview", {
        method: "POST",
        token,
        body: formData,
      });
      setPreview(result);
      setMessage(result.message);
      await onRefresh();
      await openCampaignDetail(result.campaign.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to validate campaign");
    } finally {
      setLoading(false);
    }
  };

  const startCampaign = async () => {
    if (!preview?.campaign?.id) return;
    setLoading(true);
    setError("");
    try {
      await apiRequest<{ message: string }>(`/api/mail-campaigns/${preview.campaign.id}/start`, {
        method: "POST",
        token,
      });
      setMessage("Mail campaign queued.");
      await onRefresh();
      await refreshCampaignDetail(preview.campaign.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start mail campaign");
    } finally {
      setLoading(false);
    }
  };

  const startExistingCampaign = async (campaignId: string) => {
    setSendingCampaignId(campaignId);
    setError("");
    try {
      await apiRequest<{ message: string }>(`/api/mail-campaigns/${campaignId}/start`, {
        method: "POST",
        token,
      });
      await onRefresh();
      await refreshCampaignDetail(campaignId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start mail campaign");
    } finally {
      setSendingCampaignId("");
    }
  };

  const saveDraft = async () => {
    if (!campaignDetail) return;
    setDraftSaving(true);
    setError("");
    try {
      const result = await apiRequest<{ item: MailCampaignDetail }>(`/api/mail-campaigns/${campaignDetail.id}/draft`, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          subject: draftSubject,
          body: draftBody,
        }),
      });
      setCampaignDetail(result.item);
      setPreview((current) => (current && current.campaign.id === result.item.id ? { ...current, campaign: result.item } : current));
      await onRefresh();
      setMessage("Draft saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save draft");
    } finally {
      setDraftSaving(false);
    }
  };

  const sendChatPrompt = async () => {
    if (!campaignDetail || !chatPrompt.trim()) return;
    setChatSending(true);
    setError("");
    try {
      const result = await apiRequest<{ campaign: MailCampaignDetail; assistant: { subject: string; body: string } }>(
        `/api/mail-campaigns/${campaignDetail.id}/chat`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ content: chatPrompt }),
        }
      );
      setCampaignDetail(result.campaign);
      setDraftSubject(result.assistant.subject);
      setDraftBody(result.assistant.body);
      setChatPrompt("");
      await onRefresh();
      setMessage("Draft updated by AI.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update draft");
    } finally {
      setChatSending(false);
    }
  };

  const deleteCampaign = async (campaignId: string) => {
    const ok = window.confirm("Delete this campaign and its uploaded source file from storage?");
    if (!ok) return;
    setLoading(true);
    setError("");
    try {
      await apiRequest<{ message: string }>(`/api/mail-campaigns/${campaignId}`, {
        method: "DELETE",
        token,
      });
      await onRefresh();
      if (selectedCampaignId === campaignId) {
        closeCampaignDetail();
      }
      setMessage("Campaign deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete campaign");
    } finally {
      setLoading(false);
    }
  };

  const cancelCampaign = async (campaignId: string) => {
    setLoading(true);
    setError("");
    try {
      await apiRequest<{ message: string }>(`/api/mail-campaigns/${campaignId}/cancel`, {
        method: "POST",
        token,
      });
      await onRefresh();
      if (preview?.campaign?.id === campaignId) {
        setPreview(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel mail campaign");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-grid">
      <Card
        title="Send mail"
        subtitle="Create AI-personalized outreach from generated leads or a custom CSV/XLSX upload."
      >
        <form className="form-grid" onSubmit={validateAndDraft}>
          <Field label="Source type">
            <select className="input" value={mode} onChange={(event) => setMode(event.target.value as MailDraftMode)}>
              <option value="GENERATED_LEADS">Generated leads only</option>
              <option value="CUSTOM_UPLOAD">Custom upload only</option>
              <option value="COMBINED">Combined batch</option>
            </select>
          </Field>

          {(mode === "GENERATED_LEADS" || mode === "COMBINED") ? (
            <Field label="Generated lead request" hint="Use a completed lead request with stored recipient rows.">
              <select className="input" value={selectedLeadRequestId} onChange={(event) => setSelectedLeadRequestId(event.target.value)}>
                <option value="">Select a completed lead request</option>
                {completedLeadRequests.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.filename} ({currencyLike(item.totalLeads)} leads)
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {(mode === "CUSTOM_UPLOAD" || mode === "COMBINED") ? (
            <Field label="Upload CSV or Excel" hint="Required columns: name, company, email, website, city, country, professional_details">
              <input
                className="input"
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
          ) : null}

          <Field label="Website 1" hint="Required. Add your primary company website.">
            <input className="input" value={companyWebsitePrimary} onChange={(event) => setCompanyWebsitePrimary(event.target.value)} />
          </Field>
          <Field label="Website 2" hint="Optional. Add a second business website or landing page if available.">
            <input className="input" value={companyWebsiteSecondary} onChange={(event) => setCompanyWebsiteSecondary(event.target.value)} />
          </Field>
          <Field label="Website 3" hint="Optional. Helps the AI understand multiple service lines.">
            <input className="input" value={companyWebsiteTertiary} onChange={(event) => setCompanyWebsiteTertiary(event.target.value)} />
          </Field>
          <Field label="LinkedIn" hint="Optional.">
            <input className="input" value={socialLinkedIn} onChange={(event) => setSocialLinkedIn(event.target.value)} />
          </Field>
          <Field label="Instagram" hint="Optional.">
            <input className="input" value={socialInstagram} onChange={(event) => setSocialInstagram(event.target.value)} />
          </Field>
          <Field label="Facebook" hint="Optional.">
            <input className="input" value={socialFacebook} onChange={(event) => setSocialFacebook(event.target.value)} />
          </Field>
          <Field label="Phone number" hint="Optional.">
            <input className="input" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
          </Field>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span className="field-label">Custom notes</span>
            <textarea
              className="input textarea"
              value={customInstructions}
              onChange={(event) => setCustomInstructions(event.target.value)}
              placeholder="Add campaign context, offer details, or meeting request preferences."
            />
            <span className="field-hint">Keep this focused on the services you want the AI to mention.</span>
          </label>

          <div className="action-row" style={{ gridColumn: "1 / -1" }}>
            <Button variant="secondary" type="submit" disabled={loading}>
              Validate & Estimate
            </Button>
            <Button variant="ghost" type="button" disabled={loading} onClick={resetDraft}>
              Reset
            </Button>
          </div>
        </form>

        {message && <div className="alert alert-success">{message}</div>}
        {error && <div className="alert alert-error">{error}</div>}
        {restoreNotice && !message && !error && <div className="alert alert-info">{restoreNotice}</div>}

        {preview && (
          <div className="empty-state-card warning" style={{ marginTop: 18, alignItems: "flex-start" }}>
            <div>
              <strong>Review before sending</strong>
              <p>
                {describeCampaignSource(preview.campaign.sourceType, preview.campaign.inputFileName)}: {currencyLike(preview.validRecipients)} recipient(s). Maximum reserved: {currencyLike(preview.estimatedCredits)} credits.
              </p>
              <p>{preview.serviceSummary}</p>
            </div>
            <div className="action-row">
              <Button variant="primary" disabled={loading} onClick={startCampaign}>
                {loading ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="check" />}{" "}
                Send emails
              </Button>
              <Button variant="ghost" disabled={loading} onClick={() => setPreview(null)}>
                Back
              </Button>
            </div>
          </div>
        )}

        {preview?.draftEmail && (
          <section className="draft-preview">
            <div className="draft-preview-head">
              <div>
                <span className="draft-preview-label">AI draft preview</span>
                <h3>{preview.draftEmail.subject}</h3>
                <p>
                  Drafted for {preview.draftEmail.recipientName}
                  {preview.draftEmail.recipientCompany ? ` at ${preview.draftEmail.recipientCompany}` : ""}.
                </p>
              </div>
            </div>
            <div className="draft-preview-body">
              {preview.draftEmail.body.split(/\n/g).map((line, index) => (
                <p key={`${line}-${index}`}>{line || "\u00a0"}</p>
              ))}
            </div>
          </section>
        )}

        {campaignDetail?.serviceSummary && (
          <section className="draft-preview research-preview">
            <div className="draft-preview-head">
              <div>
                <span className="draft-preview-label">Loaded research</span>
                <h3>Cached sender research</h3>
                <p>This summary is stored in the database and reused until websites or social links change.</p>
              </div>
            </div>
            <div className="draft-preview-body">
              {campaignDetail.serviceSummary.split(/\n/g).map((line, index) => (
                <p key={`${line}-${index}`}>{line || "\u00a0"}</p>
              ))}
            </div>
          </section>
        )}

        {preview?.invalidRows?.length ? (
          <div className="alert alert-error" style={{ marginTop: 14 }}>
            {preview.invalidRows.map((row) => (
              <div key={row.rowIndex}>
                {row.sourceLabel ? `${row.sourceLabel} ` : ""}Row {row.rowIndex}: {row.reason}
              </div>
            ))}
          </div>
        ) : null}

        {campaignDetail && (
          <section className="mail-gpt-shell">
            <aside className="mail-gpt-sidebar">
              <div className="drawer-head" style={{ marginBottom: 14 }}>
                <div>
                  <span className="draft-preview-label">Previous chats</span>
                  <h3>Campaign threads</h3>
                  <p>Pick a campaign to keep editing or review the saved conversation.</p>
                </div>
              </div>
              <div className="chat-thread-list">
                {campaigns.map((campaign) => {
                  const active = campaign.id === campaignDetail.id;
                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      className={`chat-thread-item ${active ? "active" : ""}`}
                      onClick={() => void openCampaignDetail(campaign.id)}
                    >
                      <strong>{describeCampaignSource(campaign.sourceType, campaign.inputFileName)}</strong>
                      <span>{formatDateTime(campaign.requestedAt)}</span>
                      <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
                    </button>
                  );
                })}
              </div>
            </aside>

            <main className="mail-gpt-main">
              <div className="mail-gpt-topbar">
                <div>
                  <span className="draft-preview-label">AI draft workspace</span>
                  <h3>{describeCampaignSource(campaignDetail.sourceType, campaignDetail.inputFileName)}</h3>
                  <p>
                    {campaignDetail.totalRecipients} recipient(s) · {campaignDetail.status} · Maximum reserved{" "}
                    {currencyLike(campaignDetail.creditsReserved)} credits
                  </p>
                </div>
                <div className="action-row">
                  <Button variant="secondary" disabled={draftSaving} onClick={() => void saveDraft()}>
                    Save draft
                  </Button>
                  <Button variant="primary" disabled={isSendingCurrentCampaign} onClick={() => void startExistingCampaign(campaignDetail.id)}>
                    {isSendingCurrentCampaign ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="check" />}{" "}
                    {isSendingCurrentCampaign ? "Sending..." : "Send emails"}
                  </Button>
                </div>
              </div>

              <section className="draft-editor">
                <Field label="Subject">
                  <input className="input" value={draftSubject} onChange={(event) => setDraftSubject(event.target.value)} />
                </Field>
                <Field label="Body">
                  <textarea
                    className="input textarea draft-body-input"
                    value={draftBody}
                    onChange={(event) => setDraftBody(event.target.value)}
                  />
                </Field>
              </section>

              <section className="chat-thread">
                {(campaignDetail.messages?.length ?? 0) > 0 ? (
                  campaignDetail.messages?.map((message) => {
                    const isUser = message.role === "USER";
                    return (
                      <article key={message.id} className={`chat-bubble ${isUser ? "user" : "assistant"}`}>
                        <div className="chat-bubble-meta">
                          <strong>{isUser ? "You" : "AI assistant"}</strong>
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                        <div className="chat-bubble-body">
                          {isUser ? (
                            <p>{message.content}</p>
                          ) : (
                            <>
                              <p className="chat-subject">
                                <strong>Subject:</strong> {message.draftSubject || "-"}
                              </p>
                              <div className="chat-body-copy">
                                {(message.draftBody || message.content).split(/\n/g).map((line, index) => (
                                  <p key={`${message.id}-${index}`}>{line || "\u00a0"}</p>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="drawer-placeholder">No chat history yet. Edit the draft or ask the AI to revise it.</div>
                )}
              </section>

              <section className="chat-composer">
                <textarea
                  className="input textarea"
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.target.value)}
                  placeholder="Tell the AI how to improve the email. For example: mention PCB layout and make it warmer."
                />
                <div className="action-row">
                  <Button variant="secondary" disabled={chatSending || !chatPrompt.trim()} onClick={() => void sendChatPrompt()}>
                    Ask AI to revise
                  </Button>
                </div>
              </section>
            </main>
          </section>
        )}
      </Card>

      <Card title="Campaign history" subtitle="Queued, running, and completed email campaigns.">
        <div className="table-toolbar">
          <div className="table-toolbar-meta">
            <strong>{campaigns.length} campaign(s)</strong>
            <span>Showing page {campaignPage} of {Math.max(1, Math.ceil(campaigns.length / campaignPageSize))}</span>
          </div>
          <div className="action-row">
            <Button
              variant="ghost"
              disabled={campaignPage <= 1}
              onClick={() => setCampaignPage((current) => Math.max(1, current - 1))}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              disabled={campaignPage >= Math.ceil(campaigns.length / campaignPageSize)}
              onClick={() => setCampaignPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Recipients</th>
                <th>Sent</th>
                <th>Failed</th>
                <th>Credits</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.slice((campaignPage - 1) * campaignPageSize, campaignPage * campaignPageSize).map((campaign) => {
                const active = campaign.status === "QUEUED" || campaign.status === "RUNNING";
                const progress = campaign.totalRecipients > 0 ? Math.min(100, Math.round((campaign.sentCount / campaign.totalRecipients) * 100)) : 0;
                return (
                  <tr key={campaign.id}>
                    <td>{formatDateTime(campaign.requestedAt)}</td>
                    <td>{describeCampaignSource(campaign.sourceType, campaign.inputFileName)}</td>
                    <td>{currencyLike(campaign.totalRecipients)}</td>
                    <td>{currencyLike(campaign.sentCount)}</td>
                    <td>{currencyLike(campaign.failedCount)}</td>
                    <td>{currencyLike(campaign.creditsCharged)}</td>
                    <td>
                      <div className="progress-cell">
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <span>{progress}%</span>
                      </div>
                    </td>
                    <td>
                      <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button variant="ghost" disabled={campaignDetailLoading && selectedCampaignId === campaign.id} onClick={() => void openCampaignDetail(campaign.id)}>
                          Details
                        </Button>
                        {(campaign.status === "DRAFT" || campaign.status === "FAILED" || campaign.status === "CANCELLED") && (
                          <Button
                            variant="secondary"
                            disabled={loading || sendingCampaignId === campaign.id}
                            onClick={() => void startExistingCampaign(campaign.id)}
                          >
                            {campaign.status === "FAILED" ? "Resume" : "Start"}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          disabled={loading || sendingCampaignId === campaign.id}
                          onClick={() => void deleteCampaign(campaign.id)}
                        >
                          Delete
                        </Button>
                        {active && (
                          <Button variant="danger" disabled={loading || sendingCampaignId === campaign.id} onClick={() => cancelCampaign(campaign.id)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!campaigns.length && (
                <tr>
                  <td colSpan={9}>No email campaigns yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Sending profile" subtitle="These credentials are used to send the outreach emails.">
        <div className="hero-metrics">
          <div className="lock-item">
            <span>Dashboard account</span>
            <strong>{user.email}</strong>
          </div>
          <div className="lock-item">
            <span>Credit cost</span>
            <strong>1 email = 4 credits</strong>
          </div>
          <div className="lock-item">
            <span>Send pace</span>
            <strong>45 seconds between sends</strong>
          </div>
        </div>
      </Card>
    </div>
  );
}
