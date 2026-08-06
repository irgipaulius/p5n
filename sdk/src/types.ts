export interface P5nConfig {
  apiBase: string;
  tilesUrl?: string | null;
  offlineTilesPath?: string | null;
  dark?: boolean;
}

export interface PinFeature {
  id: string;
  lat: number;
  lng: number;
  t: number;
  type?: string;
  name?: string | null;
  rating?: number | null;
  reviews?: number;
  attrs0?: number;
  attrs1?: number;
}

export interface TileManifest {
  version: number;
  built_at: string | null;
  place_count: number;
  bytes: number;
  url: string | null;
  bake_status?: string;
  bake_progress?: number;
  bake_total?: number;
  bake_error?: string | null;
  bake_started_at?: string | null;
}

export interface AttributeDef {
  bit_index: number;
  column_name: "attrs0" | "attrs1";
  key: string;
  label: string;
}

export interface SearchOptions {
  q?: string;
  type?: string;
  attrs0?: number;
  attrs1?: number;
  minRating?: number;
  hasPhotos?: boolean;
  limit?: number;
  west?: number;
  south?: number;
  east?: number;
  north?: number;
  onPin?: (pin: PinFeature) => void;
  signal?: AbortSignal;
}
