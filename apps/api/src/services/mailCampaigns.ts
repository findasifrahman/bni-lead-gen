import path from "path";
import { createHash, randomUUID } from "crypto";
import * as XLSX from "xlsx";
import { MailCampaign, MailCampaignSourceType, MailCampaignStatus, MailRecipientStatus, Prisma } from "@prisma/client";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { buildReadableR2Prefix, deleteR2Prefix, uploadBufferToR2 } from "../lib/r2";
import { sendMailWithCredentials } from "./mailer";
import { draftPersonalizedMail, reviseCampaignDraft, summarizeBusinessFromWebsites } from "./ai";

type UploadedFileLike = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

type MailDraftInput = {
  userId: string;
  sourceType: MailCampaignSourceType;
  leadRequestId?: string | null;
  file?: UploadedFileLike | null;
  companyWebsitePrimary: string;
  companyWebsiteSecondary: string;
  companyWebsiteTertiary?: string | null;
  socialLinkedIn?: string | null;
  socialInstagram?: string | null;
  socialFacebook?: string | null;
  phoneNumber?: string | null;
  customInstructions?: string | null;
};

type ParsedMailRow = {
  name: string;
  company: string;
  email: string;
  website: string;
  city: string;
  country: string;
  professional_details: string;
};

type InvalidMailRow = {
  rowIndex: number;
  reason: string;
  sourceLabel?: string;
};

type DraftResult = {
  campaign: MailCampaign;
  validRecipients: number;
  invalidRows: InvalidMailRow[];
  serviceSummary: string;
  draftEmail: { recipientName: string; recipientCompany: string | null; subject: string; body: string } | null;
};

type CampaignChatItem = {
  role: "USER" | "ASSISTANT";
  content: string;
  draftSubject: string | null;
  draftBody: string | null;
  createdAt: Date;
};

type SourceRowBatch = {
  sourceType: MailCampaignSourceType;
  rows: ParsedMailRow[];
};

type Job = {
  campaignId: string;
};

