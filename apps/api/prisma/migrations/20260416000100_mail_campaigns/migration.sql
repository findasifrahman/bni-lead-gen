-- CreateEnum
CREATE TYPE "MailCampaignStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "MailRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MailCampaignSourceType" AS ENUM ('GENERATED_LEADS', 'CUSTOM_UPLOAD');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "currentMailCampaignId" TEXT;
ALTER TABLE "User" ADD COLUMN "sendingEmailEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "sendingAppPasswordEncrypted" TEXT;

-- CreateTable
CREATE TABLE "MailCampaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" "MailCampaignSourceType" NOT NULL,
    "leadRequestId" TEXT,
    "inputFileName" TEXT,
    "inputFileKey" TEXT,
    "inputFileUrl" TEXT,
    "companyWebsitePrimary" TEXT NOT NULL,
    "companyWebsiteSecondary" TEXT NOT NULL,
    "companyWebsiteTertiary" TEXT,
    "socialLinkedIn" TEXT,
    "socialInstagram" TEXT,
    "socialFacebook" TEXT,
    "phoneNumber" TEXT,
    "customInstructions" TEXT,
    "serviceSummary" TEXT,
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "creditsReserved" INTEGER NOT NULL DEFAULT 0,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "MailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "MailCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "city" TEXT,
    "country" TEXT,
    "professionalDetails" TEXT,
    "sourceType" "MailCampaignSourceType" NOT NULL,
    "status" "MailRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "emailSubject" TEXT,
    "emailBody" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailCampaign_userId_requestedAt_idx" ON "MailCampaign"("userId", "requestedAt");
CREATE INDEX "MailCampaign_status_idx" ON "MailCampaign"("status");
CREATE INDEX "MailCampaign_leadRequestId_idx" ON "MailCampaign"("leadRequestId");
CREATE UNIQUE INDEX "MailRecipient_campaignId_rowIndex_key" ON "MailRecipient"("campaignId", "rowIndex");
CREATE INDEX "MailRecipient_userId_createdAt_idx" ON "MailRecipient"("userId", "createdAt");
CREATE INDEX "MailRecipient_campaignId_status_idx" ON "MailRecipient"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "MailCampaign" ADD CONSTRAINT "MailCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailRecipient" ADD CONSTRAINT "MailRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailRecipient" ADD CONSTRAINT "MailRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
