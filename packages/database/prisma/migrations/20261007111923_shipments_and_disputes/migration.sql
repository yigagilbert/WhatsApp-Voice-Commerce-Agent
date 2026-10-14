-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('NOT_SHIPPED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('SHIPPED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConfirmationAction" ADD VALUE 'ADD_SHIPMENT_TRACKING';
ALTER TYPE "ConfirmationAction" ADD VALUE 'SUBMIT_DISPUTE_RESPONSE';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'NOT_SHIPPED';

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "carrier" TEXT NOT NULL,
    "carrierNameOther" TEXT,
    "trackingNumber" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'SHIPPED',
    "providerTrackerId" TEXT,
    "providerSyncedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "paypalDisputeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lifecycleStage" TEXT,
    "outcome" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "sellerTransactionId" TEXT,
    "buyerMessage" TEXT,
    "sellerResponseDueAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "notifiedStatus" TEXT,
    "providerData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_responses" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "responseText" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipments_merchantId_createdAt_idx" ON "shipments"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_orderId_trackingNumber_key" ON "shipments"("orderId", "trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_paypalDisputeId_key" ON "disputes"("paypalDisputeId");

-- CreateIndex
CREATE INDEX "disputes_merchantId_status_idx" ON "disputes"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_responses_confirmationId_key" ON "dispute_responses"("confirmationId");

-- CreateIndex
CREATE INDEX "dispute_responses_disputeId_idx" ON "dispute_responses"("disputeId");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_responses" ADD CONSTRAINT "dispute_responses_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
