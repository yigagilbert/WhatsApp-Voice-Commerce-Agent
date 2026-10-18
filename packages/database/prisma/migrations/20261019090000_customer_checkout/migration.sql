-- CreateEnum
CREATE TYPE "OrderPlacer" AS ENUM ('MERCHANT', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('DELIVERY', 'PICKUP');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "customerConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryMethod" "DeliveryMethod",
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "placedBy" "OrderPlacer" NOT NULL DEFAULT 'MERCHANT';

-- AlterTable
ALTER TABLE "whatsapp_accounts" ADD COLUMN     "deliveryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pickupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pickupInfo" TEXT;

-- CreateIndex
CREATE INDEX "orders_merchantId_customerId_status_idx" ON "orders"("merchantId", "customerId", "status");

