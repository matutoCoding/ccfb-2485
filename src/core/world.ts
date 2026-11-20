// 世界模型：海区网格查询、鱼群实例化（昼夜迁移）、声束命中与地形遮挡

import type { FishSchool, FishSpecies, SeaArea, Vec3 } from './types';
import { clamp, lerp, randn, rng } from './physics';

export const SUBSTRATE_ID: Record<string, number> = { mud: 0, sand: 1, rock: 2 };
export const SUBSTRATE_NAME = ['泥底', '沙底', '礁石'];
export const SUBSTRATE_KEY = ['mud', 'sand', 'rock'] as const;

/** 底质声学参数：反向散射强度(dB)、粗糙度（造成底回波展宽）、二次回波衰减 */
export const SUBSTRATE_ACOUSTIC = [
  { backscatter: -40, roughness: 0.35, secondEchoGain: -16 }, // 泥：弱、软
  { backscatter: -32, roughness: 0.18, secondEchoGain: -10 }, // 沙：中
  { backscatter: -22, roughness: 0.08, secondEchoGain: -5  }, // 礁：强、硬
] as const;

export function gridIndex(area: SeaArea, ix: number, iz: number): number {
  return iz * area.nx + ix;
}

/** 双线性插值水深（米，y 向下为正） */
export function depthAt(area: SeaArea, x: number, z: number): number {
  const fx = clamp(x / area.width * (area.nx - 1), 0, area.nx - 1.0001);
  const fz = clamp(z / area.length * (area.nz - 1), 0, area.nz - 1.0001);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const d = area.depth;
  const d00 = d[gridIndex(area, ix, iz)];
  const d10 = d[gridIndex(area, ix + 1, iz)];
  const d01 = d[gridIndex(area, ix, iz + 1)];
  const d11 = d[gridIndex(area, ix + 1, iz + 1)];
  return lerp(lerp(d00, d10, tx), lerp(d01, d11, tx), tz);
}

/** 最近格底质 */
export function substrateAt(area: SeaArea, x: number, z: number): number {
  const ix = clamp(Math.round(x / area.width * (area.nx - 1)), 0, area.nx - 1);
  const iz = clamp(Math.round(z / area.length * (area.nz - 1)), 0, area.nz - 1);
  return area.substrate[gridIndex(area, ix, iz)];
}

/** 海底坡度（弧度，估计值） */
export function slopeAt(area: SeaArea, x: number, z: number): number {
  const e = Math.max(area.width / area.nx, 2);
  const dx = (depthAt(area, x + e, z) - depthAt(area, x - e, z)) / (2 * e);
  const dz = (depthAt(area, x, z + e) - depthAt(area, x, z - e)) / (2 * e);
  return Math.atan(Math.hypot(dx, dz));
}

/** 昼夜因子：0=午夜，1=正午，6 点日出 18 点日落，余弦平滑 */
export function solarFactor(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const v = 0.5 - 0.5 * Math.cos(((h - 6) / 12) * Math.PI); // 6点0，12点1，18点0
  return clamp(v, 0, 1);
}

export interface FishInstance {
  x: number; y: number; z: number;
  lengthCm: number;
  schoolId: string;
  index: number;
}

/** 实例化一个鱼群（给定仿真小时，含昼夜垂直迁移），结果确定性 */
export function instantiateSchool(
  area: SeaArea, school: FishSchool, hour: number,
  lenRange: { minLen: number; maxLen: number },
  out: FishInstance[] = [],
): FishInstance[] {
  const r = rng(school.seed);
  const n = school.count;
  if (!school.lengths || school.lengths.length !== n) {
    const lengths = new Float32Array(n);
    const offsets = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // 体长：种属范围内正态分布
      const mid = (lenRange.minLen + lenRange.maxLen) / 2;
      const sd = (lenRange.maxLen - lenRange.minLen) / 5;
      lengths[i] = clamp(mid + randn(r) * sd, lenRange.minLen, lenRange.maxLen);
      // 形状相关的归一化偏移
      let ox = 0, oy = 0, oz = 0;
      if (school.shape === 'ball') {
        // 球内均匀
        const u = r(), v = r();
        const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
        const rad = Math.cbrt(r());
        ox = rad * Math.sin(phi) * Math.cos(theta);
        oy = rad * Math.cos(phi);
        oz = rad * Math.sin(phi) * Math.sin(theta);
      } else if (school.shape === 'layer') {
        ox = randn(r) * 0.8; oy = randn(r) * 0.25; oz = randn(r) * 0.8;
      } else { // streak 长条
        ox = randn(r) * 0.9; oy = randn(r) * 0.2; oz = randn(r) * 0.45;
      }
      offsets[i * 3] = ox; offsets[i * 3 + 1] = oy; offsets[i * 3 + 2] = oz;
    }
    school.lengths = lengths;
    school.offsets = offsets;
  }
  const localDepth = depthAt(area, school.center.x, school.center.z);
  const day = solarFactor(hour);
  const frac = lerp(school.nightDepthFrac, school.dayDepthFrac, day);
  const centerY = clamp(frac * localDepth, 2, Math.max(2, localDepth - 1));
  for (let i = 0; i < n; i++) {
    const ox = school.offsets![i * 3], oy = school.offsets![i * 3 + 1], oz = school.offsets![i * 3 + 2];
    const x = school.center.x + ox * school.radiusX;
    const z = school.center.z + oz * school.radiusZ;
    const y = clamp(centerY + oy * school.radiusY, 0.8, depthAt(area, x, z) - 0.3);
    out.push({
      x, y, z,
      lengthCm: school.lengths![i],
      schoolId: school.id,
      index: i,
    });
  }
  return out;
}

