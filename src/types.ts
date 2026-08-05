export interface Env {
  DB: D1Database;
  TILES?: R2Bucket;
  ASSETS?: Fetcher;
  MAX_PLACES: string;
  REQUEST_DELAY_MS: string;
  DEFAULT_LAT: string;
  DEFAULT_LNG: string;
  TILES_PUBLIC_URL?: string;
  USE_D1_SESSIONS?: string;
  /** Shared secret for worker self-chain bursts (keeps crawl running past 30s free-tier limit). */
  CRAWL_CHAIN_SECRET?: string;
}

/** Job kinds — claim order prefers ingest chunks, then discovery, then refresh/reviews. */
export type JobKind =
  | "ingest_chunk"
  | "filter_cell"
  | "place_refresh"
  | "place_reviews"
  | "rescrape_place";

export interface JobRow {
  id: string;
  kind: JobKind;
  payload_json: string;
  status: string;
  attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_error: string | null;
}

export interface CrawlerState {
  id: number;
  paused: number;
  max_places: number;
  places_crawled: number;
  request_delay_ms: number;
  prefer_new: number;
  continuous_paused: number;
  pass_id: number;
  pass_mode: string;
  storage_handbrake: number;
  last_outbound_at: number | null;
  outbound_lock_until: number | null;
  crawl_lease_owner: string | null;
  crawl_lease_until: number | null;
  updated_at: string;
}

export interface PlaceApi {
  id: string | number;
  latitude?: string;
  longitude?: string;
  name?: string;
  titre?: string;
  code?: string;
  pays?: string;
  ville?: string;
  note_moyenne?: string;
  nb_commentaires?: string | number;
  nb_photos?: string | number;
  photos?: unknown[];
  description_en?: string;
  description_fr?: string;
  description_de?: string;
  description_es?: string;
  description_it?: string;
  description_nl?: string;
  [key: string]: unknown;
}

export interface CommentApi {
  id: string | number;
  note?: string;
  uuid?: string;
  date_creation?: string;
  commentaire?: string;
  type_vehicule?: string;
  [key: string]: unknown;
}

export interface PlaceRow {
  place_id: string;
  source: string;
  lat: number;
  lng: number;
  geohash4: string;
  geohash6: string;
  type: string;
  rating: number | null;
  review_count: number;
  attrs0: number;
  attrs1: number;
  photo_count: number;
  name: string | null;
  city: string | null;
  country: string | null;
  updated_at: string;
  reviews_fetched: number;
}

export interface PinGeo {
  id: string;
  lat: number;
  lng: number;
  t: number;
  type: string;
  name: string | null;
  updated_at: string;
}

export interface EnrichPin {
  id: string;
  lat: number;
  lng: number;
  t: number;
  type: string;
  rating: number | null;
  reviews: number;
  attrs0: number;
  attrs1: number;
  name: string | null;
}

export interface SearchPin {
  id: string;
  lat: number;
  lng: number;
  t: number;
  type: string;
  name: string | null;
  rating: number | null;
  reviews: number;
  score?: number;
}

export interface AttributeDef {
  bit_index: number;
  column_name: "attrs0" | "attrs1";
  key: string;
  label: string;
}
