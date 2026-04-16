import { randomUUID } from "crypto";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env, repoPath } from "../lib/env";
import { decryptSecret } from "../lib/crypto";
import { buildReadableR2Prefix, deleteR2Prefix, getR2ObjectUrl, uploadFileToR2 } from "../lib/r2";
import { makeLeadFilename } from "./reference";

type JobMeta = {
  requestId: string;
};

type ScraperCredentials = {
  username: string;
  password: string;
  userId?: string;
};

const runningJobs = new Map<string, ChildProcessWithoutNullStreams>();
const reservedUsernames = new Set<string>();
type LeadJob = {
  requestId: string;
  userId: string;
  username: string;
  normalizedUsername: string;
  password: string;
  country: string;
  category: string;
  keyword: string;
  filename: string;
};

type QueueAdmission = {
  accepted: boolean;
  reason?: string;
};

const pendingJobs: LeadJob[] = [];
const activeUsernames = new Set<string>();
let activeGlobalJobs = 0;
let pumpRunning = false;
let pumpRequested = false;
const MAX_GLOBAL_CONCURRENCY = Math.max(1, Number.isFinite(env.maxGlobalScrapeConcurrency) ? env.maxGlobalScrapeConcurrency : 2);
const MAX_GLOBAL_QUEUE_SIZE = Math.max(MAX_GLOBAL_CONCURRENCY, Number.isFinite(env.maxGlobalScrapeQueueSize) ? env.maxGlobalScrapeQueueSize : 10);
const BNI_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

function normalizeBniUsername(username: string): string {
  return username.trim().toLowerCase();
}

function buildLeadArtifactPrefix(email: string, country: string, category: string, keyword: string, requestId: string): string {
  const safeCategory = category ? slugify(category) : "country-only";
  const safeKeyword = keyword ? slugify(keyword) : "no-keyword";
  return buildReadableR2Prefix(["users", slugify(email), slugify(country), safeCategory, safeKeyword, requestId]);
}

function queueSize(): number {
  return activeGlobalJobs + pendingJobs.length;
}

function resolveCategorySlug(category: string): string {
  if (!category) return "country_only";
  return slugify(category);
}

function resolveSearchBucket(country: string, category: string, keyword: string): string {
  const parts = [slugify(country), resolveCategorySlug(category)];
  const keywordSlug = slugify(keyword);
  if (keywordSlug) {
    parts.push(keywordSlug);
  }
  return path.join(...parts);
}

function resolveHeadlessFlag(fallback: boolean): string {
  const configured = process.env.HEADLESS?.trim();
  if (configured) {
    return configured;
  }
  return String(fallback);
}

function sanitizeScraperError(raw: string, fallback: string): string {
  const text = raw.trim();
  if (!text) return fallback;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx];
    if (
      line.startsWith("RuntimeError:") ||
      line.startsWith("ValueError:") ||
      line.startsWith("PermissionError:") ||
      line.startsWith("TimeoutError:") ||
      line.startsWith("Exception:") ||
      line.startsWith("Error:")
    ) {
      return line.replace(/^[A-Za-z]+Error:\s*/, "").replace(/^[A-Za-z]+:\s*/, "");
    }
  }

  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine && !lastLine.includes("File \"") && !lastLine.includes("Traceback (most recent call last):")) {
    return lastLine.replace(/^[A-Za-z]+Error:\s*/, "").replace(/^[A-Za-z]+:\s*/, "");
  }

  return fallback;
}

