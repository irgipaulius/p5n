import type { PinFeature, SearchOptions } from "../types";

/** Parse NDJSON search stream — calls onPin for each row as bytes arrive. */
export async function streamSearch(apiBase: string, opts: SearchOptions): Promise<PinFeature[]> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.type) params.set("type", opts.type);
  if (opts.attrs0 != null) params.set("attrs0", String(opts.attrs0));
  if (opts.attrs1 != null) params.set("attrs1", String(opts.attrs1));
  if (opts.minRating != null && opts.minRating > 0) params.set("min_rating", String(opts.minRating));
  if (opts.hasPhotos) params.set("has_photos", "1");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.west != null) params.set("west", String(opts.west));
  if (opts.south != null) params.set("south", String(opts.south));
  if (opts.east != null) params.set("east", String(opts.east));
  if (opts.north != null) params.set("north", String(opts.north));

  const resp = await fetch(`${apiBase}/api/search?${params}`, { signal: opts.signal });
  if (!resp.ok || !resp.body) throw new Error(`search ${resp.status}`);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: PinFeature[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const pin = JSON.parse(line) as PinFeature;
      out.push(pin);
      opts.onPin?.(pin);
    }
  }
  if (buf.trim()) {
    const pin = JSON.parse(buf) as PinFeature;
    out.push(pin);
    opts.onPin?.(pin);
  }
  return out;
}
