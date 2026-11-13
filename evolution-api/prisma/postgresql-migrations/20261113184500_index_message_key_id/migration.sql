-- Status updates look up a message by instance and WhatsApp message ID.
-- Build without blocking incoming message writes on existing installations.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_key_id_idx"
ON "Message" ("instanceId", ("key"->>'id'));
