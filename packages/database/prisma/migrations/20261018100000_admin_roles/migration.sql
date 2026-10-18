-- Roles had no effect before this release (every admin could approve everything). Keep that
-- behaviour for existing admins: from now on STAFF can't approve payment requests or disputes.
UPDATE "merchant_operators" SET "role" = 'OWNER' WHERE "role" = 'STAFF';
