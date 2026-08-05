-- Env REQUEST_DELAY_MS now drives rate limit; keep DB column in sync.
UPDATE crawler_state SET request_delay_ms = 350 WHERE id = 1;
