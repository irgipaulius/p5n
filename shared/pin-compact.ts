/** Compact wire format — minimal JSON for viewport pin fetches. */

/** Viewport pin: [id, lat, lng, typeInt] */
export type CompactPin = [number, number, number, number];

/** Enrichment: [id, rating×10, reviews, attrs0, attrs1] */
export type CompactEnrich = [number, number, number, number, number];

export function compactPin(id: string | number, lat: number, lng: number, t: number): CompactPin {
  return [Number(id), lat, lng, t];
}

export function compactEnrich(
  id: string | number,
  rating: number | null | undefined,
  reviews: number | undefined,
  attrs0: number | undefined,
  attrs1: number | undefined,
): CompactEnrich {
  return [Number(id), Math.round((rating ?? 0) * 10), reviews ?? 0, attrs0 ?? 0, attrs1 ?? 0];
}

export interface DecodedPin {
  id: string;
  lat: number;
  lng: number;
  t: number;
}

export interface DecodedEnrich {
  id: string;
  rating: number;
  reviews: number;
  attrs0: number;
  attrs1: number;
}

export function decodePin(c: CompactPin): DecodedPin {
  return { id: String(c[0]), lat: c[1], lng: c[2], t: c[3] };
}

export function decodeEnrich(c: CompactEnrich): DecodedEnrich {
  return {
    id: String(c[0]),
    rating: c[1] / 10,
    reviews: c[2],
    attrs0: c[3],
    attrs1: c[4],
  };
}