function forwardChildOutput(child: ChildProcessWithoutNullStreams, label: string): void {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label} stdout] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label} stderr] ${chunk.toString()}`);
  });
}

async function appendApiDebug(message: string): Promise<void> {
  const debugDir = repoPath("debug");
  const debugFile = path.join(debugDir, "api.log");
  await fs.mkdir(debugDir, { recursive: true });
  await fs.appendFile(debugFile, `${new Date().toISOString()} | ${message}\n`, "utf8");
}

async function readCsvCount(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  return Math.max(lines.length - 1, 0);
}

async function readCsvCountIfExists(filePath: string): Promise<number> {
  try {
    return await readCsvCount(filePath);
  } catch {
    return 0;
  }
}

async function exportCsvRowsFromPython(csvPath: string): Promise<Array<Record<string, string>>> {
  const child = await spawnPython([env.scraperEntry, "export-csv-rows", "--input", csvPath], {
    HEADLESS: resolveHeadlessFlag(true),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const result = await new Promise<{ code: number | null }>((resolve) => {
    child.on("error", () => resolve({ code: 1 }));
    child.on("close", (code) => resolve({ code }));
  });
  if (result.code !== 0) {
    throw new Error(sanitizeScraperError(stderr, "Unable to read generated CSV rows"));
  }
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Generated CSV export returned an invalid payload");
  }
  return parsed.filter((row): row is Record<string, string> => Boolean(row && typeof row === "object"));
}

async function uploadDirectoryToR2(targetDir: string, objectPrefix: string): Promise<{ csvKey: string; csvUrl: string }> {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const uploaded: Array<{ name: string; key: string; url: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const localPath = path.join(targetDir, entry.name);
    const objectKey = path.posix.join(objectPrefix, entry.name);
    const contentType = entry.name.endsWith(".csv")
      ? "text/csv; charset=utf-8"
      : entry.name.endsWith(".json")
        ? "application/json; charset=utf-8"
        : entry.name.endsWith(".jsonl")
          ? "application/jsonl; charset=utf-8"
          : entry.name.endsWith(".txt")
            ? "text/plain; charset=utf-8"
            : "application/octet-stream";
    const url = await uploadFileToR2(objectKey, localPath, contentType);
    uploaded.push({ name: entry.name, key: objectKey, url });
  }
  const csvFile = uploaded.find((item) => item.name === "profiles.csv");
  if (!csvFile) {
    throw new Error("Generated CSV was not found for R2 upload");
  }
  return { csvKey: csvFile.key, csvUrl: csvFile.url };
}

function toNullableText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

async function persistGeneratedLeadRows(
  tx: Prisma.TransactionClient,
  requestId: string,
  userId: string,
  country: string,
  category: string,
  keyword: string,
  rows: Array<Record<string, string>>
): Promise<number> {
  if (!rows.length) {
    return 0;
  }

  const records = rows.map((row, index) => ({
    leadRequestId: requestId,
    userId,
    rowIndex: index + 1,
    profileUrl: toNullableText(row.profile_url) ?? "",
    name: toNullableText(row.name),
    company: toNullableText(row.company),
    email: toNullableText(row.email),
    phone1: toNullableText(row.phone_1),
    phone2: toNullableText(row.phone_2),
    website: toNullableText(row.website),
    city: toNullableText(row.city),
    country: toNullableText(row.country),
    chapter: toNullableText(row.chapter),
    professionalDetails: toNullableText(row.professional_details),
    searchCountry: country,
    searchCategory: category || null,
    searchKeyword: keyword || null,
    rawData: row as Prisma.InputJsonValue,
  }));

  const chunkSize = 500;
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    const chunk = records.slice(offset, offset + chunkSize);
    await tx.generatedLeadRow.createMany({ data: chunk });
  }
  return records.length;
}

function spawnPythonCommand(command: string, args: string[], overrides: Record<string, string> = {}, cwd = repoPath()): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      JWT_SECRET: process.env.JWT_SECRET ?? "",
      ...overrides,
    },
  });
}

async function spawnPython(args: string[], overrides: Record<string, string> = {}, cwd = repoPath()): Promise<ChildProcessWithoutNullStreams> {
  const candidates = [env.pythonBin, process.env.PYTHON_BIN, "python3", "python"]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  const tried = new Set<string>();
  let lastError: unknown;

  for (const command of candidates) {
    if (tried.has(command)) {
      continue;
    }
    tried.add(command);

    const child = spawnPythonCommand(command, args, overrides, cwd);
    const started = await new Promise<{ ok: true; child: ChildProcessWithoutNullStreams } | { ok: false; error: Error }>((resolve) => {
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        resolve({ ok: false, error });
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve({ ok: true, child });
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    if (started.ok) {
      return started.child;
    }

    lastError = started.error;
    if ((started.error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw started.error;
    }
  }

  const fallbackMessage = lastError instanceof Error ? lastError.message : "Unable to locate a Python executable";
  throw new Error(`Unable to locate Python executable. Tried: ${candidates.join(", ")}. ${fallbackMessage}`);
}

async function loadScraperCredentials(requestId: string): Promise<ScraperCredentials | null> {
  const request = await prisma.leadRequest.findUnique({
    where: { id: requestId },
    include: { user: true },
  });
  if (!request) return null;
  const username = request.user.bniUsername?.trim() ?? "";
  const password = decryptSecret(request.user.bniPasswordEncrypted ?? "");
  if (!username || !password) return null;
  return { username, password, userId: request.userId };
}

async function clearExpiredBniLocks(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "BniScrapeLock"
    WHERE "expiresAt" < NOW()
  `;
}

