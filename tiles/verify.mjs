#!/usr/bin/env node
/**
 * Verify baked PMTiles contain tippecanoe cluster props (point_count) at low zoom.
 * Usage: node verify.mjs [path/to/pins-v*.pmtiles]
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "out");

function resolveInput() {
  const arg = process.argv[2];
  if (arg && existsSync(arg)) return arg;
  const manifestPath = join(outDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const candidate = join(outDir, manifest.file);
    if (existsSync(candidate)) return candidate;
  }
  console.error("No PMTiles file found — run: npm run tiles:bake");
  process.exit(1);
}

function main() {
  const path = resolveInput();
  console.log(`PMTiles: ${path}`);

  let decoded = "";
  try {
    decoded = execSync(`tippecanoe-decode -z 3 ${path}`, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    console.error("tippecanoe-decode failed — is tippecanoe installed?");
    console.error(err.message);
    process.exit(1);
  }

  const hasPointCount = decoded.includes('"point_count"');
  const hasPinsLayer = decoded.includes('"layer": "pins"') || decoded.includes('"layer":"pins"');
  console.log(`  pins layer: ${hasPinsLayer ? "yes" : "no"}`);
  console.log(`  point_count clusters: ${hasPointCount ? "yes" : "NO — check tippecanoe flags"}`);

  if (!hasPinsLayer || !hasPointCount) process.exit(1);
  console.log("verify OK");
}

main();
