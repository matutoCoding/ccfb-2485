// 内置测试数据生成:海区、鱼种、换能器、鱼群、航线、默认设置

import {
  AppSettings,
  FishSchool,
  FishSpecies,
  GainSettings,
  SeaArea,
  SeabedCell,
  SubstrateType,
  Transducer,
  Voyage,
} from '../types';
import { Rng } from '../core/math-util';

export function buildDefaultArea(): SeaArea {
  const cols = 40;
  const rows = 30;
  const cellSize = 20; // 800m x 600m
  const rng = new Rng(771023);
  const cells: SeabedCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 西北浅(15m)向东南深(95m)的斜坡
      const slope = 15 + (c / cols) * 55 + (r / rows) * 25;
      const ripple = Math.sin(c * 0.5) * 1.2 + rng.gaussian(0, 0.6);
      let depth = slope + ripple;

      // 中部一条礁石垄(水深骤浅 6-10m)
      const reefLine = r - (6 + Math.sin(c * 0.45) * 2 + c * 0.35);
      const reef = reefLine > -1.2 && reefLine < 1.2;
      if (reef) depth -= rng.range(6, 10);

      // 东侧泥质洼地
      const pit = c > 30 && r > 18 && Math.hypot(c - 35, r - 24) < 3.5;
      if (pit) depth += rng.range(4, 8);

      let substrate: SubstrateType;
      if (reef) substrate = 'rock';
      else if (depth < 35) substrate = 'sand';
      else if (pit) substrate = 'mud';
      else substrate = rng.next() > 0.45 ? 'sand' : 'mud';

      cells.push({ depth: Math.max(6, depth), substrate });
    }
  }
  return {
    id: 'area-zhoushan',
    name: '舟山近海试验海区',
    cellSize,
    cols,
    rows,
    cells,
    surfaceTempC: 18,
    salinity: 32,
    thermocline: {
      topDepth: 22,
      thickness: 6,
      deltaTemp: 5,
      scatteringLevel: -58,
    },
  };
}

export function buildDefaultSpecies(): FishSpecies[] {
  return [
    { id: 'sp-bait', name: '鳀鱼(饵料鱼)', b20: 20, b0: -72, typicalLengthCm: 8, freqSlope: 2, color: [0.6, 0.9, 1] },
    { id: 'sp-scad', name: '蓝圆鲹', b20: 20, b0: -68, typicalLengthCm: 22, freqSlope: 1.2, color: [0.3, 0.7, 1] },
    { id: 'sp-hairtail', name: '带鱼', b20: 20, b0: -66, typicalLengthCm: 60, freqSlope: -1, color: [0.85, 0.9, 1] },
    { id: 'sp-seabream', name: '真鲷', b20: 20, b0: -63, typicalLengthCm: 35, freqSlope: 0, color: [1, 0.6, 0.45] },
    { id: 'sp-croaker', name: '大黄鱼', b20: 20, b0: -65, typicalLengthCm: 30, freqSlope: 0.6, color: [1, 0.8, 0.3] },
  ];
}

export function buildDefaultTransducers(): Transducer[] {
  return [
    { id: 'tx-50-wide', name: '50kHz 宽波束', freqKhz: 50, beamAngleDeg: 40, powerW: 1000, pulseMs: 0.6, slOffsetDb: 0, color: '#4fc3f7' },
    { id: 'tx-200-narrow', name: '200kHz 窄波束', freqKhz: 200, beamAngleDeg: 11, powerW: 300, pulseMs: 0.2, slOffsetDb: 0, color: '#ffb74d' },
    { id: 'tx-88-mid', name: '88kHz 中波束', freqKhz: 88, beamAngleDeg: 24, powerW: 600, pulseMs: 0.3, slOffsetDb: 0, color: '#81c784' },
    { id: 'tx-200-wide', name: '200kHz 宽波束(低成本)', freqKhz: 200, beamAngleDeg: 25, powerW: 150, pulseMs: 0.4, slOffsetDb: -3, color: '#e57373' },
  ];
}

export function buildDefaultSchools(): FishSchool[] {
  return [
    {
      id: 'sc-bait-night',
      speciesId: 'sp-bait',
      count: 220,
      shape: 'layer',
      x: 260,
      y: 180,
      radius: 6,
      radiusX: 90,
      radiusY: 45,
      dayDepth: 48,
      nightDepth: 12,
      meanLengthCm: 8,
      enabled: true,
    },
    {
      id: 'sc-scad-ball',
      speciesId: 'sp-scad',
      count: 90,
      shape: 'ball',
      x: 480,
      y: 320,
      radius: 14,
      radiusX: 14,
      radiusY: 14,
      dayDepth: 40,
      nightDepth: 18,
      meanLengthCm: 22,
      enabled: true,
    },
    {
      id: 'sc-croaker-bottom',
      speciesId: 'sp-croaker',
      count: 40,
      shape: 'elongated',
      x: 350,
      y: 470,
      radius: 5,
      radiusX: 60,
      radiusY: 18,
      dayDepth: 55,
      nightDepth: 30,
      meanLengthCm: 30,
      enabled: true,
    },
    {
      id: 'sc-bream-reef',
      speciesId: 'sp-seabream',
      count: 24,
      shape: 'ball',
      x: 300,
      y: 250,
      radius: 8,
      radiusX: 8,
      radiusY: 8,
      dayDepth: 30,
      nightDepth: 20,
      meanLengthCm: 35,
      enabled: true,
    },
  ];
}

export function buildDefaultVoyage(): Voyage {
  return {
    id: 'voy-1',
    name: '示例航线(含航行与抛锚)',
    startHour: 8,
    timeScale: 60, // 仿真 1 秒 = 实际 1 分钟
    route: [
      { x: 80, y: 80, speed: 2.5, dwellSec: 0 },
      { x: 300, y: 200, speed: 3.0, dwellSec: 0 },
      { x: 480, y: 320, speed: 2.0, dwellSec: 90 }, // 抛锚 90s:鱼弧拉横线
      { x: 620, y: 420, speed: 4.0, dwellSec: 0 }, // 高速段:鱼弧压扁
      { x: 350, y: 500, speed: 2.2, dwellSec: 60 },
      { x: 120, y: 300, speed: 2.5, dwellSec: 0 },
      { x: 80, y: 80, speed: 2.5, dwellSec: 0 },
    ],
  };
}

function defaultGain(): GainSettings {
  return {
    gainDb: 0,
    tvgMode: '40log',
    tvgClampM: 2,
    clutterReject: 0.35,
    colorMinDb: 45,
    colorMaxDb: 120,
    colormap: 'halieutis',
  };
}

export function buildDefaultSettings(transducers: Transducer[]): AppSettings {
  const gain: Record<string, GainSettings> = { default: defaultGain() };
  for (const t of transducers) gain[t.id] = defaultGain();
  return {
    gain,
    noise: {
      ambientDb: 42,
      wakeBubbles: 0.35,
      engineInterference: 0.25,
      crosstalk: 0.3,
      planktonLayer: 0.5,
    },
    display: {
      rangeM: 0,
      bottomLockM: 0,
      zoom: 1,
      splitScreen: true,
      showSecondEcho: true,
      showThermocline: true,
    },
    pingRateHz: 4,
  };
}
