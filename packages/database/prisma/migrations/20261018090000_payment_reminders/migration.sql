-- AlterEnum
ALTER TYPE "ConfirmationAction" ADD VALUE IF NOT EXISTS 'SEND_PAYMENT_REMINDER';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "providerCheckedAt" TIMESTAMP(3),
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 0;
