import type maplibregl from "maplibre-gl";
import { colorForType } from "../colors";

/** Simple SVG map pin icons per p4n type (t int). */
const ICON_PATHS: Record<number, string> = {
  1: "M4 20 L12 4 L20 20 Z M9 16 h6", // camping tent
  2: "M4 18 h16 M6 18 V10 h5 V6 h2 v4 h5 v8 M4 10 h16", // farm barn
  3: "M8 6 h8 v12 H8 Z M10 4 h4 v2 h-4 Z", // parking
  4: "M12 4 C8 8 6 12 6 16 h12 c0-4-2-8-6-12 Z M12 20 v-4", // nature tree
  5: "M12 4 a4 4 0 1 1 0 8 a4 4 0 1 1 0-8 M8 18 h8 v2 H8 Z", // parking day sun
  6: "M4 18 h16 M6 18 V11 l6-5 6 5 v7 M10 18 v-4 h4 v4", // homestay
  7: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M10 8 V5 h4 v3", // aire / camper
  8: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M14 6 h2 v4 h-2 Z", // aire + elec
  9: "M5 16 h14 l-2-8 H7 Z M8 16 v3 h8 v-3 M11 7 a2 2 0 0 1 4 0 v1 h-4 Z", // private
  10: "M12 4 a3 3 0 0 1 3 3 v2 h2 v10 H7 V9 h2 V7 a3 3 0 0 1 3-3 Z", // service
  11: "M12 4 a6 6 0 1 1 0 12 a6 6 0 0 1 0-12 M8 8 h8 M8 12 h8", // sports
  12: "M6 18 V8 h12 v10 M9 18 v-6 h6 v6 M10 8 V5 h4 v3", // establishment
};

function svgForType(t: number): string {
  const color = colorForType(t);
  const path = ICON_PATHS[t] ?? ICON_PATHS[3];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="11" fill="${color}" stroke="#0f172a" stroke-width="1"/>
    <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="${path}"/>
    </g>
  </svg>`;
}

function svgToImage(svg: string, size: number): Promise<ImageBitmap | HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image(size, size);
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function registerPinIcons(map: maplibregl.Map): Promise<void> {
  const types = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  await Promise.all(
    types.map(async (t) => {
      const id = `pin-t${t}`;
      if (map.hasImage(id)) return;
      const img = await svgToImage(svgForType(t), 32);
      map.addImage(id, img, { pixelRatio: 2 });
    }),
  );
}

export function iconImageExpression(): maplibregl.ExpressionSpecification {
  return [
    "concat",
    "pin-t",
    [
      "to-string",
      [
        "coalesce",
        ["get", "t"],
        3,
      ],
    ],
  ];
}
