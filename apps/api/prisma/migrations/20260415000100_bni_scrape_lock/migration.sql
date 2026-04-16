-- CreateTable
CREATE TABLE "BniScrapeLock" (
    "id" TEXT NOT NULL,
    "normalizedUsername" TEXT NOT NULL,
    "displayUsername" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BniScrapeLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BniScrapeLock_normalizedUsername_key" ON "BniScrapeLock"("normalizedUsername");

-- CreateIndex
CREATE UNIQUE INDEX "BniScrapeLock_requestId_key" ON "BniScrapeLock"("requestId");

-- CreateIndex
CREATE INDEX "BniScrapeLock_userId_idx" ON "BniScrapeLock"("userId");

-- CreateIndex
CREATE INDEX "BniScrapeLock_expiresAt_idx" ON "BniScrapeLock"("expiresAt");
