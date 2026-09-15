// Small WebGL2 helpers.

export type GL = WebGL2RenderingContext;

export function createGL(canvas: HTMLCanvasElement): GL {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: true, depth: true, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  }) as GL | null;
  if (!gl) throw new Error('WebGL2 不可用');
  return gl;
}

export function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`shader ${label}: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

export function program(gl: GL, vs: string, fs: string, label = 'prog'): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, label + '.vs'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, label + '.fs'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link ${label}: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export interface Uniforms { [k: string]: WebGLUniformLocation | null }

export function uniforms(gl: GL, p: WebGLProgram, names: string[]): Uniforms {
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}

/** Shared GLSL chunks: the axonometric camera + depth mapping. */
export const CAMERA_GLSL = `
uniform vec2 uCam;
uniform vec2 uRot;
uniform vec2 uViewport;
uniform float uZoom;
uniform float uPitch;
uniform float uZScale;

vec3 toScreen(vec2 w, float z, float bias) {
  vec2 d = w - uCam;
  float rx = d.x * uRot.x - d.y * uRot.y;
  float ry = d.x * uRot.y + d.y * uRot.x;
  float sx = rx * uZoom + uViewport.x * 0.5;
  float sy = (ry * uPitch - z * uZScale) * uZoom + uViewport.y * 0.5;
  float depth = ry * uPitch + z * uZScale - bias;
  return vec3(sx, sy, depth);
}

vec4 toClip(vec2 w, float z, float bias, float depthHalf) {
  vec3 s = toScreen(w, z, bias);
  float zndc = -clamp(s.z / depthHalf, -1.0, 1.0);
  return vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, zndc, 1.0);
}
`;
