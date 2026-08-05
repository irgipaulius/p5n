# p5n

Park4night crawler on **Cloudflare Workers + D1**.

Fetches guest JSON APIs (`lieuxGetFilter`, `commGet`) from the edge — no HTML scraping, append-only snapshots, durable job queue.

## Local

```bash
npm install
npx wrangler d1 migrations apply p5n --local
npm run dev
```

Open http://127.0.0.1:8787 and click **Crawl** (cap: 10 places via `MAX_PLACES`).

Or:

```bash
curl -X POST http://127.0.0.1:8787/api/crawl
curl http://127.0.0.1:8787/api/stats
curl http://127.0.0.1:8787/api/places
```

## Deploy

```bash
npx wrangler d1 create p5n
# put the returned database_id into wrangler.toml
npx wrangler d1 migrations apply p5n --remote
npx wrangler deploy
```

## Legacy

Previous Python/SQLite/Docker prototype lives in [`legacy/`](legacy/).
