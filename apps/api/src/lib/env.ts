import { config as loadDotenv } from "dotenv";
import fs from "fs";
import path from "path";

function findRepoRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, ".env")) && fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

const repoRoot = findRepoRoot(__dirname);
const envPath = path.join(repoRoot, ".env");
loadDotenv({ path: envPath, override: true });
loadDotenv({ path: envPath, override: false });

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "replace-me",
  encryptionKey: process.env.APP_ENCRYPTION_KEY ?? "replace-me",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  apiPort: Number(process.env.API_PORT ?? "4000"),
  pythonBin: process.env.PYTHON_BIN ?? "python",
  scraperEntry: process.env.SCRAPER_ENTRY ?? "main.py",
  googleAppPassword: process.env.GOOGLE_APP_PASSWORD ?? "",
  googleSenderEmail: process.env.GOOGLE_SENDER_EMAIL ?? "",
  outputDir: process.env.OUTPUT_DIR ?? "output",
  debugDir: process.env.DEBUG_DIR ?? "debug",
  maxGlobalScrapeConcurrency: Number(process.env.MAX_GLOBAL_SCRAPE_CONCURRENCY ?? "2"),
  maxGlobalScrapeQueueSize: Number(process.env.MAX_GLOBAL_SCRAPE_QUEUE_SIZE ?? "10"),
  r2AccountId: process.env.R2_ACCOUNT_ID ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.R2_API_TOKEN_VALUE ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.R2_API_DEFAULT_VALUE ?? "",
  r2Bucket: process.env.R2_BUCKET ?? "",
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? "",
  r2Endpoint: process.env.R2_ENDPOINT ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModelName: process.env.OPENAI_MODEL_NAME ?? "gpt-5.4-nano",
  zhipuApiBaseUrl: process.env.ZHIPU_API_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
  zhipuApiKey: process.env.ZHIPU_LLM_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  zhipuModelNameGeneral: process.env.ZHIPU_MODEL_NAME_GENERAL ?? "GLM-4.7",
  zhipuModelNameSmall: process.env.ZHIPU_MODEL_NAME_SMALL ?? "GLM-4.7-Flash",
};

export function repoPath(...segments: string[]): string {
  return path.join(repoRoot, ...segments);
}
