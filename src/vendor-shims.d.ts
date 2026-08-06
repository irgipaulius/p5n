declare module "geojson-vt" {
  interface TileCoord {
    z: number;
    x: number;
    y: number;
  }

  interface TileIndex {
    tileCoords: TileCoord[];
    getTile(z: number, x: number, y: number): unknown;
  }

  export default function geojsonvt(
    data: GeoJSON.FeatureCollection,
    options?: Record<string, unknown>,
  ): TileIndex;
}

declare module "vt-pbf" {
  const vtpbf: {
    fromGeojsonVt(layers: Record<string, unknown>, options?: Record<string, unknown>): Uint8Array;
  };
  export default vtpbf;
}
