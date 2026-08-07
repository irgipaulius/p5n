/**
 * Worker-side PMTiles bakery — dashboard POST /api/tiles/bake.
 * geojson-vt + vt-pbf + s2-pmtiles (no tippecanoe/npm required).
 */
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { BufferWriter, S2PMTilesWriter, TileType } from "s2-pmtiles";
import { typeToInt } from "../shared/place-types";
import { nowIso } from "./db";
import type { Env } from "./types";

const EXPORT_BATCH = 5000;
const LAYER = "pins";
const EXTENT = 4096;
const MAX_ZOOM = 14;
const GRID_HEATMAP_MAX_Z = 10;

type PinFeature = {
  type: "Feature";
  id?: string | number;
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
    geometry: number[][][];
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

function clusterTileFeatures(features: GeoJsonVtTile["features"], z: number): GeoJsonVtTile["features"] {
  if (z > GRID_HEATMAP_MAX_Z || features.length === 0) return features;

  const grid = z <= 4 ? 512 : z <= 7 ? 256 : 128;
  const cells = new Map<string, { x: number; y: number; count: number }>();

  for (const f of features) {
    const ring = f.geometry?.[0];
    if (!ring?.length) continue;
    const x = ring[0][0];
    const y = ring[0][1];
    const cx = Math.floor(x / grid) * grid + grid / 2;
    const cy = Math.floor(y / grid) * grid + grid / 2;
    const key = `${cx},${cy}`;
    const cur = cells.get(key);
    if (cur) cur.count += 1;
    else cells.set(key, { x: cx, y: cy, count: 1 });
  }

  return [...cells.values()].map((c, i) => ({
    type: 1,
    geometry: [[[c.x, c.y]]],
    properties: { point_count: c.count },
    id: i,
  }));
}

function encodeTile(tile: GeoJsonVtTile | null): Uint8Array | null {
  if (!tile?.features?.length) return null;
  const buf = vtpbf.fromGeojsonVt({ [LAYER]: tile }, { version: 2, extent: EXTENT });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function writeIndexTiles(
  writer: S2PMTilesWriter,
  index: GeoJsonVtIndex,
  minZ: number,
  maxZ: number,
  clusterHeatmap: boolean,
): Promise<number> {
  let written = 0;
  for (const { z, x, y } of index.tileCoords) {
    if (z < minZ || z > maxZ) continue;
    let tile = index.getTile(z, x, y);
    if (!tile?.features?.length) continue;
    if (clusterHeatmap) {
      tile = { features: clusterTileFeatures(tile.features, z) };
      if (!tile.features.length) continue;
    }
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

async function loadAllPlaces(
  db: D1Database,
  onProgress: (done: number, total: number) => Promise<void>,
): Promise<{ total: number; collection: PinFeatureCollection }> {
  const total =
    (await db.prepare("SELECT COUNT(*) AS n FROM places WHERE lat IS NOT NULL").first<{ n: number }>())?.n ?? 0;

  const features: PinFeature[] = [];
  let offset = 0;

  while (offset < total) {
    const batch = await db
      .prepare(
        `SELECT place_id, lat, lng, type FROM places WHERE lat IS NOT NULL ORDER BY place_id LIMIT ? OFFSET ?`,
      )
      .bind(EXPORT_BATCH, offset)
      .all<{ place_id: string; lat: number; lng: number; type: string }>();

    const rows = batch.results ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      features.push({
        type: "Feature",
        id: row.place_id,
        geometry: { type: "Point", coordinates: [row.lng, row.lat] },
        properties: { id: String(row.place_id), t: typeToInt(row.type) },
      });
    }

    offset += rows.length;
    await onProgress(offset, total);
  }

  return { total, collection: { type: "FeatureCollection", features } };
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

  await onProgress({ phase: "export", done: 0, total: 1 });

  const { total: placeCount, collection } = await loadAllPlaces(db, async (done, total) => {
    await onProgress({ phase: "export", done, total });
  });

  if (placeCount === 0) {
    throw new Error("no places with coordinates to bake");
  }

  await onProgress({ phase: "tile", done: 0, total: 3 });

  const gridIndex = geojsonvt(gridToGeoJson(gridRows), {
    maxZoom: GRID_HEATMAP_MAX_Z,
    indexMaxZoom: 5,
    indexMaxPoints: 100000,
    tolerance: 2,
    extent: EXTENT,
    buffer: 64,
  }) as unknown as GeoJsonVtIndex;

  const pinIndex = geojsonvt(collection, {
    maxZoom: MAX_ZOOM,
    indexMaxZoom: 6,
    indexMaxPoints: 100000,
    tolerance: 2,
    extent: EXTENT,
    buffer: 64,
    promoteId: "id",
  }) as unknown as GeoJsonVtIndex;

  const writer = new S2PMTilesWriter(new BufferWriter(), TileType.Pbf);

  let tileCount = 0;
  tileCount += await writeIndexTiles(writer, gridIndex, 0, GRID_HEATMAP_MAX_Z, false);
  await onProgress({ phase: "tile", done: 1, total: 3 });

  tileCount += await writeIndexTiles(writer, pinIndex, GRID_HEATMAP_MAX_Z + 1, MAX_ZOOM, false);
  await onProgress({ phase: "tile", done: 2, total: 3 });

  await writer.commit({
    name: "p5n-pins",
    description: "Park5Night POI pins",
    version: "1",
    minzoom: 0,
    maxzoom: MAX_ZOOM,
    type: "overlay",
    vector_layers: [
      {
        id: LAYER,
        fields: { id: "String", t: "Number", point_count: "Number" },
        description: "Camping / parking POIs",
        minzoom: 0,
        maxzoom: MAX_ZOOM,
      },
    ],
  });

  await onProgress({ phase: "tile", done: 3, total: 3 });

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
