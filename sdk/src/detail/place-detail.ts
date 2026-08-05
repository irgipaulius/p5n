const DB_NAME = "p5n-cache";
const STORE = "places";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "place_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedPlace(placeId: string): Promise<unknown | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(placeId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function cachePlace(placeId: string, data: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ place_id: placeId, data, cached_at: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function fetchPlaceDetail(apiBase: string, placeId: string): Promise<unknown> {
  const cached = await getCachedPlace(placeId);
  if (cached) return (cached as { data: unknown }).data;

  const resp = await fetch(`${apiBase}/api/places/${encodeURIComponent(placeId)}`);
  if (!resp.ok) throw new Error(`place ${resp.status}`);
  const data = await resp.json();
  await cachePlace(placeId, data);
  return data;
}
