/**
 * MIT — AbelVM/maplibre-preload (vendored)
 * Preloads tiles before flyTo/easeTo/panTo/zoomTo for smoother camera moves.
 */
export class MaplibrePreload {
  constructor(map, options = {}) {
    this.map = map;
    this.progressCallback = options.progressCallback || null;
    this.burstLimit = options.burstLimit || 200;
    this.async = options.hasOwnProperty("async") && !options.async ? false : true;
    this.useTile = options.hasOwnProperty("useTile") && !options.useTile ? false : true;
    this.controller = {};
    this._patchMoveMethods();
    this.map._captureTileClass = (e) => {
      if (e.tile && e.tile.tileID) {
        e.target.Tile = e.tile.constructor;
        e.target.OverscaledTileID = e.tile.tileID.constructor;
        e.target.off("sourcedata", e.target._captureTileClass);
      }
    };
    if (this.useTile) this.map.on("sourcedata", this.map._captureTileClass);
  }

  _patchMoveMethods() {
    const methods = ["flyTo", "panTo", "easeTo", "zoomTo"];
    methods.forEach((method) => {
      const original = this.map[method].bind(this.map);
      this.map[method] = async (options) => {
        Object.keys(this.controller).forEach((a) => {
          this.controller[a].abort("cancelling due to new movement");
          delete this.controller[a];
        });
        if (this.async) {
          await this._preloadTilesForMove(method, options);
        } else {
          this._preloadTilesForMove(method, options);
        }
        return original(options);
      };
    });
  }

  async _preloadTilesForMove(method, options) {
    if (options.hasOwnProperty("animate") && !options.animate) return true;
    this.duration = options.duration || 1000;
    this.padding = options.padding || 0;
    this.fps = options.fps || 60;
    this.rho = options.curve || 1.42;
    const start = {
      center: this.map.getCenter(),
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
    };
    const tc = options.center || start.center;
    const endCenter = tc.lng ? tc : { lng: tc[0], lat: tc[1] };
    const end = {
      center: endCenter,
      zoom: options.zoom !== undefined ? options.zoom : start.zoom,
      bearing: options.bearing !== undefined ? options.bearing : start.bearing,
      pitch: options.pitch !== undefined ? options.pitch : start.pitch,
    };

    let samples;
    if (method === "flyTo") {
      samples = this._sampleFlyToPath(start, end, options);
    } else if (method === "panTo") {
      samples = this._samplePanToPath(start, end, options);
    } else if (method === "easeTo") {
      samples = this._sampleEaseToPath(start, end, options);
    } else if (method === "zoomTo") {
      samples = this._sampleZoomToPath(start, end, options);
    } else {
      samples = [end];
    }

    const endRequests = {};
    const perSource = this._getVisibleTilesPerSource(end, 0);
    for (const [sourceId, tiles] of Object.entries(perSource)) {
      if (!endRequests[sourceId]) endRequests[sourceId] = new Set();
      tiles.forEach((t) => endRequests[sourceId].add(t));
    }
    await this._preloadTilesInternal(endRequests);

    const tileRequests = {};
    for (const s of samples) {
      let f = 0;
      let size = 0;
      let perSource = this._getVisibleTilesPerSource(s);
      for (const [, tiles] of Object.entries(perSource)) {
        size = Math.max(size, tiles.length);
      }
      while (size > 1.1 * this.burstLimit) {
        f++;
        size = 0;
        perSource = this._getVisibleTilesPerSource(s, f / 20);
        for (const [, tiles] of Object.entries(perSource)) {
          size = Math.max(size, tiles.length);
        }
      }
      for (const [sourceId, tiles] of Object.entries(perSource)) {
        if (!tileRequests[sourceId]) tileRequests[sourceId] = new Set();
        tiles.forEach((t) => tileRequests[sourceId].add(t));
      }
    }
    await this._preloadTilesInternal(tileRequests);
  }

  _sampleFlyToPath(start, end, options) {
    return this._flyToFrames(options);
  }

  _samplePanToPath(start, end) {
    const totalFrames = Math.ceil((this.duration / 1000) * this.fps);
    const samples = [end];
    for (let i = 1; i < totalFrames; i++) {
      const t = i / totalFrames;
      samples.push({
        center: this._interpolateLngLatLinear(start.center, end.center, t),
        zoom: start.zoom,
        bearing: start.bearing,
        pitch: start.pitch,
      });
    }
    return samples;
  }

  _sampleEaseToPath(start, end) {
    const totalFrames = Math.ceil((this.duration / 1000) * this.fps);
    const samples = [end];
    for (let i = 1; i < totalFrames; i++) {
      const t = i / totalFrames;
      samples.push({
        center: this._interpolateLngLatLinear(start.center, end.center, t),
        zoom: this._interpolateLinear(start.zoom, end.zoom, t),
        bearing: this._interpolateLinear(start.bearing, end.bearing, t),
        pitch: this._interpolateLinear(start.pitch, end.pitch, t),
      });
    }
    return samples;
  }

