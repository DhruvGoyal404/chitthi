-- migrate:up
-- When did each member receive / read a message? Read markers are watermarks (one row per member),
-- so their history is kept here, append-only: one row each time a marker moves forward. For a
-- message with seq s, a member's delivered/read time is the first event of that kind with
-- upto_seq >= s. Written only by the trigger (SECURITY DEFINER); the API can only read it.
CREATE TABLE marker_events (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id  uuid        NOT NULL REFERENCES conversations (id),
  user_id          uuid        NOT NULL REFERENCES users (id),
  kind             text        NOT NULL,
  upto_seq         bigint      NOT NULL,
  at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marker_events_kind_check CHECK (kind IN ('delivered', 'read')),
  CONSTRAINT marker_events_seq_check CHECK (upto_seq >= 1)
);
CREATE INDEX marker_events_lookup_idx ON marker_events (conversation_id, user_id, kind, upto_seq);

CREATE FUNCTION read_markers_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.last_delivered_seq > OLD.last_delivered_seq THEN
    INSERT INTO public.marker_events (conversation_id, user_id, kind, upto_seq)
    VALUES (NEW.conversation_id, NEW.user_id, 'delivered', NEW.last_delivered_seq);
  END IF;
  IF NEW.last_read_seq > OLD.last_read_seq THEN
    INSERT INTO public.marker_events (conversation_id, user_id, kind, upto_seq)
    VALUES (NEW.conversation_id, NEW.user_id, 'read', NEW.last_read_seq);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER read_markers_log AFTER UPDATE ON read_markers
  FOR EACH ROW EXECUTE FUNCTION read_markers_log();

GRANT SELECT ON marker_events TO chitthi_app;

-- migrate:down
DROP TRIGGER read_markers_log ON read_markers;
DROP FUNCTION read_markers_log();
DROP TABLE marker_events;
