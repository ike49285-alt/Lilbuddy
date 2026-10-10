// view3d.js — the valley in 3D: the same frame the flat map draws, as a
// heightfield you can turn, tilt and zoom. Raw WebGL 1, no library.
//
// Units are cells: x across, z down the valley (the 2D map's y), y up, with
// heights exaggerated so a metre-high bank reads. The ground takes its
// colours from the flat map's cell image, so every map mode works; where
// there's water, the surface drawn is the water's.

const EXAG = 4;
const UNIT = EXAG / 4;                 // metres of height to cells (4 m), exaggerated
const FOV = (45 * Math.PI) / 180;
const MIN_PITCH = 0.12, MAX_PITCH = 1.45;
const MIN_DIST = 8, MAX_DIST = 520;

const TERRAIN_VS = `
attribute vec2 aPos;
attribute vec4 aHN;     // height, then the normal's x and z
attribute float aWet;
uniform mat4 uMVP;
uniform vec2 uSize;
varying vec2 vUV;
varying vec3 vN;
varying vec3 vP;
varying float vWet;
void main() {
  vUV = aPos / uSize;
  vN = vec3(aHN.y, 1.0, aHN.z);
  vWet = aWet;
  vP = vec3(aPos.x, aHN.x, aPos.y);
  gl_Position = uMVP * vec4(vP, 1.0);
}`;

