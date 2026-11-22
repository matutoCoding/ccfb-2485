// 声学物理:声速、吸收、声纳方程、波束指向性、TVG
// 所有距离单位 m,频率 kHz,角度内部统一弧度

import { FishSpecies, Transducer } from '../types';
import { deg2rad, loglogInterp } from './math-util';

/**
 * Mackenzie (1981) 九项式声速
 * @param tempC 水温 ℃
 * @param salinity 盐度 ppt
 * @param depthM 深度 m
 */
export function soundSpeed(tempC: number, salinity: number, depthM: number): number {
  const T = tempC;
  const S = salinity;
  const D = depthM;
  return (
    1448.96 +
    4.591 * T -
    5.304e-2 * T * T +
    2.374e-4 * T * T * T +
    1.34 * (S - 35) +
    1.63e-2 * D +
    1.675e-7 * D * D -
    1.025e-2 * T * (S - 35) -
    7.139e-13 * T * D * D * D
  );
}

/** 海区平均声速(用于距离门换算的标称值) */
export function meanSoundSpeed(area: { surfaceTempC: number; salinity: number; cells: { depth: number }[] }): number {
  const meanDepth = area.cells.reduce((s, c) => s + c.depth, 0) / Math.max(1, area.cells.length);
  const midT = area.surfaceTempC - 2; // 粗略中层降温
  return soundSpeed(midT, area.salinity, meanDepth / 2);
}

// 海水吸收系数经验表 (盐度35/pH8 浅海近似),dB/km
// 数据与 Francois & Garrison (1982) 同量级,仿真标定用
const ABSORPTION_TABLE: Array<[number, number]> = [
  [10, 0.9],
  [20, 2.8],
  [50, 12.0],
  [100, 35.0],
  [200, 70.0],
  [400, 118.0],
];

/** 吸收系数 dB/m,含水温修正(相对 15℃) */
export function absorptionDbPerM(freqKhz: number, tempC = 15): number {
  const dbPerKm = loglogInterp(ABSORPTION_TABLE, freqKhz);
  const tempFactor = 1 + 0.015 * (tempC - 15);
  return (dbPerKm * tempFactor) / 1000;
}

/** 声源级 SL(dB re 1μPa @1m),额定功率换算 + 个体修正 */
export function sourceLevel(t: Transducer): number {
  return 170.8 + 10 * Math.log10(t.powerW) + t.slOffsetDb;
}

/** 一阶贝塞尔 J1,级数展开(圆活塞指向性用) */
function besselJ1(x: number): number {
  if (Math.abs(x) < 1e-6) return x / 2 - (x * x * x) / 16;
  const ax = x / 2;
  let term = ax; // n=0: (-1)^0 / (0! 1!) (x/2)^1
  let sum = term;
  for (let n = 1; n < 12; n++) {
    term *= -(ax * ax) / (n * (n + 1));
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return sum;
}

/**
 * 圆活塞换能器双程波束指向性损失(正数 dB,轴上为 0)
 * @param angleOff 偏离波束轴角度 rad
 * @param halfBeamDeg -3dB 半波束角(全角的一半)
 */
export function beamPatternDb(angleOff: number, halfBeamDeg: number): number {
  const half = deg2rad(halfBeamDeg);
  const sinHalf = Math.sin(half);
  const x = 1.616 * (Math.sin(angleOff) / sinHalf); // 1.616 处 2J1/x = 1/√2
  if (x < 1e-6) return 0;
  const piston = (2 * besselJ1(x)) / x;
  const norm = piston; // 轴上归一(轴上 =1)
  const db = -20 * Math.log10(Math.abs(norm));
  // 双程 = 单程强度图案平方 → dB 翻倍;旁瓣地板 -40dB
  const twoWay = Math.min(db * 2, 40);
  return twoWay;
}

/** 鱼体目标强度 TS:TS = b20·log10(L/cm) + b0 + 频率修正(每倍频程) */
export function targetStrength(species: FishSpecies, lengthCm: number, freqKhz: number): number {
  const base = species.b20 * Math.log10(Math.max(1, lengthCm)) + species.b0;
  const freqCorr = species.freqSlope * Math.log2(freqKhz / 50);
  return base + freqCorr;
}

/** 单程传播损失 TL = 20log10(r) + αr */
export function transmissionLoss(r: number, alphaDbPerM: number): number {
  return 20 * Math.log10(Math.max(1, r)) + alphaDbPerM * r;
}

export type TvgMode = '40log' | '20log' | 'off';

/**
 * TVG 时变增益
 * 40log: G = 40log10(r) + 2αr  —— 鱼群(点目标)校正,输出与距离无关
 * 20log: G = 20log10(r) + αr   —— 底质(面目标)校正
 * 近场钳制避免小距离数值发散
 */
export function tvgGain(r: number, mode: TvgMode, alphaDbPerM: number, clampM: number): number {
  const re = Math.max(r, clampM);
  switch (mode) {
    case '40log':
      return 40 * Math.log10(re) + 2 * alphaDbPerM * re;
    case '20log':
      return 20 * Math.log10(re) + alphaDbPerM * re;
    case 'off':
      return 0;
  }
}

/** 距离分辨率(采样窗长),m */
export function rangeResolution(c: number, pulseMs: number): number {
  return (c * (pulseMs / 1000)) / 2;
}

/**
 * 海底面回波级(等效束宽法)
 * EL = SL - 2TL + Sb + 10log10(A),A = r·Φ·Δr
 * @param sbDb 底质反向散射强度 dB
 * @param beamWidthRad 全波束角 rad
 * @param rangeGate 距离门 Δr m
 */
export function bottomEchoLevel(
  sl: number,
  r: number,
  alpha: number,
  sbDb: number,
  beamWidthRad: number,
  rangeGate: number
): number {
  const tl2 = 2 * transmissionLoss(r, alpha);
  const area = Math.max(1e-6, r * beamWidthRad * rangeGate);
  return sl - tl2 + sbDb + 10 * Math.log10(area);
}

/** 点目标(鱼)回波级 EL = SL - 2TL + TS + 波束损失 */
export function fishEchoLevel(
  sl: number,
  r: number,
  alpha: number,
  ts: number,
  beamLossDb: number
): number {
  return sl - 2 * transmissionLoss(r, alpha) + ts - beamLossDb;
}
