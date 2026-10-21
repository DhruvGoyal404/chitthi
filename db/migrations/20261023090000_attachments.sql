-- migrate:up
-- Media attachments (docs/MEDIA.md). An upload becomes an attachments row at once (message_id
-- NULL); sending a message links up to 10 of the sender's own unattached uploads to it. Files
-- live in the storage driver under random keys; only the keys are here. Rows are never deleted:
-- deleted_at marks the content gone (tombstone, account erase, orphan sweep), blob_removed_at
-- records that the stored files were removed.
CREATE TABLE attachments (
  -- Random (v4), not time-ordered: an attachment id is a capability-like name in URLs.
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id      uuid        NOT NULL REFERENCES users (id),
  kind             text        NOT NULL,
  mime             text        NOT NULL,
  byte_size        bigint      NOT NULL,
  sha256           bytea       NOT NULL,
  -- For display and the download's filename only (sanitised); never used on disk.
  file_name        text        NOT NULL,
  storage_key      text        NOT NULL,
  thumb_key        text,
  width            integer,
  height           integer,
  -- A tiny inline image (data:image/webp;base64,…) shown while the thumbnail loads.
  placeholder      text,
  message_id       uuid        REFERENCES messages (id),
  position         smallint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  attached_at      timestamptz,
  deleted_at       timestamptz,
  blob_removed_at  timestamptz,
  CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'file')),
  CONSTRAINT attachments_mime_check CHECK (
    (kind = 'image' AND mime IN ('image/jpeg', 'image/png', 'image/webp')) OR
    (kind = 'file' AND mime IN ('application/pdf', 'text/plain', 'application/zip'))),
  CONSTRAINT attachments_size_check CHECK (
    byte_size > 0 AND byte_size <= CASE kind WHEN 'image' THEN 10485760 ELSE 26214400 END),
  CONSTRAINT attachments_sha256_len CHECK (octet_length(sha256) = 32),
  CONSTRAINT attachments_file_name_check CHECK (char_length(file_name) BETWEEN 1 AND 200 AND file_name !~ '[/\\[:cntrl:]]'),
  CONSTRAINT attachments_storage_key_format CHECK (storage_key ~ '^[0-9a-f]{32}$'),
  CONSTRAINT attachments_thumb_key_format CHECK (thumb_key IS NULL OR thumb_key ~ '^[0-9a-f]{32}$'),
  CONSTRAINT attachments_image_shape CHECK (
    -- IS NOT NULL spelled out: a CHECK that evaluates to NULL passes.
    (kind = 'image' AND thumb_key IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND placeholder IS NOT NULL
       AND width BETWEEN 1 AND 2560 AND height BETWEEN 1 AND 2560
       AND placeholder ~ '^data:image/webp;base64,[A-Za-z0-9+/=]+$' AND char_length(placeholder) <= 2048) OR
    (kind = 'file' AND thumb_key IS NULL AND width IS NULL AND height IS NULL AND placeholder IS NULL)),
  CONSTRAINT attachments_link_shape CHECK (
    (message_id IS NULL AND position IS NULL AND attached_at IS NULL) OR
    (message_id IS NOT NULL AND position IS NOT NULL AND position BETWEEN 0 AND 9 AND attached_at IS NOT NULL)),
  CONSTRAINT attachments_removed_after_deleted CHECK (blob_removed_at IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT attachments_storage_key_key UNIQUE (storage_key),
  CONSTRAINT attachments_thumb_key_key UNIQUE (thumb_key),
  CONSTRAINT attachments_message_position_key UNIQUE (message_id, position)
);
CREATE INDEX attachments_message_idx ON attachments (message_id) WHERE message_id IS NOT NULL;
-- The sweeper's two jobs: unattached uploads past their hour, and files still to remove.
CREATE INDEX attachments_orphans_idx ON attachments (created_at) WHERE message_id IS NULL AND deleted_at IS NULL;
CREATE INDEX attachments_unremoved_idx ON attachments (deleted_at) WHERE deleted_at IS NOT NULL AND blob_removed_at IS NULL;
CREATE INDEX attachments_uploader_idx ON attachments (uploader_id);

