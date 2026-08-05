import type { PlaceApi } from "./types";

/** p4n boolean-ish field → bit_index (matches attribute_defs seed). */
const P4N_BITS: Record<string, number> = {
  wifi: 0,
  douche: 1,
  electricite: 2,
  animaux: 3,
  eau: 4,
  baignade: 5,
  poubelle: 6,
  wc: 7,
  parking: 8,
  piscine: 9,
  laverie: 10,
  gaz: 11,
  donnees: 12,
  acces_handi: 13,
  bbq: 14,
  poussette: 15,
  sport: 16,
  jeux: 17,
  restaurant: 18,
  boulangerie: 19,
  supermarche: 20,
  pharmacie: 21,
  laverie_auto: 22,
  piste: 23,
  peche: 24,
  velo: 25,
  ski: 26,
  plongee: 27,
  location: 28,
  visite: 29,
  camping: 30,
  naturiste: 31,
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
  for (const [key, bit] of Object.entries(P4N_BITS)) {
    if (!truthy(place[key])) continue;
    if (bit < 16) attrs0 |= 1 << bit;
    else attrs1 |= 1 << (bit - 16);
  }
  return { attrs0, attrs1 };
}

export function typeCode(code: string | undefined | null): string {
  return String(code || "P").trim() || "P";
}

/** Map type string to small int for tile props `{id, t}`. */
export const TYPE_TO_INT: Record<string, number> = {
  C: 1,
  F: 2,
  P: 3,
  PN: 4,
  PJ: 5,
  OR: 6,
  AR: 7,
  AC: 8,
  ACC_PR: 9,
  PSS: 10,
  SF: 11,
  E: 12,
  DS: 3,
};

export function typeToInt(code: string): number {
  return TYPE_TO_INT[code] ?? 3;
}

export function intToType(t: number): string {
  for (const [code, n] of Object.entries(TYPE_TO_INT)) {
    if (n === t) return code;
  }
  return "P";
}