  _sampleZoomToPath(start, end) {
    const totalFrames = Math.ceil((this.duration / 1000) * this.fps);
    const samples = [end];
    for (let i = 1; i < totalFrames; i++) {
      const t = i / totalFrames;
      samples.push({
        center: start.center,
        zoom: this._interpolateLinear(start.zoom, end.zoom, t),
        bearing: start.bearing,
        pitch: start.pitch,
      });
    }
    return samples;
  }

  _getVisibleTilesPerSource({ center, zoom, bearing, pitch }, factor = 0) {
    const perSource = {};
    for (const sourceId in this.map.style.sourceCaches) {
      const sourceCache = this.map.style.sourceCaches[sourceId];
      if (!sourceCache.used) continue;
      perSource[sourceId] = this._getVisibleTileRange(this.map.getSource(sourceId), { center, zoom, bearing, pitch }, factor).map(
        (t) => `${t[0]}|${t[1]}|${t[2]}`,
      );
    }
    return perSource;
  }

  _getVisibleTileRange(source, { zoom, pitch }, factor) {
    function lngLatToTile(lng, lat, z) {
      const z2 = Math.pow(2, z);
      const x = z2 * ((lng + 180) / 360);
      const y = (z2 * (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI)) / 2;
      return [x, y];
    }

    const tr = this.map.transform;
    const width = tr.width;
    const height = tr.height;
    const pitchLimit = pitch / 150;
    const cornerPoints = [
      [width * factor, height * (factor + pitchLimit)],
      [width * (1 - factor), height * (factor + pitchLimit)],
      [width * (1 - factor), height * (1 - factor)],
      [width * factor, height * (1 - factor)],
    ];
    const cornerLngLat = cornerPoints.map((p) => this.map.transform.screenPointToLocation({ x: p[0], y: p[1] }));
    const tileCoords = cornerLngLat.map((c) => lngLatToTile(c.lng, c.lat, Math.floor(zoom)));
    const xs = tileCoords.map(([x]) => x);
    const ys = tileCoords.map(([, y]) => y);
    const minX = Math.floor(Math.min(...xs));
    const maxX = Math.ceil(Math.max(...xs));
    const minY = Math.floor(Math.min(...ys));
    const maxY = Math.ceil(Math.max(...ys));
    const tiles = [];

    for (let x = minX; x < maxX; x++) {
      for (let y = minY; y < maxY; y++) {
        if (source.scheme != "xyz") y = Math.pow(2, zoom) - y - 1;
        tiles.push([Math.floor(zoom), x, y]);
      }
    }

    return tiles;
  }

  async _preloadTilesInternal(tileRequests) {
    if (this.useTile) {
      const tileArray = [];
      for (const [sourceId, tileSet] of Object.entries(tileRequests)) {
        const source = this.map.getSource(sourceId);
        const tileSize = source.tileSize;
        for (const t of [...tileSet]) {
          const [z, x, y] = t.split("|");
          const tileID = new this.map.OverscaledTileID(z, 0, z, x, y);
          const tile = new this.map.Tile(tileID, tileSize);
          tileArray.push(source.loadTile(tile));
        }
      }
      return Promise.allSettled(tileArray);
    }

    return new Promise((resolve) => {
      const uuid = this._uuid();
      const timeoutId = setTimeout(() => {
        this.controller[uuid].abort("timeout");
        cleanup();
        resolve();
      }, this.duration * 5);
      const cleanup = () => {
        delete this.controller[uuid];
        clearTimeout(timeoutId);
      };
      const fetchArray = [];
      let loaded = 0;
      let failed = 0;
      this.controller[uuid] = new AbortController();

      for (const [sourceId, tileSet] of Object.entries(tileRequests)) {
        const source = this.map.getSource(sourceId);
        for (const tile of [...tileSet]) {
          const [z, x, y] = tile.split("|");
          const url = source.tiles[0].replace("{z}", z).replace("{x}", x).replace("{y}", y);
          try {
            fetchArray.push(fetch(url, { signal: this.controller[uuid].signal }));
          } catch {
            /* ignore */
          }
        }
      }
      Promise.allSettled(fetchArray)
        .then((response) => {
          response.forEach((r) => {
            if (!r.ok) failed++;
            else loaded++;
            if (this.progressCallback) {
              this.progressCallback({ loaded, total: fetchArray.length, failed });
            }
          });
          cleanup();
          resolve();
        })
        .catch(() => {
          cleanup();
          resolve();
        });
    });
  }

