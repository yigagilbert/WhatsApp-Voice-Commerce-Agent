-- CreateEnum
CREATE TYPE "StatusAdApproval" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "StatusAdPublish" AS ENUM ('PHONE', 'KATALE');

-- CreateEnum
CREATE TYPE "StatusAdStatus" AS ENUM ('DRAFT', 'READY', 'POSTED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "status_ad_settings" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::INTEGER[],
    "times" TEXT[] DEFAULT ARRAY['09:00']::TEXT[],
    "timezone" TEXT,
    "approval" "StatusAdApproval" NOT NULL DEFAULT 'MANUAL',
    "publish" "StatusAdPublish" NOT NULL DEFAULT 'PHONE',
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_ad_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_ads" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT,
    "slotKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "StatusAdStatus" NOT NULL DEFAULT 'DRAFT',
    "headline" TEXT NOT NULL DEFAULT '',
    "caption" TEXT NOT NULL DEFAULT '',
    "cta" TEXT NOT NULL DEFAULT '',
    "theme" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'template',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedVia" TEXT,
    "publishingAt" TIMESTAMP(3),
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "publishError" TEXT,
    "nextPublishAt" TIMESTAMP(3),
    "statusMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_ads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "status_ad_settings_merchantId_key" ON "status_ad_settings"("merchantId");

-- CreateIndex
CREATE INDEX "status_ads_merchantId_createdAt_idx" ON "status_ads"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "status_ads_status_nextAttemptAt_idx" ON "status_ads"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "status_ads_merchantId_slotKey_key" ON "status_ads"("merchantId", "slotKey");

-- AddForeignKey
ALTER TABLE "status_ad_settings" ADD CONSTRAINT "status_ad_settings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_ads" ADD CONSTRAINT "status_ads_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_ads" ADD CONSTRAINT "status_ads_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
