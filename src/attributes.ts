import type { PlaceApi } from "./types";
import { typeToInt, TYPE_TO_INT } from "../shared/place-types";

export { typeToInt, TYPE_TO_INT } from "../shared/place-types";
export { intToType } from "../shared/place-types";

/** Canonical key → p4n API field name (matches attribute_defs.source_mappings). */
const P4N_FIELD: Record<string, string> = {
  wifi: "wifi",
  douche: "douche",
  electricite: "electricite",
  animaux: "animaux",
  eau: "point_eau",
  baignade: "baignade",
  poubelle: "poubelle",
  wc: "wc_public",
  parking: "caravaneige",
  piscine: "piscine",
  laverie: "laverie",
  gaz: "gaz",
  donnees: "donnees_mobile",
  acces_handi: "acces_handi",
  bbq: "bbq",
  poussette: "poussette",
  sport: "rando",
  jeux: "jeux_enfants",
  restaurant: "restaurant",
  boulangerie: "boulangerie",
  supermarche: "supermarche",
  pharmacie: "pharmacie",
  laverie_auto: "lavage",
  piste: "vtt",
  peche: "peche",
  velo: "vtt",
  ski: "ski",
  plongee: "plongee",
  location: "location",
  visite: "visites",
  camping: "camping",
  naturiste: "naturiste",
};

/** bit_index → canonical key */
const BIT_KEYS: Record<number, string> = {
  0: "wifi",
  1: "douche",
  2: "electricite",
  3: "animaux",
  4: "eau",
  5: "baignade",
  6: "poubelle",
  7: "wc",
  8: "parking",
  9: "piscine",
  10: "laverie",
  11: "gaz",
  12: "donnees",
  13: "acces_handi",
  14: "bbq",
  15: "poussette",
  16: "sport",
  17: "jeux",
  18: "restaurant",
  19: "boulangerie",
  20: "supermarche",
  21: "pharmacie",
  22: "laverie_auto",
  23: "piste",
  24: "peche",
  25: "velo",
  26: "ski",
  27: "plongee",
  28: "location",
  29: "visite",
  30: "camping",
  31: "naturiste",
};

function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "oui" || s === "yes";
  }
  return false;
}

export function encodeAttributes(place: PlaceApi): { attrs0: number; attrs1: number } {
  let attrs0 = 0;
  let attrs1 = 0;
  for (const [bitStr, key] of Object.entries(BIT_KEYS)) {
    const bit = Number(bitStr);
    const field = P4N_FIELD[key] ?? key;
    if (!truthy(place[field])) continue;
    if (bit < 16) attrs0 |= 1 << bit;
    else attrs1 |= 1 << (bit - 16);
  }
  return { attrs0, attrs1 };
}

/** Max review comments indexed per place (FTS + display cache). Full list: client commGet. */
export const MAX_REVIEWS_PER_PLACE = 20;

export function typeCode(code: string | undefined | null): string {
  return String(code || "P").trim() || "P";
}

export function photoCountFrom(place: PlaceApi): number {
  const nb = place.nb_photos;
  if (nb != null && String(nb).trim() !== "") return Number(nb) || 0;
  if (Array.isArray(place.photos)) return place.photos.length;
  return 0;
}

export function extractPhotoUrls(place: PlaceApi): string[] {
  const raw = place.photos;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const thumb = String(p.link_thumb || p.link_large || "").trim();
    if (thumb) out.push(thumb);
  }
  return out.slice(0, 12);
}
