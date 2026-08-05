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
  1: "#22c55e",
  2: "#eab308",
  3: "#3b82f6",
  4: "#10b981",
  5: "#6366f1",
  6: "#d97706",
  7: "#14b8a6",
  8: "#06b6d4",
  9: "#8b5cf6",
  10: "#64748b",
  11: "#ef4444",
  12: "#ec4899",
  13: "#84cc16",
  14: "#0ea5e9",
  15: "#0284c7",
  16: "#78716c",
  17: "#a855f7",
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

/** SVG path data (24×24 viewBox) for pin / filter icons. */
export const TYPE_ICON_PATHS: Record<number, string> = {
  1: "M4 20 L12 4 L20 20 Z M9 16 h6",
  2: "M4 18 h16 M6 18 V10 h5 V6 h2 v4 h5 v8",
  3: "M8 6 h8 v12 H8 Z M10 4 h4 v2 h-4 Z",
  4: "M12 4 C8 8 6 12 6 16 h12 c0-4-2-8-6-12 Z M12 20 v-4",
  5: "M12 4 a4 4 0 1 1 0 8 a4 4 0 1 1 0-8 M8 18 h8 v2 H8 Z",
  6: "M4 16 l3-6 2 3 3-8 3 8 2-3 3 6 M6 18 h12",
  7: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M10 8 V5 h4 v3",
  8: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M14 6 h2 v4 h-2 Z",
  9: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M11 7 a2 2 0 0 1 4 0 v1 h-4 Z",
  10: "M12 4 a3 3 0 0 1 3 3 v2 h2 v10 H7 V9 h2 V7 a3 3 0 0 1 3-3 Z",
  11: "M12 4 a6 6 0 1 1 0 12 a6 6 0 0 1 0-12 M8 8 h8 M8 12 h8",
  12: "M6 18 V8 h12 v10 M9 18 v-6 h6 v6 M10 8 V5 h4 v3",
  13: "M4 18 h16 M6 14 h4 v4 H6 Z M14 14 h4 v4 h-4 Z M10 10 h4 v2 h-4 Z",
  14: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M12 6 v2",
  15: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M11 6 h2 v4 M15 6 h2 v4",
  16: "M8 8 h8 v10 H8 Z M10 6 h4 v2 h-4 Z M10 12 h4",
  17: "M8 6 h8 v12 H8 Z M10 10 v4 h4 v-4 M11 14 h2",
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