-- Linking is one-way and once: an attachment joins one message, at one position, and then
-- only its deletion markers may change.
CREATE FUNCTION attachments_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.uploader_id <> OLD.uploader_id OR NEW.kind <> OLD.kind OR NEW.mime <> OLD.mime
     OR NEW.byte_size <> OLD.byte_size OR NEW.sha256 <> OLD.sha256 OR NEW.file_name <> OLD.file_name
     OR NEW.storage_key <> OLD.storage_key OR NEW.thumb_key IS DISTINCT FROM OLD.thumb_key
     OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.placeholder IS DISTINCT FROM OLD.placeholder OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable attachment column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.message_id IS NOT NULL AND (NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.position IS DISTINCT FROM OLD.position) THEN
    RAISE EXCEPTION 'an attachment belongs to one message for good' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND (NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'a deleted attachment cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.message_id IS NULL AND NEW.message_id IS NOT NULL THEN
    NEW.attached_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attachments_before_update BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_before_update();

CREATE FUNCTION attachments_forbid_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'attachments are never hard-deleted; set deleted_at' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER attachments_forbid_delete BEFORE DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_forbid_delete();

-- A text message may have up to 10 attachments. Then the body (caption) is optional; without
-- attachments it stays required. attachment_count is set by the sender and verified at commit
-- against the rows actually linked (deferred), so the two can never disagree.
-- The body rule is rewritten with IS NOT NULL spelled out: the Phase 2 version
-- (char_length(body) BETWEEN …) evaluated to NULL for a NULL body and so let a live text message
-- with no body through; only the API's validation stopped it.
ALTER TABLE messages ADD COLUMN attachment_count smallint NOT NULL DEFAULT 0;
ALTER TABLE messages ADD CONSTRAINT messages_attachment_count_check CHECK (attachment_count BETWEEN 0 AND 10);
ALTER TABLE messages ADD CONSTRAINT messages_attachments_text_only CHECK (kind = 'text' OR attachment_count = 0);
ALTER TABLE messages DROP CONSTRAINT messages_live_text;
ALTER TABLE messages ADD CONSTRAINT messages_live_text CHECK (
  kind <> 'text' OR deleted_at IS NOT NULL OR (
    send_body_sha256 IS NOT NULL AND octet_length(send_body_sha256) = 32 AND (
      (body IS NULL AND attachment_count > 0) OR
      (body IS NOT NULL AND char_length(body) BETWEEN 1 AND 4000 AND btrim(body) <> ''))));

CREATE FUNCTION messages_check_attachment_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  linked integer;
BEGIN
  SELECT count(*) INTO linked FROM public.attachments a WHERE a.message_id = NEW.id;
  IF linked <> NEW.attachment_count THEN
    RAISE EXCEPTION 'message has % linked attachments, expected %', linked, NEW.attachment_count
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messages_attachment_count_matches';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER messages_check_attachment_count AFTER INSERT ON messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION messages_check_attachment_count();

-- Only a message inserted in this same transaction can take attachments (no adding media to an
-- old message later): checked when an attachment is linked.
CREATE FUNCTION attachments_link_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m record;
BEGIN
  IF NEW.message_id IS NULL OR OLD.message_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT x.sender_id, x.kind, x.deleted_at, x.xmin = pg_current_xact_id()::xid AS mine_now
    INTO m FROM public.messages x WHERE x.id = NEW.message_id;
  IF NOT FOUND OR m.kind <> 'text' OR m.deleted_at IS NOT NULL OR NOT m.mine_now OR m.sender_id <> NEW.uploader_id
     OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'attachments join only a new message of their uploader'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attachments_link_rules';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attachments_link_check BEFORE UPDATE OF message_id ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_link_check();

-- Delete-for-everyone (a tombstone) takes the attachments with it: they are marked deleted in
-- the same transaction, and the API removes the files after commit (the sweeper retries).
CREATE FUNCTION messages_tombstone_attachments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.attachment_count > 0 THEN
    UPDATE public.attachments SET deleted_at = now() WHERE message_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER messages_tombstone_attachments AFTER UPDATE OF deleted_at ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_tombstone_attachments();

GRANT SELECT,
      INSERT (uploader_id, kind, mime, byte_size, sha256, file_name, storage_key, thumb_key, width, height, placeholder),
      UPDATE (message_id, position, deleted_at, blob_removed_at)
   ON attachments TO chitthi_app;
GRANT INSERT (attachment_count) ON messages TO chitthi_app;

-- migrate:down
REVOKE INSERT (attachment_count) ON messages FROM chitthi_app;
REVOKE ALL ON attachments FROM chitthi_app;
DROP TRIGGER messages_tombstone_attachments ON messages;
DROP FUNCTION messages_tombstone_attachments();
DROP TRIGGER attachments_link_check ON attachments;
DROP FUNCTION attachments_link_check();
DROP TRIGGER messages_check_attachment_count ON messages;
DROP FUNCTION messages_check_attachment_count();
ALTER TABLE messages DROP CONSTRAINT messages_live_text;
ALTER TABLE messages ADD CONSTRAINT messages_live_text CHECK (
    kind <> 'text' OR deleted_at IS NOT NULL OR
    (char_length(body) BETWEEN 1 AND 4000 AND btrim(body) <> '' AND octet_length(send_body_sha256) = 32));
ALTER TABLE messages DROP CONSTRAINT messages_attachments_text_only;
ALTER TABLE messages DROP CONSTRAINT messages_attachment_count_check;
ALTER TABLE messages DROP COLUMN attachment_count;
DROP TRIGGER attachments_forbid_delete ON attachments;
DROP FUNCTION attachments_forbid_delete();
DROP TRIGGER attachments_before_update ON attachments;
DROP FUNCTION attachments_before_update();
DROP TABLE attachments;
