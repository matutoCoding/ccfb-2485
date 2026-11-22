// 瀑布图 WebGL2 渲染器
// 环形纹理存储每 ping 距离门(右进左出),fragment shader 完成
// 环形展开 -> 底锁/缩放窗口 -> dB 归一 -> 色标 LUT 映射

import { EchoContributor, GainSettings, PingColumn } from '../types';
import { buildColormapLut } from './colormap';
import { createQuadProgram, createTexture2D, makeQuadVao, uniformLocations } from './gl-util';

const VERT_SRC = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_ring;      // 环形回波纹理(编码 dB)
uniform sampler2D u_lut;       // 色标
uniform sampler2D u_bottom;    // 每列海底距离纹理(编码 m)
uniform int u_width;
uniform int u_height;
uniform int u_writePos;        // 最新列写入位置
uniform int u_filled;          // 已填充列数(≤ width)
uniform float u_minDb;
uniform float u_maxDb;
uniform float u_encMin;
uniform float u_encMax;
uniform float u_bottomLock;    // >0 开启底锁,窗口高度 m
uniform float u_zoom;
uniform float u_rangeM;        // 满屏量程 m
uniform float u_binStep;
uniform float u_txDepth;
uniform bool u_showBottomLine;
out vec4 outColor;

float decodeDb(vec4 c) {
  float v = dot(c.rgb, vec3(65536.0, 256.0, 1.0)) / 65535.0;
  return u_encMin + v * (u_encMax - u_encMin);
}

float decodeM(vec4 c) {
  return dot(c.rgb, vec3(65536.0, 256.0, 1.0)) / 65535.0 * 512.0;
}