export function instantiateWorld(
  area: SeaArea, schools: FishSchool[], species: FishSpecies[], hour: number,
): FishInstance[] {
  const map = new Map(species.map((s) => [s.id, s]));
  const out: FishInstance[] = [];
  for (const sc of schools) {
    const sp = map.get(sc.speciesId);
    if (!sp) continue;
    instantiateSchool(area, sc, hour, { minLen: sp.minLength, maxLen: sp.maxLength }, out);
  }
  return out;
}

export interface ConeHit {
  fish: FishInstance;
  range: number;
  thetaOff: number; // 偏离垂直轴角度 rad
  horizontal: number;
}

/**
 * 声束圆锥内的鱼目标查询。
 * cutoffFactor：超过该倍数半角的目标视为波束外（高斯旁瓣截断）。
 */
export function queryCone(
  fish: FishInstance[], boat: Vec3, halfAngleRad: number, cutoffFactor = 2.5,
): ConeHit[] {
  const hits: ConeHit[] = [];
  const cutoff = halfAngleRad * cutoffFactor;
  for (const f of fish) {
    const dx = f.x - boat.x, dz = f.z - boat.z;
    const dh = Math.hypot(dx, dz);
    const theta = Math.atan2(dh, f.y - boat.y);
    if (theta <= cutoff) {
      hits.push({ fish: f, range: Math.hypot(dh, f.y - boat.y), thetaOff: theta, horizontal: dh });
    }
  }
  return hits;
}

/**
 * 地形遮挡：换能器到目标的声线是否被海底（斜坡/礁石）挡住。
 * 沿声线按水平步长采样，任一点声线深度 >= 海底深度即遮挡（波束盲区）。
 */
export function isOccluded(
  area: SeaArea, boat: Vec3, target: Vec3, stepM = 1.5,
): boolean {
  const dx = target.x - boat.x, dz = target.z - boat.z;
  const dy = target.y - boat.y;
  const dh = Math.hypot(dx, dz);
  if (dh < 1e-6) return false;
  const steps = Math.max(2, Math.ceil(dh / stepM));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = boat.x + dx * t, z = boat.z + dz * t;
    const rayY = boat.y + dy * t;
    if (rayY >= depthAt(area, x, z) - 0.15) return true;
  }
  return false;
}

/**
 * 声线与海底求交（用于底回波射线采样）。
 * 从船沿 (yaw, thetaOff) 方向步进，找到第一个声线深度 >= 海床的位置，返回斜距与坐标。
 */
export function rayBottom(
  area: SeaArea, boat: Vec3, thetaOff: number, yaw: number, maxRange: number,
): { range: number; x: number; y: number; z: number } | null {
  const sy = Math.cos(thetaOff);
  const sh = Math.sin(thetaOff);
  const dx = Math.sin(yaw) * sh, dz = Math.cos(yaw) * sh;
  const step = 1.0;
  const steps = Math.floor(maxRange / step);
  for (let i = 1; i <= steps; i++) {
    const r = i * step;
    const x = boat.x + dx * r, z = boat.z + dz * r;
    const y = boat.y + sy * r;
    if (x < 0 || z < 0 || x > area.width || z > area.length) return null;
    const bot = depthAt(area, x, z);
    if (y >= bot) {
      // 二分细化一次
      let lo = r - step, hi = r;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        const mx = boat.x + dx * mid, mz = boat.z + dz * mid, my = boat.y + sy * mid;
        if (my >= depthAt(area, mx, mz)) hi = mid; else lo = mid;
      }
      const rr = hi;
      return { range: rr, x: boat.x + dx * rr, y: boat.y + sy * rr, z: boat.z + dz * rr };
    }
  }
  return null;
}
