// WebGL2 瀑布图渲染器
// R32F 浮点纹理存每 ping 原始电平(dB)，着色器内做 TVG/增益/杂波抑制/色标
// 纹理列即时间（右进左滚），行即距离门（每门 BIN_M 米）

import { BIN_M, MAX_BINS } from '../core/engine';
import { buildLut, DISPLAY_CEIL, DISPLAY_FLOOR } from '../core/colormaps';
import type { DisplaySettings, PingMeta } from '../core/types';

const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform float uGain;
uniform float uTvgStrength;
uniform int   uTvgMode;
uniform float uAlpha;
uniform float uClutter;
uniform sampler2D uRaw;
uniform sampler2D uLut;
uniform float uFloor;
uniform float uCeil;
uniform float uRangeMax;
uniform int   uBottomLock;
uniform float uLockTop;
uniform float uLockH;
uniform int   uCols;
uniform int   uRows;
uniform int   uCursor;

float log10(float x) { return log(x) / log(10.0); }

float tvgFor(float range) {
  float R = max(range, 0.5);
  if (uTvgMode == 0 || uTvgStrength <= 0.0) return 0.0;
  float logPart = uTvgMode == 1 ? 40.0 * log10(R) : 30.0 * log10(R);
  // 与 CPU tvgDb 一致的 82dB 硬件封顶
  return min(82.0, uTvgStrength * (logPart + 2.0 * uAlpha * R));
}

void main() {
  // 右进左滚：屏幕右侧为最新列
  float age = (1.0 - vUv.x) * float(uCols);
  int col = int(mod(float(uCursor) - age + float(uCols) * 2.0, float(uCols)));
  float u = (float(col) + 0.5) / float(uCols);

  float rowRange;
  if (uBottomLock == 1) {
    rowRange = uLockTop + (1.0 - vUv.y) * uLockH;
  } else {
    rowRange = (1.0 - vUv.y) * uRangeMax;
  }
  float row = rowRange / ${BIN_M.toFixed(4)};
  // 纹理 y=0 在底部且 bin0（浅水）写入 y=0，故 bin row 对应纹理 v=(row+0.5)/rows
  float v = (row + 0.5) / float(uRows);
  float raw = texture(uRaw, vec2(u, v)).r;
  if (raw < -1000.0) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float g = tvgFor(rowRange);
  float shown = raw + g + uGain - uClutter;
  // 噪声基底追踪门限（NBT）：门限 = FLOOR + TVG - 25dB，
  // 纯噪声（shown≈ambient+TVG）低于门限压黑，真实鱼回波（raw≥45）远高于门限始终显色。
  float noiseGate = uFloor + g - 25.0;
  if (shown <= noiseGate) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float val = clamp((shown - uFloor) / (uCeil - uFloor), 0.0, 1.0);
  vec3 rgb = texture(uLut, vec2(val, 0.5)).rgb;
  frag = vec4(rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export interface LockWindow { enabled: boolean; top: number; height: number }

export class WaterfallRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  cols: number;
  rows = MAX_BINS;
  cursor = -1;
  private prog: WebGLProgram;
  private rawTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private alpha = 0;
  private colBuf = new Float32Array(MAX_BINS);

  constructor(canvas: HTMLCanvasElement, cols = 480) {
    this.canvas = canvas;
    this.cols = cols;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of [
      'uGain', 'uTvgStrength', 'uTvgMode', 'uAlpha', 'uClutter', 'uRaw', 'uLut',
      'uFloor', 'uCeil', 'uRangeMax', 'uBottomLock', 'uLockTop', 'uLockH',
      'uCols', 'uRows', 'uCursor',
    ]) this.uni[name] = gl.getUniformLocation(prog, name);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // R32F 浮点纹理（NEAREST，无需 float-linear 扩展）
    this.rawTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, this.rows, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setLut('sonar');
  }

  setLut(key: string): void {
    const gl = this.gl;
    const lut = buildLut(key);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
  }

  setAlpha(alpha: number): void {
    this.alpha = alpha;
  }

  /** 推入一列 ping（raw: dB，-Infinity 写成极小值） */
  pushPing(meta: PingMeta): void {
    const gl = this.gl;
    this.cursor = (this.cursor + 1) % this.cols;
    const src = meta.raw;
    for (let i = 0; i < this.rows; i++) {
      const v = src[i];
      this.colBuf[i] = isFinite(v) ? v : -9999;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.cursor, 0, 1, this.rows, gl.RED, gl.FLOAT, this.colBuf);
  }

  /** 屏幕 x 比例(0..1) -> 已写入的列序号（用于 A 显示联动），-1 表示无数据 */
  screenXToColumn(xFrac: number): number {
    if (this.cursor < 0) return -1;
    const age = Math.floor((1 - xFrac) * this.cols);
    return (this.cursor - age + this.cols * 2) % this.cols;
  }

  clear(): void {
    const gl = this.gl;
    this.cursor = -1;
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    const empty = new Float32Array(this.cols * this.rows).fill(-9999);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.cols, this.rows, 0, gl.RED, gl.FLOAT, empty);
  }

  render(s: DisplaySettings, rangeMax: number, lock: LockWindow): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.uni.uRaw, 0);
    gl.uniform1i(this.uni.uLut, 1);
    gl.uniform1f(this.uni.uGain, s.gainDb);
    gl.uniform1f(this.uni.uTvgStrength, s.tvgStrength);
    gl.uniform1i(this.uni.uTvgMode, s.tvgMode === 'off' ? 0 : s.tvgMode === 'single' ? 1 : 2);
    gl.uniform1f(this.uni.uAlpha, this.alpha);
    gl.uniform1f(this.uni.uClutter, s.clutterDb);
    gl.uniform1f(this.uni.uFloor, DISPLAY_FLOOR);
    gl.uniform1f(this.uni.uCeil, DISPLAY_CEIL);
    gl.uniform1f(this.uni.uRangeMax, rangeMax);
    gl.uniform1i(this.uni.uBottomLock, lock.enabled ? 1 : 0);
    gl.uniform1f(this.uni.uLockTop, lock.top);
    gl.uniform1f(this.uni.uLockH, lock.height);
    gl.uniform1i(this.uni.uCols, this.cols);
    gl.uniform1i(this.uni.uRows, this.rows);
    gl.uniform1i(this.uni.uCursor, Math.max(this.cursor, 0));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
