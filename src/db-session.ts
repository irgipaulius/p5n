import type { Env } from "./types";

type D1WithSession = D1Database & {
  withSession?: (mode: string) => D1Database;
};

/** Read path: prefer nearest D1 replica when Sessions API is available. */
export function readDb(env: Env): D1Database {
  const db = env.DB as D1WithSession;
  if (typeof db.withSession === "function") {
    return db.withSession("first-unconstrained") as unknown as D1Database;
  }
  return env.DB;
}

/** Write path: always primary. */
export function writeDb(env: Env): D1Database {
  return env.DB;
}
