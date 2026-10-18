-- CreateEnum
CREATE TYPE "PaymentLinkMode" AS ENUM ('AUTO', 'APPROVAL');

-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('MERCHANT', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "ConversationAudience" AS ENUM ('ADMIN', 'CUSTOMER');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "audience" "ConversationAudience" NOT NULL DEFAULT 'ADMIN',
ADD COLUMN     "handoffUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "source" "CustomerSource" NOT NULL DEFAULT 'MERCHANT',
ADD COLUMN     "whatsappLid" TEXT,
ADD COLUMN     "whatsappPhone" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "visibleToCustomers" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "wid" TEXT NOT NULL,
    "customerCommerceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paymentLinkMode" "PaymentLinkMode" NOT NULL DEFAULT 'AUTO',
    "handoffHours" INTEGER NOT NULL DEFAULT 12,
    "shopInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_wid_key" ON "whatsapp_accounts"("wid");

-- CreateIndex
CREATE INDEX "whatsapp_accounts_merchantId_idx" ON "whatsapp_accounts"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_productId_key" ON "product_images"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_merchantId_whatsappLid_key" ON "customers"("merchantId", "whatsappLid");

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

