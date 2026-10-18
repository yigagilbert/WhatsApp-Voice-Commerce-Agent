-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "ReportRunStatus" AS ENUM ('SENDING', 'SENT', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "merchant_operators" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "receiveAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "receiveReports" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "whatsappLid" TEXT;

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" "ReportFrequency" NOT NULL DEFAULT 'WEEKLY',
    "weekday" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 8,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,
    "includeSales" BOOLEAN NOT NULL DEFAULT true,
    "includeInventory" BOOLEAN NOT NULL DEFAULT true,
    "includeUnpaid" BOOLEAN NOT NULL DEFAULT true,
    "includeDisputes" BOOLEAN NOT NULL DEFAULT true,
    "includeChart" BOOLEAN NOT NULL DEFAULT true,
    "includeInsights" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ReportRunStatus" NOT NULL DEFAULT 'SENDING',
    "text" TEXT NOT NULL,
    "chartBase64" TEXT,
    "chartCaption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "textSentAt" TIMESTAMP(3),
    "chartSentAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_schedules_merchantId_key" ON "report_schedules"("merchantId");

-- CreateIndex
CREATE INDEX "report_runs_merchantId_createdAt_idx" ON "report_runs"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_runs_merchantId_periodKey_key" ON "report_runs"("merchantId", "periodKey");

-- CreateIndex
CREATE INDEX "report_deliveries_status_nextAttemptAt_idx" ON "report_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_deliveries_runId_operatorId_key" ON "report_deliveries"("runId", "operatorId");

-- CreateIndex
CREATE INDEX "merchant_operators_channel_whatsappLid_idx" ON "merchant_operators"("channel", "whatsappLid");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_operators_channel_phone_key" ON "merchant_operators"("channel", "phone");

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_runId_fkey" FOREIGN KEY ("runId") REFERENCES "report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "merchant_operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill existing WhatsApp operators: a phone-number chat ID gives the E.164 phone; a linked ID
-- (@lid) is kept as whatsappLid so the sender still matches.
UPDATE "merchant_operators"
SET "phone" = '+' || split_part("externalId", '@', 1)
WHERE "channel" = 'whatsapp' AND "externalId" ~ '^[0-9]{6,15}@c\.us$';

UPDATE "merchant_operators"
SET "whatsappLid" = "externalId"
WHERE "channel" = 'whatsapp' AND "externalId" LIKE '%@lid';
