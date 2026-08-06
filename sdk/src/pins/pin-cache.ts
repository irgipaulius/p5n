import type { PinFeature } from "../types";
import { pinInBbox } from "./viewport-pins";

/** Session-local pin store — avoids refetching tiles already loaded this visit. */
export class PinSessionCache {
  private pins = new Map<string, PinFeature>();
  private loadedTiles = new Set<string>();

  get size(): number {
    return this.pins.size;
  }

  hasTile(g4: string): boolean {
    return this.loadedTiles.has(g4);
  }

  missingTiles(g4cells: string[]): string[] {
    return g4cells.filter((g) => !this.loadedTiles.has(g));
  }

  mergeTiles(tiles: Record<string, PinFeature[]>): number {
    let added = 0;
    for (const [g4, list] of Object.entries(tiles)) {
      this.loadedTiles.add(g4);
      for (const pin of list) {
        if (!this.pins.has(pin.id)) added += 1;
        this.pins.set(pin.id, pin);
      }
    }
    return added;
  }

  addPin(pin: PinFeature): void {
    this.pins.set(pin.id, pin);
  }

  pinsInBbox(bbox: { west: number; south: number; east: number; north: number }): PinFeature[] {
    const out: PinFeature[] = [];
    for (const pin of this.pins.values()) {
      if (pinInBbox(pin, bbox)) out.push(pin);
    }
    return out;
  }
}
