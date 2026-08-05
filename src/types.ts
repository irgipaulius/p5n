export interface Env {
  DB: D1Database;
  MAX_PLACES: string;
  REQUEST_DELAY_MS: string;
  DEFAULT_LAT: string;
  DEFAULT_LNG: string;
}

/** Job kinds — claim order prefers discovery/new over refresh/reviews. */
export type JobKind =
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
  updated_at: string;
  prefer_new?: number;
  continuous_paused?: number;
  pass_id?: number;
  pass_mode?: string;
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
  [key: string]: unknown;
}
