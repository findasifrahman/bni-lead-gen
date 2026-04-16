-- CreateTable
CREATE TABLE "MailResearchCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailResearchCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailResearchCache_userId_createdAt_idx" ON "MailResearchCache"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailResearchCache_userId_fingerprint_key" ON "MailResearchCache"("userId", "fingerprint");

-- AddForeignKey
ALTER TABLE "MailResearchCache" ADD CONSTRAINT "MailResearchCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
