// 极简 WebGL2 三维引擎：mat4 数学、轨道相机、基础网格与着色器
// 坐标约定：x 东、z 南、y 向下为深度（相机在水面上方俯视）

export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function mat4LookAt(eye: number[], center: number[], up: number[]): Mat4 {
  const z = norm3(sub3(eye, center));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = mat4Identity();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -dot3(x, eye); m[13] = -dot3(y, eye); m[14] = -dot3(z, eye);
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function sub3(a: number[], b: number[]): number[] { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot3(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export class OrbitCamera {
  target = [300, 30, 250];
  yaw = Math.PI * 0.25;
  pitch = 0.62;       // 俯视角
  dist = 520;
  fov = Math.PI / 4;

  eye(): number[] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] - this.dist * Math.sin(this.pitch),
      this.target[2] + this.dist * cp * Math.cos(this.yaw),
    ];
  }
  view(): Mat4 {
    return mat4LookAt(this.eye(), this.target, [0, -1, 0]);
  }
  proj(aspect: number): Mat4 {
    return mat4Perspective(this.fov, aspect, 1, 4000);
  }
  attach(canvas: HTMLCanvasElement): () => void {
    let dragging = false; let lx = 0; let ly = 0;
    const down = (e: PointerEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); };
    const up = () => { dragging = false; };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      this.yaw -= (e.clientX - lx) * 0.006;
      this.pitch = Math.min(1.45, Math.max(0.12, this.pitch - (e.clientY - ly) * 0.005));
      lx = e.clientX; ly = e.clientY;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.dist = Math.min(1400, Math.max(80, this.dist * (1 + Math.sign(e.deltaY) * 0.09)));
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('wheel', wheel);
    };
  }
}

const MESH_VERT = /* glsl */ `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uVP;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const MESH_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uAlpha;
out vec4 frag;
void main() { frag = vec4(vColor, uAlpha); }`;

export interface MeshData {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  alpha?: number;
  mode?: number; // gl.LINES 等
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? '着色器编译失败');
  return sh;
}

export class GLEngine {
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private meshes: { mesh: MeshData; vbo: WebGLBuffer; cbo: WebGLBuffer; ibo: WebGLBuffer; vao: WebGLVertexArrayObject }[] = [];
  private uVP: WebGLUniformLocation | null;
  private uAlpha: WebGLUniformLocation | null;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, MESH_VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, MESH_FRAG));
    gl.linkProgram(p);
    this.prog = p;
    this.uVP = gl.getUniformLocation(p, 'uVP');
    this.uAlpha = gl.getUniformLocation(p, 'uAlpha');
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  upload(mesh: MeshData): void {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const cbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    this.meshes.push({ mesh, vbo, cbo, ibo, vao });
  }

  replace(mesh: MeshData): void {
    const gl = this.gl;
    const rec = this.meshes.find((m) => m.mesh === mesh);
    if (!rec) return this.upload(mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.cbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rec.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
  }

  clearMeshes(): void {
    const gl = this.gl;
    for (const m of this.meshes) {
      gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.cbo); gl.deleteBuffer(m.ibo); gl.deleteVertexArray(m.vao);
    }
    this.meshes = [];
  }

  render(cam: OrbitCamera): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.04, 0.07, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = mat4Multiply(cam.proj(w / h), cam.view());
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uVP, false, vp);
    for (const rec of this.meshes) {
      gl.bindVertexArray(rec.vao);
      gl.uniform1f(this.uAlpha, rec.mesh.alpha ?? 1);
      gl.drawElements(rec.mesh.mode ?? gl.TRIANGLES, rec.mesh.indices.length, gl.UNSIGNED_INT, 0);
    }
  }
}

// ---------- 网格构造工具 ----------

export function seabedMesh(
  area: { width: number; length: number; nx: number; nz: number; depth: Float32Array; substrate: Uint8Array },
): MeshData {
  const { nx, nz } = area;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const palette = [
    [0.36, 0.30, 0.20], // 泥
    [0.45, 0.42, 0.26], // 沙
    [0.42, 0.44, 0.50], // 礁
  ];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      positions[i * 3] = (ix / (nx - 1)) * area.width;
      positions[i * 3 + 1] = area.depth[i];
      positions[i * 3 + 2] = (iz / (nz - 1)) * area.length;
      const c = palette[area.substrate[i]];
      const shade = 0.85 + 0.3 * (area.depth[i] / 90);
      colors[i * 3] = c[0] * shade; colors[i * 3 + 1] = c[1] * shade; colors[i * 3 + 2] = c[2] * shade;
    }
  }
  const indices: number[] = [];
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, colors, indices: new Uint32Array(indices) };
}

