#!/usr/bin/env node
/**
 * Bake pins.geojsonseq → pins.pmtiles via tippecanoe.
 * Requires tippecanoe installed: brew install tippecanoe
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const inFile = join(__dir, "out", "pins.geojsonseq");
const outDir = join(__dir, "out");

if (!existsSync(inFile)) {
  console.error("Missing pins.geojsonseq — run: npm run export");
  process.exit(1);
}

const version = Date.now();
const outFile = join(outDir, `pins-v${version}.pmtiles`);

console.log("Running tippecanoe (cluster-preserving heatmap LOD)…");
execSync(
  [
    "tippecanoe",
    "-o", outFile,
    "-zg",
    "-l", "pins",
    "-r1",
    "--cluster-densest-as-needed",
    "--cluster-distance=10",
    "--extend-zooms-if-still-dropping",
    "--drop-densest-as-needed",
    "--include=id",
    "--include=t",
    "--force",
    inFile,
  ].join(" "),
  { stdio: "inherit" },
);

const bytes = statSync(outFile).size;
const featureCount = readFileSync(inFile, "utf8").trim().split("\n").filter(Boolean).length;

const manifest = {
  version,
  built_at: new Date().toISOString(),
  place_count: featureCount,
  bytes,
  file: `pins-v${version}.pmtiles`,
};

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Baked ${featureCount} pins → ${outFile} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log("Upload to R2:");
console.log(`  wrangler r2 object put p5n-tiles/pins-v${version}.pmtiles --file=${outFile}`);
console.log(`  wrangler r2 object put p5n-tiles/manifest.json --file=${join(outDir, "manifest.json")}`);
