import { defineConfig } from "prisma/config";
import { config as loadDotenv } from "dotenv";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";

loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });

export default defineConfig({
  experimental: {
    adapter: true,
  },
  schema: "./prisma/schema.prisma",
  engine: "js",
  adapter: async () => new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
  migrations: {
    seed: "node prisma/seed.cjs",
  },
});
