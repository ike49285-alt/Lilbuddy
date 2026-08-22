// render.js — drawing the map.
//
// The whole map is one ImageData pass over the raster world.js built. Each
// pixel looks up its cell, the cell looks up its owner, and the owner picks a
// colour; a border is simply a pixel whose right or lower neighbour resolves to
// a different owner. No polygons, no path stroking, no per-frame geometry.

// Radius per settlement tier. A mature world holds close to a thousand towns,
// so the smallest tier has to stay near-invisible or the map disappears under
// its own dots; cities are what the eye should pick out.
const TIER_MARKERS = [0, 1.3, 2.4, 4.2];
const TIER_ALPHA = [0, 0.3, 0.55, 0.95];

export class MapRenderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.world = world;
    this.ctx = canvas.getContext('2d');

    // Painted at raster resolution, then scaled up. Scaling one bitmap beats
    // touching four times as many pixels.
    this.buffer = document.createElement('canvas');
    this.buffer.width = world.width;
    this.buffer.height = world.height;
    this.bufferCtx = this.buffer.getContext('2d');
    this.image = this.bufferCtx.createImageData(world.width, world.height);

    // Cached RGB per polity id, so the hue hash isn't recomputed per pixel.
    this.colorCache = new Map();
    this.owners = null;
    this.settlements = [];
    this.highlight = -1;
  }

  // Golden-angle hue stepping keeps adjacent ids visually far apart, which
  // matters because neighbouring polities usually have nearby ids.
  colorFor(id) {
    let c = this.colorCache.get(id);
    if (c) return c;
    const hue = (id * 137.508) % 360;
    const sat = 0.42 + ((id * 37) % 23) / 100;
    const light = 0.44 + ((id * 61) % 17) / 100;
    c = hslToRgb(hue / 360, sat, light);
    if (this.colorCache.size > 4096) this.colorCache.clear();
    this.colorCache.set(id, c);
    return c;
  }

  setState({ owners, settlements, highlight }) {
    if (owners) this.owners = owners;
    if (settlements) this.settlements = settlements;
    if (highlight !== undefined) this.highlight = highlight;
  }

  draw() {
    const w = this.world;
    const { raster, palette } = w;
    const owners = this.owners;
    const data = this.image.data;
    const width = w.width;
    const height = w.height;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        const cell = raster[i];
        const p = i * 4;

        let r = palette[cell * 3];
        let g = palette[cell * 3 + 1];
        let b = palette[cell * 3 + 2];

        const owner = owners ? owners[cell] : -1;
        if (owner >= 0) {
          const col = this.colorFor(owner);
          // Political colour over terrain rather than instead of it, so
          // mountains and desert still read through an empire.
          r = (r * 0.32 + col[0] * 0.68) | 0;
          g = (g * 0.32 + col[1] * 0.68) | 0;
          b = (b * 0.32 + col[2] * 0.68) | 0;
        }

        // Borders: a pixel whose right or lower neighbour belongs to someone
        // else. Cheap, and it traces the Voronoi edges exactly.
        let edge = false;
        if (x + 1 < width) {
          const nc = raster[i + 1];
          if (nc !== cell && (owners ? owners[nc] : -1) !== owner) edge = true;
        }
        if (!edge && y + 1 < height) {
          const nc = raster[i + width];
          if (nc !== cell && (owners ? owners[nc] : -1) !== owner) edge = true;
        }
        if (edge && owner >= 0) { r = (r * 0.55) | 0; g = (g * 0.55) | 0; b = (b * 0.55) | 0; }

        if (cell === this.highlight) { r = Math.min(255, r + 60); g = Math.min(255, g + 60); b = Math.min(255, b + 50); }

        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }

    this.bufferCtx.putImageData(this.image, 0, 0);

    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buffer, 0, 0, cw, ch);

    this.drawSettlements(ctx, cw / width, ch / height);
  }

  drawSettlements(ctx, scaleX, scaleY) {
    const w = this.world;
    ctx.save();
    for (const s of this.settlements) {
      const tier = Math.min(3, s.tier);
      const radius = TIER_MARKERS[tier] * (scaleX * 0.6);
      if (radius <= 0) continue;
      const x = w.sx[s.cell] * scaleX;
      const y = w.sy[s.cell] * scaleY;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = tier >= 3 ? '#fff8e8' : '#12141a';
      ctx.globalAlpha = TIER_ALPHA[tier];
      ctx.fill();
      if (s.tier >= 3) {
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#2b2b2b';
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Canvas coordinates back to a cell index, for hover and click.
  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = this.world;
    const x = Math.floor(((clientX - rect.left) / rect.width) * w.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * w.height);
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return -1;
    return w.raster[y * w.width + x];
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
