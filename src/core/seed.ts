// 内置种子数据：测试海区（泥/沙/礁、斜坡、礁石隆起）、4 鱼种、4 换能器、3 鱼群、2 航次

import type {
  DBSchema, FishSchool, FishSpecies, SeaArea, Transducer, Voyage,
} from './types';
import { rng } from './physics';
import { SUBSTRATE_ID } from './world';

function makeArea(): SeaArea {
  const nx = 31, nz = 26;
  const width = 600, length = 500;
  const depth = new Float32Array(nx * nz);
  const substrate = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = (ix / (nx - 1)) * width;
      const z = (iz / (nz - 1)) * length;
      // 基础斜坡：西北浅（18m）向东南深（85m）
      let d = 18 + (x / width) * 38 + (z / length) * 28;
      // 中部海槽
      d += 9 * Math.exp(-(((x - 330) ** 2) / (2 * 90 ** 2) + ((z - 250) ** 2) / (2 * 70 ** 2)));
      // 礁石隆起（东侧），制造波束盲区
      const reef = 16 * Math.exp(-(((x - 470) ** 2) / (2 * 42 ** 2) + ((z - 170) ** 2) / (2 * 38 ** 2)));
      d -= reef;
      // 平缓起伏
      d += 1.2 * Math.sin(x / 45) * Math.cos(z / 38);
      depth[iz * nx + ix] = Math.max(6, d);

      // 底质分区：西侧泥、中部沙、东侧礁石带
      let s: SeaArea['substrate'][number] = SUBSTRATE_ID.sand;
      if (x < 200) s = SUBSTRATE_ID.mud;
      if (x > 400 || reef > 6) s = SUBSTRATE_ID.rock;
      substrate[iz * nx + ix] = s;
    }
  }
  return {
    id: 'area-demo',
    name: '东海近岸演示海区',
    width, length, nx, nz,
    depth, substrate,
    soundSpeed: 1500,
    thermocline: { enabled: false, top: 22, thickness: 8, strength: 0.5 },
    planktonLayer: { enabled: false, dayDepth: 48, nightDepth: 18, thickness: 10, strength: 0.45 },
  };
}

function makeSpecies(): FishSpecies[] {
  return [
    { id: 'sp-bait', name: '鳀鱼（饵料鱼）', b20: 20, b0: -72, minLength: 6, maxLength: 12, color: '#9fd8ff' },
    { id: 'sp-scad', name: '竹荚鱼', b20: 20, b0: -66, minLength: 18, maxLength: 30, color: '#7fe0b0' },
    { id: 'sp-hairtail', name: '带鱼', b20: 20, b0: -63, minLength: 40, maxLength: 90, color: '#d8d8f0' },
    { id: 'sp-seabream', name: '真鲷', b20: 20, b0: -60, minLength: 25, maxLength: 55, color: '#f0a8a0' },
  ];
}

function makeTransducers(): Transducer[] {
  return [
    { id: 'td-50-wide', name: '50kHz 宽波束换能器', frequency: 50000, beamAngleDeg: 40, powerW: 1000, pulseMs: 0.6, gainCalib: 0 },
    { id: 'td-50-narrow', name: '50kHz 窄波束换能器', frequency: 50000, beamAngleDeg: 22, powerW: 1000, pulseMs: 0.4, gainCalib: 1.5 },
    { id: 'td-200-wide', name: '200kHz 宽波束换能器', frequency: 200000, beamAngleDeg: 24, powerW: 600, pulseMs: 0.25, gainCalib: 0 },
    { id: 'td-200-narrow', name: '200kHz 窄波束换能器', frequency: 200000, beamAngleDeg: 9, powerW: 600, pulseMs: 0.15, gainCalib: 2 },
  ];
}

function makeSchools(areaId: string): FishSchool[] {
  return [
    {
      id: 'sc-bait-night', areaId, speciesId: 'sp-bait', name: '表层鳀鱼群',
      count: 90, shape: 'layer',
      center: { x: 180, y: 0, z: 150 }, radiusX: 70, radiusY: 6, radiusZ: 55,
      dayDepthFrac: 0.78, nightDepthFrac: 0.18, seed: 101,
    },
    {
      id: 'sc-scad-mid', areaId, speciesId: 'sp-scad', name: '竹荚鱼群',
      count: 46, shape: 'ball',
      center: { x: 300, y: 0, z: 260 }, radiusX: 26, radiusY: 14, radiusZ: 26,
      dayDepthFrac: 0.72, nightDepthFrac: 0.35, seed: 202,
    },
    {
      id: 'sc-bream-bottom', areaId, speciesId: 'sp-seabream', name: '贴底真鲷群',
      count: 22, shape: 'streak',
      center: { x: 430, y: 0, z: 200 }, radiusX: 34, radiusY: 4, radiusZ: 16,
      dayDepthFrac: 0.95, nightDepthFrac: 0.6, seed: 303,
    },
  ];
}

function makeVoyages(areaId: string): Voyage[] {
  const r = rng(7);
  const routeA = [
    { x: 60, z: 60, speed: 7 },
    { x: 180, z: 120, speed: 8 },
    { x: 300, z: 200, speed: 6.5 },
    { x: 430, z: 180, speed: 5 },
    { x: 520, z: 300, speed: 7.5 },
    { x: 480, z: 430, speed: 0 }, // 抛锚
  ];
  const routeB = Array.from({ length: 7 }, (_, i) => ({
    x: 80 + i * 75 + (r() - 0.5) * 30,
    z: 420 - i * 55 + (r() - 0.5) * 24,
    speed: i === 3 ? 0 : 5.5 + r() * 3,
  }));
  return [
    { id: 'vy-main', areaId, name: '常规巡航航线（含抛锚）', route: routeA, startHour: 8, durationMin: 40 },
    { id: 'vy-cross', areaId, name: '斜穿海槽航线', route: routeB, startHour: 17.5, durationMin: 30 },
  ];
}

export function buildSeedData(): DBSchema {
  const area = makeArea();
  return {
    areas: [area],
    species: makeSpecies(),
    schools: makeSchools(area.id),
    transducers: makeTransducers(),
    voyages: makeVoyages(area.id),
    settings: {
      id: 'global',
      display: {
        gainDb: 0, tvgMode: 'single', tvgStrength: 1, clutterDb: 0,
        colormap: 'sonar', rangeM: 0, bottomLockM: 0, zoomStep: 0,
      },
      noise: {
        wakeBubbles: true, wakeLevel: 0.4,
        engine: false, engineLevel: 0.5,
        crosstalk: false, crosstalkLevel: 0.5, ambient: 8,
      },
    },
  };
}
