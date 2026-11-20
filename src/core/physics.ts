// 声呐物理：声呐方程、波束几何、TVG、吸收系数、目标强度
// 所有距离单位米，角度内部用弧度；电平一律 dB（参考 1μPa）

import type { Transducer } from './types';

export const SOUND_SPEED_DEFAULT = 1500;

/** 吸收系数 dB/m（Ainslie-McColm 简化式，f 单位 kHz） */
export function absorptionDbPerM(freqHz: number): number {
  const f = freqHz / 1000; // kHz
  const T = 14;     // 水温 ℃（近海典型）
  const S = 32;     // 盐度 ppt
  const pH = 8.0;
  const D = 0.05;   // 深度 km（表层）
  const f1 = 0.78 * Math.sqrt(S / 35) * Math.exp(T / 26);
  const f2 = 42 * Math.exp(T / 17);
  const a1 = 0.106 * (f1 * f * f) / (f1 * f1 + f * f) * Math.exp((pH - 8) / 0.56);
  const a2 = 0.52 * (1 + T / 43) * (S / 35) * (f2 * f * f) / (f2 * f2 + f * f) * Math.exp(-D / 6);
  const a3 = 0.00049 * f * f * Math.exp(-(T / 27 + D / 17));
  // 公式给出 dB/km
  return (a1 + a2 + a3) / 1000;
}

/**
 * 声源级 SL（dB re 1μPa @1m）。
 * 民用渔船探鱼器典型 SL≈190–200dB（本仿真相对电平体系）：
 * 基础常数 140 + 10logP + 指向性指数 DI，1kW、40° 波束约 195dB。
 */
export function sourceLevel(t: Transducer): number {
  // 指向性指数 DI = 10log(4π/(2π(1-cos θhalf))) ≈ 20log(1.22π/θhalf_rad)
  const half = (t.beamAngleDeg / 2) * Math.PI / 180;
  const DI = 20 * Math.log10(1.22 * Math.PI / half);
  return 140 + 10 * Math.log10(Math.max(t.powerW, 1e-3)) + DI + t.gainCalib;
}

/**
 * 高斯波束指向性（dB）。
 * 约定波束角全角 θ 为 -3dB 点（单程），半角 β=θ/2：
 *   单程 b(γ) = -3 (γ/β)^2，边缘 γ=β 时为 -3dB；
 *   双程 = 2 倍，边缘 -6dB。
 */
export function beamOneWayDb(thetaOffRad: number, beamHalfAngleRad: number): number {
  const u = thetaOffRad / beamHalfAngleRad;
  return -3 * u * u;
}
export function beamTwoWayDb(thetaOffRad: number, beamHalfAngleRad: number): number {
  return 2 * beamOneWayDb(thetaOffRad, beamHalfAngleRad);
}

/** 鱼目标强度 TS(dB) = b20*log10(L_cm) + b0 */
export function targetStrengthDb(lengthCm: number, b20: number, b0: number): number {
  return b20 * Math.log10(Math.max(lengthCm, 1)) + b0;
}

/**
 * 鱼回波电平（接收端，dB re 1μPa），声呐方程：
 * EL = SL - 2αR - 20logR(双程几何扩展，拆成两次 20log) - ...
 * 标准形式：EL = SL + TS - 2TL，TL = 20logR + αR
 */
export function fishEchoDb(
  sl: number, ts: number, range: number, alpha: number,
  beamTwoWay: number,
): number {
  const R = Math.max(range, 0.5);
  const TL = 20 * Math.log10(R) + alpha * R;
  return sl + ts - 2 * TL + beamTwoWay;
}

/**
 * TVG 时间可变增益（dB），与显示端声呐方程对应：
 *  - single: 40logR + 2αR  → 补偿单目标（点散射体，EL 中含 40logR 项）
 *  - school: 30logR + 2αR  → 补偿鱼群（层状分布等效体积回波）
 * strength 做 0..1 混合，off 时为 0。
 * TVG_MAX_DB：接收机 TVC 增益硬件封顶，取 82dB 保证 10–80m 作业区间内
 * 单目标精确等化（80m 需 ~78dB，留 4dB 余量未触顶）；配合 28dB 低噪声基底，
 * 满 TVG 后深水噪声仍低于显示窗口下沿，不会形成满屏亮带。
 */
export const TVG_MAX_DB = 82;

export function tvgDb(range: number, alpha: number, mode: 'off' | 'single' | 'school', strength: number): number {
  if (mode === 'off' || strength <= 0) return 0;
  const R = Math.max(range, 0.5);
  const logPart = mode === 'single' ? 40 * Math.log10(R) : 30 * Math.log10(R);
  return Math.min(TVG_MAX_DB, strength * (logPart + 2 * alpha * R));
}

/** 脉宽对应的距离分辨力（m）：τ_eff = c τ / 2 为一个距离门厚度 */
export function pulseGateM(pulseMs: number, c: number): number {
  return (c * pulseMs * 1e-3) / 2;
}

/** 距离门半宽（用于包络），cτ/4 */
export function pulseHalfGateM(pulseMs: number, c: number): number {
  return pulseGateM(pulseMs, c) / 2;
}

/** 斜距 -> 双程传播时间 s */
export function rangeToTime(range: number, c: number): number {
  return (2 * range) / c;
}

/**
 * 鱼穿过波束形成的月牙弧几何（理论值）。
 * 船以速度 v 运动、鱼静止于深度 d（垂直距离，近似斜距），
 * 波束半角 β，鱼在波束内的水平扫宽 W = 2 d tanβ，
 * 经过时长 Δt = W / v；
 * 弧上任意水平偏移 x 处斜距 R(x) = sqrt(d² + x²)，
 * 弧顶（x=0）深度 d，弧缘深度 d / cosβ。
 * 弧宽（ping 数）= W / (v / pingRate)。
 */
export interface ArcGeometry {
  widthM: number;        // 弧的水平宽度 m
  durationSec: number;   // 持续时间
  sagM: number;          // 弧缘相对弧顶的下垂量 m
  apexRange: number;     // 弧顶斜距
  edgeRange: number;     // 弧缘斜距
  widthPings: number;    // 弧宽（ping 数，理论）
}

export function theoreticalArc(
  depth: number, beamHalfAngleRad: number, boatSpeed: number, pingRate: number,
): ArcGeometry {
  const W = 2 * depth * Math.tan(beamHalfAngleRad);
  const durationSec = boatSpeed > 1e-6 ? W / boatSpeed : Infinity;
  const apex = depth;
  const edge = depth / Math.cos(beamHalfAngleRad);
  return {
    widthM: W,
    durationSec,
    sagM: edge - apex,
    apexRange: apex,
    edgeRange: edge,
    widthPings: durationSec * pingRate,
  };
}

/** 节 -> m/s */
export function knotToMs(knot: number): number {
  return knot * 0.514444;
}

/** 确定性伪随机（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 正态分布随机（Box-Muller，带 rng） */
export function randn(r: () => number): number {
  const u = Math.max(r(), 1e-9), v = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}
export function linToDb(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}
