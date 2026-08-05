const OPFS_PINS = "pins.pmtiles";
const OPFS_MANIFEST = "tiles-manifest.json";

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export async function hasOfflineTiles(): Promise<boolean> {
  try {
    const root = await getRoot();
    await root.getFileHandle(OPFS_PINS);
    return true;
  } catch {
    return false;
  }
}

export async function getOfflineTilesUrl(): Promise<string | null> {
  if (!(await hasOfflineTiles())) return null;
  const root = await getRoot();
  const handle = await root.getFileHandle(OPFS_PINS);
  const file = await handle.getFile();
  return URL.createObjectURL(file);
}

export async function saveOfflineManifest(manifest: unknown): Promise<void> {
  const root = await getRoot();
  const handle = await root.getFileHandle(OPFS_MANIFEST, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(manifest));
  await writable.close();
}

export async function loadOfflineManifest(): Promise<{ version?: number } | null> {
  try {
    const root = await getRoot();
    const handle = await root.getFileHandle(OPFS_MANIFEST);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

export async function downloadPinsPmtiles(
  url: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`download ${resp.status}`);

  const total = Number(resp.headers.get("content-length") || 0);
  const root = await getRoot();
  const handle = await root.getFileHandle(OPFS_PINS, { create: true });
  const writable = await handle.createWritable();

  const reader = resp.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writable.write(value);
    received += value.byteLength;
    if (total > 0) onProgress?.(Math.round((received / total) * 100));
  }
  await writable.close();
}

export async function clearOfflineTiles(): Promise<void> {
  try {
    const root = await getRoot();
    await root.removeEntry(OPFS_PINS);
  } catch {
    /* ignore */
  }
}
