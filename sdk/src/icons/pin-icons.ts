import type maplibregl from "maplibre-gl";
import { ALL_TYPE_INTS, TYPE_ICON_PATHS, colorForType } from "../colors";

function svgForType(t: number): string {
  const color = colorForType(t);
  const path = TYPE_ICON_PATHS[t] ?? TYPE_ICON_PATHS[3];
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
  await Promise.all(
    ALL_TYPE_INTS.map(async (t) => {
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
    ["to-string", ["coalesce", ["to-number", ["get", "t"]], 3]],
  ];
}

/** Inline SVG for filter chips / UI (not map images). */
export function typeIconSvg(t: number, size = 16): string {
  const color = colorForType(t);
  const path = TYPE_ICON_PATHS[t] ?? TYPE_ICON_PATHS[3];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="${color}" stroke="#0f172a" stroke-width="1"/>
    <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="${path}"/>
    </g>
  </svg>`;
}

/** Simple facility icons for filter chips. */
export const ATTR_ICONS: Record<string, string> = {
  wifi: "📶",
  douche: "🚿",
  electricite: "⚡",
  animaux: "🐾",
  eau: "💧",
  baignade: "🏊",
  poubelle: "🗑",
  wc: "🚻",
  parking: "🅿",
  piscine: "🏊",
  laverie: "🧺",
  gaz: "🔥",
  donnees: "📱",
  acces_handi: "♿",
  bbq: "🍖",
  poussette: "👶",
  sport: "🏃",
  jeux: "🎠",
  restaurant: "🍽",
  boulangerie: "🥖",
  supermarche: "🛒",
  pharmacie: "💊",
  laverie_auto: "🚗",
  piste: "🛤",
  peche: "🎣",
  velo: "🚴",
  ski: "⛷",
  plongee: "🤿",
  location: "🔑",
  visite: "🗺",
  camping: "⛺",
  naturiste: "🏖",
};

export function attrIcon(key: string): string {
  return ATTR_ICONS[key] ?? "•";
}
