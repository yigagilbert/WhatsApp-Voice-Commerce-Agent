-- Who wrote a message, and what it pointed at (quoted replies).
CREATE TYPE "MessageKind" AS ENUM ('REPLY', 'ALERT', 'TEAM');

ALTER TABLE "messages"
  ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'REPLY',
  ADD COLUMN "stanzaId" TEXT,
  ADD COLUMN "refs" JSONB,
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "messages_conversationId_stanzaId_idx" ON "messages"("conversationId", "stanzaId");

-- A merchant cancelling a customer's placed order needs its own code.
ALTER TYPE "ConfirmationAction" ADD VALUE 'CANCEL_ORDER';
