// gpu.js — the bare bones of computing on the GPU with WebGL2: float
// textures, render targets, shaders, and a full-screen triangle to run a
// shader once per pixel. Used by gpuflow.js from the worker, through an
// OffscreenCanvas; nothing here touches the page.

// Whether this browser can compute with float textures off the page.
export function gpuAvailable() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
    const t = texture(gl, 2, 2, 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export function context(w = 1, h = 1) {
  const gl = new OffscreenCanvas(w, h).getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('no WebGL2');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');
  // One triangle covering the target: a shader then runs once per pixel.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  return gl;
}

const FORMATS = { 1: ['R32F', 'RED'], 2: ['RG32F', 'RG'], 4: ['RGBA32F', 'RGBA'] };

// A float texture of w × h texels with `channels` floats each, read with
// texelFetch only (no filtering).
export function texture(gl, w, h, channels, data = null) {
  const [internal, format] = FORMATS[channels];
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl[internal], w, h, 0, gl[format], gl.FLOAT, data);
  t.w = w; t.h = h; t.channels = channels; t.format = gl[format];
  return t;
}

export function upload(gl, t, data) {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, t.format, gl.FLOAT, data);
}

// A render target onto one or more textures of the same size.
export function target(gl, ...textures) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  textures.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(textures.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`render target incomplete (${status})`);
  fb.w = textures[0].w; fb.h = textures[0].h; fb.textures = textures;
  return fb;
}

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// A shader program from a fragment shader body; `uniforms` lists the
// uniform names to look up.
export function program(gl, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, k) => `${k + 1}: ${l}`).join('\n'));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < n; k++) { const info = gl.getActiveUniform(p, k); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// Runs a program over a render target: textures bound in order to the
// named samplers, then the uniforms set by `set(u)`.
export function run(gl, prog, fb, textures, set) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.viewport(0, 0, fb.w, fb.h);
  gl.useProgram(prog.p);
  let unit = 0;
  for (const [name, t] of Object.entries(textures)) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (prog.u[name]) gl.uniform1i(prog.u[name], unit);
    unit++;
  }
  if (set) set(prog.u);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Reads a texture back into a Float32Array of its channels. (Only RGBA
// float reads are sure to work, so other textures go through a scratch
// array.)
export function read(gl, t, out) {
  const fb = t.readFb || (t.readFb = target(gl, t));
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  if (t.channels === 4) { gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, out); return out; }
  const tmp = t.readTmp || (t.readTmp = new Float32Array(t.w * t.h * 4));
  gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, tmp);
  const c = t.channels;
  for (let k = 0, n = t.w * t.h; k < n; k++) for (let j = 0; j < c; j++) out[k * c + j] = tmp[k * 4 + j];
  return out;
}
