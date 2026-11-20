// 色标与显示端映射：原始电平 dB -> 色阶 0..1
// 同一份纯函数在 CPU（自检/A显示）与 GLSL（瀑布图着色器）中保持一致

import type { DisplaySettings } from './types';
import { clamp } from './physics';

/**
 * 显示电平窗口（dB，仿真内部相对电平体系）。
 * 下沿 50dB：平静海环境噪声（默认 18dB）即便经满 TVG 抬升后仍贴近下沿，呈暗色颗粒；
 * 上沿 100dB：礁石强底回波接近顶部，单鱼 TVG 后居中段（约 75–95dB）。
 */
export const DISPLAY_FLOOR = 50;
export const DISPLAY_CEIL = 100;

export interface ColorStop { t: number; rgb: [number, number, number] }

export const COLORMAPS: Record<string, { name: string; stops: ColorStop[] }> = {
  sonar: {
    name: '探鱼器经典',
    stops: [
      { t: 0.00, rgb: [6, 8, 18] },
      { t: 0.18, rgb: [20, 28, 74] },
      { t: 0.38, rgb: [28, 88, 150] },
      { t: 0.55, rgb: [40, 170, 150] },
      { t: 0.72, rgb: [180, 210, 70] },
      { t: 0.86, rgb: [240, 160, 45] },
      { t: 1.00, rgb: [255, 240, 210] },
    ],
  },
  blue: {
    name: '蓝灰海图',
    stops: [
      { t: 0, rgb: [4, 8, 16] },
      { t: 0.3, rgb: [18, 48, 92] },
      { t: 0.6, rgb: [60, 130, 190] },
      { t: 0.85, rgb: [160, 210, 235] },
      { t: 1, rgb: [240, 250, 255] },
    ],
  },
  thermal: {
    name: '热力黑白',
    stops: [
      { t: 0, rgb: [0, 0, 0] },
      { t: 0.4, rgb: [90, 0, 0] },
      { t: 0.7, rgb: [220, 60, 0] },
      { t: 0.9, rgb: [255, 200, 60] },
      { t: 1, rgb: [255, 255, 235] },
    ],
  },
  gray: {
    name: '灰度',
    stops: [
      { t: 0, rgb: [0, 0, 0] },
      { t: 1, rgb: [235, 235, 235] },
    ],
  },
};

export function buildLut(key: string, size = 256): Uint8ClampedArray {
  const cm = COLORMAPS[key] ?? COLORMAPS.sonar;
  const lut = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let a = cm.stops[0], b = cm.stops[cm.stops.length - 1];
    for (let s = 0; s < cm.stops.length - 1; s++) {
      if (t >= cm.stops[s].t && t <= cm.stops[s + 1].t) { a = cm.stops[s]; b = cm.stops[s + 1]; break; }
    }
    const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    lut[i * 3] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k;
    lut[i * 3 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k;
    lut[i * 3 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k;
  }
  return lut;
}

/**
 * 显示映射（CPU 版，自检与 A 显示共用），与瀑布图着色器严格一致。
 * 噪声基底追踪门限 NBT：gate = FLOOR + TVG - 25dB。
 * 环境噪声 shown≈ambient+TVG 低于门限被压黑；真实鱼回波（raw≥45）远高于门限始终显色。
 */
export function displayLevel(rawDb: number, tvg: number, s: DisplaySettings): number {
  if (!isFinite(rawDb)) return 0;
  const shown = rawDb + tvg + s.gainDb - s.clutterDb;
  const noiseGate = DISPLAY_FLOOR + tvg - 25;
  if (shown <= noiseGate) return 0;
  return clamp((shown - DISPLAY_FLOOR) / (DISPLAY_CEIL - DISPLAY_FLOOR), 0, 1);
}

/** 量化到 LUT 色阶索引（0..255），用于"同色阶"自检 */
export function colorIndex(rawDb: number, tvg: number, s: DisplaySettings): number {
  return Math.round(displayLevel(rawDb, tvg, s) * 255);
}

/** GLSL 片段：与 displayLevel 完全一致的映射 + LUT 采样 */
export const DISPLAY_GLSL = /* glsl */ `
uniform float uGain;
uniform float uTvgStrength;
uniform int   uTvgMode;   // 0 off 1 single 2 school
uniform float uAlpha;
uniform float uClutter;
uniform sampler2D uRaw;   // R32F 原始电平
uniform sampler2D uLut;
uniform float uFloor;
uniform float uCeil;
uniform float uRangeMax;  // 瀑布图纵轴最大量程 m
uniform float uBinM;
uniform int   uBottomLock;
uniform float uLockTop;   // 底锁起始深度 m
uniform float uLockH;

float tvgFor(float range) {
  float R = max(range, 0.5);
  if (uTvgMode == 0 || uTvgStrength <= 0.0) return 0.0;
  float logPart = uTvgMode == 1 ? 40.0 * log10(R) : 30.0 * log10(R);
  return min(82.0, uTvgStrength * (logPart + 2.0 * uAlpha * R));
}

vec3 applyDisplay(vec2 uv) {
  float raw = texture(uRaw, uv).r;
  float rowRange;
  if (uBottomLock == 1) {
    rowRange = uLockTop + (1.0 - uv.y) * uLockH;
  } else {
    rowRange = (1.0 - uv.y) * uRangeMax;
  }
  float g = tvgFor(rowRange);
  if (raw < -1000.0) return vec3(0.0);
  float v = raw + g + uGain - uClutter;
  v = (v - uFloor) / (uCeil - uFloor);
  v = clamp(v, 0.0, 1.0);
  return texture(uLut, vec2(v, 0.5)).rgb;
}
`;
