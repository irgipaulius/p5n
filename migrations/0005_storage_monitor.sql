-- Storage monitor + outbound rate-limit timestamp

ALTER TABLE crawler_state ADD COLUMN storage_handbrake INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawler_state ADD COLUMN last_outbound_at REAL;

UPDATE crawler_state SET request_delay_ms = 500 WHERE id = 1;
