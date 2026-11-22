// 海底地形:网格插值、波束脚印、底质参数、盲区几何

import { SeaArea, SubstrateParams, SubstrateType } from '../types';
import { clamp, deg2rad } from './math-util';

export const SUBSTRATES: Record<SubstrateType, SubstrateParams> = {
  mud: {
    backscatter: -32,
    secondEchoLoss: 14,
    roughness: 1.6,
    label: '泥底',
    color: [0.42, 0.36, 0.28],
  },
  sand: {
    backscatter: -24,
    secondEchoLoss: 9,
    roughness: 1.1,
    label: '沙底',
    color: [0.76, 0.68, 0.45],
  },
  rock: {
    backscatter: -12,
    secondEchoLoss: 4,
    roughness: 2.4,
    label: '礁石',
    color: [0.55, 0.55, 0.58],
  },
};

/** 网格坐标 -> 海底深度(双线性插值),超出边界取边缘值 */
export function depthAt(area: SeaArea, x: number, y: number): number {
  const { cellSize, cols, rows, cells } = area;
  const fx = clamp(x / cellSize - 0.5, 0, cols - 1.001);
  const fy = clamp(y / cellSize - 0.5, 0, rows - 1.001);
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;
  const i = (r: number, c: number) => cells[r * cols + c].depth;
  const d00 = i(r0, c0);
  const d10 = i(r0, c0 + 1);
  const d01 = i(r0 + 1, c0);
  const d11 = i(r0 + 1, c0 + 1);
  const d0 = d00 + (d10 - d00) * tx;
  const d1 = d01 + (d11 - d01) * tx;
  return d0 + (d1 - d0) * ty;
}

/** 最近网格单元的底质 */
export function substrateAt(area: SeaArea, x: number, y: number): SubstrateType {
  const c = clamp(Math.floor(x / area.cellSize), 0, area.cols - 1);
  const r = clamp(Math.floor(y / area.cellSize), 0, area.rows - 1);
  return area.cells[r * area.cols + c].substrate;
}

/** 波束脚印水平半径 m */
export function footprintRadius(range: number, halfBeamAngleDeg: number): number {
  return range * Math.tan(deg2rad(halfBeamAngleDeg));
}

export interface FootprintProfile {
  /** 最近回波距离对应的斜距 m */
  minSlant: number;
  /** 脚印内最浅深度 m */
  minDepth: number;
  /** 脚印内最深深度 m */
  maxDepth: number;
  meanDepth: number;
  /** 主导底质(按岩石>沙>泥的强回波优先) */
  substrate: SubstrateType;
  /** 估算坡度角 rad(深度差/脚印直径) */
  slopeRad: number;
}

/**
 * 采样波束脚印内的海底剖面
 * @param txDepth 换能器吃水深度 m
 */
export function sampleFootprint(
  area: SeaArea,
  boatX: number,
  boatY: number,
  txDepth: number,
  verticalRange: number,
  halfBeamAngleDeg: number
): FootprintProfile {
  const radius = footprintRadius(verticalRange, halfBeamAngleDeg);
  const step = Math.max(area.cellSize * 0.5, 1);
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let sum = 0;
  let n = 0;
  let minSlant = Infinity;
  const votes: Record<SubstrateType, number> = { mud: 0, sand: 0, rock: 0 };

  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const px = boatX + dx;
      const py = boatY + dy;
      if (px < 0 || py < 0 || px > area.cols * area.cellSize || py > area.rows * area.cellSize) continue;
      if (dx * dx + dy * dy > radius * radius) continue;
      const d = depthAt(area, px, py);
      minDepth = Math.min(minDepth, d);
      maxDepth = Math.max(maxDepth, d);
      sum += d;
      n++;
      const slant = Math.hypot(dx, dy, d - txDepth);
      minSlant = Math.min(minSlant, slant);
      votes[substrateAt(area, px, py)]++;
    }
  }
  if (n === 0) {
    const d = depthAt(area, boatX, boatY);
    return {
      minSlant: d - txDepth,
      minDepth: d,
      maxDepth: d,
      meanDepth: d,
      substrate: substrateAt(area, boatX, boatY),
      slopeRad: 0,
    };
  }
  const substrate: SubstrateType =
    votes.rock > n * 0.25 ? 'rock' : votes.sand > votes.mud ? 'sand' : 'mud';
  const slopeRad = Math.atan2(maxDepth - minDepth, Math.max(1e-6, 2 * radius));
  return {
    minSlant,
    minDepth,
    maxDepth,
    meanDepth: sum / n,
    substrate,
    slopeRad,
  };
}

/**
 * 波束盲区垂直高度 m
 * 斜坡盲区:h ≈ r·tan(β/2)·tan(α),叠加脉宽垂直分辨单元
 * @param range 海底距离 m
 * @param halfBeamDeg 半波束角
 * @param slopeRad 海底坡度
 * @param rangeRes 脉宽距离分辨率
 */
export function deadZoneHeight(
  range: number,
  halfBeamDeg: number,
  slopeRad: number,
  rangeRes: number
): number {
  const geometric = range * Math.tan(deg2rad(halfBeamDeg)) * Math.tan(slopeRad);
  return geometric + rangeRes;
}

/** 鱼是否被海底回波吞掉:位于海底上方盲区高度内 */
export function isSwallowedByBottom(
  fishDepth: number,
  bottomDepth: number,
  deadZone: number
): boolean {
  return bottomDepth - fishDepth < deadZone && fishDepth < bottomDepth;
}
