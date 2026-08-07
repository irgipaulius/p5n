/**
 * Worker-side PMTiles bakery — dashboard POST /api/tiles/bake.
 * pin_grid → MVT heatmap (direct tile bucketing, no geojson-vt tree walk).
 * Individual pins load via /api/pins/bbox when zoomed in.
 */
import vtpbf from "vt-pbf";
import { BufferWriter, S2PMTilesWriter, TileType } from "s2-pmtiles";
import { nowIso } from "./db";
import type { Env } from "./types";

const LAYER = "pins";
const EXTENT = 4096;
const GRID_HEATMAP_MAX_Z = 8;

type GridRow = { g4: string; count: number; lat: number; lng: number };

type GeoJsonVtTile = {
  features: Array<{
    geometry: number[][][];
    tags?: Record<string, unknown>;
    id?: number;
    type?: number;
  }>;
};

export type BakeProgress = {
  phase: "grid" | "export" | "tile" | "upload";
  done: number;
  total: number;
};

function encodeTile(tile: GeoJsonVtTile | null): Uint8Array | null {
  if (!tile?.features?.length) return null;
  const buf = vtpbf.fromGeojsonVt({ [LAYER]: tile }, { version: 2, extent: EXTENT });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(0, Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)),
  );
  return { x, y };
}

function tilePoint(lng: number, lat: number, z: number, x: number, y: number): [number, number] {
  const px = ((lng + 180) / 360) * (1 << z) * EXTENT;
  const latRad = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * (1 << z) * EXTENT;
  return [Math.round(px - x * EXTENT), Math.round(py - y * EXTENT)];
}

/** Bucket pre-aggregated grid cells into MVT tiles — O(cells × zoom), worker-safe. */
async function writeGridHeatmapTiles(
  writer: S2PMTilesWriter,
  rows: GridRow[],
  minZ: number,
  maxZ: number,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<number> {
  let written = 0;
  const zoomLevels = maxZ - minZ + 1;

  for (let z = minZ; z <= maxZ; z++) {
    const buckets = new Map<
      string,
      { x: number; y: number; count: number; lngSum: number; latSum: number; n: number }
    >();

    for (const row of rows) {
      const { x, y } = lngLatToTile(row.lng, row.lat, z);
      const key = `${x},${y}`;
      let b = buckets.get(key);
      if (!b) {
        b = { x, y, count: 0, lngSum: 0, latSum: 0, n: 0 };
        buckets.set(key, b);
      }
      b.count += row.count;
      b.lngSum += row.lng;
      b.latSum += row.lat;
      b.n += 1;
    }

    let featId = 0;
    for (const b of buckets.values()) {
      const lng = b.lngSum / b.n;
      const lat = b.latSum / b.n;
      const [px, py] = tilePoint(lng, lat, z, b.x, b.y);
      const data = encodeTile({
        features: [
          {
            type: 1,
            geometry: [[[px, py]]],
            tags: { point_count: b.count, count: b.count },
            id: featId++,
          },
        ],
      });
      if (!data) continue;
      await writer.writeTileXYZ(z, b.x, b.y, data);
      written += 1;
    }

    await onProgress?.(z - minZ + 1, zoomLevels);
    // Yield so progress writes flush before the next zoom level hammers CPU.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  return written;
}

export async function buildPmtilesBytes(
  db: D1Database,
  onProgress: (p: BakeProgress) => Promise<void>,
): Promise<{ bytes: Uint8Array; placeCount: number; tileCount: number }> {
  await onProgress({ phase: "grid", done: 0, total: 1 });

  const gridRows =
    (
      await db.prepare("SELECT g4, count, lat, lng FROM pin_grid ORDER BY g4").all<GridRow>()
    ).results ?? [];

  if (gridRows.length === 0) {
    throw new Error("pin_grid empty — nothing to bake");
  }

  await onProgress({ phase: "grid", done: 1, total: 1 });

  const placeCount =
    (await db.prepare("SELECT COUNT(*) AS n FROM places WHERE lat IS NOT NULL").first<{ n: number }>())?.n ?? 0;

  if (placeCount === 0) {
    throw new Error("no places with coordinates to bake");
  }

  await onProgress({ phase: "tile", done: 0, total: GRID_HEATMAP_MAX_Z + 1 });

  const writer = new S2PMTilesWriter(new BufferWriter(), TileType.Pbf);
  const tileCount = await writeGridHeatmapTiles(writer, gridRows, 0, GRID_HEATMAP_MAX_Z, async (done, total) => {
    await onProgress({ phase: "tile", done, total });
  });
  await onProgress({ phase: "tile", done: GRID_HEATMAP_MAX_Z + 1, total: GRID_HEATMAP_MAX_Z + 1 });

  await onProgress({ phase: "upload", done: 0, total: 1 });
  await writer.commit({
    name: "p5n-pins",
    description: "Park5Night heatmap density (pins via bbox API when zoomed in)",
    version: "1",
    minzoom: 0,
    maxzoom: GRID_HEATMAP_MAX_Z,
    type: "overlay",
    vector_layers: [
      {
        id: LAYER,
        fields: { point_count: "Number", count: "Number" },
        description: "Pre-aggregated pin density",
        minzoom: 0,
        maxzoom: GRID_HEATMAP_MAX_Z,
      },
    ],
  });

  const bufWriter = writer.writer as BufferWriter;
  const bytes = bufWriter.commit();

  if (tileCount === 0) {
    throw new Error("tile generation produced zero tiles");
  }

  return { bytes, placeCount, tileCount };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** D1 local dev may return BLOB as comma-separated decimals; production may return ArrayBuffer. */
function d1Bytes(raw: unknown): Uint8Array | null {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") {
    if (raw.includes(",")) return Uint8Array.from(raw.split(",").map((n) => Number(n.trim())));
    try {
      return base64ToBytes(raw);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  return null;
}

export async function storePmtiles(env: Env, db: D1Database, key: string, bytes: Uint8Array): Promise<void> {
  if (env.TILES) {
    await env.TILES.put(key, bytes, {
      httpMetadata: { contentType: "application/vnd.pmtiles" },
    });
    return;
  }
  const encoded = bytesToBase64(bytes);
  await db
    .prepare(
      `INSERT INTO tile_blob (key, data, bytes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, updated_at = excluded.updated_at`,
    )
    .bind(key, encoded, bytes.byteLength, nowIso())
    .run();
}

export async function readStoredPmtiles(env: Env, db: D1Database, key: string): Promise<ArrayBuffer | null> {
  if (env.TILES) {
    const obj = await env.TILES.get(key);
    if (obj) return obj.arrayBuffer();
  }

  const row = await db.prepare("SELECT data FROM tile_blob WHERE key = ?").bind(key).first<{ data: unknown }>();
  const bytes = d1Bytes(row?.data);
  if (!bytes) return null;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
