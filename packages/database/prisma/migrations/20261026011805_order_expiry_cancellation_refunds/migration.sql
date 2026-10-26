-- CreateEnum
CREATE TYPE "OrderCancelReason" AS ENUM ('PAYMENT_EXPIRED', 'MERCHANT', 'CUSTOMER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancelReason" "OrderCancelReason",
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "paymentDueAt" TIMESTAMP(3),
ADD COLUMN     "refundedMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "refundedMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'refund',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_merchantId_createdAt_idx" ON "refunds"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_externalId_key" ON "refunds"("provider", "externalId");

-- CreateIndex
CREATE INDEX "orders_status_paymentDueAt_idx" ON "orders"("status", "paymentDueAt");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: payments already marked REFUNDED by the old webhook handler were full refunds.
UPDATE "payments" SET "refundedMinor" = "amountMinor" WHERE "status" = 'REFUNDED';

-- Their orders were left PAID: bring them in line (only when no other completed payment exists).
UPDATE "orders" o
SET "status" = 'REFUNDED', "refundedMinor" = o."totalMinor"
WHERE o."status" = 'PAID'
  AND EXISTS (SELECT 1 FROM "payments" p WHERE p."orderId" = o."id" AND p."status" = 'REFUNDED')
  AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."orderId" = o."id" AND p."status" = 'COMPLETED');
