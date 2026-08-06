import type maplibregl from "maplibre-gl";
import { ALL_TYPE_INTS, TYPE_ICON_PATHS, colorForType } from "../colors";

const STROKE_ICON = 'fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

function letterP(): string {
  return `<text x="12" y="16.5" text-anchor="middle" fill="#fff" font-size="13" font-weight="700" font-family="system-ui,sans-serif">P</text>`;
}

function cogIcon(): string {
  return `<g ${STROKE_ICON}>
    <circle cx="12" cy="12" r="3.2"/>
    <path d="M12 5.5v2 M12 16.5v2 M5.5 12h2 M16.5 12h2 M7.4 7.4l1.4 1.4 M15.2 15.2l1.4 1.4 M7.4 16.6l1.4-1.4 M15.2 8.8l1.4-1.4"/>
  </g>`;
}

function picnicIcon(): string {
  return `<g ${STROKE_ICON}>
    <path d="M12 5 L9 11 h6 Z"/>
    <path d="M12 11 v5"/>
    <path d="M6 18 h12"/>
    <path d="M8 18 v2 M16 18 v2"/>
    <path d="M7 15 h3 M14 15 h3"/>
  </g>`;
}

function pathIcon(t: number): string {
  const path = TYPE_ICON_PATHS[t] ?? TYPE_ICON_PATHS[3];
  if (!path) return "";
  return `<g ${STROKE_ICON}><path d="${path}"/></g>`;
}

function typeInnerMarkup(t: number): string {
  switch (t) {
    case 3:
    case 5:
      return letterP();
    case 10:
    case 16:
      return cogIcon();
    case 13:
      return picnicIcon();
    default:
      return pathIcon(t);
  }
}

function svgForType(t: number): string {
  const color = colorForType(t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="11" fill="${color}" stroke="#0f172a" stroke-width="1"/>
    ${typeInnerMarkup(t)}
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="${color}" stroke="#0f172a" stroke-width="1"/>
    ${typeInnerMarkup(t)}
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
