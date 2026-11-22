// 三维场景:海底网格 / 声束圆锥 / 鱼群实例 / 航线 / 船位
// 纯 WebGL2 手写 shader,简易轨道相机,支持反查定位

import { FishInstance, SeaArea, Transducer, Voyage } from '../types';
import { deg2rad } from '../core/math-util';
import { SUBSTRATES, depthAt } from '../core/seabed';
import { compileShader, createProgram } from './gl-util';

const VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_color;
uniform mat4 u_vp;
uniform vec3 u_offset;
out vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_vp * vec4(a_pos + u_offset, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_color;
uniform float u_alpha;
out vec4 outColor;
void main() { outColor = vec4(v_color, u_alpha); }`;

// 实例化渲染(鱼)
const INST_VS = `#version 300 es
layout(location=0) in vec3 a_offset;
layout(location=1) in vec3 a_color;
layout(location=2) in float a_scale;
uniform mat4 u_vp;
uniform vec3 u_camRight;
out vec3 v_color;
void main() {
  // 始终面向相机的小十字片
  vec3 world = a_offset;
  v_color = a_color;
  gl_Position = u_vp * vec4(world, 1.0);
  gl_PointSize = a_scale;
}`;

const INST_FS = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  outColor = vec4(v_color, 1.0 - r * 0.8);
}`;

export interface CameraPose {
  yaw: number;
  pitch: number;
  dist: number;
  target: [number, number, number];
}

export interface HighlightTarget {
  x: number;
  y: number;
  z: number;
  label: string;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export class View3D {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private instProg: WebGLProgram;
  private uAlpha: WebGLUniformLocation | null;
  private uVp: WebGLUniformLocation | null;
  private uOffset: WebGLUniformLocation | null;
  private instVp: WebGLUniformLocation | null;
  private meshVao: WebGLVertexArrayObject;
  private meshCount = 0;
  private coneVaos: { vao: WebGLVertexArrayObject; count: number; color: number[] }[] = [];
  private coneOffset: [number, number, number] = [0, 0, 0];
  private fishVao: WebGLVertexArrayObject;
  private fishCount = 0;
  private routeVao: WebGLVertexArrayObject | null = null;
  private routeCount = 0;
  private boatVao: WebGLVertexArrayObject | null = null;
  camera: CameraPose = { yaw: -0.7, pitch: 0.62, dist: 420, target: [400, 300, 30] };
  highlight: HighlightTarget | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private area: SeaArea;

  constructor(canvas: HTMLCanvasElement, area: SeaArea) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.area = area;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.03, 0.06, 0.11, 1);

    this.prog = createProgram(gl, VS, FS);
    this.uAlpha = gl.getUniformLocation(this.prog, 'u_alpha');
    this.uVp = gl.getUniformLocation(this.prog, 'u_vp');
    this.uOffset = gl.getUniformLocation(this.prog, 'u_offset');
    this.instProg = createProgram(gl, INST_VS, INST_FS);
    this.instVp = gl.getUniformLocation(this.instProg, 'u_vp');

    this.meshVao = this.buildSeabedMesh(area);
    this.fishVao = this.emptyVao(3, 3, 1);
    this.attachControls(canvas);
  }

  private emptyVao(...locs: number[]): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    for (const loc of locs) {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, loc === 2 ? 1 : 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private buildSeabedMesh(area: SeaArea): WebGLVertexArrayObject {
    const gl = this.gl;
    const verts: number[] = [];
    const pushTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number], sub: keyof typeof SUBSTRATES) => {
      const col = SUBSTRATES[sub].color;
      for (const p of [a, b, c]) verts.push(p[0], p[1], p[2], col[0], col[1], col[2]);
    };
    for (let r = 0; r < area.rows - 1; r++) {
      for (let c = 0; c < area.cols - 1; c++) {
        const x0 = c * area.cellSize;
        const x1 = (c + 1) * area.cellSize;
        const y0 = r * area.cellSize;
        const y1 = (r + 1) * area.cellSize;
        const i = (rr: number, cc: number) => rr * area.cols + cc;
        const p00: [number, number, number] = [x0, y0, area.cells[i(r, c)].depth];
        const p10: [number, number, number] = [x1, y0, area.cells[i(r, c + 1)].depth];
        const p01: [number, number, number] = [x0, y1, area.cells[i(r + 1, c)].depth];
        const p11: [number, number, number] = [x1, y1, area.cells[i(r + 1, c + 1)].depth];
        const sub = area.cells[i(r, c)].substrate;
        pushTri(p00, p10, p11, sub);
        pushTri(p00, p11, p01, sub);
      }
    }
    this.meshCount = verts.length / 6;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * 更新声束圆锥:几何形状只取决于换能器波束角,以原点为锥顶静态构建;
   * 船移动时仅更新平移 uniform,不重建 GPU 缓冲
   */
  updateCones(transducers: Transducer[], boatX: number, boatY: number, _boatDepth: number) {
    const gl = this.gl;
    this.coneOffset = [boatX, boatY, 0];
    // 几何未变(同一批换能器、同一海区量程)时直接复用
    const sig = transducers.map((t) => `${t.id}:${t.beamAngleDeg}`).join('|');
    if (sig === this.coneSig) return;
    this.coneSig = sig;

    for (const c of this.coneVaos) gl.deleteVertexArray(c.vao);
    this.coneVaos = [];
    for (const t of transducers) {
      const range = Math.max(...this.area.cells.map((c) => c.depth)) + 10;
      const rad = range * Math.tan(deg2rad(t.beamAngleDeg / 2));
      const seg = 28;
      const verts: number[] = [];
      const tip: [number, number, number] = [0, 0, 0.8];
      const rimPts: [number, number, number][] = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        rimPts.push([rad * Math.cos(a), rad * Math.sin(a), range]);
      }
      const col = hexToRgb01(t.color);
      for (let i = 0; i < seg; i++) {
        for (const p of [tip, rimPts[i], rimPts[i + 1]]) {
          verts.push(...p, ...col);
        }
      }
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.coneVaos.push({ vao, count: seg * 3, color: col });
    }
  }
  private coneSig = '';

  updateFish(fish: FishInstance[], speciesColor: Map<string, [number, number, number]>) {
    const gl = this.gl;
    const offsets: number[] = [];
    const colors: number[] = [];
    const scales: number[] = [];
    for (const f of fish) {
      const col = speciesColor.get(f.speciesId) ?? [1, 1, 1];
      offsets.push(f.x, f.y, f.z);
      colors.push(...col);
      scales.push(5);
    }
    this.fishCount = fish.length;
    gl.bindVertexArray(this.fishVao);
    const setup = (loc: number, components: number, values: number[]) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, components, gl.FLOAT, false, 0, 0);
    };
    setup(0, 3, offsets);
    setup(1, 3, colors);
    setup(2, 1, scales);
    gl.bindVertexArray(null);
  }

  updateRoute(voyage: Voyage) {
    const gl = this.gl;
    if (this.routeVao) gl.deleteVertexArray(this.routeVao);
    const verts: number[] = [];
    const col: [number, number, number] = [0.4, 0.85, 1];
    for (const p of voyage.route) verts.push(p.x, p.y, 1.2, ...col);
    this.routeCount = voyage.route.length;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.routeVao = vao;
  }

  updateBoat(x: number, y: number) {
    const gl = this.gl;
    if (this.boatVao) gl.deleteVertexArray(this.boatVao);
    const s = 10;
    const col: [number, number, number] = [1, 0.95, 0.5];
    const verts: number[] = [
      x, y - s, 1.5, ...col,
      x + s * 0.7, y + s, 1.5, ...col,
      x - s * 0.7, y + s, 1.5, ...col,
    ];
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.boatVao = vao;
  }

  /** 相机聚焦到反查目标 */
  focusOn(t: HighlightTarget) {
    this.highlight = t;
    this.camera.target = [t.x, t.y, Math.min(80, t.z + 10)];
    this.camera.dist = 180;
  }

  private attachControls(canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.camera.yaw -= dx * 0.006;
      this.camera.pitch = Math.max(0.15, Math.min(1.35, this.camera.pitch + dy * 0.005));
    });
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.dist = Math.max(60, Math.min(1200, this.camera.dist * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }

  private vpMatrix(aspect: number): Float32Array {
    const { yaw, pitch, dist, target } = this.camera;
    const eye: number[] = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.cos(pitch) * Math.cos(yaw),
      target[2] + dist * Math.sin(pitch),
    ];
    const view = mat4LookAt(eye, target, [0, 0, 1]);
    const proj = mat4Perspective(Math.PI / 4, aspect, 1, 4000);
    return mul4(proj, view);
  }

  render(canvas: HTMLCanvasElement) {
    const gl = this.gl;
    const aspect = canvas.width / canvas.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.vpMatrix(aspect);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uVp, false, vp);
    // 海底/航线/船均为绝对坐标,无平移
    gl.uniform3f(this.uOffset, 0, 0, 0);

    // 海底
    gl.uniform1f(this.uAlpha, 1);
    gl.bindVertexArray(this.meshVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.meshCount);

    // 航线
    if (this.routeVao) {
      gl.uniform1f(this.uAlpha, 0.9);
      gl.bindVertexArray(this.routeVao);
      gl.drawArrays(gl.LINE_STRIP, 0, this.routeCount);
    }
    // 船
    if (this.boatVao) {
      gl.uniform1f(this.uAlpha, 1);
      gl.bindVertexArray(this.boatVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // 声束锥(半透明,以原点建模,用 uniform 平移到船位)
    gl.depthMask(false);
    gl.uniform3f(this.uOffset, this.coneOffset[0], this.coneOffset[1], this.coneOffset[2]);
    for (const cone of this.coneVaos) {
      gl.uniform1f(this.uAlpha, 0.13);
      gl.bindVertexArray(cone.vao);
      gl.drawArrays(gl.TRIANGLES, 0, cone.count);
    }
    gl.depthMask(true);
    gl.uniform3f(this.uOffset, 0, 0, 0);

    // 鱼群点精灵
    if (this.fishCount > 0) {
      gl.useProgram(this.instProg);
      gl.uniformMatrix4fv(this.instVp, false, vp);
      gl.bindVertexArray(this.fishVao);
      gl.drawArrays(gl.POINTS, 0, this.fishCount);
    }
    gl.bindVertexArray(null);
  }
}

function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
