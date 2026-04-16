-- AlterEnum
ALTER TYPE "LeadRequestStatus" ADD VALUE IF NOT EXISTS 'QUEUED';

-- CreateTable
CREATE TABLE "GeneratedLeadRow" (
    "id" TEXT NOT NULL,
    "leadRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "email" TEXT,
    "phone1" TEXT,
    "phone2" TEXT,
    "website" TEXT,
    "city" TEXT,
    "country" TEXT,
    "chapter" TEXT,
    "professionalDetails" TEXT,
    "searchCountry" TEXT NOT NULL,
    "searchCategory" TEXT,
    "searchKeyword" TEXT,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedLeadRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedLeadRow_leadRequestId_rowIndex_key" ON "GeneratedLeadRow"("leadRequestId", "rowIndex");

-- CreateIndex
CREATE INDEX "GeneratedLeadRow_userId_createdAt_idx" ON "GeneratedLeadRow"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GeneratedLeadRow_leadRequestId_idx" ON "GeneratedLeadRow"("leadRequestId");

-- CreateIndex
CREATE INDEX "GeneratedLeadRow_searchCountry_searchCategory_searchKeyword_idx" ON "GeneratedLeadRow"("searchCountry", "searchCategory", "searchKeyword");

-- AddForeignKey
ALTER TABLE "GeneratedLeadRow" ADD CONSTRAINT "GeneratedLeadRow_leadRequestId_fkey" FOREIGN KEY ("leadRequestId") REFERENCES "LeadRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedLeadRow" ADD CONSTRAINT "GeneratedLeadRow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