async function acquireBniScrapeLock(requestId: string, userId: string, username: string): Promise<boolean> {
  const normalizedUsername = normalizeBniUsername(username);
  if (!normalizedUsername) return false;

  await clearExpiredBniLocks();
  try {
    await prisma.$executeRaw`
      INSERT INTO "BniScrapeLock" (
        "id",
        "normalizedUsername",
        "displayUsername",
        "requestId",
        "userId",
        "acquiredAt",
        "expiresAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${randomUUID()},
        ${normalizedUsername},
        ${username.trim()},
        ${requestId},
        ${userId},
        NOW(),
        NOW() + INTERVAL '6 hours',
        NOW(),
        NOW()
      )
    `;
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

async function releaseBniScrapeLock(requestId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "BniScrapeLock"
    WHERE "requestId" = ${requestId}
  `;
}

async function getActiveBniScrapeLock(username: string): Promise<{ requestId: string; displayUsername: string } | null> {
  const normalizedUsername = normalizeBniUsername(username);
  if (!normalizedUsername) return null;
  await clearExpiredBniLocks();
  const locks = await prisma.$queryRaw<Array<{ requestId: string; displayUsername: string }>>`
    SELECT "requestId", "displayUsername"
    FROM "BniScrapeLock"
    WHERE "normalizedUsername" = ${normalizedUsername}
    LIMIT 1
  `;
  return locks[0] ?? null;
}

export async function isBniUsernameLocked(username: string): Promise<{ requestId: string; displayUsername: string } | null> {
  return getActiveBniScrapeLock(username);
}

async function canStartUsernameNow(normalizedUsername: string): Promise<boolean> {
  if (!normalizedUsername) return false;
  const lock = await getActiveBniScrapeLock(normalizedUsername);
  return !lock;
}

async function pumpLeadQueue(): Promise<void> {
  if (pumpRunning) {
    pumpRequested = true;
    return;
  }

  pumpRunning = true;
  try {
    do {
      pumpRequested = false;
      while (activeGlobalJobs < MAX_GLOBAL_CONCURRENCY) {
        let startableIndex = -1;
        for (let index = 0; index < pendingJobs.length; index += 1) {
          const job = pendingJobs[index];
          // Reserve the username locally first so we do not start duplicates in the same pump cycle.
          if (activeUsernames.has(job.normalizedUsername)) {
            continue;
          }
          if (await canStartUsernameNow(job.normalizedUsername)) {
            startableIndex = index;
            break;
          }
        }

        if (startableIndex === -1) {
          break;
        }

        const [job] = pendingJobs.splice(startableIndex, 1);
        activeUsernames.add(job.normalizedUsername);
        activeGlobalJobs += 1;
        void runLeadScrapeJob(job)
          .catch((error) => {
            console.error("Unexpected scrape job crash:", error);
          })
          .finally(() => {
            activeGlobalJobs = Math.max(0, activeGlobalJobs - 1);
            activeUsernames.delete(job.normalizedUsername);
            void pumpLeadQueue();
          });
      }
    } while (pumpRequested);
  } finally {
    pumpRunning = false;
    if (pumpRequested) {
      void pumpLeadQueue();
    }
  }
}

async function markRequestMissingCredentials(requestId: string): Promise<void> {
  const request = await prisma.leadRequest.findUnique({
    where: { id: requestId },
  });
  await prisma.leadRequest.update({
    where: { id: requestId },
    data: {
      status: "FAILED",
      errorMessage: "Save your BNI username and password in Settings before starting lead generation.",
      completedAt: new Date(),
    },
  });
  if (request) {
    await prisma.user.update({
      where: { id: request.userId },
      data: {
        currentLeadRequestId: null,
        creditsReserved: { decrement: request.requiredCredits },
      },
    });
  }
}

async function updateRequestFailure(requestId: string, message: string): Promise<void> {
  const request = await prisma.leadRequest.findUnique({
    where: { id: requestId },
  });
  await prisma.leadRequest.update({
    where: { id: requestId },
    data: {
      status: "FAILED",
      errorMessage: message,
      completedAt: new Date(),
    },
  });
  if (request) {
    await prisma.user.update({
      where: { id: request.userId },
      data: {
        creditsReserved: { decrement: request.requiredCredits },
        currentLeadRequestId: null,
      },
    });
  } else {
    await prisma.user.updateMany({
      where: { currentLeadRequestId: requestId },
      data: { currentLeadRequestId: null },
    });
  }
}

async function runLeadScrapeJob(job: LeadJob): Promise<void> {
  const { requestId, userId, username, normalizedUsername, password, country, category, keyword } = job;
  try {
    const lockAcquired = await acquireBniScrapeLock(requestId, userId, username);
    if (!lockAcquired) {
      const lock = await getActiveBniScrapeLock(username);
      const message = lock
        ? `This BNI username is already running another scrape (${lock.displayUsername}). Please wait for it to finish.`
        : "This BNI username is already running another scrape. Please wait for it to finish.";
      void appendApiDebug(`username locked | request=${requestId} | username=${username} | ${message}`);
      await updateRequestFailure(requestId, message);
      return;
    }

    const args = [env.scraperEntry, "scrape-category", "--country", country, "--resume-mode", "start-from-last"];
    if (category) {
      args.push("--category", category);
    }
    if (keyword) {
      args.push("--keyword", keyword);
    }

    const child = await spawnPython(args, {
      BNI_USERNAME: username,
      BNI_PASSWORD: password,
      HEADLESS: resolveHeadlessFlag(true),
    });
    runningJobs.set(requestId, child);
    forwardChildOutput(child, `lead:${requestId}`);

    await prisma.leadRequest.update({
      where: { id: requestId },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    let stdoutBuffer = "";
    let lastProgress = -1;
    let progressTail = Promise.resolve();
    const applyProgress = async (totalLeads: number) => {
      if (!Number.isFinite(totalLeads) || totalLeads < 0 || totalLeads === lastProgress) {
        return;
      }
      lastProgress = totalLeads;
      await prisma.leadRequest.update({
        where: { id: requestId },
        data: {
          totalLeads,
          estimatedMinutes: Math.max(1, Math.ceil(totalLeads / 50)),
        },
      });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/PROGRESS:(\d+)/i);
        if (!match) continue;
        const totalLeads = Number(match[1]);
        if (Number.isFinite(totalLeads)) {
          progressTail = progressTail.then(() => applyProgress(totalLeads)).catch(() => undefined);
        }
      }
    });

    const result = await new Promise<{ code: number | null; error?: string }>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => resolve({ code: 1, error: error.message }));
      child.on("close", async (code) => {
        await progressTail.catch(() => undefined);
        resolve({ code, error: stderr.trim() || undefined });
      });
    });

    runningJobs.delete(requestId);
    if (result.code !== 0) {
      console.error("Lead generation failed:", result.error ?? "Lead generation job failed");
      void appendApiDebug(`generation failed | request=${requestId} | country=${country} | category=${category} | keyword=${keyword} | ${result.error ?? "Lead generation job failed"}`);
      const failedRequest = await prisma.leadRequest.findUnique({ where: { id: requestId } });
      await prisma.leadRequest.update({
        where: { id: requestId },
        data: {
          status: "FAILED",
          errorMessage: sanitizeScraperError(result.error ?? "", "Lead generation job failed"),
          completedAt: new Date(),
        },
      });
      if (failedRequest) {
        await prisma.user.update({
          where: { id: failedRequest.userId },
          data: {
            currentLeadRequestId: null,
            creditsReserved: { decrement: failedRequest.requiredCredits },
          },
        });
      }
      return;
    }

    let csvPath = "";
    let prefix = "";
    try {
      csvPath = repoPath("output", resolveSearchBucket(country, category, keyword), "profiles.csv");
      const indexPath = repoPath("output", resolveSearchBucket(country, category, keyword), "members_index.csv");
      const request = await prisma.leadRequest.findUnique({ where: { id: requestId }, include: { user: true } });
      if (!request) {
        throw new Error("Lead request not found");
      }
      const requestUser = request.user;
      const totalLeads = await readCsvCount(csvPath);
      const indexedLeads = await readCsvCountIfExists(indexPath);
      const reservedCredits = request.requiredCredits ?? 0;
      const actualCredits = Math.ceil(totalLeads / 2);
      prefix = buildLeadArtifactPrefix(requestUser.email, country, category, keyword, requestId);
      const r2Upload = await uploadDirectoryToR2(path.dirname(csvPath), prefix);
      const csvRows = totalLeads > 0 ? await exportCsvRowsFromPython(csvPath) : [];
      const insertedRows = await prisma.$transaction(async (tx) => {
        const inserted = await persistGeneratedLeadRows(
          tx,
          requestId,
          request.userId,
          country,
          category,
          keyword,
          csvRows
        );
        await tx.leadRequest.update({
          where: { id: requestId },
          data: {
            status: "COMPLETED",
            csvPath: r2Upload.csvKey,
            r2Prefix: prefix,
            r2CsvKey: r2Upload.csvKey,
            r2CsvUrl: r2Upload.csvUrl,
            totalLeads,
            requiredCredits: actualCredits,
            errorMessage:
              totalLeads === 0
                ? indexedLeads > 0
                  ? "Profiles were found, but no email addresses were available for extraction."
                  : "No matching profiles found for the selected filters."
                : null,
            completedAt: new Date(),
          },
        });
        await tx.user.update({
          where: { id: requestUser.id },
          data: {
            creditsBalance: { decrement: actualCredits },
            creditsReserved: { decrement: reservedCredits },
            currentLeadRequestId: null,
          },
        });
        return inserted;
      });
      console.info(
        "Lead generation completed: request=%s country=%s category=%s keyword=%s index_rows=%s email_rows=%s csv=%s inserted_rows=%s r2=%s",
        requestId,
        country,
        category || "<country-only>",
        keyword || "<keyword-empty>",
        indexedLeads,
        totalLeads,
        csvPath,
        insertedRows,
        r2Upload.csvUrl
      );
      await fs.rm(path.dirname(csvPath), { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Lead generation job failed";
      console.error("Lead generation completion failed:", error);
      if (prefix) {
        await deleteR2Prefix(prefix).catch(() => undefined);
      }
      await updateRequestFailure(requestId, sanitizeScraperError(message, "Lead generation job failed"));
      return;
    }
  } finally {
    runningJobs.delete(requestId);
    activeUsernames.delete(normalizedUsername);
    reservedUsernames.delete(normalizedUsername);
    await releaseBniScrapeLock(requestId);
    void pumpLeadQueue();
  }
}

export async function startLeadScrape(meta: JobMeta & { country: string; category: string; keyword: string; filename: string }): Promise<QueueAdmission> {
  const { requestId, country, category, keyword, filename } = meta;
  const credentials = await loadScraperCredentials(requestId);
  if (!credentials || !credentials.userId) {
    await markRequestMissingCredentials(requestId);
    return { accepted: false, reason: "Save your BNI username and password in Settings before starting lead generation." };
  }

  const normalizedUsername = normalizeBniUsername(credentials.username);
  if (!normalizedUsername) {
    await markRequestMissingCredentials(requestId);
    return { accepted: false, reason: "Save your BNI username and password in Settings before starting lead generation." };
  }

  await clearExpiredBniLocks();
  if (reservedUsernames.has(normalizedUsername) || (await getActiveBniScrapeLock(credentials.username))) {
    return { accepted: false, reason: "This BNI username is already running another scrape. Please wait for it to finish." };
  }
  if (queueSize() >= MAX_GLOBAL_QUEUE_SIZE) {
    return { accepted: false, reason: "Server is busy. Please try again in a moment." };
  }

  reservedUsernames.add(normalizedUsername);
  pendingJobs.push({
    requestId,
    userId: credentials.userId,
    username: credentials.username,
    normalizedUsername,
    password: credentials.password,
    country,
    category,
    keyword,
    filename,
  });

  void pumpLeadQueue();
  return { accepted: true };
}

export async function estimateLeadGenerationByCredentials(
  credentials: ScraperCredentials,
  meta: { country: string; category: string; keyword: string }
): Promise<{
  totalLeads: number;
  requiredCredits: number;
  estimatedMinutes: number;
}> {
  const { country, category, keyword } = meta;

  const args = [env.scraperEntry, "index-category", "--country", country];
  if (category) {
    args.push("--category", category);
  }
  if (keyword) {
    args.push("--keyword", keyword);
  }

  const child = await spawnPython(args, {
    BNI_USERNAME: credentials.username,
    BNI_PASSWORD: credentials.password,
    HEADLESS: resolveHeadlessFlag(true),
  });
  forwardChildOutput(child, "estimate");

  const result = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, error: error.message }));
    child.on("close", (code) => resolve({ code, error: stderr.trim() || undefined }));
  });

  if (result.code !== 0) {
    console.error("Lead estimate failed:", result.error ?? "Lead estimate job failed");
    void appendApiDebug(`estimate failed | country=${country} | category=${category} | keyword=${keyword} | ${result.error ?? "Lead estimate job failed"}`);
    throw new Error(sanitizeScraperError(result.error ?? "", "Lead estimate job failed"));
  }

  const estimatePath = repoPath("output", resolveSearchBucket(country, category, keyword), "members_index.csv");
  const totalLeads = await readCsvCountIfExists(estimatePath);
  console.info(
    "Lead estimate completed: country=%s category=%s keyword=%s index_rows=%s path=%s",
    country,
    category || "<country-only>",
    keyword || "<keyword-empty>",
    totalLeads,
    estimatePath
  );
  return {
    totalLeads,
    requiredCredits: Math.max(1, Math.ceil(totalLeads / 2)),
    estimatedMinutes: Math.max(1, Math.ceil(totalLeads / 50)),
  };
}

export function cancelRunningJob(requestId: string): boolean {
  const child = runningJobs.get(requestId);
  if (!child) return false;
  child.kill("SIGTERM");
  runningJobs.delete(requestId);
  return true;
}

export async function createRequestedFilename(userId: string, country: string, category: string, keyword: string): Promise<string> {
  return makeLeadFilename(userId, country, category, keyword);
}