const REQUIRED_COLUMNS = ["name", "company", "email", "website", "city", "country", "professional_details"] as const;
const pendingJobs: Job[] = [];
const activeCampaigns = new Set<string>();
let pumpRunning = false;
let pumpRequested = false;
const MAX_GLOBAL_CONCURRENCY = 1;
const MAX_QUEUE_SIZE = 5;
const EMAIL_DELAY_MS = 45_000;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^\w_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCell(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function buildResearchFingerprint(input: {
  websites: string[];
  linkedIn?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  phoneNumber?: string | null;
  customInstructions?: string | null;
}): string {
  const normalized = {
    websites: input.websites
      .map((value) => normalizeUrl(value).toLowerCase())
      .filter(Boolean)
      .sort(),
    linkedIn: (input.linkedIn ?? "").trim().toLowerCase(),
    instagram: (input.instagram ?? "").trim().toLowerCase(),
    facebook: (input.facebook ?? "").trim().toLowerCase(),
    phoneNumber: (input.phoneNumber ?? "").trim().replace(/\s+/g, " "),
    customInstructions: (input.customInstructions ?? "").trim().replace(/\s+/g, " "),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function getOrCreateResearchSummary(input: {
  userId: string;
  websites: string[];
  linkedIn?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  phoneNumber?: string | null;
  customInstructions?: string | null;
}): Promise<string> {
  const fingerprint = buildResearchFingerprint(input);
  const cache = await prisma.mailResearchCache.findUnique({
    where: {
      userId_fingerprint: {
        userId: input.userId,
        fingerprint,
      },
    },
  });
  if (cache) {
    return cache.summary;
  }

  const summary = await summarizeBusinessFromWebsites({
    websites: input.websites,
    linkedIn: input.linkedIn ?? undefined,
    instagram: input.instagram ?? undefined,
    facebook: input.facebook ?? undefined,
    phoneNumber: input.phoneNumber ?? undefined,
    customInstructions: input.customInstructions ?? undefined,
  });

  await prisma.mailResearchCache.upsert({
    where: {
      userId_fingerprint: {
        userId: input.userId,
        fingerprint,
      },
    },
    update: {
      inputJson: {
        websites: input.websites,
        linkedIn: input.linkedIn ?? "",
        instagram: input.instagram ?? "",
        facebook: input.facebook ?? "",
        phoneNumber: input.phoneNumber ?? "",
        customInstructions: input.customInstructions ?? "",
      },
      summary,
    },
    create: {
      userId: input.userId,
      fingerprint,
      inputJson: {
        websites: input.websites,
        linkedIn: input.linkedIn ?? "",
        instagram: input.instagram ?? "",
        facebook: input.facebook ?? "",
        phoneNumber: input.phoneNumber ?? "",
        customInstructions: input.customInstructions ?? "",
      },
      summary,
    },
  });

  return summary;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function parseTabularFile(file: UploadedFileLike): ParsedMailRow[] {
  const workbook = XLSX.read(file.buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("The uploaded file does not contain any worksheets");
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) {
    throw new Error("The uploaded file did not contain any data rows");
  }

  const normalized = rows.map((row) => {
    const mapped: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      mapped[normalizeHeader(key)] = normalizeCell(value);
    }
    return {
      name: mapped.name ?? "",
      company: mapped.company ?? "",
      email: mapped.email ?? "",
      website: mapped.website ?? "",
      city: mapped.city ?? "",
      country: mapped.country ?? "",
      professional_details: mapped.professional_details ?? mapped.professionaldetails ?? "",
    } satisfies ParsedMailRow;
  });

  return normalized;
}

function validateMailRows(
  rows: ParsedMailRow[],
  sourceType: MailCampaignSourceType
): { validRows: ParsedMailRow[]; invalidRows: InvalidMailRow[] } {
  const validRows: ParsedMailRow[] = [];
  const invalidRows: InvalidMailRow[] = [];

  rows.forEach((row, index) => {
    if (!looksLikeEmail(row.email)) {
      invalidRows.push({ rowIndex: index + 1, reason: "Invalid email address" });
      return;
    }
    if (sourceType === "CUSTOM_UPLOAD") {
      const missing = REQUIRED_COLUMNS.filter((column) => !normalizeCell(row[column]).length);
      if (missing.length) {
        invalidRows.push({ rowIndex: index + 1, reason: `Missing required fields: ${missing.join(", ")}` });
        return;
      }
    } else if (!normalizeCell(row.name).length) {
      invalidRows.push({ rowIndex: index + 1, reason: "Missing recipient name" });
      return;
    }
    validRows.push(row);
  });

  return { validRows, invalidRows };
}

async function readGeneratedLeadRecipients(leadRequestId: string): Promise<ParsedMailRow[]> {
  const rows = await prisma.generatedLeadRow.findMany({
    where: { leadRequestId, email: { not: null } },
    orderBy: { rowIndex: "asc" },
  });
  return rows.map((row) => ({
    name: row.name ?? "",
    company: row.company ?? "",
    email: row.email ?? "",
    website: row.website ?? "",
    city: row.city ?? "",
    country: row.country ?? "",
    professional_details: row.professionalDetails ?? "",
  }));
}

function uniqueRowsByEmail(rows: Array<{ row: ParsedMailRow; sourceType: MailCampaignSourceType }>): Array<{ row: ParsedMailRow; sourceType: MailCampaignSourceType }> {
  const seen = new Set<string>();
  const deduped: Array<{ row: ParsedMailRow; sourceType: MailCampaignSourceType }> = [];
  for (const item of rows) {
    const email = item.row.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    deduped.push(item);
  }
  return deduped;
}

function formatSourceLabel(sourceType: MailCampaignSourceType): string {
  switch (sourceType) {
    case "GENERATED_LEADS":
      return "Generated leads";
    case "CUSTOM_UPLOAD":
      return "Custom upload";
    case "COMBINED":
      return "Combined batch";
    default:
      return sourceType;
  }
}

function buildMailObjectKey(email: string, campaignId: string, fileName: string): string {
  return buildReadableR2Prefix(["users", slugify(email), "mail", campaignId, slugify(fileName)]);
}

function buildEmailHtml(input: { subject: string; body: string; senderEmail: string }): string {
  const bodyHtml = input.body
    .split(/\n\s*\n/g)
    .map((paragraph) => `<p style="margin:0 0 14px;">${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
  return `
    <div style="margin:0;padding:0;background:#f5f8fc;">
      <div style="max-width:680px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#172338;">
        <div style="background:#ffffff;border:1px solid #d9e4f2;border-radius:20px;overflow:hidden;box-shadow:0 12px 30px rgba(15,23,42,.08);">
          <div style="padding:22px 24px;background:linear-gradient(135deg,#ff7a18 0%,#1967d2 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.9;">Professional outreach</div>
            <h1 style="margin:8px 0 0;font-size:22px;line-height:1.2;">${input.subject}</h1>
          </div>
          <div style="padding:24px 24px 12px;font-size:15px;line-height:1.7;">
            ${bodyHtml}
            <p style="margin:18px 0 0;color:#172338;">Best regards,<br />${input.senderEmail}</p>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

function formatAssistantDraft(subject: string, body: string): string {
  return `Subject: ${subject}\n\n${body}`.trim();
}

function parseLatestDraft(messages: CampaignChatItem[]): { subject: string; body: string } | null {
  const assistant = [...messages].reverse().find((message) => message.role === "ASSISTANT" && message.draftSubject && message.draftBody);
  if (!assistant || !assistant.draftSubject || !assistant.draftBody) {
    return null;
  }
  return {
    subject: assistant.draftSubject,
    body: assistant.draftBody,
  };
}

async function createDraftRecipients(
  tx: Prisma.TransactionClient,
  campaignId: string,
  userId: string,
  rows: Array<{ row: ParsedMailRow; sourceType: MailCampaignSourceType }>
): Promise<number> {
  if (!rows.length) return 0;
  const recipients = rows.map((item, index) => ({
    id: randomUUID(),
    campaignId,
    userId,
    rowIndex: index + 1,
    name: item.row.name.trim(),
    company: item.row.company.trim() || null,
    email: item.row.email.trim(),
    website: normalizeUrl(item.row.website) || null,
    city: item.row.city.trim() || null,
    country: item.row.country.trim() || null,
    professionalDetails: item.row.professional_details.trim() || null,
    sourceType: item.sourceType,
    rawData: {
      ...item.row,
      sourceType: item.sourceType,
    } as Prisma.InputJsonValue,
  }));

  const chunkSize = 500;
  for (let offset = 0; offset < recipients.length; offset += chunkSize) {
    const chunk = recipients.slice(offset, offset + chunkSize);
    const values = chunk.map((recipient) =>
      Prisma.sql`(
        ${recipient.id},
        ${recipient.campaignId},
        ${recipient.userId},
        ${recipient.rowIndex},
        ${recipient.name},
        ${recipient.company},
        ${recipient.email},
        ${recipient.website},
        ${recipient.city},
        ${recipient.country},
        ${recipient.professionalDetails},
        ${recipient.sourceType}::"MailCampaignSourceType",
        ${JSON.stringify(recipient.rawData)}::jsonb
      )`
    );
    await tx.$executeRaw(
      Prisma.sql`
        INSERT INTO "MailRecipient" (
          "id",
          "campaignId",
          "userId",
          "rowIndex",
          "name",
          "company",
          "email",
          "website",
          "city",
          "country",
          "professionalDetails",
          "sourceType",
          "rawData"
        )
        VALUES ${Prisma.join(values)}
      `
    );
  }
  return recipients.length;
}

async function uploadSourceFileIfNeeded(
  userEmail: string,
  campaignId: string,
  file: UploadedFileLike | null | undefined
): Promise<{ inputFileName: string | null; inputFileKey: string | null; inputFileUrl: string | null }> {
  if (!file) return { inputFileName: null, inputFileKey: null, inputFileUrl: null };
  const extension = path.extname(file.originalname).toLowerCase() || ".bin";
  const fileName = file.originalname || `mail-upload${extension}`;
  const key = buildMailObjectKey(userEmail, campaignId, fileName);
  const url = await uploadBufferToR2(key, file.buffer, file.mimetype || "application/octet-stream");
  return {
    inputFileName: file.originalname,
    inputFileKey: key,
    inputFileUrl: url,
  };
}

async function seedCampaignThread(
  tx: Prisma.TransactionClient,
  input: {
    campaignId: string;
    userId: string;
    draftEmail: { recipientName: string; recipientCompany: string | null; subject: string; body: string } | null;
  }
): Promise<void> {
  if (!input.draftEmail) return;
  await tx.mailCampaignChatMessage.createMany({
    data: [
      {
        campaignId: input.campaignId,
        userId: input.userId,
        role: "ASSISTANT",
        content: formatAssistantDraft(input.draftEmail.subject, input.draftEmail.body),
        draftSubject: input.draftEmail.subject,
        draftBody: input.draftEmail.body,
      },
    ],
  });
  await tx.mailCampaign.update({
    where: { id: input.campaignId },
    data: {
      draftSubject: input.draftEmail.subject,
      draftBody: input.draftEmail.body,
    },
  });
}

export async function createMailCampaignDraft(input: MailDraftInput): Promise<{
  campaign: MailCampaign;
  validRecipients: number;
  invalidRows: InvalidMailRow[];
  serviceSummary: string;
  draftEmail: { recipientName: string; recipientCompany: string | null; subject: string; body: string } | null;
}> {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw new Error("User not found");
  }

  if (!input.companyWebsitePrimary.trim()) {
    throw new Error("At least one company website is required");
  }

  const serviceSummary = await getOrCreateResearchSummary({
    userId: input.userId,
    websites: [input.companyWebsitePrimary, input.companyWebsiteSecondary, input.companyWebsiteTertiary ?? ""].filter(Boolean),
    linkedIn: input.socialLinkedIn ?? undefined,
    instagram: input.socialInstagram ?? undefined,
    facebook: input.socialFacebook ?? undefined,
    phoneNumber: input.phoneNumber ?? undefined,
    customInstructions: input.customInstructions ?? undefined,
  });

  const sourceBatches: SourceRowBatch[] = [];
  if (input.sourceType === "GENERATED_LEADS" || input.sourceType === "COMBINED") {
    if (!input.leadRequestId) {
      throw new Error("Select a generated lead request to continue");
    }
    sourceBatches.push({
      sourceType: "GENERATED_LEADS",
      rows: await readGeneratedLeadRecipients(input.leadRequestId),
    });
  }
  if (input.sourceType === "CUSTOM_UPLOAD" || input.sourceType === "COMBINED") {
    if (!input.file) {
      throw new Error("Upload a CSV or Excel file to continue");
    }
    sourceBatches.push({
      sourceType: "CUSTOM_UPLOAD",
      rows: parseTabularFile(input.file),
    });
  }

  if (!sourceBatches.length) {
    throw new Error("No valid recipient rows were found");
  }

  const validatedRows: Array<{ row: ParsedMailRow; sourceType: MailCampaignSourceType }> = [];
  const invalidRows: InvalidMailRow[] = [];
  for (const batch of sourceBatches) {
    const validated = validateMailRows(batch.rows, batch.sourceType);
    validatedRows.push(...validated.validRows.map((row) => ({ row, sourceType: batch.sourceType })));
    invalidRows.push(
      ...validated.invalidRows.map((row) => ({
        ...row,
        sourceLabel: formatSourceLabel(batch.sourceType),
      }))
    );
  }

  const dedupedRows = uniqueRowsByEmail(validatedRows);
  if (!dedupedRows.length || invalidRows.length) {
    const invalidPreview = invalidRows
      .slice(0, 5)
      .map((row) => `${row.sourceLabel ? `${row.sourceLabel} ` : ""}row ${row.rowIndex}: ${row.reason}`)
      .join("; ");
    throw new Error(
      invalidRows.length
        ? `Upload validation failed: ${invalidPreview}`
        : "The uploaded file did not contain any valid recipient rows"
    );
  }

  const previewRecipient = dedupedRows[0];
  const previewSenderEmail = decryptSecret(user.sendingEmailEncrypted ?? "") || user.email;
  const draftEmail =
    previewRecipient && previewSenderEmail
      ? await draftPersonalizedMail({
          senderCompanySummary: serviceSummary,
          senderEmail: previewSenderEmail,
          customInstructions: input.customInstructions ?? undefined,
          recipient: {
            name: previewRecipient.row.name,
            company: previewRecipient.row.company,
            email: previewRecipient.row.email,
            city: previewRecipient.row.city,
            country: previewRecipient.row.country,
            professionalDetails: previewRecipient.row.professional_details,
            website: previewRecipient.row.website,
          },
        })
      : null;

  const campaign = await prisma.$transaction(async (tx) => {
    const draft = await tx.mailCampaign.create({
      data: {
        userId: input.userId,
        sourceType: input.sourceType,
        leadRequestId: input.leadRequestId ?? null,
        companyWebsitePrimary: input.companyWebsitePrimary.trim(),
        companyWebsiteSecondary: input.companyWebsiteSecondary.trim(),
        companyWebsiteTertiary: input.companyWebsiteTertiary?.trim() || null,
        socialLinkedIn: input.socialLinkedIn?.trim() || null,
        socialInstagram: input.socialInstagram?.trim() || null,
        socialFacebook: input.socialFacebook?.trim() || null,
        phoneNumber: input.phoneNumber?.trim() || null,
        customInstructions: input.customInstructions?.trim() || null,
        serviceSummary,
        totalRecipients: dedupedRows.length,
        status: "DRAFT",
      },
    });

    const fileMeta =
      input.file && (input.sourceType === "CUSTOM_UPLOAD" || input.sourceType === "COMBINED")
        ? await uploadSourceFileIfNeeded(user.email, draft.id, input.file)
        : null;

    const recipientCount = await createDraftRecipients(tx, draft.id, input.userId, dedupedRows);
    const updated = await tx.mailCampaign.update({
      where: { id: draft.id },
      data: {
        inputFileName: fileMeta?.inputFileName ?? null,
        inputFileKey: fileMeta?.inputFileKey ?? null,
        inputFileUrl: fileMeta?.inputFileUrl ?? null,
        totalRecipients: recipientCount,
      },
    });
    await seedCampaignThread(tx, {
      campaignId: draft.id,
      userId: input.userId,
      draftEmail: draftEmail
        ? {
            recipientName: previewRecipient.row.name,
            recipientCompany: previewRecipient.row.company || null,
            subject: draftEmail.subject,
            body: draftEmail.body,
          }
        : null,
    });
    return updated;
  });

  return {
    campaign,
    validRecipients: dedupedRows.length,
    invalidRows,
    serviceSummary,
    draftEmail: draftEmail
      ? {
          recipientName: previewRecipient.row.name,
          recipientCompany: previewRecipient.row.company || null,
          subject: draftEmail.subject,
          body: draftEmail.body,
        }
      : null,
  };
}

async function finalizeCampaignCredits(campaignId: string, sentCount: number): Promise<void> {
  const campaign = await prisma.mailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  const charged = sentCount * 4;
  await prisma.$transaction(async (tx) => {
    await tx.mailCampaign.update({
      where: { id: campaignId },
      data: {
        creditsCharged: charged,
        sentCount,
      },
    });
    await tx.user.update({
      where: { id: campaign.userId },
      data: {
        creditsBalance: { decrement: charged },
        creditsReserved: { decrement: campaign.creditsReserved },
        currentMailCampaignId: null,
      },
    });
  });
}

async function markMailCampaignFailed(campaignId: string, errorMessage: string): Promise<void> {
  const campaign = await prisma.mailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  await prisma.mailCampaign.update({
    where: { id: campaignId },
    data: {
      status: "FAILED",
      errorMessage,
    },
  });
}

async function processCampaign(campaignId: string): Promise<void> {
  const campaign = await prisma.mailCampaign.findUnique({
    where: { id: campaignId },
    include: {
      user: true,
      messages: { orderBy: { createdAt: "asc" } },
      recipients: { orderBy: { rowIndex: "asc" } },
    },
  });
  if (!campaign) {
    return;
  }
  if (campaign.status === "CANCELLED") {
    return;
  }

  const senderEmail = decryptSecret(campaign.user.sendingEmailEncrypted ?? "");
  const senderAppPassword = decryptSecret(campaign.user.sendingAppPasswordEncrypted ?? "");
  if (!senderEmail || !senderAppPassword) {
    await markMailCampaignFailed(campaign.id, "Save sending email and app password in Settings before sending mail campaigns.");
    return;
  }

  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
    },
  });

  let sentCount = campaign.sentCount;
  let failedCount = campaign.failedCount;
  const latestDraft = campaign.draftSubject && campaign.draftBody
    ? { subject: campaign.draftSubject, body: campaign.draftBody }
    : parseLatestDraft(campaign.messages as CampaignChatItem[]);

  for (const recipient of campaign.recipients) {
    const latestCampaign = await prisma.mailCampaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    if (!latestCampaign || latestCampaign.status === "CANCELLED") {
      break;
    }
    if (recipient.status === MailRecipientStatus.SENT) {
      continue;
    }

    try {
      const draft = await draftPersonalizedMail({
        senderCompanySummary: campaign.serviceSummary ?? "",
        senderEmail,
        customInstructions: campaign.customInstructions ?? undefined,
        currentDraft: latestDraft,
        recipient: {
          name: recipient.name,
          company: recipient.company,
          email: recipient.email,
          city: recipient.city,
          country: recipient.country,
          professionalDetails: recipient.professionalDetails,
          website: recipient.website,
        },
      });
      const subject = draft.subject.trim();
      const body = draft.body.trim();
      const html = buildEmailHtml({
        subject,
        body,
        senderEmail,
      });

      await prisma.mailRecipient.update({
        where: { id: recipient.id },
        data: {
          emailSubject: subject,
          emailBody: body,
          lastError: null,
        },
      });
      await sendMailWithCredentials(
        {
          senderEmail,
          appPassword: senderAppPassword,
        },
        {
          to: recipient.email,
          subject,
          text: body,
          html,
        }
      );

      sentCount += 1;
      await prisma.$transaction(async (tx) => {
        await tx.mailRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            lastError: null,
          },
        });
        await tx.mailCampaign.update({
          where: { id: campaign.id },
          data: {
            sentCount,
            creditsCharged: sentCount * 4,
          },
        });
      });
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : "Unable to send email";
      await prisma.$transaction(async (tx) => {
        await tx.mailRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "FAILED",
            lastError: message,
          },
        });
        await tx.mailCampaign.update({
          where: { id: campaign.id },
          data: {
            failedCount,
            errorMessage: message.slice(0, 500),
          },
        });
      });
    }

    await new Promise((resolve) => setTimeout(resolve, EMAIL_DELAY_MS));
  }

  const refreshed = await prisma.mailCampaign.findUnique({ where: { id: campaign.id } });
  if (!refreshed) return;
  if (refreshed.status === "CANCELLED") {
    await finalizeCampaignCredits(campaign.id, sentCount);
    await prisma.mailCampaign.update({
      where: { id: campaign.id },
      data: {
        cancelledAt: new Date(),
      },
    });
    return;
  }

  await prisma.mailCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      errorMessage: failedCount > 0 ? `${failedCount} recipient(s) failed, but the campaign completed.` : null,
    },
  });
  await finalizeCampaignCredits(campaign.id, sentCount);
}

