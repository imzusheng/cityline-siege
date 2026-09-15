// Frame orchestration.
//
//   ground  -> baked city map, one textured quad
//   blocks  -> every extruded building, one draw call, depth buffer
//   props   -> trees / barricades / corpses (depth cleared, so they read as
//              the tactical layer and never hide the battle)
//   units   -> soldiers and infected, one instanced draw call each atlas
//   fx      -> tracers, muzzle flashes, blood, dust on top

import type { GL, Uniforms } from './glutil';
import { createGL, program, uniforms, CAMERA_GLSL } from './glutil';
import { Camera } from './camera';
import { SpriteBatch, SPRITE_STRIDE } from './sprites';
import { buildFacadeTexture, bakeGround, buildDetailTexture, GROUND_TEX_W, GROUND_TEX_H } from './textures';
import { buildBuildingMesh, VERTEX_FLOATS } from './buildings';
import { buildAtlases, unitCellIndex, UNIT_CELL, UNIT_COLS, UNIT_ATLAS, PROP_CELL, PROP_ATLAS, PROP_ANCHOR_Y, PROP_WORLD_SIZE, PX_PER_SWU, type AtlasLayout } from './atlas';
import { CHAR_H, CELL } from './figures';
import { DIR_BASE, DIR_MIRROR, DIR_TO_BASE, TOTAL_FRAMES, animFrameIndex, dirBucket } from '../entities/anim';
import { HUMAN_HEIGHT, ZSCALE, ZOMBIE_HEIGHT, BRUTE_HEIGHT } from '../core/config';
import type { World } from '../simulation/world';
import { FX } from '../simulation/world';

const UNIT_SWU = CELL / PX_PER_SWU;

const GROUND_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aWorld;
layout(location=1) in vec2 aUV;
uniform float uDepthHalf;
out vec2 vUV;
${CAMERA_GLSL}
void main() {
  gl_Position = toClip(aWorld, 0.0, 0.0, uDepthHalf);
  vUV = aUV;
}
`;

const GROUND_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uDetail;
in vec2 vUV;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = vUV;
  vec3 c = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  // tiling detail keeps the pavement crisp when the camera is close
  float det = texture(uDetail, uv * vec2(880.0, 660.0)).r;
  c *= 0.78 + det * 0.46;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  if (inside < 0.5) {
    // countryside beyond the city limits: dark scrub with a slow noise break-up
    float n = hash(floor(uv * 640.0)) * 0.4 + hash(floor(uv * 96.0)) * 0.35 + hash(floor(uv * 18.0)) * 0.25;
    vec3 dirt = mix(vec3(0.085, 0.094, 0.070), vec3(0.150, 0.158, 0.118), n);
    float d = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
    c = dirt * (1.0 - clamp(d * 0.30, 0.0, 0.35));
  }
  outColor = vec4(c, 1.0);
}
`;

const BUILD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLayer;
layout(location=3) in vec3 aTint;
uniform float uDepthHalf;
out vec2 vUV;
out float vLayer;
out vec3 vTint;
${CAMERA_GLSL}
void main() {
  gl_Position = toClip(aPos.xy, aPos.z, 0.0, uDepthHalf);
  vUV = aUV;
  vLayer = aLayer;
  vTint = aTint;
}
`;

const BUILD_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uFacade;
in vec2 vUV;
in float vLayer;
in vec3 vTint;
out vec4 outColor;
void main() {
  vec4 c = texture(uFacade, vec3(vUV, vLayer));
  outColor = vec4(c.rgb * vTint, 1.0);
}
`;

const FX_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aWorld;
layout(location=1) in vec2 aOffset;
layout(location=2) in vec4 aColor;
uniform float uDepthHalf;
out vec4 vColor;
${CAMERA_GLSL}
void main() {
  vec3 s = toScreen(aWorld, 0.0, 0.0);
  vec2 p = s.xy + aOffset;
  gl_Position = vec4(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0, 0.0, 1.0);
  vColor = aColor;
}
`;

const FX_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }
`;

