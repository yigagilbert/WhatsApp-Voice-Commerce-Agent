-- CreateEnum
CREATE TYPE "StatusAdPublish" AS ENUM ('PHONE', 'KATALE');

-- AlterTable
ALTER TABLE "status_ad_settings" ADD COLUMN     "publish" "StatusAdPublish" NOT NULL DEFAULT 'PHONE';

-- AlterTable
ALTER TABLE "status_ads" ADD COLUMN     "nextPublishAt" TIMESTAMP(3),
ADD COLUMN     "postedVia" TEXT,
ADD COLUMN     "publishAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publishError" TEXT,
ADD COLUMN     "publishingAt" TIMESTAMP(3),
ADD COLUMN     "statusMessageId" TEXT;
