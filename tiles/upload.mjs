#!/usr/bin/env node
/** Upload baked tiles to R2 and print D1 manifest update command. */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "out");
const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
const pmtiles = join(outDir, manifest.file);

console.log(`Uploading ${manifest.file} (${manifest.bytes} bytes)…`);
execSync(`npx wrangler r2 object put p5n-tiles/${manifest.file} --file=${pmtiles} --remote`, {
  cwd: join(__dir, ".."),
  stdio: "inherit",
});
execSync(`npx wrangler r2 object put p5n-tiles/manifest.json --file=${join(outDir, "manifest.json")} --remote`, {
  cwd: join(__dir, ".."),
  stdio: "inherit",
});

console.log("\nUpdate D1 tile_manifest:");
console.log(
  `npx wrangler d1 execute p5n --remote --command "UPDATE tile_manifest SET version=${manifest.version}, built_at='${manifest.built_at}', place_count=${manifest.place_count}, r2_key='${manifest.file}', bytes=${manifest.bytes} WHERE id=1"`,
);
