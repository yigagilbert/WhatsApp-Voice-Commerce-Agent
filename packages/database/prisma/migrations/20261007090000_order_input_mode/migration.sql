-- How the merchant asked for the order: typed text or a transcribed voice note.
CREATE TYPE "OrderInputMode" AS ENUM ('TEXT', 'VOICE');

ALTER TABLE "orders" ADD COLUMN "inputMode" "OrderInputMode" NOT NULL DEFAULT 'TEXT';

-- Backfill: an order drafted in the same request (correlation ID) as a voice transcription
-- came from a voice note.
UPDATE "orders" o
SET "inputMode" = 'VOICE'
FROM "audit_events" d
JOIN "audit_events" s
  ON s."correlationId" = d."correlationId" AND s."type" = 'speech.transcribed'
WHERE d."type" = 'order.drafted'
  AND d."entityId" = o."id"
  AND d."correlationId" IS NOT NULL;