async function pumpQueue(): Promise<void> {
  if (pumpRunning) {
    pumpRequested = true;
    return;
  }

  pumpRunning = true;
  try {
    do {
      pumpRequested = false;
      while (pendingJobs.length && activeCampaigns.size < MAX_GLOBAL_CONCURRENCY) {
        const job = pendingJobs.shift();
        if (!job) break;
        activeCampaigns.add(job.campaignId);
        void processCampaign(job.campaignId)
          .catch(async (error) => {
            const message = error instanceof Error ? error.message : "Mail campaign failed";
            await markMailCampaignFailed(job.campaignId, message);
          })
          .finally(() => {
            activeCampaigns.delete(job.campaignId);
            void pumpQueue();
          });
      }
    } while (pumpRequested);
  } finally {
    pumpRunning = false;
    if (pumpRequested) {
      void pumpQueue();
    }
  }
}

export async function startMailCampaign(campaignId: string): Promise<{ accepted: boolean; reason?: string }> {
  const campaign = await prisma.mailCampaign.findUnique({
    where: { id: campaignId },
    include: { user: true },
  });
  if (!campaign) {
    return { accepted: false, reason: "Mail campaign not found" };
  }
  if (!campaign.user.sendingEmailEncrypted || !campaign.user.sendingAppPasswordEncrypted) {
    return { accepted: false, reason: "Save sending email and app password in Settings before sending mail campaigns." };
  }
  if (campaign.status === "RUNNING" || campaign.status === "QUEUED") {
    return { accepted: false, reason: "This mail campaign is already running" };
  }
  const creditsNeeded = campaign.totalRecipients * 4;
  const creditsAvailable = Math.max(campaign.user.creditsBalance - campaign.user.creditsReserved, 0);
  const hasExistingReservation = campaign.creditsReserved > 0;
  if (!hasExistingReservation && creditsAvailable < creditsNeeded) {
    return { accepted: false, reason: "Not enough credits" };
  }
  if (pendingJobs.length + activeCampaigns.size >= MAX_QUEUE_SIZE) {
    return { accepted: false, reason: "Server is busy. Please try again in a moment." };
  }

  await prisma.$transaction(async (tx) => {
    if (hasExistingReservation) {
      const reservation = await tx.user.updateMany({
        where: { id: campaign.userId, currentMailCampaignId: null },
        data: {
          currentMailCampaignId: campaignId,
        },
      });
      if (reservation.count === 0) {
        throw new Error("You already have an active mail campaign");
      }
      await tx.mailCampaign.update({
        where: { id: campaignId },
        data: {
          status: "QUEUED",
          errorMessage: null,
        },
      });
    } else {
      await tx.mailCampaign.update({
        where: { id: campaignId },
        data: {
          status: "QUEUED",
          creditsReserved: creditsNeeded,
          errorMessage: null,
        },
      });
      const reservation = await tx.user.updateMany({
        where: { id: campaign.userId, currentMailCampaignId: null },
        data: {
          creditsReserved: { increment: creditsNeeded },
          currentMailCampaignId: campaignId,
        },
      });
      if (reservation.count === 0) {
        throw new Error("You already have an active mail campaign");
      }
    }
  });

  pendingJobs.push({ campaignId });
  void pumpQueue();
  return { accepted: true };
}