const TERRAIN_FS = `
precision mediump float;
uniform sampler2D uColor;
uniform vec3 uSun;
uniform vec3 uEye;
varying vec2 vUV;
varying vec3 vN;
varying vec3 vP;
varying float vWet;
void main() {
  vec3 c = texture2D(uColor, vUV).rgb;
  vec3 n = normalize(vN);
  float shade = clamp(dot(n, uSun) / max(uSun.y, 0.25), 0.45, 1.35);
  vec3 col = c * shade;
  if (vWet > 0.5) {
    vec3 h = normalize(uSun + normalize(uEye - vP));
    col += vec3(0.32) * pow(max(dot(n, h), 0.0), 80.0);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// Whether this browser can draw the 3D view at all.
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

export class View3D {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.W = 0;
    this.H = 0;
    this.heights = null;     // what's drawn, per cell, in cells
    this.frameOf = null;
    this.lost = false;
    this.cam = null;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); this.frameOf = null; this.painted = null; });
    this.init();
  }

  init() {
    const opts = { antialias: true, alpha: false, preserveDrawingBuffer: false };
    const gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    this.terrainProg = program(gl, TERRAIN_VS, TERRAIN_FS);
    this.tColor = texture(gl);
    this.bPos = gl.createBuffer();
    this.bHN = gl.createBuffer();
    this.bWet = gl.createBuffer();
    this.bIdx = gl.createBuffer();
    this.meshW = 0;
  }

  // The grid, built once per world size: one vertex per cell centre.
  mesh(W, H) {
    if (this.meshW === W && this.meshH === H) return;
    const gl = this.gl;
    this.meshW = W;
    this.meshH = H;
    const pos = new Float32Array(W * H * 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; pos[i * 2] = x + 0.5; pos[i * 2 + 1] = y + 0.5; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const idx = new Uint16Array((W - 1) * (H - 1) * 6);
    let k = 0;
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const a = y * W + x, b = a + 1, c = a + W, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.nIdx = idx.length;
    this.hn = new Float32Array(W * H * 4);
    this.wet = new Float32Array(W * H);
    this.heights = new Float32Array(W * H);
  }

  // Heights and normals for a new frame: the sea flat at sea level, lakes
  // flat at their water level.
  shape(f) {
    const { W, H, z, h: depth, seaLevel } = f;
    const { hn, wet, heights } = this;
    let top = seaLevel * UNIT;
    for (let i = 0; i < W * H; i++) {
      const d = depth[i];
      const h = (z[i] + (d > 0.03 ? d : 0)) * UNIT;
      wet[i] = d > 0.08 ? 1 : 0;
      heights[i] = h;
      if (h > top) top = h;
    }
    this.top = top;
    for (let y = 0; y < H; y++) {
      const ym = (y > 0 ? y - 1 : y) * W, yp = (y < H - 1 ? y + 1 : y) * W;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = i * 4;
        hn[o] = heights[i];

        const xm = x > 0 ? x - 1 : x, xp = x < W - 1 ? x + 1 : x;
        hn[o + 1] = -(heights[y * W + xp] - heights[y * W + xm]) / Math.max(1, xp - xm);
        hn[o + 2] = -(heights[yp + x] - heights[ym + x]) / Math.max(1, (yp - ym) / W);
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bHN);
    gl.bufferData(gl.ARRAY_BUFFER, hn, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bWet);
    gl.bufferData(gl.ARRAY_BUFFER, wet, gl.DYNAMIC_DRAW);
  }

  // Ground height under a world point, in cells, between cell centres.
  heightAt(wx, wy) {
    const { W, H, heights } = this;
    if (!heights) return 0;
    const fx = Math.max(0, Math.min(W - 1, wx - 0.5)), fy = Math.max(0, Math.min(H - 1, wy - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = heights[y0 * W + x0], b = heights[y0 * W + x1], c = heights[y1 * W + x0], d = heights[y1 * W + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  // --- the camera -----------------------------------------------------------

  // Looking up the valley from out at sea, the whole of it in view.
  resetCamera() {
    this.cam = { tx: this.W / 2 || 64, ty: this.H * 0.5 || 128, yaw: 0, pitch: 0.62, dist: 330 };
  }

  turn(dx, dy) {
    const c = this.cam;
    c.yaw -= dx * 0.008;
    c.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, c.pitch + dy * 0.006));
  }

  zoomBy(factor) {
    const c = this.cam;
    c.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, c.dist / factor));
  }

  // Slides the point looked at across the ground, by screen pixels, as if
  // dragging the land under the fingers.
  slide(dx, dy) {
    const c = this.cam;
    const k = (c.dist * Math.tan(FOV / 2) * 2) / Math.max(1, this.canvas.clientHeight);
    const s = Math.sin(c.yaw), co = Math.cos(c.yaw);
    // Screen right is (cos, -sin) on the ground; screen up is away from the camera.
    const up = 1 / Math.max(0.35, Math.sin(c.pitch));
    c.tx -= (dx * co + dy * s * up) * k;
    c.ty -= (-dx * s + dy * co * up) * k;
    c.tx = Math.max(0, Math.min(this.W, c.tx));
    c.ty = Math.max(0, Math.min(this.H, c.ty));
  }

  lookAt(wx, wy) {
    this.cam.tx = wx;
    this.cam.ty = wy;
  }

  // Camera position and basis, and the projection, for the current size.
  matrices() {
    const c = this.cam;
    const ty = Math.max(this.heightAt(c.tx, c.ty), this.seaH || 0);
    const target = [c.tx, ty, c.ty];
    const eye = [
      c.tx + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      ty + c.dist * Math.sin(c.pitch),
      c.ty + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
    ];
    const f = norm(sub(target, eye));
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const near = Math.max(0.3, c.dist * 0.02), far = c.dist * 4 + 600;
    const t = 1 / Math.tan(FOV / 2);
    const view = [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -dot(r, eye), -dot(u, eye), dot(f, eye), 1,
    ];
    const proj = [
      t / aspect, 0, 0, 0,
      0, t, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ];
    this.eye = eye; this.fwd = f; this.right = r; this.up = u; this.aspect = aspect;
    this.mvp = mul(proj, view);
    return this.mvp;
  }

  // The world point (cells) under a point on screen (CSS pixels from the
  // canvas's corner), or null if it's sky.
  pick(px, py) {
    if (!this.heights || !this.cam) return null;
    this.matrices();
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const nx = (2 * px) / cw - 1, ny = 1 - (2 * py) / ch;
    const tn = Math.tan(FOV / 2);
    const { eye, fwd: f, right: r, up: u } = this;
    const d = norm([
      f[0] + r[0] * nx * tn * this.aspect + u[0] * ny * tn,
      f[1] + r[1] * nx * tn * this.aspect + u[1] * ny * tn,
      f[2] + r[2] * nx * tn * this.aspect + u[2] * ny * tn,
    ]);
    const above = (t) => eye[1] + d[1] * t - this.heightAt(eye[0] + d[0] * t, eye[2] + d[2] * t);
    const step = 0.4;
    const limit = this.cam.dist * 5 + 800;
    let t0 = 0;
    for (let t = step; t < limit; t += step) {
      const x = eye[0] + d[0] * t, z = eye[2] + d[2] * t;
      const inside = x >= 0 && z >= 0 && x <= this.W && z <= this.H;
      if (inside && above(t) <= 0) {
        let lo = t0, hi = t;
        for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (above(m) > 0) lo = m; else hi = m; }
        return [eye[0] + d[0] * hi, eye[2] + d[2] * hi];
      }
      t0 = t;
      if (d[1] >= 0 && eye[1] + d[1] * t > this.top + 1) break;
    }
    return null;
  }

  // Where a world point sits on the effects canvas (its backing pixels), and
  // how many of those pixels a cell spans there; null if behind the camera.
  project(wx, wy, w, h) {
    if (!this.heights || !this.cam) return null;
    const m = this.matrices();
    const X = wx, Y = this.heightAt(wx, wy), Z = wy;
    const cx = m[0] * X + m[4] * Y + m[8] * Z + m[12];
    const cy = m[1] * X + m[5] * Y + m[9] * Z + m[13];
    const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
    if (cw <= 0.01) return null;
    return { x: ((cx / cw) * 0.5 + 0.5) * w, y: (0.5 - (cy / cw) * 0.5) * h, s: (h / 2) / (Math.tan(FOV / 2) * cw) };
  }

  // --- drawing ----------------------------------------------------------------

  fit() {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return { w, h, dpr };
  }

  // Draws a frame (the flat map's cell image must already be painted for
  // it). Called for every new frame and whenever the camera moves.
  render(f) {
    if (this.lost || !f) return;
    const gl = this.gl;
    const { w, h } = this.fit();
    if (!this.cam || this.W !== f.W || this.H !== f.H) {
      this.W = f.W; this.H = f.H;
      if (!this.cam) this.resetCamera();
    }
    this.mesh(f.W, f.H);
    const fresh = this.frameOf !== f;
    if (fresh) {
      this.frameOf = f;
      this.shape(f);
      this.seaH = f.seaLevel * UNIT;
    }
    // The cell image, whenever it's been repainted (a new frame, a new mode).
    if (this.painted !== this.renderer.painted) {
      this.painted = this.renderer.painted;
      gl.bindTexture(gl.TEXTURE_2D, this.tColor);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.renderer.terrain);
    }
    // An afternoon sun from the north-west, always.
    const sx = -1.2, sz = -1.6, hl = Math.hypot(sx, sz), elev = Math.asin(0.7);
    const L = [(sx / hl) * Math.cos(elev), Math.sin(elev), (sz / hl) * Math.cos(elev)];

    const mvp = this.matrices();
    gl.viewport(0, 0, w, h);
    const sky = [0.62, 0.74, 0.84];
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    this.skyRgb = sky.map((v) => Math.round(v * 255));
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // The ground.
    let p = this.terrainProg;
    gl.useProgram(p.prog);
    attrib(gl, p, 'aPos', this.bPos, 2);
    attrib(gl, p, 'aHN', this.bHN, 4);
    attrib(gl, p, 'aWet', this.bWet, 1);
    gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
    gl.uniform2f(p.u.uSize, f.W, f.H);
    gl.uniform3fv(p.u.uSun, L);
    gl.uniform3fv(p.u.uEye, this.eye);
    bindTex(gl, 0, this.tColor, p.u.uColor);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    disable(gl, p);
  }
}

// --- small WebGL and vector helpers --------------------------------------------

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(prog));
  const u = {}, a = {};
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let k = 0; k < nu; k++) { const info = gl.getActiveUniform(prog, k); u[info.name] = gl.getUniformLocation(prog, info.name); }
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) || 0;
  for (let k = 0; k < na; k++) { const info = gl.getActiveAttrib(prog, k); a[info.name] = gl.getAttribLocation(prog, info.name); }
  return { prog, u, a };
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return t;
}

function attrib(gl, p, name, buf, size) {
  const loc = p.a[name];
  if (loc === undefined || loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function disable(gl, p) {
  for (const loc of Object.values(p.a)) if (loc >= 0) gl.disableVertexAttribArray(loc);
}

function bindTex(gl, unit, tex, loc) {
  if (!loc) return;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Column-major 4 × 4 product a·b.
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
