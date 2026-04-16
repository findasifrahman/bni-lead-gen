import fs from "fs";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./lib/prisma";
import { env, repoPath } from "./lib/env";
import { encryptSecret, decryptSecret } from "./lib/crypto";
import { AuthedRequest, requireAdmin, requireAuth, signJwt } from "./lib/auth";
import { getCategories, getCountryItems } from "./services/reference";
import { sendPasswordResetEmail } from "./services/email";
import {
  cancelRunningJob,
  estimateLeadGenerationByCredentials,
  isBniUsernameLocked,
  startLeadScrape,
} from "./services/scraperRunner";
import { deleteR2Prefix, getR2Object } from "./lib/r2";
import {
  cancelMailCampaign,
  appendCampaignChatMessage,
  createMailCampaignDraft,
  deleteMailCampaign,
  getMailCampaign,
  listMailCampaigns,
  startMailCampaign,
} from "./services/mailCampaigns";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/\d/, "Password must include a number");

const userCreateSchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
  password: passwordSchema,
  role: z.enum(["USER", "ADMIN"]).default("USER"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().default(false),
});

const leadRequestSchema = z.object({
  keyword: z.string().trim().optional().default(""),
  country: z.string().trim().min(2),
  category: z.string().trim().optional().default(""),
});

const applyCreditSchema = z.object({
  requestedCredits: z.number().int().min(200).max(5000),
  note: z.string().trim().optional().default(""),
});

const settingsSchema = z.object({
  bniUsername: z.string().trim().optional().default(""),
  bniPassword: z.string().trim().optional().default(""),
  sendingEmail: z.string().trim().optional().default(""),
  sendingAppPassword: z.string().trim().optional().default(""),
  currentPassword: z.string().trim().optional().default(""),
  newPassword: z.string().trim().optional().default(""),
  confirmPassword: z.string().trim().optional().default(""),
});

const mailCampaignDraftSchema = z.object({
  sourceType: z.enum(["GENERATED_LEADS", "CUSTOM_UPLOAD", "COMBINED"]),
  leadRequestId: z.string().trim().optional().default(""),
  companyWebsitePrimary: z.string().trim().min(2),
  companyWebsiteSecondary: z.string().trim().optional().default(""),
  companyWebsiteTertiary: z.string().trim().optional().default(""),
  socialLinkedIn: z.string().trim().optional().default(""),
  socialInstagram: z.string().trim().optional().default(""),
  socialFacebook: z.string().trim().optional().default(""),
  phoneNumber: z.string().trim().optional().default(""),
  customInstructions: z.string().trim().optional().default(""),
});

const mailCampaignChatSchema = z.object({
  content: z.string().trim().min(1),
});

