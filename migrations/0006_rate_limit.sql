-- Global outbound gate + single crawl driver lease

ALTER TABLE crawler_state ADD COLUMN outbound_lock_until REAL;
ALTER TABLE crawler_state ADD COLUMN crawl_lease_owner TEXT;
ALTER TABLE crawler_state ADD COLUMN crawl_lease_until REAL;

UPDATE crawler_state SET request_delay_ms = 750 WHERE id = 1;
