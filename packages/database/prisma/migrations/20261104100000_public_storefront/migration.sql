-- CreateEnum
CREATE TYPE "CartTransferStatus" AS ENUM ('OPEN', 'CLAIMED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category" TEXT;

-- CreateTable
CREATE TABLE "storefronts" (
    "merchantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tagline" TEXT,
    "about" TEXT,
    "logoMimeType" TEXT,
    "logoStorage" "ImageStorage",
    "logoData" BYTEA,
    "logoKey" TEXT,
    "logoUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefronts_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "cart_transfers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientKey" TEXT,
    "status" "CartTransferStatus" NOT NULL DEFAULT 'OPEN',
    "items" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_slug_key" ON "storefronts"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "cart_transfers_tokenHash_key" ON "cart_transfers"("tokenHash");

-- CreateIndex
CREATE INDEX "cart_transfers_merchantId_clientKey_status_idx" ON "cart_transfers"("merchantId", "clientKey", "status");

-- CreateIndex
CREATE INDEX "cart_transfers_expiresAt_idx" ON "cart_transfers"("expiresAt");

-- CreateIndex
CREATE INDEX "products_merchantId_category_idx" ON "products"("merchantId", "category");

-- AddForeignKey
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_transfers" ADD CONSTRAINT "cart_transfers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