  _flyToFrames(options) {
    const totalFrames = Math.ceil((this.duration / 1000) * this.fps);
    const tr = this.map._getTransformForUpdate();
    const startCenter = tr.center;
    const startZoom = tr.zoom;
    const startBearing = tr.bearing;
    const startPitch = tr.pitch;
    const startRoll = tr.roll;
    const startPadding = tr.padding;
    const center = options.center.lng ? options.center : { lng: options.center[0], lat: options.center[1] };
    const bearing = "bearing" in options ? this.map._normalizeBearing(options.bearing, startBearing) : startBearing;
    const pitch = "pitch" in options ? +options.pitch : startPitch;
    const roll = "roll" in options ? this.map._normalizeBearing(options.roll, startRoll) : startRoll;
    const padding = "padding" in options ? options.padding : startPadding;
    const flyToHandler = this.map.cameraHelper.handleFlyTo(tr, {
      bearing,
      pitch,
      roll,
      padding,
      locationAtOffset: tr.center,
      offsetAsPoint: { x: 0, y: 0 },
      center: options.center,
      minZoom: options.minZoom || 0,
      zoom: options.zoom,
    });
    const w0 = Math.max(tr.width, tr.height);
    const w1 = w0 / flyToHandler.scaleOfZoom;
    const u1 = flyToHandler.pixelPathLength;
    let rho = options.curve || 1.42;
    if (typeof flyToHandler.scaleOfMinZoom === "number") {
      const wMax = w0 / flyToHandler.scaleOfMinZoom;
      rho = Math.sqrt((wMax / u1) * 2);
    }
    const rho2 = rho * rho;
    function zoomOutFactor(descent) {
      const b =
        (w1 * w1 - w0 * w0 + (descent ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (descent ? w1 : w0) * rho2 * u1);
      return Math.log(Math.sqrt(b * b + 1) - b);
    }
    function sinh(n) {
      return (Math.exp(n) - Math.exp(-n)) / 2;
    }
    function cosh(n) {
      return (Math.exp(n) + Math.exp(-n)) / 2;
    }
    function tanh(n) {
      return sinh(n) / cosh(n);
    }
    const r0 = zoomOutFactor(false);
    function w(s) {
      return cosh(r0) / cosh(r0 + rho * s);
    }
    function u(s) {
      return (w0 * ((cosh(r0) * tanh(r0 + rho * s) - sinh(r0)) / rho2)) / u1;
    }
    let S = (zoomOutFactor(true) - r0) / rho;
    if (Math.abs(u1) < 0.000002 || !isFinite(S)) {
      const k = w1 < w0 ? -1 : 1;
      S = Math.abs(Math.log(w1 / w0)) / rho;
    }
    const frames = [];
    for (let i = 0; i <= totalFrames; i++) {
      const k = i / totalFrames;
      const s = k * S;
      const scale = 1 / w(s);
      frames.push({
        center: this._interpolateLngLatLinear(startCenter, center, k),
        zoom: startZoom + Math.log2(scale),
        bearing: bearing + (bearing - startBearing) * k,
        pitch: pitch + (pitch - startPitch) * k,
      });
    }
    frames.push({
      center,
      zoom: options.zoom,
      bearing,
      pitch,
    });
    return frames;
  }

  _interpolateLinear(a, b, t) {
    return a + (b - a) * t;
  }

  _interpolateLngLatLinear(a, b, t) {
    return { lng: this._interpolateLinear(a.lng, b.lng, t), lat: this._interpolateLinear(a.lat, b.lat, t) };
  }

  _uuid() {
    const lut = [];
    const d0 = (Math.random() * 0xffffffff) | 0;
    const d1 = (Math.random() * 0xffffffff) | 0;
    const d2 = (Math.random() * 0xffffffff) | 0;
    const d3 = (Math.random() * 0xffffffff) | 0;
    for (let i = 0; i < 256; i++) {
      lut[i] = (i < 16 ? "0" : "") + i.toString(16);
    }
    return (
      lut[d0 & 0xff] +
      lut[(d0 >> 8) & 0xff] +
      lut[(d0 >> 16) & 0xff] +
      lut[(d0 >> 24) & 0xff] +
      "-" +
      lut[d1 & 0xff] +
      lut[(d1 >> 8) & 0xff] +
      "-" +
      lut[((d1 >> 16) & 0x0f) | 0x40] +
      lut[(d1 >> 24) & 0xff] +
      "-" +
      lut[((d2 >> 0) & 0x3f) | 0x80] +
      lut[(d2 >> 8) & 0xff] +
      "-" +
      lut[(d2 >> 16) & 0xff] +
      lut[(d2 >> 24) & 0xff] +
      lut[d3 & 0xff] +
      lut[(d3 >> 8) & 0xff] +
      lut[(d3 >> 16) & 0xff] +
      lut[(d3 >> 24) & 0xff]
    );
  }
}
