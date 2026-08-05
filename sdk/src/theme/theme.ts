import type maplibregl from "maplibre-gl";
import { basemapStyle } from "../map-core";

export function watchTheme(
  map: maplibregl.Map,
  onDark?: (dark: boolean) => void,
  reattach?: () => void,
  opts: { skipInitial?: boolean } = {},
): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (dark: boolean) => {
    onDark?.(dark);
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    map.setStyle(basemapStyle(dark), { diff: false });
    map.once("style.load", () => {
      map.jumpTo({ center, zoom, bearing, pitch });
      reattach?.();
    });
  };
  if (!opts.skipInitial) apply(mq.matches);
  const handler = (e: MediaQueryListEvent) => apply(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export function setMapTheme(map: maplibregl.Map, dark: boolean, reattach?: () => void): void {
  const center = map.getCenter();
  const zoom = map.getZoom();
  map.setStyle(basemapStyle(dark), { diff: false });
  map.once("style.load", () => {
    map.jumpTo({ center, zoom });
    reattach?.();
  });
}