void main() {
  // 屏幕坐标:uv.x 0=最旧列(左),1=最新列(右);uv.y 0=顶部(浅水)
  float colT = v_uv.x;
  float rowT = 1.0 - v_uv.y;

  // 环形展开:已填充列始终均匀铺满屏幕宽度
  // 最旧列序号 = writePos-filled,最新 = writePos-1
  float f = max(float(u_filled), 1.0);
  float w = float(u_width);
  float seq = min(floor(colT * f), f - 1.0); // 0=最旧 ... filled-1=最新
  float colIndex = mod(float(u_writePos) - f + seq + w, w);
  float ringX = (colIndex + 0.5) / w;

  float rowStart = 0.0;
  float rowSpan = float(u_height);
  if (u_bottomLock > 0.0) {
    float bm = decodeM(texture(u_bottom, vec2(ringX, 0.5)));
    float topM = max(0.0, bm - u_bottomLock);
    rowStart = topM / u_binStep;
    rowSpan = u_bottomLock / u_binStep;
  } else if (u_zoom > 1.0) {
    rowSpan = float(u_height) / u_zoom;
    rowStart = 0.0;
  }
  float srcRowF = rowStart + rowT * rowSpan;
  // 数据行 0(浅水)在纹理 v≈0;屏幕顶部 rowT=0 → srcRowF≈0 → ringY≈0 采到浅水行
  float ringY = clamp((srcRowF + 0.5) / float(u_height), 0.0, 1.0);

  float db = decodeDb(texture(u_ring, vec2(ringX, ringY)));
  float norm = clamp((db - u_minDb) / (u_maxDb - u_minDb), 0.0, 1.0);
  vec3 col = texture(u_lut, vec2(norm, 0.5)).rgb;

  // 底锁模式下叠加海底分界线
  if (u_bottomLock > 0.0 && u_showBottomLine) {
    float bm = decodeM(texture(u_bottom, vec2(ringX, 0.5)));
    float topM = max(0.0, bm - u_bottomLock);
    float depthHere = topM + rowT * u_bottomLock;
    if (abs(depthHere - bm) < u_binStep * 1.5) col = mix(col, vec3(1.0, 0.9, 0.4), 0.55);
  }
  outColor = vec4(col, 1.0);
}`;

export interface PickedEcho {
  column: PingColumn;
  row: number;
  rangeM: number;
  contributors: EchoContributor[];
}

export class WaterfallRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null>;
  private ringTex: WebGLTexture;
  private bottomTex: WebGLTexture;
  private lutTex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  private writePos = 0;
  private filled = 0;
  /** 环形元数据,与纹理列一一对应 */
  private meta: (PingColumn | null)[];
  private currentGain: GainSettings;
  private encMin = -20;
  private encMax = 160;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    initialGain: GainSettings
  ) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    gl.clearColor(0.02, 0.03, 0.06, 1);
    this.width = width;
    this.height = height;
    this.currentGain = initialGain;
    this.meta = new Array(width).fill(null);

    this.program = createQuadProgram(gl, FRAG_SRC);
    this.vao = makeQuadVao(gl);
    this.u = uniformLocations(gl, this.program, [
      'u_ring', 'u_lut', 'u_bottom', 'u_width', 'u_height', 'u_writePos', 'u_filled',
      'u_minDb', 'u_maxDb', 'u_encMin', 'u_encMax', 'u_bottomLock',
      'u_zoom', 'u_rangeM', 'u_binStep', 'u_txDepth', 'u_showBottomLine',
    ]);

    this.ringTex = createTexture2D(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(width * height * 4));
    this.bottomTex = createTexture2D(gl, width, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(width * 4));
    this.lutTex = createTexture2D(gl, 256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, buildColormapLut(initialGain.colormap));
  }

  setColormap(id: string) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, buildColormapLut(id));
  }

  private encodeDb(v: number): [number, number, number] {
    const n = Math.max(0, Math.min(1, (v - this.encMin) / (this.encMax - this.encMin)));
    const q = Math.round(n * 65535);
    return [(q >> 16) & 255, (q >> 8) & 255, q & 255];
  }

  private encodeM(m: number): [number, number, number] {
    const q = Math.round(Math.max(0, Math.min(1, m / 512)) * 65535);
    return [(q >> 16) & 255, (q >> 8) & 255, q & 255];
  }

  /** 追加一列 ping(距离门重采样到固定 height 行) */
  pushColumn(col: PingColumn, gain: GainSettings, rangeM: number) {
    const gl = this.gl;
    const pixels = new Uint8Array(this.height * 4);
    for (let row = 0; row < this.height; row++) {
      const r = ((row + 0.5) / this.height) * rangeM;
      const srcBin = Math.round(r / col.binStep);
      const db = srcBin < col.bins.length ? col.bins[srcBin] : this.encMin;
      const [rr, gg, bb] = this.encodeDb(db);
      pixels[row * 4] = rr;
      pixels[row * 4 + 1] = gg;
      pixels[row * 4 + 2] = bb;
      pixels[row * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.writePos, 0, 1, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const bp = new Uint8Array(4);
    const [br, bg2, bb2] = this.encodeM(col.bottomRange);
    bp[0] = br; bp[1] = bg2; bp[2] = bb2; bp[3] = 255;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bottomTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.writePos, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bp);

    this.meta[this.writePos] = col;
    this.writePos = (this.writePos + 1) % this.width;
    this.filled = Math.min(this.filled + 1, this.width);
    this.currentGain = gain;
  }

  render(opts: { rangeM: number; binStep: number; bottomLockM: number; zoom: number }) {
    const gl = this.gl;
    const g = this.currentGain;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.uniform1i(this.u.u_ring, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.u.u_lut, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bottomTex);
    gl.uniform1i(this.u.u_bottom, 2);

    gl.uniform1i(this.u.u_width, this.width);
    gl.uniform1i(this.u.u_height, this.height);
    gl.uniform1i(this.u.u_writePos, this.writePos);
    gl.uniform1i(this.u.u_filled, this.filled);
    gl.uniform1f(this.u.u_minDb, g.colorMinDb);
    gl.uniform1f(this.u.u_maxDb, g.colorMaxDb);
    gl.uniform1f(this.u.u_encMin, this.encMin);
    gl.uniform1f(this.u.u_encMax, this.encMax);
    gl.uniform1f(this.u.u_bottomLock, opts.bottomLockM);
    gl.uniform1f(this.u.u_zoom, opts.zoom);
    gl.uniform1f(this.u.u_rangeM, opts.rangeM);
    gl.uniform1f(this.u.u_binStep, opts.binStep);
    gl.uniform1f(this.u.u_txDepth, 0.8);
    gl.uniform1i(this.u.u_showBottomLine, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 屏幕坐标 -> 该位置对应的 ping 列与距离行
   * 与 fragment shader 的 seq 映射保持同一套逻辑
   * @param x 画布像素 x,0 在左
   */
  pick(x: number, y: number, rangeM: number, bottomLockM: number): PickedEcho | null {
    if (this.filled === 0) return null;
    const colT = x / this.width;
    const f = Math.max(this.filled, 1);
    const seq = Math.min(Math.floor(colT * f), f - 1);
    const idx = (this.writePos - f + seq + this.width * 2) % this.width;
    const column = this.meta[idx];
    if (!column) return null;
    const rowT = 1 - y / this.height;
    let range: number;
    if (bottomLockM > 0) {
      range = Math.max(0, column.bottomRange - bottomLockM) + rowT * bottomLockM;
    } else {
      range = rowT * rangeM;
    }
    const row = Math.round(range / column.binStep);
    const contributors = row >= 0 && row < column.contributors.length ? column.contributors[row] : [];
    return { column, row, rangeM: range, contributors };
  }

  /** 取最新一列(A 显示默认) */
  latest(): PingColumn | null {
    if (this.filled === 0) return null;
    return this.meta[(this.writePos - 1 + this.width) % this.width];
  }

  clear() {
    this.writePos = 0;
    this.filled = 0;
    this.meta.fill(null);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, this.width, this.height,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(this.width * this.height * 4)
    );
  }
}
