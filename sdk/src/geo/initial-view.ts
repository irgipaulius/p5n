import type maplibregl from "maplibre-gl";

export interface InitialView {
  lat: number;
  lng: number;
  zoom: number;
  source: "gps" | "ip" | "default";
}

const DEFAULT: InitialView = { lat: 50, lng: 10, zoom: 5, source: "default" };

async function fetchIpView(apiBase: string): Promise<InitialView | null> {
  try {
    const resp = await fetch(`${apiBase}/api/geo/ip`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { lat: number; lng: number; source?: string };
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return null;
    return {
      lat: data.lat,
      lng: data.lng,
      zoom: 8,
      source: data.source === "ip" ? "ip" : "default",
    };
  } catch {
    return null;
  }
}

function requestGps(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 600_000 },
    );
  });
}

/** Rough IP center first, then browser location prompt; returns final view used. */
export async function resolveInitialView(map: maplibregl.Map, apiBase: string): Promise<InitialView> {
  const ipView = (await fetchIpView(apiBase)) ?? DEFAULT;
  map.jumpTo({ center: [ipView.lng, ipView.lat], zoom: ipView.zoom });

  const gps = await requestGps();
  if (gps) {
    const view: InitialView = { lat: gps.lat, lng: gps.lng, zoom: 11, source: "gps" };
    map.flyTo({ center: [gps.lng, gps.lat], zoom: view.zoom, duration: 600 });
    return view;
  }
  return ipView;
}