const mailCampaignDraftUpdateSchema = z.object({
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const creditAdjustSchema = z.object({
  amount: z.number().int(),
});

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toPublicUser(user: {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  creditsBalance: number;
  creditsReserved: number;
  bniUsername: string | null;
  maxProfileConcurrency: number;
  maxCountryProfiles: number;
  requestDelayMin: number;
  requestDelayMax: number;
  headless: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    creditsBalance: user.creditsBalance,
    creditsReserved: user.creditsReserved,
    creditsAvailable: Math.max(user.creditsBalance - user.creditsReserved, 0),
    hasBniUsername: Boolean(user.bniUsername),
    maxProfileConcurrency: user.maxProfileConcurrency,
    maxCountryProfiles: user.maxCountryProfiles,
    requestDelayMin: user.requestDelayMin,
    requestDelayMax: user.requestDelayMax,
    headless: user.headless,
  };
}

function estimateMinutes(totalLeads: number): number {
  return Math.max(1, Math.ceil(totalLeads / 50));
}

async function appendApiDebug(message: string): Promise<void> {
  const debugDir = repoPath("debug");
  const debugFile = path.join(debugDir, "api.log");
  await fs.promises.mkdir(debugDir, { recursive: true });
  await fs.promises.appendFile(debugFile, `${new Date().toISOString()} | ${message}\n`, "utf8");
}

async function getAuthedUser(req: AuthedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!user) {
    res.status(401).json({ message: "User not found" });
    return null;
  }
  return user;
}

function getOutputDownloadLink(requestId: string): string {
  return `/api/generated-leads/${requestId}/download`;
}

function buildResetUrl(token: string): string {
  return `${env.webOrigin}/reset-password?token=${encodeURIComponent(token)}`;
}

const mailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "upgrade-insecure-requests": null,
        },
      },
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
    })
  );
  app.use(cors({ origin: env.webOrigin, credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "bni-lead-gen-api" });
  });

  app.get("/reference/countries", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    res.json({ items: getCountryItems(query) });
  });

  app.get("/reference/categories", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    res.json({ items: getCategories(query) });
  });

  app.post("/auth/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      res.status(423).json({
        message: "Account temporarily locked due to too many failed attempts",
        lockedUntil: user.lockedUntil,
      });
      return;
    }

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
      const failedLoginCount = user.failedLoginCount + 1;
      const lockedUntil = failedLoginCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount, lockedUntil },
      });
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const token = signJwt(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
      },
      parsed.data.rememberMe
    );

    res.json({
      token,
      user: toPublicUser(user),
    });
  });

  app.post("/auth/forgot-password", async (req, res) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) {
      res.json({ message: "If the email exists, a reset link will be sent." });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token: tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });
    await sendPasswordResetEmail(user.email, buildResetUrl(token));
    res.json({ message: "If the email exists, a reset link will be sent." });
  });

  app.post("/auth/reset-password", async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });

    if (!resetToken || resetToken.status !== "PENDING" || resetToken.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ message: "Reset token is invalid or expired" });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await prisma.user.update({
      where: { id: resetToken.userId },
      data: {
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { status: "USED", usedAt: new Date() },
    });
    res.json({ message: "Password reset successfully" });
  });

  app.use("/api", requireAuth);

  app.get("/api/me", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    res.json({ user: toPublicUser(user) });
  });

  app.get("/api/dashboard/summary", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const lastLeadRequest = await prisma.leadRequest.findFirst({
      where: { userId: user.id },
      orderBy: { requestedAt: "desc" },
    });
    const currentLeadRequest = user.currentLeadRequestId
      ? await prisma.leadRequest.findUnique({ where: { id: user.currentLeadRequestId } })
      : null;
    const activeLeadRequest = currentLeadRequest && ["QUEUED", "RUNNING"].includes(currentLeadRequest.status)
      ? currentLeadRequest
      : lastLeadRequest && ["QUEUED", "RUNNING"].includes(lastLeadRequest.status)
        ? lastLeadRequest
        : null;
    res.json({
      user: toPublicUser(user),
      activeLeadRequest,
      lastLeadRequest,
    });
  });

  app.get("/api/generated-leads", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const rows = await prisma.leadRequest.findMany({
      where: {
        userId: user.id,
        status: "COMPLETED",
        OR: [{ r2CsvKey: { not: null } }, { csvPath: { not: null } }],
        totalLeads: { gt: 0 },
      },
      orderBy: { requestedAt: "desc" },
    });
    const filtered = rows.filter((row) => {
      if (!search) return true;
      return [row.filename, row.country, row.category ?? "", row.keyword ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
    res.json({
      items: filtered.map((row) => ({
        ...row,
        downloadUrl: getOutputDownloadLink(row.id),
      })),
    });
  });

  app.delete("/api/generated-leads/:id", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const requestId = req.params.id as string;
    const leadRequest = await prisma.leadRequest.findFirst({
      where: { id: requestId, userId: user.id, status: "COMPLETED" },
    });
    if (!leadRequest) {
      res.status(404).json({ message: "Lead request not found" });
      return;
    }

    if (leadRequest.r2Prefix || leadRequest.r2CsvKey) {
      const prefix = leadRequest.r2Prefix ?? path.posix.dirname(leadRequest.r2CsvKey ?? "");
      if (prefix) {
        await deleteR2Prefix(prefix).catch(() => undefined);
      }
    } else if (leadRequest.csvPath && fs.existsSync(leadRequest.csvPath)) {
      const targetDir = path.dirname(leadRequest.csvPath);
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    }
    await prisma.leadRequest.delete({ where: { id: requestId } });
    res.json({ message: "Generated lead file deleted" });
  });

  app.get("/api/generated-leads/:id/download", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const requestId = req.params.id as string;
    const leadRequest = await prisma.leadRequest.findFirst({
      where: { id: requestId, userId: user.id, status: "COMPLETED" },
    });
    if (leadRequest?.r2CsvKey) {
      try {
        const object = await getR2Object(leadRequest.r2CsvKey);
        const body = object.Body as NodeJS.ReadableStream | undefined;
        if (!body) {
          res.status(404).json({ message: "File not found" });
          return;
        }
        res.setHeader("Content-Disposition", `attachment; filename="${leadRequest.filename}"`);
        if (object.ContentType) {
          res.setHeader("Content-Type", object.ContentType);
        }
        body.pipe(res);
        return;
      } catch (error) {
        console.error("Failed to stream R2 download:", error);
      }
    }
    if (leadRequest?.csvPath && fs.existsSync(leadRequest.csvPath)) {
      res.download(leadRequest.csvPath, leadRequest.filename);
      return;
    }
    res.status(404).json({ message: "File not found" });
  });

  app.get("/api/account", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const applications = await prisma.creditApplication.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      user: toPublicUser(user),
      applications,
    });
  });

  app.post("/api/account/credit-applications", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const parsed = applyCreditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const application = await prisma.creditApplication.create({
      data: {
        userId: user.id,
        requestedCredits: parsed.data.requestedCredits,
        note: parsed.data.note,
      },
    });

    res.json({
      application,
      message: "Thank you. Our team will contact you soon.",
    });
  });

  app.get("/api/settings", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const revealPassword = String(req.query.revealPassword ?? "").toLowerCase() === "true";
    const revealMailPassword = String(req.query.revealMailPassword ?? "").toLowerCase() === "true";
    res.json({
      settings: {
        bniUsername: user.bniUsername ?? "",
        bniPassword: revealPassword ? decryptSecret(user.bniPasswordEncrypted ?? "") : "",
        hasBniPassword: Boolean(user.bniPasswordEncrypted),
        sendingEmail: decryptSecret(user.sendingEmailEncrypted ?? ""),
        sendingAppPassword: revealMailPassword ? decryptSecret(user.sendingAppPasswordEncrypted ?? "") : "",
        hasSendingAppPassword: Boolean(user.sendingAppPasswordEncrypted),
        maxProfileConcurrency: user.maxProfileConcurrency,
        maxCountryProfiles: user.maxCountryProfiles,
        requestDelayMin: user.requestDelayMin,
        requestDelayMax: user.requestDelayMax,
        headless: user.headless,
      },
    });
  });

  app.patch("/api/settings", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const currentPasswordOk = await bcrypt.compare(parsed.data.currentPassword || "", user.passwordHash);
    const passwordChangeRequested = Boolean(parsed.data.newPassword);
    if (passwordChangeRequested && !currentPasswordOk) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }
    if (passwordChangeRequested && parsed.data.newPassword !== parsed.data.confirmPassword) {
      res.status(400).json({ message: "New passwords do not match" });
      return;
    }
    if (passwordChangeRequested) {
      const strong = passwordSchema.safeParse(parsed.data.newPassword);
      if (!strong.success) {
        res.status(400).json({ message: strong.error.issues[0]?.message ?? "Password too weak" });
        return;
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        bniUsername: parsed.data.bniUsername || user.bniUsername,
        bniPasswordEncrypted: parsed.data.bniPassword ? encryptSecret(parsed.data.bniPassword) : user.bniPasswordEncrypted,
        sendingEmailEncrypted: parsed.data.sendingEmail ? encryptSecret(parsed.data.sendingEmail) : user.sendingEmailEncrypted,
        sendingAppPasswordEncrypted: parsed.data.sendingAppPassword
          ? encryptSecret(parsed.data.sendingAppPassword)
          : user.sendingAppPasswordEncrypted,
        ...(passwordChangeRequested
          ? {
              passwordHash: await bcrypt.hash(parsed.data.newPassword, 12),
            }
          : {}),
      },
    });

    res.json({ message: "Settings saved successfully" });
  });

  app.get("/api/mail-campaigns", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const campaigns = await listMailCampaigns(user.id);
    res.json({
      items: campaigns,
    });
  });

  app.get("/api/mail-campaigns/:id", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const campaign = await getMailCampaign(user.id, req.params.id as string);
    if (!campaign) {
      res.status(404).json({ message: "Mail campaign not found" });
      return;
    }
    res.json({ item: campaign });
  });

  app.post("/api/mail-campaigns/preview", mailUpload.single("file"), async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const parsed = mailCampaignDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    try {
      const draft = await createMailCampaignDraft({
        userId: user.id,
        sourceType: parsed.data.sourceType,
        leadRequestId: parsed.data.leadRequestId || null,
        file: req.file
          ? {
              originalname: req.file.originalname,
              mimetype: req.file.mimetype,
              buffer: req.file.buffer,
            }
          : null,
        companyWebsitePrimary: parsed.data.companyWebsitePrimary,
        companyWebsiteSecondary: parsed.data.companyWebsiteSecondary,
        companyWebsiteTertiary: parsed.data.companyWebsiteTertiary || null,
        socialLinkedIn: parsed.data.socialLinkedIn || null,
        socialInstagram: parsed.data.socialInstagram || null,
        socialFacebook: parsed.data.socialFacebook || null,
        phoneNumber: parsed.data.phoneNumber || null,
        customInstructions: parsed.data.customInstructions || null,
      });

      res.json({
        campaign: draft.campaign,
        invalidRows: draft.invalidRows,
        serviceSummary: draft.serviceSummary,
        draftEmail: draft.draftEmail,
        validRecipients: draft.validRecipients,
        estimatedCredits: draft.validRecipients * 4,
        message:
          draft.validRecipients > 0
            ? `Validated ${draft.validRecipients} recipient(s). Maximum ${draft.validRecipients * 4} credits may be deducted.`
            : "No valid recipients found in the provided source.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to validate mail campaign";
      res.status(400).json({ message });
    }
  });

  app.post("/api/mail-campaigns/:id/start", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const campaignId = req.params.id as string;
    const campaign = await prisma.mailCampaign.findFirst({
      where: { id: campaignId, userId: user.id },
    });
    if (!campaign) {
      res.status(404).json({ message: "Mail campaign not found" });
      return;
    }
    const result = await startMailCampaign(campaignId);
    if (!result.accepted) {
      res.status(result.reason?.startsWith("Server is busy") ? 503 : 409).json({
        message: result.reason ?? "Unable to start mail campaign",
      });
      return;
    }
    res.status(202).json({ message: "Mail campaign queued" });
  });

  app.post("/api/mail-campaigns/:id/cancel", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const campaignId = req.params.id as string;
    const campaign = await prisma.mailCampaign.findFirst({
      where: { id: campaignId, userId: user.id },
    });
    if (!campaign) {
      res.status(404).json({ message: "Mail campaign not found" });
      return;
    }
    const cancelled = await cancelMailCampaign(campaignId);
    if (!cancelled) {
      res.status(400).json({ message: "Unable to cancel mail campaign" });
      return;
    }
    res.json({ message: "Mail campaign cancelled" });
  });

  app.delete("/api/mail-campaigns/:id", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    try {
      const deleted = await deleteMailCampaign(req.params.id as string, user.id);
      if (!deleted) {
        res.status(404).json({ message: "Mail campaign not found" });
        return;
      }
      res.json({ message: "Mail campaign deleted" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete mail campaign";
      res.status(400).json({ message });
    }
  });

  app.post("/api/mail-campaigns/:id/chat", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const parsed = mailCampaignChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    try {
      const result = await appendCampaignChatMessage({
        userId: user.id,
        campaignId: req.params.id as string,
        content: parsed.data.content,
      });
      res.json({
        campaign: result.campaign,
        assistant: result.assistant,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update campaign draft";
      res.status(400).json({ message });
    }
  });

  app.patch("/api/mail-campaigns/:id/draft", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const parsed = mailCampaignDraftUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const campaign = await prisma.mailCampaign.findFirst({
      where: { id: req.params.id as string, userId: user.id },
    });
    if (!campaign) {
      res.status(404).json({ message: "Mail campaign not found" });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.mailCampaign.update({
        where: { id: campaign.id },
        data: {
          draftSubject: parsed.data.subject,
          draftBody: parsed.data.body,
        },
      });
      await tx.mailCampaignChatMessage.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          role: "ASSISTANT",
          content: `Subject: ${parsed.data.subject}\n\n${parsed.data.body}`,
          draftSubject: parsed.data.subject,
          draftBody: parsed.data.body,
        },
      });
    });
    const updated = await getMailCampaign(user.id, campaign.id);
    res.json({ item: updated });
  });

  app.get("/api/lead-requests", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const rows = await prisma.leadRequest.findMany({
      where: {
        userId: user.id,
        ...(from || to
          ? {
              requestedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { requestedAt: "desc" },
    });
    const filtered = rows.filter((row) => {
      if (!search) return true;
      return [row.filename, row.country, row.category ?? "", row.keyword ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
    res.json({ items: filtered });
  });

  app.get("/api/lead-requests/:id", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const requestId = req.params.id as string;
    const leadRequest = await prisma.leadRequest.findFirst({
      where: { id: requestId, userId: user.id },
    });
    if (!leadRequest) {
      res.status(404).json({ message: "Lead request not found" });
      return;
    }
    res.json({ item: leadRequest });
  });

  app.post("/api/lead-requests", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    if (user.currentLeadRequestId) {
      res.status(409).json({ message: "A lead generation request is already running" });
      return;
    }
    if (!user.bniUsername || !user.bniPasswordEncrypted) {
      res.status(409).json({
        message: "Save your BNI username and password in Settings before starting lead generation.",
      });
      return;
    }

    const usernameLock = await isBniUsernameLocked(user.bniUsername);
    if (usernameLock) {
      res.status(409).json({
        message: "This BNI username is already running another scrape. Please wait for it to finish.",
      });
      return;
    }

    const parsed = leadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const hasActiveRequest = await prisma.leadRequest.findFirst({
      where: {
        userId: user.id,
        status: "RUNNING",
      },
    });
    if (hasActiveRequest) {
      res.status(409).json({ message: "You already have an active lead request" });
      return;
    }

    const keywordForLead = parsed.data.keyword.trim();
    const estimatedRequiredCredits = Math.max(1, Math.ceil(user.maxCountryProfiles / 2));
    const creditsAvailable = Math.max(user.creditsBalance - user.creditsReserved, 0);
    if (creditsAvailable < estimatedRequiredCredits) {
      res.status(409).json({
        message: "Not enough credits",
        requiredCredits: estimatedRequiredCredits,
        creditsAvailable,
      });
      return;
    }
    const filename = await import("./services/reference").then(({ makeLeadFilename }) =>
      makeLeadFilename(user.id, parsed.data.country, parsed.data.category, keywordForLead)
    );

    let leadRequest;
    try {
      leadRequest = await prisma.$transaction(async (tx) => {
        const latestUser = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            creditsBalance: true,
            creditsReserved: true,
            currentLeadRequestId: true,
          },
        });
        if (!latestUser) {
          throw new Error("User not found");
        }
        const latestAvailable = Math.max(latestUser.creditsBalance - latestUser.creditsReserved, 0);
        if (latestUser.currentLeadRequestId) {
          throw new Error("You already have an active lead request");
        }
        if (latestAvailable < estimatedRequiredCredits) {
          throw new Error("Not enough credits");
        }

        const created = await tx.leadRequest.create({
          data: {
            userId: user.id,
            keyword: parsed.data.keyword,
            country: parsed.data.country,
            category: parsed.data.category,
            filename,
            totalLeads: 0,
            requiredCredits: estimatedRequiredCredits,
            estimatedMinutes: Math.max(1, Math.ceil(user.maxCountryProfiles / 50)),
            status: "QUEUED",
          },
        });

        const reservation = await tx.user.updateMany({
          where: { id: user.id, currentLeadRequestId: null },
          data: {
            creditsReserved: { increment: estimatedRequiredCredits },
            currentLeadRequestId: created.id,
          },
        });
        if (reservation.count === 0) {
          throw new Error("You already have an active lead request");
        }

        return created;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start lead generation";
      if (message === "Not enough credits") {
        res.status(409).json({
          message: "Not enough credits",
          requiredCredits: estimatedRequiredCredits,
          creditsAvailable: Math.max(user.creditsBalance - user.creditsReserved, 0),
        });
        return;
      }
      if (message === "You already have an active lead request") {
        res.status(409).json({ message: "You already have an active lead request" });
        return;
      }
      console.error("Failed to create lead request:", error);
      res.status(500).json({ message: "Unable to start lead generation" });
      return;
    }

    const admission = await startLeadScrape({
      requestId: leadRequest.id,
      country: parsed.data.country,
      category: parsed.data.category,
      keyword: keywordForLead,
      filename,
    });

    if (!admission.accepted) {
      await prisma.leadRequest.update({
        where: { id: leadRequest.id },
        data: {
          status: "FAILED",
          errorMessage: admission.reason ?? "Unable to start lead generation",
          completedAt: new Date(),
        },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: {
          creditsReserved: { decrement: estimatedRequiredCredits },
          currentLeadRequestId: null,
        },
      });
      res.status(admission.reason?.startsWith("Server is busy") ? 503 : 409).json({
        message: admission.reason ?? "Unable to start lead generation",
      });
      return;
    }

    res.status(202).json({
      item: leadRequest,
      message: "Lead generation queued",
    });
  });

  app.post("/api/lead-requests/preflight", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    if (user.currentLeadRequestId) {
      res.status(409).json({ message: "A lead generation request is already running" });
      return;
    }
    if (!user.bniUsername || !user.bniPasswordEncrypted) {
      res.status(409).json({
        message: "Save your BNI username and password in Settings before starting lead generation.",
      });
      return;
    }

    const parsed = leadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const credentials = {
      username: user.bniUsername.trim(),
      password: decryptSecret(user.bniPasswordEncrypted ?? ""),
    };
    if (!credentials.password) {
      res.status(409).json({
        message: "Save your BNI username and password in Settings before starting lead generation.",
      });
      return;
    }

    const usernameLock = await isBniUsernameLocked(credentials.username);
    if (usernameLock) {
      res.status(409).json({
        message: "This BNI username is already running another scrape. Please wait for it to finish.",
      });
      return;
    }

    let estimate;
    try {
      estimate = await estimateLeadGenerationByCredentials(credentials, {
        country: parsed.data.country,
        category: parsed.data.category,
        keyword: parsed.data.keyword,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to estimate generation";
      console.error("Preflight estimate failed:", error);
      void appendApiDebug(`preflight failed | user=${user.id} | country=${parsed.data.country} | category=${parsed.data.category} | keyword=${parsed.data.keyword} | ${message}`);
      res.status(400).json({ message });
      return;
    }

    const creditsAvailable = Math.max(user.creditsBalance - user.creditsReserved, 0);
    if (creditsAvailable < estimate.requiredCredits) {
      res.status(409).json({
        message: "Not enough credits",
        requiredCredits: estimate.requiredCredits,
        creditsAvailable,
      });
      return;
    }

    res.json({
      estimate,
      message:
        estimate.totalLeads === 0
          ? "No matching profiles found for the selected filters."
          : `Maximum ${estimate.requiredCredits} credits may be deducted if all scraped profiles have emails.`,
    });
  });

  app.post("/api/lead-requests/:id/cancel", async (req, res) => {
    const user = await getAuthedUser(req as AuthedRequest, res);
    if (!user) return;
    const requestId = req.params.id as string;
    const leadRequest = await prisma.leadRequest.findFirst({
      where: { id: requestId, userId: user.id },
    });
    if (!leadRequest) {
      res.status(404).json({ message: "Lead request not found" });
      return;
    }

    const running = cancelRunningJob(leadRequest.id);
    if (leadRequest.status === "RUNNING" || leadRequest.status === "COUNTING" || leadRequest.status === "AWAITING_APPROVAL") {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          currentLeadRequestId: null,
          creditsReserved: { decrement: leadRequest.requiredCredits },
        },
      });
    }

    await prisma.leadRequest.update({
      where: { id: leadRequest.id },
      data: {
        status: "CANCELLED",
        cancelReason: running ? "Cancelled by user" : "Cancelled before scrape",
        cancelledAt: new Date(),
      },
    });

    res.json({ message: "Lead request cancelled" });
  });

  app.get("/api/admin/users", requireAdmin, async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        creditsBalance: true,
        creditsReserved: true,
        currentLeadRequestId: true,
        maxProfileConcurrency: true,
        maxCountryProfiles: true,
        requestDelayMin: true,
        requestDelayMax: true,
        headless: true,
        createdAt: true,
      },
    });
    res.json({
      items: users.map((user) => ({
        ...user,
        creditsAvailable: Math.max(user.creditsBalance - user.creditsReserved, 0),
      })),
    });
  });

  app.post("/api/admin/users", requireAdmin, async (req, res) => {
    const parsed = userCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        passwordHash,
        role: parsed.data.role,
      },
    });
    res.status(201).json({ item: toPublicUser(user) });
  });

  app.patch("/api/admin/users/:id/credits", requireAdmin, async (req, res) => {
    const parsed = creditAdjustSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const userId = req.params.id as string;
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        creditsBalance: {
          increment: parsed.data.amount,
        },
      },
    });
    res.json({ item: toPublicUser(user) });
  });

  app.get("/api/admin/credit-applications", requireAdmin, async (_req, res) => {
    const items = await prisma.creditApplication.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });
    res.json({ items });
  });

  app.patch("/api/admin/credit-applications/:id", requireAdmin, async (req, res) => {
    const schema = z.object({
      status: z.enum(["APPROVED", "REJECTED"]),
      adminNote: z.string().trim().optional().default(""),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const applicationId = req.params.id as string;
    const application = await prisma.creditApplication.findUnique({
      where: { id: applicationId },
      include: { user: true },
    });
    if (!application) {
      res.status(404).json({ message: "Credit application not found" });
      return;
    }

    await prisma.creditApplication.update({
      where: { id: application.id },
      data: {
        status: parsed.data.status,
        adminNote: parsed.data.adminNote,
      },
    });

    if (parsed.data.status === "APPROVED") {
      await prisma.user.update({
        where: { id: application.userId },
        data: {
          creditsBalance: { increment: application.requestedCredits },
        },
      });
    }

    res.json({ message: "Credit application updated" });
  });

  app.post("/api/admin/lead-requests/:id/resume", requireAdmin, async (req, res) => {
    const leadRequestId = req.params.id as string;
    const leadRequest = await prisma.leadRequest.findUnique({
      where: { id: leadRequestId },
    });
    if (!leadRequest) {
      res.status(404).json({ message: "Lead request not found" });
      return;
    }
    res.json({
      message: "Manual resume hook reserved for future use",
      item: leadRequest,
    });
  });

  const webDist = repoPath("apps", "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    console.error(error);
    res.status(500).json({ message: "Unexpected server error" });
  });

  return app;
}
