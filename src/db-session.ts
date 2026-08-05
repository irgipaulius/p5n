import type { Env } from "./types";

type D1WithSession = D1Database & {
  withSession?: (mode: string) => D1Database;
};

/** Read path: D1 Sessions on deployed workers; primary locally (sessions → SQLITE_AUTH in miniflare). */
export function readDb(env: Env): D1Database {
  if (env.USE_D1_SESSIONS === "1") {
    const db = env.DB as D1WithSession;
    if (typeof db.withSession === "function") {
      return db.withSession("first-unconstrained") as unknown as D1Database;
    }
  }
  return env.DB;
}

/** Write path: always primary. */
export function writeDb(env: Env): D1Database {
  return env.DB;
}
