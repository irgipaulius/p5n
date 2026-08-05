/** Pin type int → color (MapLibre circle layer). */
export const TYPE_COLORS: Record<number, string> = {
  1: "#22c55e",
  2: "#eab308",
  3: "#3b82f6",
  4: "#10b981",
  5: "#6366f1",
  6: "#f97316",
  7: "#14b8a6",
  8: "#06b6d4",
  9: "#8b5cf6",
  10: "#64748b",
  11: "#ef4444",
  12: "#ec4899",
};

export const TYPE_LABELS: Record<number, string> = {
  1: "Camping",
  2: "Farm",
  3: "Parking",
  4: "Nature",
  5: "Parking day",
  6: "Homestay",
  7: "Aire",
  8: "Aire CC",
  9: "Private aire",
  10: "Service",
  11: "Sports",
  12: "Establishment",
};

export function colorForType(t: number): string {
  return TYPE_COLORS[t] ?? "#3b82f6";
}
