import { PrismaClient } from "@prisma/client";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma = globalThis.prisma ?? new PrismaClient({
  log: ["warn", "error"],
  datasources: {
    db: {
      url: env.databaseUrl,
    },
  },
});

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}
