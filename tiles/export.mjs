#!/usr/bin/env node
/**
 * Export slim places from local D1 → GeoJSONSeq for tippecanoe.
 * Usage: node export.mjs [--db ../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/...sqlite]
 *
 * Default: wrangler d1 execute export via subprocess.
 */
import { execSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "out");
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, "pins.geojsonseq");

console.log("Exporting places from D1…");

let rows;
try {
  const raw = execSync(
    `npx wrangler d1 execute p5n --local --command "SELECT place_id, lat, lng, type, rating FROM places WHERE lat IS NOT NULL" --json`,
    { cwd: join(__dir, ".."), encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  rows = parsed[0]?.results ?? [];
} catch (err) {
  console.error("D1 export failed — run migrations and crawl some places first.");
  console.error(err.message);
  process.exit(1);
}

const TYPE_MAP = {
  C: 1, F: 2, P: 3, PN: 4, PJ: 5, OR: 6, AR: 7, AC: 8, ACC_PR: 9, PSS: 10, SF: 11, E: 12,
};

const ws = createWriteStream(outFile);
let count = 0;
for (const row of rows) {
  const t = TYPE_MAP[row.type] ?? 3;
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [row.lng, row.lat] },
    properties: {
      id: String(row.place_id),
      t,
      rating: row.rating ?? 0,
    },
  };
  ws.write(JSON.stringify(feature) + "\n");
  count += 1;
}
ws.end();

console.log(`Wrote ${count} features → ${outFile}`);
