import { listAttributeDefs, listPlacesGroupedByGeohash4, listPlacesInBbox, searchPlacesPage } from "./db";
import type { Env, SearchPin } from "./types";

const PAGE_SIZE = 50;

export function parseBbox(url: URL): { west: number; south: number; east: number; north: number } | null {
  const west = url.searchParams.get("west") ?? url.searchParams.get("minLng");
  const south = url.searchParams.get("south") ?? url.searchParams.get("minLat");
  const east = url.searchParams.get("east") ?? url.searchParams.get("maxLng");
  const north = url.searchParams.get("north") ?? url.searchParams.get("maxLat");
  if (!west || !south || !east || !north) return null;
  return {
    west: Number(west),
    south: Number(south),
    east: Number(east),
    north: Number(north),
  };
}

export function handleIpGeo(request: Request): Response {
  const cf = request.cf as
    | { latitude?: string; longitude?: string; city?: string; country?: string }
    | undefined;
  if (cf?.latitude && cf?.longitude) {
    const lat = Number(cf.latitude);
    const lng = Number(cf.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return json({
        lat,
        lng,
        city: cf.city ?? null,
        country: cf.country ?? null,
        source: "ip",
      });
    }
  }
  return json({ lat: 50, lng: 10, city: null, country: null, source: "default" });
}

export async function handleBboxPins(env: Env, url: URL): Promise<Response> {
  const bbox = parseBbox(url);
  if (!bbox) return json({ error: "bbox required: west,south,east,north" }, 400);
  const limit = Math.min(10_000, Number(url.searchParams.get("limit") || 5000));
  const pins = await listPlacesInBbox(env, bbox.west, bbox.south, bbox.east, bbox.north, limit);
  return json({ pins, count: pins.length }, 200, {
    "cache-control": "public, max-age=30",
  });
}

export async function handleTilePins(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("g4") ?? "";
  const tiles = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => /^[0-9b-hj-km-np-z]{4}$/.test(s)))];
  if (tiles.length === 0) return json({ error: "g4 required: comma-separated geohash4 tiles" }, 400);
  if (tiles.length > 48) return json({ error: "max 48 tiles per request" }, 400);

  const grouped = await listPlacesGroupedByGeohash4(env, tiles);
  let count = 0;
  for (const list of Object.values(grouped)) count += list.length;

  return json({ tiles: grouped, count }, 200, {
    "cache-control": "public, max-age=300",
  });
}

export async function handleEnrich(env: Env, url: URL): Promise<Response> {
  const bbox = parseBbox(url);
  if (!bbox) return json({ error: "bbox required" }, 400);
  const since = url.searchParams.get("since") ?? undefined;
  const { enrichPlaces } = await import("./db");
  const pins = await enrichPlaces(env, bbox.west, bbox.south, bbox.east, bbox.north, since);
  return json({ pins, count: pins.length }, 200, {
    "cache-control": "no-store",
  });
}

export async function handleAttributes(env: Env): Promise<Response> {
  const attrs = await listAttributeDefs(env);
  return json({ attributes: attrs });
}

/** NDJSON stream — flush each page as it is fetched. */
export function handleStreamingSearch(env: Env, url: URL): Response {
  const q = url.searchParams.get("q") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const attrs0 = url.searchParams.has("attrs0") ? Number(url.searchParams.get("attrs0")) : undefined;
  const attrs1 = url.searchParams.has("attrs1") ? Number(url.searchParams.get("attrs1")) : undefined;
  const minRating = url.searchParams.has("min_rating")
    ? Number(url.searchParams.get("min_rating"))
    : undefined;
  const hasPhotos = url.searchParams.get("has_photos") === "1";
  const max = Math.min(5000, Number(url.searchParams.get("limit") || 2000));
  const bbox = parseBbox(url);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let offset = 0;
      let sent = 0;
      try {
        while (sent < max) {
          const page = await searchPlacesPage(env, {
            q,
            type,
            attrs0,
            attrs1,
            minRating,
            hasPhotos: hasPhotos || undefined,
            west: bbox?.west,
            south: bbox?.south,
            east: bbox?.east,
            north: bbox?.north,
            offset,
            limit: Math.min(PAGE_SIZE, max - sent),
          });
          if (!page.length) break;
          for (const row of page) {
            controller.enqueue(enc.encode(JSON.stringify(row) + "\n"));
            sent += 1;
          }
          offset += page.length;
          if (page.length < PAGE_SIZE) break;
        }
        controller.close();
      } catch (err) {
        controller.enqueue(
          enc.encode(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }) + "\n",
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "transfer-encoding": "chunked",
    },
  });
}

export async function handleTileManifest(env: Env, request: Request): Promise<Response> {
  const { readDb } = await import("./db");
  const manifest = await readDb(env).prepare("SELECT * FROM tile_manifest WHERE id = 1").first();
  const base = env.TILES_PUBLIC_URL || new URL(request.url).origin;
  const version = (manifest as { version?: number })?.version ?? 0;
  const r2Key = (manifest as { r2_key?: string })?.r2_key;
  const url = r2Key ? `${base}/tiles/${r2Key}` : null;
  return json({
    version,
    built_at: (manifest as { built_at?: string })?.built_at ?? null,
    place_count: (manifest as { place_count?: number })?.place_count ?? 0,
    bytes: (manifest as { bytes?: number })?.bytes ?? 0,
    url,
  });
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export type { SearchPin };
