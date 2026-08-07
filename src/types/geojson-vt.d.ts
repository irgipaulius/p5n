declare module "geojson-vt" {
  interface GeoJSONVTOptions {
    maxZoom?: number;
    indexMaxZoom?: number;
    indexMaxPoints?: number;
    tolerance?: number;
    extent?: number;
    buffer?: number;
    promoteId?: string | null;
  }

  interface GeoJSONVT {
    tileCoords: Array<{ z: number; x: number; y: number }>;
    getTile(z: number, x: number, y: number): unknown;
  }

  interface FeatureCollection {
    type: "FeatureCollection";
    features: Feature[];
  }

  interface Feature {
    type: "Feature";
    id?: string | number;
    geometry: { type: "Point"; coordinates: [number, number] };
    properties?: Record<string, unknown>;
  }

  export default function geojsonvt(data: FeatureCollection, options?: GeoJSONVTOptions): GeoJSONVT;
}

declare module "vt-pbf" {
  export function fromGeojsonVt(
    layers: Record<string, unknown>,
    options?: { version?: number; extent?: number },
  ): Uint8Array;
}