export async function cancelMailCampaign(campaignId: string): Promise<boolean> {
  const campaign = await prisma.mailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return false;
  if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED") return true;

  if (activeCampaigns.has(campaignId)) {
    await prisma.mailCampaign.update({
      where: { id: campaignId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });
    return true;
  }

  const charged = campaign.sentCount * 4;
  await prisma.$transaction(async (tx) => {
    await tx.mailCampaign.update({
      where: { id: campaignId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        creditsCharged: charged,
      },
    });
    await tx.user.update({
      where: { id: campaign.userId },
      data: {
        creditsBalance: { decrement: charged },
        creditsReserved: { decrement: campaign.creditsReserved },
        currentMailCampaignId: null,
      },
    });
  });
  return true;
}

export async function deleteMailCampaign(campaignId: string, userId: string): Promise<boolean> {
  const campaign = await prisma.mailCampaign.findFirst({
    where: { id: campaignId, userId },
  });
  if (!campaign) return false;
  if (campaign.status === "RUNNING" || campaign.status === "QUEUED") {
    throw new Error("Cancel the active campaign before deleting it");
  }

  if (campaign.inputFileKey) {
    await deleteR2Prefix(path.posix.dirname(campaign.inputFileKey));
  }

  await prisma.mailCampaign.delete({
    where: { id: campaign.id },
  });
  return true;
}

export async function listMailCampaigns(userId: string) {
  return prisma.mailCampaign.findMany({
    where: { userId },
    orderBy: { requestedAt: "desc" },
  });
}

export async function getMailCampaign(userId: string, campaignId: string) {
  return prisma.mailCampaign.findFirst({
    where: { id: campaignId, userId },
    include: {
      recipients: { orderBy: { rowIndex: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function appendCampaignChatMessage(input: {
  userId: string;
  campaignId: string;
  content: string;
}): Promise<{ campaign: unknown; assistant: { subject: string; body: string } }> {
  const campaign = await prisma.mailCampaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    include: {
      user: true,
      recipients: { orderBy: { rowIndex: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!campaign) {
    throw new Error("Mail campaign not found");
  }
  const anchorRecipient = campaign.recipients[0];
  if (!anchorRecipient) {
    throw new Error("No recipient draft is available for this campaign");
  }

  const currentDraft = campaign.draftSubject && campaign.draftBody
    ? { subject: campaign.draftSubject, body: campaign.draftBody }
    : parseLatestDraft(campaign.messages as CampaignChatItem[]);
  const conversation = campaign.messages
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const assistant = await reviseCampaignDraft({
    senderCompanySummary: campaign.serviceSummary ?? "",
    senderEmail: campaign.user.sendingEmailEncrypted ? decryptSecret(campaign.user.sendingEmailEncrypted) || campaign.user.email : campaign.user.email,
    customInstructions: campaign.customInstructions ?? undefined,
    recipient: {
      name: anchorRecipient.name,
      company: anchorRecipient.company,
      email: anchorRecipient.email,
      city: anchorRecipient.city,
      country: anchorRecipient.country,
      professionalDetails: anchorRecipient.professionalDetails,
      website: anchorRecipient.website,
    },
    currentDraft,
    userInstruction: input.content,
    conversation,
  });

  await prisma.$transaction(async (tx) => {
    await tx.mailCampaignChatMessage.createMany({
      data: [
        {
          campaignId: input.campaignId,
          userId: input.userId,
          role: "USER",
          content: input.content,
        },
        {
          campaignId: input.campaignId,
          userId: input.userId,
          role: "ASSISTANT",
          content: formatAssistantDraft(assistant.subject, assistant.body),
          draftSubject: assistant.subject,
          draftBody: assistant.body,
        },
      ],
    });
    await tx.mailCampaign.update({
      where: { id: input.campaignId },
      data: {
        draftSubject: assistant.subject,
        draftBody: assistant.body,
      },
    });
  });

  const updatedCampaign = await getMailCampaign(input.userId, input.campaignId);
  return {
    campaign: updatedCampaign,
    assistant,
  };
}
