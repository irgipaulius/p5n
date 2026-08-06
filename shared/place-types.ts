/** Canonical p4n type code → tile int, labels, colors, icon paths (single source of truth). */

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
  APN: 13,
  ACC_G: 14,
  ACC_P: 15,
  ASS: 16,
  DS: 17,
};

export const TYPE_COLORS: Record<number, string> = {
  1: "#16a34a",
  2: "#ca8a04",
  3: "#2563eb",
  4: "#059669",
  5: "#ea580c",
  6: "#b45309",
  7: "#0d9488",
  8: "#0891b2",
  9: "#7c3aed",
  10: "#475569",
  11: "#dc2626",
  12: "#db2777",
  13: "#92400e",
  14: "#0284c7",
  15: "#0369a1",
  16: "#57534e",
  17: "#9333ea",
};

export const TYPE_LABELS: Record<number, string> = {
  1: "Camping",
  2: "Farm",
  3: "Parking",
  4: "Nature",
  5: "Parking day",
  6: "4x4 / off-road",
  7: "Aire",
  8: "Aire CC",
  9: "Private aire",
  10: "Service area",
  11: "Sports",
  12: "Establishment",
  13: "Picnic area",
  14: "Free aire",
  15: "Paid aire",
  16: "Service only",
  17: "Dump station",
};

export const TYPE_CODE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_TO_INT).map(([code, t]) => [code, TYPE_LABELS[t] ?? code]),
);

/** SVG path data (24×24 viewBox) for pin / filter icons — Park4Night-inspired glyphs. */
export const TYPE_ICON_PATHS: Record<number, string> = {
  1: "M4 19 L12 5 L20 19 Z M8 19 h8",
  2: "M4 18 h16 M5 18 V11 h6 V7 h2 v4 h6 v7 M8 11 h8",
  3: "",
  4: "M12 5 C9 9 8 12 8 15 h8 c0-3-1-6-4-10 Z M11 15 v4 M13 15 v4",
  5: "",
  6: "M4 17 h16 M6 14 l2-4 2 2 2-5 2 5 2-2 2 4 M8 17 v2 h8 v-2",
  7: "M5 15 h14 a1 1 0 0 0 1-1 V9 H4 v5 a1 1 0 0 0 1 1 Z M7 15 v3 h10 v-3 M8 9 V6 h8 v3",
  8: "M5 15 h14 a1 1 0 0 0 1-1 V9 H4 v5 a1 1 0 0 0 1 1 Z M7 15 v3 h10 v-3 M14 6 h3 v3 h-3 Z",
  9: "M5 15 h14 a1 1 0 0 0 1-1 V9 H4 v5 a1 1 0 0 0 1 1 Z M7 15 v3 h10 v-3 M11 7 a2 2 0 0 1 4 0",
  10: "",
  11: "M12 5 a7 7 0 1 1 0 14 a7 7 0 0 1 0-14 M8 12 h8",
  12: "M6 18 V9 h12 v9 M9 18 v-5 h6 v5 M10 9 V6 h4 v3",
  13: "",
  14: "M5 15 h14 a1 1 0 0 0 1-1 V9 H4 v5 a1 1 0 0 0 1 1 Z M7 15 v3 h10 v-3 M12 6 v3",
  15: "M5 15 h14 a1 1 0 0 0 1-1 V9 H4 v5 a1 1 0 0 0 1 1 Z M7 15 v3 h10 v-3 M10 6 h1 v3 M13 6 h1 v3",
  16: "",
  17: "M9 6 h6 v3 H9 Z M8 9 h8 v9 H8 Z M10 12 h4 M11 15 h2",
};

export const ALL_TYPE_INTS = Object.values(TYPE_TO_INT).sort((a, b) => a - b);

export function typeToInt(code: string): number {
  return TYPE_TO_INT[code] ?? 3;
}

export function intToType(t: number): string {
  for (const [code, n] of Object.entries(TYPE_TO_INT)) {
    if (n === t) return code;
  }
  return "P";
}

export function colorForType(t: number): string {
  return TYPE_COLORS[t] ?? "#3b82f6";
}

export function labelForType(t: number): string {
  return TYPE_LABELS[t] ?? "Place";
}

export function labelForCode(code: string): string {
  return TYPE_CODE_LABELS[code] ?? code;
}
