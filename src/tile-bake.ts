import geojsonvt from "geojson-vt";
import { BufferWriter, Compression, S2PMTilesWriter, TileType } from "s2-pmtiles";
import vtpbf from "vt-pbf";
import { chunkIdFor } from "../shared/tile-chunks";
import { typeToInt } from "../shared/place-types";
import { emit, nowIso, updateTileManifest, writeDb } from "./db";
import type { Env } from "./types";

const EXPORT_BATCH = 5000;
const LAYER = "pins";

type BakeFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; t: number };
};

export interface TileBakeStatus {
  bake_status: string;
  bake_progress: number;
  bake_total: number;
  bake_error: string | null;
  bake_started_at: string | null;
  version: number;
  place_count: number;
  built_at: string | null;
  bytes: number;
  r2_key: string | null;
}

export async function getTileBakeStatus(env: Env): Promise<TileBakeStatus | null> {
  return writeDb(env)
    .prepare(
      `SELECT bake_status, bake_progress, bake_total, bake_error, bake_started_at,
              version, place_count, built_at, bytes, r2_key
       FROM tile_manifest WHERE id = 1`,
    )
    .first<TileBakeStatus>();
}

export async function startTileBake(env: Env): Promise<{ ok: boolean; error?: string }> {
  if (!env.TILES) {
    return { ok: false, error: "R2 TILES binding not configured — enable p5n-tiles in wrangler.toml" };
  }

  const db = writeDb(env);
  const row = await db.prepare("SELECT bake_status FROM tile_manifest WHERE id = 1").first<{ bake_status: string }>();
  if (row?.bake_status === "running") {
    return { ok: false, error: "bake already running" };
  }

  await db
    .prepare(
      `UPDATE tile_manifest
       SET bake_status = 'running', bake_progress = 0, bake_total = 0,
           bake_error = NULL, bake_started_at = ?
       WHERE id = 1`,
    )
    .bind(nowIso())
    .run();

  return { ok: true };
}

async function buildPmtiles(features: BakeFeature[]): Promise<Uint8Array> {
  const index = geojsonvt(
    { type: "FeatureCollection", features },
    {
      maxZoom: 14,
      indexMaxZoom: 14,
      indexMaxPoints: 0,
      promoteId: "id",
      generateId: false,
    },
  );

  const bufWriter = new BufferWriter();
  const writer = new S2PMTilesWriter(bufWriter, TileType.Pbf, Compression.None);

  for (const { z, x, y } of index.tileCoords) {
    const tile = index.getTile(z, x, y);
    if (!tile) continue;
    const pbf = vtpbf.fromGeojsonVt({ [LAYER]: tile }) as Uint8Array | ArrayBuffer;
    const bytes = pbf instanceof Uint8Array ? pbf : new Uint8Array(pbf);
    await writer.writeTileXYZ(z, x, y, bytes);
  }

  await writer.commit({
    name: "p5n pins",
    vector_layers: [{ id: LAYER, fields: { id: "String", t: "Number" } }],
  } as Parameters<typeof writer.commit>[0]);

  return bufWriter.commit();
}

export async function listTileChunks(
  env: Env,
  ids: string[],
  request: Request,
): Promise<Array<{ chunk_id: string; version: number; place_count: number; bytes: number; url: string }>> {
  if (ids.length === 0) return [];
  const db = writeDb(env);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT chunk_id, version, place_count, bytes, r2_key FROM tile_chunks WHERE chunk_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ chunk_id: string; version: number; place_count: number; bytes: number; r2_key: string }>();

  const base = env.TILES_PUBLIC_URL || new URL(request.url).origin;
  return (rows.results ?? []).map((r) => ({
    chunk_id: r.chunk_id,
    version: r.version,
    place_count: r.place_count,
    bytes: r.bytes,
    url: `${base}/tiles/${r.r2_key}`,
  }));
}

export async function runTileBake(env: Env): Promise<void> {
  const db = writeDb(env);
  try {
    if (!env.TILES) throw new Error("R2 TILES binding not configured");

    const total =
      (await db.prepare("SELECT COUNT(*) AS n FROM places WHERE lat IS NOT NULL").first<{ n: number }>())?.n ?? 0;
    await db.prepare("UPDATE tile_manifest SET bake_total = ? WHERE id = 1").bind(total).run();
    await emit(db, `tile bake: exporting ${total} places into 10° chunks…`);

    const byChunk = new Map<string, BakeFeature[]>();
    let offset = 0;

    while (offset < total) {
      const batch = await db
        .prepare(
          `SELECT place_id, lat, lng, type FROM places
           WHERE lat IS NOT NULL ORDER BY place_id LIMIT ? OFFSET ?`,
        )
        .bind(EXPORT_BATCH, offset)
        .all<{ place_id: string; lat: number; lng: number; type: string }>();

      const rows = batch.results ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const feature: BakeFeature = {
          type: "Feature",
          id: row.place_id,
          geometry: { type: "Point", coordinates: [row.lng, row.lat] },
          properties: { id: String(row.place_id), t: typeToInt(row.type) },
        };
        const cid = chunkIdFor(row.lat, row.lng);
        const list = byChunk.get(cid) ?? [];
        list.push(feature);
        byChunk.set(cid, list);
      }

      offset += rows.length;
      await db.prepare("UPDATE tile_manifest SET bake_progress = ? WHERE id = 1").bind(offset).run();
    }

    if (byChunk.size === 0) {
      throw new Error("no places with coordinates to bake");
    }

    const version = Date.now();
    let totalBytes = 0;
    let chunkNum = 0;
    const chunkTotal = byChunk.size;

    await emit(db, `tile bake: encoding ${chunkTotal} regional PMTiles…`);

    for (const [chunkId, features] of byChunk) {
      chunkNum += 1;
      const out = await buildPmtiles(features);
      const r2Key = `chunks/pins-${chunkId}-v${version}.pmtiles`;

      await env.TILES.put(r2Key, out, {
        httpMetadata: {
          contentType: "application/vnd.pmtiles",
          cacheControl: "public, max-age=31536000, immutable",
        },
      });

      await db
        .prepare(
          `INSERT INTO tile_chunks (chunk_id, version, built_at, place_count, r2_key, bytes)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET
             version = excluded.version,
             built_at = excluded.built_at,
             place_count = excluded.place_count,
             r2_key = excluded.r2_key,
             bytes = excluded.bytes`,
        )
        .bind(chunkId, version, nowIso(), features.length, r2Key, out.byteLength)
        .run();

      totalBytes += out.byteLength;
      if (chunkNum % 5 === 0 || chunkNum === chunkTotal) {
        await emit(db, `tile bake: chunk ${chunkNum}/${chunkTotal} (${chunkId}, ${features.length} pins)`);
      }
    }

    await updateTileManifest(db, version, offset, "", totalBytes);
    await db
      .prepare(
        `UPDATE tile_manifest SET bake_status = 'idle', bake_progress = ?, bake_error = NULL WHERE id = 1`,
      )
      .bind(offset)
      .run();

    await emit(
      db,
      `tile bake done — ${offset} pins in ${chunkTotal} chunks, ${(totalBytes / (1024 * 1024)).toFixed(2)} MB total`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.prepare("UPDATE tile_manifest SET bake_status = 'error', bake_error = ? WHERE id = 1").bind(msg).run();
    await emit(db, `tile bake failed: ${msg}`, "error");
  }
}