export class Renderer {
  gl: GL;
  atlas: AtlasLayout;
  private groundProg: WebGLProgram;
  private groundU: Uniforms;
  private groundTex: WebGLTexture;
  private detailTex: WebGLTexture;
  private groundVao: WebGLVertexArrayObject;
  private groundBuf: WebGLBuffer;
  private buildProg: WebGLProgram;
  private buildU: Uniforms;
  private facade: WebGLTexture;
  private buildVao: WebGLVertexArrayObject;
  private buildBuf: WebGLBuffer;
  private buildCount = 0;
  private fxProg: WebGLProgram;
  private fxU: Uniforms;
  private fxVao: WebGLVertexArrayObject;
  private fxBuf: WebGLBuffer;
  private fxData = new Float32Array(8 * 6 * 3000);
  private fxVertices = 0;
  private units: SpriteBatch;
  private groundSprites: SpriteBatch;
  camera: Camera;
  debugPasses = { ground: true, buildings: true, props: true, units: true, fx: true };
  stats = { units: 0, props: 0, corpses: 0, buildings: 0, effects: 0 };
  private corpseCursor = 0;

  constructor(gl: GL, camera: Camera, world: World) {
    this.gl = gl;
    this.camera = camera;
    this.atlas = buildAtlases();

    // ---- ground
    this.groundProg = program(gl, GROUND_VS, GROUND_FS, 'ground');
    this.groundU = uniforms(gl, this.groundProg, ['uCam', 'uRot', 'uViewport', 'uZoom', 'uPitch', 'uZScale', 'uDepthHalf', 'uTex', 'uDetail']);
    this.detailTex = buildDetailTexture(gl);
    const gtex = gl.createTexture()!;
    this.groundTex = gtex;
    gl.bindTexture(gl.TEXTURE_2D, gtex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const groundCanvas = bakeGround(world.city);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, groundCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.groundVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.groundVao);
    const gbuf = gl.createBuffer()!;
    this.groundBuf = gbuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, gbuf);
    const GX = -2600, GY = -2600, GW = 6400 + 5200, GH = 4800 + 5200;
    const u0 = GX / 6400, v0 = GY / 4800, u1 = (GX + GW) / 6400, v1 = (GY + GH) / 4800;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      GX, GY, u0, v0, GX + GW, GY, u1, v0, GX + GW, GY + GH, u1, v1,
      GX, GY, u0, v0, GX + GW, GY + GH, u1, v1, GX, GY + GH, u0, v1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    // ---- buildings
    this.buildProg = program(gl, BUILD_VS, BUILD_FS, 'building');
    this.buildU = uniforms(gl, this.buildProg, ['uCam', 'uRot', 'uViewport', 'uZoom', 'uPitch', 'uZScale', 'uDepthHalf', 'uFacade']);
    this.facade = buildFacadeTexture(gl);
    const mesh = buildBuildingMesh(world.city);
    this.buildCount = mesh.count;
    this.stats.buildings = mesh.buildings;
    this.buildVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.buildVao);
    const bbuf = gl.createBuffer()!;
    this.buildBuf = bbuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, bbuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const S = VERTEX_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 24);
    gl.bindVertexArray(null);

    // ---- sprites
    this.units = new SpriteBatch(gl, 4200);
    this.units.topRatio = 78 / CELL;
    this.units.botRatio = (CELL - 78) / CELL;
    this.units.minPx = 6.0;
    this.units.texture = this.makeTexture(gl, this.atlas.unitCanvas, UNIT_ATLAS);

    this.groundSprites = new SpriteBatch(gl, 4200);
    this.groundSprites.topRatio = PROP_ANCHOR_Y / PROP_CELL;
    this.groundSprites.botRatio = (PROP_CELL - PROP_ANCHOR_Y) / PROP_CELL;
    this.groundSprites.minPx = 0;
    this.groundSprites.texture = this.makeTexture(gl, this.atlas.propCanvas, PROP_ATLAS);

    // ---- fx
    this.fxProg = program(gl, FX_VS, FX_FS, 'fx');
    this.fxU = uniforms(gl, this.fxProg, ['uCam', 'uRot', 'uViewport', 'uZoom', 'uPitch', 'uZScale', 'uDepthHalf']);
    this.fxVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fxVao);
    this.fxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.fxData.byteLength, gl.DYNAMIC_DRAW);
    const FS = (2 + 2 + 4) * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, FS, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, FS, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FS, 16);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  }

  private makeTexture(gl: GL, canvas: HTMLCanvasElement, size: number): WebGLTexture {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    void size;
    return t;
  }

  private setCam(u: Uniforms): void {
    const c = this.camera;
    const gl = this.gl;
    gl.uniform2f(u.uCam!, c.sx, c.sy);
    gl.uniform2f(u.uRot!, c.cosr, c.sinr);
    gl.uniform2f(u.uViewport!, c.W, c.H);
    gl.uniform1f(u.uZoom!, c.szoom);
    gl.uniform1f(u.uPitch!, 0.70);
    gl.uniform1f(u.uZScale!, ZSCALE);
    if (u.uDepthHalf) gl.uniform1f(u.uDepthHalf!, 9000);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    this.camera.W = w; this.camera.H = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (gl.canvas.width !== cw || gl.canvas.height !== ch) {
      gl.canvas.width = cw; gl.canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
  }

  render(world: World): void {
    const gl = this.gl;
    const c = this.camera;
    gl.clearColor(0.055, 0.06, 0.058, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // ---- ground
    if (!this.debugPasses.ground) { gl.clear(gl.DEPTH_BUFFER_BIT); }
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (this.debugPasses.ground) {
    gl.useProgram(this.groundProg);
    this.setCam(this.groundU);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.groundTex);
    gl.uniform1i(this.groundU.uTex!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.detailTex);
    gl.uniform1i(this.groundU.uDetail!, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.groundVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ---- buildings
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    if (this.debugPasses.buildings) {
    gl.useProgram(this.buildProg);
    this.setCam(this.buildU);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.facade);
    gl.uniform1i(this.buildU.uFacade!, 0);
    gl.bindVertexArray(this.buildVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.buildCount);
    gl.bindVertexArray(null);
    }

    // The tactical layer stays readable without units appearing to stand on
    // rooftops: soldiers are depth-tested against the buildings, and anything
    // that ends up hidden is re-drawn as a translucent x-ray silhouette
    // (depthFunc GREATER draws only the fragments that failed the test).
    this.buildGroundSprites(world);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.groundSprites.prog);
    this.setCam(this.groundSprites.u);
    this.groundSprites.flush();
    this.stats.props = this.propCount;
    this.stats.corpses = world.corpses.length;

    this.buildUnitSprites(world);
    gl.useProgram(this.units.prog);
    this.setCam(this.units.u);
    this.units.flush(this.units.count, 'solid');
    this.units.flush(this.units.count, 'xray');
    this.stats.units = this.units.count;

    this.buildFx(world);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.fxProg);
    this.setCam(this.fxU);
    gl.bindVertexArray(this.fxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
    if (this.fxVertices > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.fxData.subarray(0, this.fxVertices * 8));
      gl.drawArrays(gl.TRIANGLES, 0, this.fxVertices);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this.stats.effects = this.fxVertices / 6;
  }

  private propCount = 0;

  private buildGroundSprites(world: World): void {
    const b = this.groundSprites;
    const g = b.data;
    b.reset(4800);
    const atlas = this.atlas;
    const cols = 5;
    const cellUV = PROP_CELL / PROP_ATLAS;
    const size = PROP_WORLD_SIZE;
    let n = 0;

    // static props ------------------------------------------------------
    const push = (name: string, x: number, y: number, scale: number, r: number, gg: number, bb: number, a: number, bias: number) => {
      const idx = atlas.propIndex[name] ?? 0;
      const col = idx % cols, row = (idx / cols) | 0;
      b.push(x, y, size * scale, col * cellUV, row * cellUV, cellUV, cellUV, r, gg, bb, a, 0, bias);
      n++;
    };

    for (const t of world.city.trees) {
      push(t.kind === 0 ? 'tree_a' : 'tree_b', t.x, t.y, 0.85 + t.r * 0.02, 1, 1, 1, 1, 0);
    }
    for (const bar of world.city.barricades) {
      if (!bar.alive) continue;
      const dmg = bar.hp / bar.maxHp;
      push(bar.kind === 0 ? 'barricade_a' : 'barricade_b', bar.x, bar.y, 0.8, 0.75 + 0.25 * dmg, 0.75 + 0.25 * dmg, 0.75 + 0.25 * dmg, 1, 0);
    }
    const DEBRIS: string[] = ['rubble', 'crater', 'wreck', 'barrel', 'crate', 'blood_a'];
    for (const d of world.city.debris) {
      const name = DEBRIS[d.kind] ?? 'rubble';
      const idx = atlas.propIndex[name] ?? 0;
      const col = idx % cols, row = (idx / cols) | 0;
      const v = 0.86 + (d.kind % 3) * 0.06;
      b.push(d.x, d.y, size * d.scale, col * cellUV, row * cellUV, cellUV, cellUV, v, v, v, 1, 0, 1.4);
      n++;
    }
    this.propCount = n;

    // corpses -----------------------------------------------------------
    const corpses = world.corpses;
    for (let i = 0; i < corpses.length; i++) {
      const c = corpses[i]!;
      const idx = c.cell;
      const col = idx % cols, row = (idx / cols) | 0;
      const du = c.mirror ? -cellUV : cellUV;
      const u0 = c.mirror ? (col + 1) * cellUV : col * cellUV;
      const age = world.state.time - c.t;
      const fade = age > 150 ? Math.max(0.35, 1 - (age - 150) / 240) : 1;
      const dark = age > 90 ? 0.82 : 1;
      b.push(c.x, c.y, size, u0, row * cellUV, du, cellUV, dark, dark, dark, fade, 0, 0.9);
      n++;
    }
    void g;
  }

  private buildUnitSprites(world: World): void {
    const b = this.units;
    b.reset(4200);
    const atlas = this.atlas;
    const cellUV = UNIT_CELL / UNIT_ATLAS;
    const cam = this.camera;

    const humans = world.humans;
    for (let i = 0; i < humans.length; i++) {
      const h = humans[i]!;
      if (!h.alive && h.deadT > 1.1) continue;
      const phi = cam.screenAngle(h.faceX, h.faceY);
      const bucket = dirBucket(phi);
      const base = DIR_TO_BASE[bucket]!;
      const mirror = DIR_MIRROR[bucket]!;
      const frameIdx = animFrameIndex(h.anim.name, h.anim.frame);
      const cell = unitCellIndex(h.typeIndex, base, frameIdx);
      const col = cell % UNIT_COLS, row = (cell / UNIT_COLS) | 0;
      const u0 = mirror ? (col + 1) * cellUV : col * cellUV;
      const du = mirror ? -cellUV : cellUV;
      const heightScale = HUMAN_HEIGHT / 10.4;
      let tint = 1;
      if (h.anim.name === 'hit') tint = 1.25;
      b.push(h.x, h.y, UNIT_SWU * heightScale, u0, row * cellUV, du, cellUV, tint, tint, tint, 1, 6.0, 0);
    }

    const zombies = world.zombies;
    for (let i = 0; i < zombies.length; i++) {
      const z = zombies[i]!;
      if (!z.alive && z.deadT > 1.1) continue;
      const phi = cam.screenAngle(z.faceX, z.faceY);
      const bucket = dirBucket(phi);
      const base = DIR_TO_BASE[bucket]!;
      const mirror = DIR_MIRROR[bucket]!;
      const frameIdx = animFrameIndex(z.anim.name, z.anim.frame);
      const cell = unitCellIndex(z.typeIndex, base, frameIdx);
      const col = cell % UNIT_COLS, row = (cell / UNIT_COLS) | 0;
      const u0 = mirror ? (col + 1) * cellUV : col * cellUV;
      const du = mirror ? -cellUV : cellUV;
      const hs = (z.cls === 'brute' ? BRUTE_HEIGHT : ZOMBIE_HEIGHT) / 10.4;
      let r = 1, g = 1, bl = 1;
      if (z.hitFlash > 0) { r = 1.5; g = 1.15; bl = 1.1; }
      else {
        const v = 0.92 + z.seed * 0.16;
        r = v; g = v; bl = v;
      }
      b.push(z.x, z.y, UNIT_SWU * hs, u0, row * cellUV, du, cellUV, r, g, bl, 1, 5.2, 0.02);
    }
  }

  /** Muzzle flashes, tracers and combat feedback. */
  private buildFx(world: World): void {
    const cam = this.camera;
    let n = 0;
    const d = this.fxData;
    const capQuads = d.length / 48;
    const sizePxBase = UNIT_SWU * cam.szoom;
    const scale = sizePxBase / CELL;

    // tracers + muzzle flashes, derived from the shooter state so the flash
    // always sits exactly on the animated muzzle
    const humans = world.humans;
    for (let i = 0; i < humans.length; i++) {
      const h = humans[i]!;
      if (!h.alive || h.shotT <= 0) continue;
      const phi = cam.screenAngle(h.faceX, h.faceY);
      const bucket = dirBucket(phi);
      const base = DIR_TO_BASE[bucket]!;
      const mirror = DIR_MIRROR[bucket]!;
      const frameIdx = animFrameIndex(h.anim.name, h.anim.frame);
      const mi = ((h.typeIndex * DIR_BASE + base) * TOTAL_FRAMES + frameIdx) * 2;
      let mx = this.atlas.muzzle[mi]!;
      const my = this.atlas.muzzle[mi + 1]!;
      if (mirror) mx = -mx;
      const a = cam.worldToScreen(h.x, h.y);
      const muzzleX = a.x + mx * scale;
      const muzzleY = a.y + my * scale;
      const life = h.cls === 'gunner' ? 0.07 : 0.1;
      const k = clamp01(h.shotT / life);
      if (k > 0.42 && n < capQuads) {
        const size = Math.max(5, Math.min(26, (7 + 6 * k) * Math.max(0.5, cam.szoom * 0.34)));
        n = this.emitQuad(n, h.x, h.y,
          muzzleX - size * 0.5 - a.x, muzzleY - size * 0.5 - a.y, size, size,
          1.0, 0.84 * k + 0.1, 0.46 * k + 0.05, 0.85 * k);
      }
      const tgt = cam.worldToScreen(h.shotX, h.shotY);
      if (n + 6 <= capQuads) {
        const dx = tgt.x - muzzleX, dy = tgt.y - muzzleY;
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * 0.85, ny = dx / l * 0.85;
        const m = (1 - k) * 0.55;
        const x0 = muzzleX + dx * m, y0 = muzzleY + dy * m;
        n = this.emitTri(n, h.x, h.y,
          x0 + nx - a.x, y0 + ny - a.y,
          tgt.x + nx - a.x, tgt.y + ny - a.y,
          tgt.x - nx - a.x, tgt.y - ny - a.y,
          1.0, 0.93, 0.74, 0.55 * k);
        n = this.emitTri(n, h.x, h.y,
          x0 + nx - a.x, y0 + ny - a.y,
          tgt.x - nx - a.x, tgt.y - ny - a.y,
          x0 - nx - a.x, y0 - ny - a.y,
          1.0, 0.93, 0.74, 0.55 * k);
      }
    }

    // entity effects
    const eff = world.effects;
    for (let i = 0; i < eff.length; i++) {
      const e = eff[i]!;
      const a = cam.worldToScreen(e.x, e.y);
      const k = clamp01(e.t / e.max);
      const rad = e.scale * (0.45 + (1 - k) * 1.3) * Math.max(0.4, Math.min(2.4, cam.szoom * 0.42));
      n = this.emitQuad(n, e.x, e.y, -rad * 0.5, -rad * 0.5, rad, rad, e.r, e.g, e.b, e.alpha * k * 0.85);
    }

    this.fxVertices = n;
  }

  private emitQuad(n: number, wxx: number, wyy: number, ox: number, oy: number, w: number, h: number, r: number, g: number, b: number, a: number): number {
    const d = this.fxData;
    if (n + 6 > d.length / 8) return n;
    let o = n * 8;
    const put = (px: number, py: number) => {
      d[o++] = wxx; d[o++] = wyy;
      d[o++] = px; d[o++] = py;
      d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    };
    put(ox, oy); put(ox + w, oy); put(ox + w, oy + h);
    put(ox, oy); put(ox + w, oy + h); put(ox, oy + h);
    return n + 6;
  }

  private emitTri(n: number, wxx: number, wyy: number,
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    r: number, g: number, b: number, a: number): number {
    const d = this.fxData;
    if (n + 3 > d.length / 8) return n;
    let o = n * 8;
    const put = (px: number, py: number) => {
      d[o++] = wxx; d[o++] = wyy;
      d[o++] = px; d[o++] = py;
      d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    };
    put(x0, y0); put(x1, y1); put(x2, y2);
    return n + 3;
  }

  /** Release GPU resources (used when the world is regenerated). */
  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.groundTex);
    gl.deleteTexture(this.facade);
    gl.deleteTexture(this.detailTex);
    gl.deleteProgram(this.groundProg);
    gl.deleteProgram(this.buildProg);
    gl.deleteProgram(this.fxProg);
    gl.deleteBuffer(this.fxBuf);
    gl.deleteBuffer(this.buildBuf);
    gl.deleteBuffer(this.groundBuf);
    gl.deleteVertexArray(this.buildVao);
    gl.deleteVertexArray(this.fxVao);
    gl.deleteVertexArray(this.groundVao);
    for (const b of [this.units, this.groundSprites]) b.dispose();
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export { FX, SPRITE_STRIDE, GROUND_TEX_W, GROUND_TEX_H };
