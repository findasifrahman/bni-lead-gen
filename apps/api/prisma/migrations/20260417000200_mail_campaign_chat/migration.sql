-- CreateEnum
CREATE TYPE "MailCampaignChatRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "MailCampaignChatMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MailCampaignChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "draftSubject" TEXT,
    "draftBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailCampaignChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailCampaignChatMessage_campaignId_createdAt_idx" ON "MailCampaignChatMessage"("campaignId", "createdAt");
CREATE INDEX "MailCampaignChatMessage_userId_createdAt_idx" ON "MailCampaignChatMessage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MailCampaignChatMessage" ADD CONSTRAINT "MailCampaignChatMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailCampaignChatMessage" ADD CONSTRAINT "MailCampaignChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
