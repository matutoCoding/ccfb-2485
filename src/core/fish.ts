// 鱼群布放与昼夜行为

import { FishInstance, FishSchool, FishSpecies } from '../types';
import { Rng } from './math-util';
import { targetStrength } from './acoustics';

export function createSchoolFish(
  school: FishSchool,
  species: FishSpecies,
  freqKhz: number,
  rng: Rng
): FishInstance[] {
  const out: FishInstance[] = [];
  for (let i = 0; i < school.count; i++) {
    let ox = 0;
    let oy = 0;
    let oz = 0;
    switch (school.shape) {
      case 'ball': {
        // 球内均匀分布
        const r = school.radius * Math.cbrt(rng.next());
        const theta = rng.range(0, Math.PI * 2);
        const phi = Math.acos(rng.range(-1, 1));
        ox = r * Math.sin(phi) * Math.cos(theta);
        oy = r * Math.sin(phi) * Math.sin(theta);
        oz = r * Math.cos(phi);
        break;
      }
      case 'layer': {
        const a = rng.range(0, Math.PI * 2);
        const rr = Math.sqrt(rng.next());
        ox = school.radiusX * rr * Math.cos(a);
        oy = school.radiusY * rr * Math.sin(a);
        oz = rng.gaussian(0, school.radius * 0.35);
        break;
      }
      case 'elongated': {
        const a = rng.range(0, Math.PI * 2);
        const rr = Math.cbrt(rng.next());
        ox = school.radiusX * rr * Math.cos(a);
        oy = school.radiusY * rr * Math.sin(a);
        oz = rng.gaussian(0, school.radius * 0.5) * rr;
        break;
      }
    }
    const lengthCm = school.meanLengthCm * rng.range(0.8, 1.2);
    out.push({
      id: i,
      schoolId: school.id,
      speciesId: species.id,
      x: school.x + ox,
      y: school.y + oy,
      zOffset: oz,
      z: school.dayDepth + oz,
      lengthCm,
      tsDb: targetStrength(species, lengthCm, freqKhz),
    });
  }
  return out;
}

/**
 * 昼夜垂直迁移
 * 白天(10-16 时)沉底最深,夜间(20-04 时)上浮最浅,晨昏平滑过渡
 * @param hour 当日小时 0-24
 */
export function dielFactor(hour: number): number {
  // 0 = 夜间位(浅),1 = 白天位(深)
  const table: Array<[number, number]> = [
    [0, 0],
    [4, 0],
    [5.5, 0.15],
    [7, 0.7],
    [9, 1],
    [16, 1],
    [17.5, 0.75],
    [19, 0.25],
    [20.5, 0],
    [24, 0],
  ];
  for (let i = 0; i < table.length - 1; i++) {
    const [h0, v0] = table[i];
    const [h1, v1] = table[i + 1];
    if (hour >= h0 && hour <= h1) {
      const t = (hour - h0) / (h1 - h0);
      const s = t * t * (3 - 2 * t);
      return v0 + (v1 - v0) * s;
    }
  }
  return 0;
}

/** 按当前时刻把鱼群整体迁移到对应水层(保持群内相对位置) */
export function updateSchoolDepth(
  fish: FishInstance[],
  school: FishSchool,
  hour: number
): void {
  const f = dielFactor(hour);
  const centerDepth = school.nightDepth + (school.dayDepth - school.nightDepth) * f;
  for (const inst of fish) {
    inst.z = centerDepth + inst.zOffset;
  }
}
