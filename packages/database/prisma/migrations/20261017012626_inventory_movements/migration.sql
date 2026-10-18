-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('SALE', 'RESTOCK', 'ADJUSTMENT', 'RETURN', 'DAMAGED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "lowStockAlertedAt" TIMESTAMP(3),
ADD COLUMN     "reorderLevel" INTEGER;

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "actor" "AuditActor" NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_merchantId_createdAt_idx" ON "stock_movements"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_orderId_productId_type_key" ON "stock_movements"("orderId", "productId", "type");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
