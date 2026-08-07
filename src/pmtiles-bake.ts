/**
 * Worker-side PMTiles bakery — dashboard POST /api/tiles/bake.
 * Heatmap density only (pin_grid → MVT). Individual pins load via /api/pins/bbox on zoom-in.
 */
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { BufferWriter, S2PMTilesWriter, TileType } from "s2-pmtiles";
import { nowIso } from "./db";
import type { Env } from "./types";

const LAYER = "pins";
const EXTENT = 4096;
const GRID_HEATMAP_MAX_Z = 10;

type PinFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties?: Record<string, unknown>;
};

type PinFeatureCollection = {
  type: "FeatureCollection";
  features: PinFeature[];
};

type GeoJsonVtIndex = {
  tileCoords: Array<{ z: number; x: number; y: number }>;
  getTile: (z: number, x: number, y: number) => GeoJsonVtTile | null;
};

type GeoJsonVtTile = {
  features: Array<{
    geometry: number[][] | number[][][];
    tags?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    id?: number | string;
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

function childTiles(z: number, x: number, y: number): Array<{ z: number; x: number; y: number }> {
  const nz = z + 1;
  const nx = x * 2;
  const ny = y * 2;
  return [
    { z: nz, x: nx, y: ny },
    { z: nz, x: nx + 1, y: ny },
    { z: nz, x: nx, y: ny + 1 },
    { z: nz, x: nx + 1, y: ny + 1 },
  ];
}

function enumerateTiles(index: GeoJsonVtIndex, minZ: number, maxZ: number): Array<{ z: number; x: number; y: number }> {
  const out: Array<{ z: number; x: number; y: number }> = [];
  const queue: Array<{ z: number; x: number; y: number }> = [...index.tileCoords];
  const queued = new Set<string>();
  for (const c of index.tileCoords) queued.add(`${c.z}:${c.x}:${c.y}`);

  while (queue.length > 0) {
    const { z, x, y } = queue.shift()!;
    if (z > maxZ) continue;

    const tile = index.getTile(z, x, y);
    if (!tile?.features?.length) continue;

    if (z >= minZ) out.push({ z, x, y });

    if (z < maxZ) {
      for (const child of childTiles(z, x, y)) {
        const key = `${child.z}:${child.x}:${child.y}`;
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(child);
      }
    }
  }

  return out;
}

async function writeIndexTiles(
  writer: S2PMTilesWriter,
  index: GeoJsonVtIndex,
  minZ: number,
  maxZ: number,
): Promise<number> {
  let written = 0;
  for (const { z, x, y } of enumerateTiles(index, minZ, maxZ)) {
    const tile = index.getTile(z, x, y);
    const data = encodeTile(tile);
    if (!data) continue;
    await writer.writeTileXYZ(z, x, y, data);
    written += 1;
  }
  return written;
}

function gridToGeoJson(rows: Array<{ g4: string; count: number; lat: number; lng: number }>): PinFeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
      properties: { count: r.count, point_count: r.count, g4: r.g4, grid: true },
    })),
  };
}

export async function buildPmtilesBytes(
  db: D1Database,
  onProgress: (p: BakeProgress) => Promise<void>,
): Promise<{ bytes: Uint8Array; placeCount: number; tileCount: number }> {
  await onProgress({ phase: "grid", done: 0, total: 1 });

  const gridRows =
    (
      await db.prepare("SELECT g4, count, lat, lng FROM pin_grid ORDER BY g4").all<{
        g4: string;
        count: number;
        lat: number;
        lng: number;
      }>()
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

  await onProgress({ phase: "tile", done: 0, total: 1 });

  const gridIndex = geojsonvt(gridToGeoJson(gridRows), {
    maxZoom: GRID_HEATMAP_MAX_Z,
    indexMaxZoom: 5,
    indexMaxPoints: 100000,
    tolerance: 2,
    extent: EXTENT,
    buffer: 64,
  }) as unknown as GeoJsonVtIndex;

  const writer = new S2PMTilesWriter(new BufferWriter(), TileType.Pbf);
  const tileCount = await writeIndexTiles(writer, gridIndex, 0, GRID_HEATMAP_MAX_Z);
  await onProgress({ phase: "tile", done: 1, total: 1 });

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
