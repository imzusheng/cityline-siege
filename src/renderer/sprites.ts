// Instanced alpha-tested billboard sprites.
//
// Instance layout (13 floats): worldX, worldY, sizeSwu, u0, v0, du, dv,
//                             tintR, tintG, tintB, alpha, minPx, depthBias

import type { GL, Uniforms } from './glutil';
import { program, uniforms, CAMERA_GLSL } from './glutil';

export const SPRITE_STRIDE = 13;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aWorld;
layout(location=2) in float aSize;
layout(location=3) in vec4 aUV;
layout(location=4) in vec4 aTint;
layout(location=5) in vec2 aMisc;
uniform float uDepthHalf;
uniform float uTopRatio;
uniform float uBotRatio;
uniform float uMinPxDefault;
uniform float uAlphaMul;
out vec2 vUV;
out vec4 vTint;
${CAMERA_GLSL}
void main() {
  vec3 s = toScreen(aWorld, 0.0, aMisc.y);
  float sizePx = max(aSize * uZoom, aMisc.x > 0.0 ? aMisc.x : uMinPxDefault);
  float py = s.y - uTopRatio * sizePx + aCorner.y * (uTopRatio + uBotRatio) * sizePx;
  float px = s.x + (aCorner.x - 0.5) * sizePx;
  float zndc = -clamp(s.z / uDepthHalf, -1.0, 1.0);
  gl_Position = vec4(px / uViewport.x * 2.0 - 1.0, 1.0 - py / uViewport.y * 2.0, zndc, 1.0);
  vUV = vec2(aUV.x + aCorner.x * aUV.z, aUV.y + aCorner.y * aUV.w);
  vTint = vec4(aTint.rgb, aTint.a * uAlphaMul);
}
`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in vec4 vTint;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  c.a *= vTint.a;
  if (c.a < 0.02) discard;
  outColor = vec4(c.rgb * vTint.rgb, c.a);
}
`;

export class SpriteBatch {
  private gl: GL;
  prog: WebGLProgram;
  u: Uniforms;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private instBuf: WebGLBuffer;
  private capacity = 0;
  data!: Float32Array;
  count = 0;
  texture: WebGLTexture | null = null;
  topRatio = 0.8125;
  botRatio = 0.1875;
  minPx = 3.2;

  constructor(gl: GL, capacity = 4096) {
    this.gl = gl;
    this.prog = program(gl, VS, FS, 'sprite');
    this.u = uniforms(gl, this.prog, ['uCam', 'uRot', 'uViewport', 'uZoom', 'uPitch', 'uZScale', 'uDepthHalf', 'uTopRatio', 'uBotRatio', 'uMinPxDefault', 'uTex', 'uAlphaMul']);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    this.alloc(capacity);
    const S = SPRITE_STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 8); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 12); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, S, 28); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 2, gl.FLOAT, false, S, 44); gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);
  }

  private alloc(cap: number): void {
    const gl = this.gl;
    this.capacity = cap;
    this.data = new Float32Array(cap * SPRITE_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }

  reset(minCapacity = 0): void {
    this.count = 0;
    if (this.capacity < minCapacity) this.alloc(Math.ceil(minCapacity * 1.3));
  }

  push(wx: number, wy: number, sizeSwu: number, u0: number, v0: number, du: number, dv: number,
       r: number, g: number, b: number, a: number, minPx = 0, bias = 0): void {
    if (this.count >= this.capacity) {
      const next = new Float32Array(this.capacity * 2 * SPRITE_STRIDE);
      next.set(this.data);
      this.data = next;
      this.capacity *= 2;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instBuf);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data.byteLength, this.gl.DYNAMIC_DRAW);
    }
    const o = this.count * SPRITE_STRIDE;
    const d = this.data;
    d[o] = wx; d[o + 1] = wy; d[o + 2] = sizeSwu;
    d[o + 3] = u0; d[o + 4] = v0; d[o + 5] = du; d[o + 6] = dv;
    d[o + 7] = r; d[o + 8] = g; d[o + 9] = b; d[o + 10] = a;
    d[o + 11] = minPx; d[o + 12] = bias;
    this.count++;
  }

  /** Upload and draw.
   *  mode "solid" writes depth normally; "xray" draws only the fragments that
   *  FAILED the depth test, i.e. the units hidden behind a building, as a
   *  translucent silhouette. */
  flush(count = this.count, mode: 'solid' | 'xray' = 'solid'): void {
    if (count <= 0 || !this.texture) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, count * SPRITE_STRIDE));
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.u.uTex!, 0);
    gl.uniform1f(this.u.uDepthHalf!, 9000);
    gl.uniform1f(this.u.uTopRatio!, this.topRatio);
    gl.uniform1f(this.u.uBotRatio!, this.botRatio);
    gl.uniform1f(this.u.uMinPxDefault!, this.minPx);
    if (mode === 'xray') {
      gl.uniform1f(this.u.uAlphaMul!, 0.42);
      gl.depthFunc(gl.GREATER);
      gl.depthMask(false);
    } else {
      gl.uniform1f(this.u.uAlphaMul!, 1.0);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
  }

  upload(count = this.count): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, count * SPRITE_STRIDE));
  }
}