/** 声束圆锥（半透明壳 + 底边圆），apex 在换能器，轴向 +y（向下） */
export function coneMesh(
  x: number, z: number, depth: number, halfAngle: number,
  rgb: [number, number, number], segments = 40,
): MeshData {
  const r = depth * Math.tan(halfAngle);
  const positions: number[] = [x, 0.5, z];
  const colors: number[] = [rgb[0], rgb[1], rgb[2]];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(x + r * Math.cos(a), depth, z + r * Math.sin(a));
    colors.push(rgb[0], rgb[1], rgb[2]);
  }
  const indices: number[] = [];
  for (let i = 1; i <= segments; i++) indices.push(0, i, i + 1);
  return {
    positions: new Float32Array(positions), colors: new Float32Array(colors),
    indices: new Uint32Array(indices), alpha: 0.14,
  };
}

export function coneRimMesh(
  x: number, z: number, depth: number, halfAngle: number,
  rgb: [number, number, number], segments = 48,
): MeshData {
  const r = depth * Math.tan(halfAngle);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(x + r * Math.cos(a), depth, z + r * Math.sin(a));
    colors.push(rgb[0], rgb[1], rgb[2]);
    if (i < segments) indices.push(i, i + 1);
  }
  return {
    positions: new Float32Array(positions), colors: new Float32Array(colors),
    indices: new Uint32Array(indices), alpha: 0.9, mode: 2, // LINES
  };
}

export function pointsMesh(points: { x: number; y: number; z: number; color: [number, number, number]; size?: number }[]): MeshData {
  // 点用十字短线段（LINES）替代，保证在任意距离可见
  const linePos: number[] = []; const lineCol: number[] = []; const lineIdx: number[] = [];
  const s = 1.6;
  points.forEach((p) => {
    const base = linePos.length / 3;
    linePos.push(p.x - s, p.y, p.z, p.x + s, p.y, p.z, p.x, p.y - s, p.z, p.x, p.y + s, p.z);
    for (let k = 0; k < 4; k++) lineCol.push(p.color[0], p.color[1], p.color[2]);
    lineIdx.push(base, base + 1, base + 2, base + 3);
  });
  return {
    positions: new Float32Array(linePos), colors: new Float32Array(lineCol),
    indices: new Uint32Array(lineIdx), mode: 2, alpha: 1,
  };
}

export function polylineMesh(points: { x: number; y: number; z: number }[], rgb: [number, number, number], alpha = 1): MeshData {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  points.forEach((p, i) => {
    positions.push(p.x, p.y, p.z);
    colors.push(rgb[0], rgb[1], rgb[2]);
    if (i < points.length - 1) indices.push(i, i + 1);
  });
  return {
    positions: new Float32Array(positions), colors: new Float32Array(colors),
    indices: new Uint32Array(indices), mode: 2, alpha,
  };
}

export function boatMesh(x: number, z: number, heading: number): MeshData {
  // 小三角船标（水面 y=0.3），heading: 0 朝 +z
  const s = 5;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const rx = Math.cos(heading), rz = -Math.sin(heading);
  const verts = [
    [fx * s * 1.4, fz * s * 1.4],
    [-fx * s + rx * s * 0.7, -fz * s + rz * s * 0.7],
    [-fx * s - rx * s * 0.7, -fz * s - rz * s * 0.7],
  ];
  const positions = new Float32Array([
    x + verts[0][0], 0.4, z + verts[0][1],
    x + verts[1][0], 0.4, z + verts[1][1],
    x + verts[2][0], 0.4, z + verts[2][1],
  ]);
  const colors = new Float32Array([
    0.95, 0.85, 0.4, 0.95, 0.85, 0.4, 0.95, 0.85, 0.4,
  ]);
  return { positions, colors, indices: new Uint32Array([0, 1, 2]), alpha: 1 };
}
