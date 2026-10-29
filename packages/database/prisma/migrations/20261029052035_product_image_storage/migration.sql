-- CreateEnum
CREATE TYPE "ImageStorage" AS ENUM ('DATABASE', 'R2');

-- AlterTable
ALTER TABLE "product_images" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "objectKey" TEXT,
ADD COLUMN     "storage" "ImageStorage" NOT NULL DEFAULT 'DATABASE',
ADD COLUMN     "thumbData" BYTEA,
ADD COLUMN     "thumbKey" TEXT,
ADD COLUMN     "width" INTEGER,
ALTER COLUMN "data" DROP NOT NULL;
