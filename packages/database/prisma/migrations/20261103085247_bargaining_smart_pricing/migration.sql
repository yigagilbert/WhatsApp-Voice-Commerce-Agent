-- CreateEnum
CREATE TYPE "LinePricing" AS ENUM ('LIST', 'QUANTITY', 'BUNDLE', 'NEGOTIATED');

-- CreateEnum
CREATE TYPE "PriceOfferStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "bundleMinItems" INTEGER,
ADD COLUMN     "bundlePercentOff" INTEGER;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "listUnitPriceMinor" INTEGER,
ADD COLUMN     "priceOfferId" TEXT,
ADD COLUMN     "pricing" "LinePricing" NOT NULL DEFAULT 'LIST';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "bargainingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minPriceMinor" INTEGER,
ADD COLUMN     "quantityDiscounts" JSONB;

-- CreateTable
CREATE TABLE "price_offers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderId" TEXT,
    "quantity" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "listUnitMinor" INTEGER NOT NULL,
    "offerUnitMinor" INTEGER NOT NULL,
    "customerUnitMinor" INTEGER,
    "round" INTEGER NOT NULL,
    "status" "PriceOfferStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_offers_merchantId_customerId_productId_createdAt_idx" ON "price_offers"("merchantId", "customerId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "price_offers_orderId_status_idx" ON "price_offers"("orderId", "status");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_priceOfferId_fkey" FOREIGN KEY ("priceOfferId") REFERENCES "price_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_offers" ADD CONSTRAINT "price_offers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_offers" ADD CONSTRAINT "price_offers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
