-- CreateTable
CREATE TABLE "app_secrets" (
    "name" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_secrets_pkey" PRIMARY KEY ("name")
);
