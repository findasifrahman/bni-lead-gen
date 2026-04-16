-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

CREATE TYPE "LeadRequestStatus" AS ENUM ('COUNTING', 'AWAITING_APPROVAL', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

CREATE TYPE "CreditApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TYPE "PasswordResetStatus" AS ENUM ('PENDING', 'USED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "fullName" TEXT,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'USER',
  "creditsBalance" INTEGER NOT NULL DEFAULT 0,
  "creditsReserved" INTEGER NOT NULL DEFAULT 0,
  "currentLeadRequestId" TEXT,
  "bniUsername" TEXT,
  "bniPasswordEncrypted" TEXT,
  "maxProfileConcurrency" INTEGER NOT NULL DEFAULT 1,
  "maxCountryProfiles" INTEGER NOT NULL DEFAULT 360,
  "requestDelayMin" DOUBLE PRECISION NOT NULL DEFAULT 3.5,
  "requestDelayMax" DOUBLE PRECISION NOT NULL DEFAULT 6.5,
  "headless" BOOLEAN NOT NULL DEFAULT true,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "keyword" TEXT,
  "country" TEXT NOT NULL,
  "category" TEXT,
  "filename" TEXT NOT NULL,
  "totalLeads" INTEGER NOT NULL DEFAULT 0,
  "requiredCredits" INTEGER NOT NULL DEFAULT 0,
  "estimatedMinutes" INTEGER NOT NULL DEFAULT 0,
  "uuidCsvPath" TEXT,
  "csvPath" TEXT,
  "status" "LeadRequestStatus" NOT NULL DEFAULT 'COUNTING',
  "cancelReason" TEXT,
  "errorMessage" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "countCompletedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "LeadRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditApplication" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestedCredits" INTEGER NOT NULL,
  "note" TEXT,
  "status" "CreditApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "adminId" TEXT,
  "adminNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "status" "PasswordResetStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "LeadRequest_userId_requestedAt_idx" ON "LeadRequest"("userId", "requestedAt");
CREATE INDEX "LeadRequest_status_idx" ON "LeadRequest"("status");
CREATE INDEX "LeadRequest_filename_idx" ON "LeadRequest"("filename");
CREATE INDEX "CreditApplication_status_idx" ON "CreditApplication"("status");
CREATE INDEX "CreditApplication_userId_createdAt_idx" ON "CreditApplication"("userId", "createdAt");
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");
CREATE INDEX "PasswordResetToken_userId_status_idx" ON "PasswordResetToken"("userId", "status");

-- AddForeignKey
ALTER TABLE "LeadRequest"
  ADD CONSTRAINT "LeadRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreditApplication"
  ADD CONSTRAINT "CreditApplication_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
