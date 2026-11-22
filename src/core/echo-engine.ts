// 回波仿真引擎:逐 ping 按声束几何 + 声纳方程生成距离门回波
// 纯 TypeScript,不依赖 DOM,可在 Node 下运行自检

import {
  AppSettings,
  EchoContributor,
  FishInstance,
  FishSchool,
  GainSettings,
  PingColumn,
  SeaArea,
  SubstrateType,
  Transducer,
} from '../types';
import { Rng, clamp, deg2rad } from './math-util';
import {
  absorptionDbPerM,
  beamPatternDb,
  bottomEchoLevel,
  fishEchoLevel,
  rangeResolution,
  sourceLevel,
  soundSpeed,
  tvgGain,
} from './acoustics';
import {
  SUBSTRATES,
  deadZoneHeight,
  depthAt,
  footprintRadius,
  isSwallowedByBottom,
  sampleFootprint,
} from './seabed';
import { createSchoolFish, updateSchoolDepth } from './fish';

/** 空间哈希单元边长 m */
const HASH_CELL = 8;

export interface EngineWorld {
  area: SeaArea;
  schools: FishSchool[];
  species: Map<string, { id: string; b20: number; b0: number; freqSlope: number }>;
}

export interface PingInput {
  index: number;
  timeSec: number;
  hour: number;
  x: number;
  y: number;
  speed: number;
  anchored: boolean;
}

/** 测试模式:固定单鱼(用于月牙弧/TVG 精度自检) */
export interface TestFish {
  x: number;
  y: number;
  depth: number;
  tsDb: number;
  id: number;
}

export class EchoEngine {
  /** 每个换能器维护的鱼群实例(频率不同 TS 不同,各自生成) */
  private fishByTx = new Map<string, FishInstance[]>();
  private backgroundByTx = new Map<string, Float32Array>();
  private rng: Rng;
  private noiseRng: Rng;
  private c: number;
  private testFish: TestFish | null = null;

  constructor(
    private world: EngineWorld,
    private transducer: Transducer,
    private settings: AppSettings,
    seed = 20261123
  ) {
    this.rng = new Rng(seed);
    this.noiseRng = new Rng(seed ^ 0x9e3779b9);
    const { area } = world;
    this.c = soundSpeed(area.surfaceTempC, area.salinity, 20);
    this.rebuildFish();
  }

  setTestFish(f: TestFish | null) {
    this.testFish = f;
  }

  get speedOfSound() {
    return this.c;
  }

  get halfBeamDeg() {
    return this.transducer.beamAngleDeg / 2;
  }

  get binStep() {
    // 距离门 = 脉宽分辨率 / 2(2 倍过采样,弧顶亚门量化)
    return rangeResolution(this.c, this.transducer.pulseMs) / 2;
  }

  get rangeRes() {
    return rangeResolution(this.c, this.transducer.pulseMs);
  }

  rebuildFish() {
    const all: FishInstance[] = [];
    for (const school of this.world.schools) {
      if (!school.enabled) continue;
      const sp = this.world.species.get(school.speciesId);
      if (!sp) continue;
      const rng = new Rng(hashStr(school.id) ^ (this.transducer.freqKhz * 1000 | 0));
      const fish = createSchoolFish(
        school,
        {
          id: sp.id,
          name: '',
          b20: sp.b20,
          b0: sp.b0,
          typicalLengthCm: school.meanLengthCm,
          freqSlope: sp.freqSlope,
          color: [1, 1, 1],
        },
        this.transducer.freqKhz,
        rng
      );
      // 全局唯一 id:鱼在数组中的起始偏移
      const offset = all.length;
      for (const f of fish) {
        f.id += offset;
        all.push(f);
      }
    }
    this.fishByTx.set(this.transducer.id, all);
    this.backgroundByTx.delete(this.transducer.id);
  }

  get fish(): FishInstance[] {
    return this.fishByTx.get(this.transducer.id) ?? [];
  }

  private gain(): GainSettings {
    return (
      this.settings.gain[this.transducer.id] ??
      this.settings.gain.default ??
      Object.values(this.settings.gain)[0]
    );
  }

  /** 构建空间哈希:只收录波束脚印附近的鱼 */
  private buildHash(fish: FishInstance[], x: number, y: number, maxR: number): Map<number, number[]> {
    const map = new Map<number, number[]>();
    const rad = footprintRadius(maxR, this.halfBeamDeg);
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (Math.abs(f.x - x) > rad || Math.abs(f.y - y) > rad) continue;
      const key = hashCell(Math.floor(f.x / HASH_CELL), Math.floor(f.y / HASH_CELL));
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(i);
    }
    return map;
  }

  generatePing(input: PingInput): PingColumn {
    const { area } = this.world;
    const tx = this.transducer;
    const g = this.gain();
    const maxRange =
      this.settings.display.rangeM > 0
        ? this.settings.display.rangeM
        : Math.max(...area.cells.map((c) => c.depth)) + 20;
    const binCount = Math.ceil(maxRange / this.binStep);
    const bins = new Float32Array(binCount);
    const contributors: EchoContributor[][] = Array.from({ length: binCount }, () => []);
    const alpha = absorptionDbPerM(tx.freqKhz, area.surfaceTempC);
    const sl = sourceLevel(tx);
    const transducerDepth = 0.8; // 换能器吃水 m

    // ---- 1. 鱼群昼夜迁移 ----
    if (!this.testFish) {
      const fish = this.fish;
      for (const school of this.world.schools) {
        const members = fish.filter((f) => f.schoolId === school.id);
        if (members.length) updateSchoolDepth(members, school, input.hour);
      }
    }

    // ---- 2. 海底剖面 + 盲区 ----
    const profile = sampleFootprint(
      area,
      input.x,
      input.y,
      transducerDepth,
      maxRange,
      this.halfBeamDeg
    );
    const bottomRange = profile.minSlant;
    const deadZone = deadZoneHeight(bottomRange, this.halfBeamDeg, profile.slopeRad, this.rangeRes);
    const substrate = SUBSTRATES[profile.substrate];

    // ---- 3. 环境噪声底 ----
    const noiseFloor = this.settings.noise.ambientDb;
    bins.fill(noiseFloor);

    // ---- 4. 鱼回波 ----
    const addContribution = (bin: number, c: EchoContributor) => {
      if (bin < 0 || bin >= binCount) return;
      const list = contributors[bin];
      if (list.length < 4) list.push(c);
      else {
        // 保留最强的 4 个来源
        let minIdx = 0;
        for (let k = 1; k < list.length; k++) if (list[k].level < list[minIdx].level) minIdx = k;
        if (c.level > list[minIdx].level) list[minIdx] = c;
      }
    };

    const accumulateDb = (bin: number, level: number) => {
      if (bin < 0 || bin >= binCount) return;
      bins[bin] = addDb(bins[bin], level);
    };

    if (this.testFish) {
      const tf = this.testFish;
      const dx = tf.x - input.x;
      const dy = tf.y - input.y;
      const dz = tf.depth - transducerDepth;
      const r = Math.hypot(dx, dy, dz);
      const angle = Math.atan2(Math.hypot(dx, dy), dz);
      const loss = beamPatternDb(angle, this.halfBeamDeg);
      const bottomDepthHere = depthAt(area, input.x, input.y);
      if (isSwallowedByBottom(tf.depth, bottomDepthHere, deadZone)) {
        const bin = Math.round(r / this.binStep);
        addContribution(bin, { kind: 'fish', id: tf.id, level: -999 });
      } else if (loss < 40) {
        const level = fishEchoLevel(sl, r, alpha, tf.tsDb, loss);
        this.smearEcho(r, level, { kind: 'fish', id: tf.id, level }, bins, contributors, accumulateDb, addContribution);
      }
    } else {
      const fish = this.fish;
      const hash = this.buildHash(fish, input.x, input.y, maxRange);
      const rad = footprintRadius(maxRange, this.halfBeamDeg);
      const cx = Math.floor(input.x / HASH_CELL);
      const cy = Math.floor(input.y / HASH_CELL);
      const cellSpan = Math.ceil(rad / HASH_CELL) + 1;
      const bottomDepthHere = depthAt(area, input.x, input.y);
      for (let hy = cy - cellSpan; hy <= cy + cellSpan; hy++) {
        for (let hx = cx - cellSpan; hx <= cx + cellSpan; hx++) {
          const arr = hash.get(hashCell(hx, hy));
          if (!arr) continue;
          for (const idx of arr) {
            const f = fish[idx];
            const dx = f.x - input.x;
            const dy = f.y - input.y;
            const dz = f.z - transducerDepth;
            if (dz <= 0) continue;
            const r = Math.hypot(dx, dy, dz);
            if (r > maxRange) continue;
            const angle = Math.atan2(Math.hypot(dx, dy), dz);
            if (angle > deg2rad(this.halfBeamDeg) * 1.6) continue;
            const loss = beamPatternDb(angle, this.halfBeamDeg);
            if (loss >= 40) continue;
            // 贴底鱼被海底回波吞掉:标记但不再产生独立鱼回波
            if (isSwallowedByBottom(f.z, bottomDepthHere, deadZone)) {
              const bin = Math.round(r / this.binStep);
              addContribution(bin, { kind: 'fish', id: f.id, level: -999 });
              continue;
            }
            const level = fishEchoLevel(sl, r, alpha, f.tsDb, loss);
            this.smearEcho(
              r,
              level,
              { kind: 'fish', id: f.id, level },
              bins,
              contributors,
              accumulateDb,
              addContribution
            );
          }
        }
      }
    }

    // ---- 5. 温跃层弱散射面 ----
    if (this.settings.display.showThermocline && area.thermocline) {
      const tc = area.thermocline;
      for (let z = tc.topDepth; z <= tc.topDepth + tc.thickness; z += this.binStep) {
        const bin = Math.round((z - transducerDepth) / this.binStep);
        if (bin < 0 || bin >= binCount) continue;
        const profile2 =
          10 * Math.log10(Math.max(1e-3, footprintRadius(z, this.halfBeamDeg) * this.binStep));
        const lvl = sl - 4 * (20 * Math.log10(Math.max(1, z)) + alpha * z) + tc.scatteringLevel + profile2;
        accumulateDb(bin, lvl);
        addContribution(bin, { kind: 'thermocline', id: -1, level: lvl });
      }
    }

    // ---- 6. 浮游生物散射层(随昼夜迁移,白天 40m 夜间 15m) ----
    const plk = this.settings.noise.planktonLayer;
    if (plk > 0) {
      const dayFrac = input.hour >= 9 && input.hour <= 16 ? 1 : 0;
      const layerDepth = 15 + dayFrac * 25;
      const thickness = 6;
      const startBin = Math.round((layerDepth - thickness / 2) / this.binStep);
      const endBin = Math.round((layerDepth + thickness / 2) / this.binStep);
      for (let b = startBin; b <= endBin && b < binCount; b++) {
        if (b < 0) continue;
        const r = b * this.binStep;
        const fluct = this.noiseRng.range(-4, 2);
        const lvl = noiseFloor + 6 + 14 * plk + fluct - alpha * r * 2;
        accumulateDb(b, lvl);
        addContribution(b, { kind: 'plankton', id: -1, level: lvl });
      }
    }

    // ---- 7. 船尾流气泡:船速越快、浅水区越强,拖尾锥形 ----
    const wake = this.settings.noise.wakeBubbles;
    if (wake > 0 && input.speed > 0.2) {
      const depthLimit = 6 + 8 * wake;
      const endBin = Math.min(binCount, Math.round(depthLimit / this.binStep));
      for (let b = 1; b < endBin; b++) {
        const r = b * this.binStep;
        const taper = 1 - r / depthLimit;
        const lvl = noiseFloor + 18 * wake * taper + this.noiseRng.range(-5, 3);
        accumulateDb(b, lvl);
        addContribution(b, { kind: 'bubble', id: -1, level: lvl });
      }
    }

    // ---- 8. 发动机干扰:固定距离间隔的水平亮线 ----
    const eng = this.settings.noise.engineInterference;
    if (eng > 0) {
      const spacing = Math.round(12 / this.binStep);
      for (let b = spacing; b < binCount; b += spacing) {
        const lvl = noiseFloor + 12 * eng + this.noiseRng.range(-2, 2);
        accumulateDb(b, lvl);
      }
    }

    // ---- 9. 他船探鱼器串频:周期性斜向干扰带 ----
    const cross = this.settings.noise.crosstalk;
    if (cross > 0) {
      const period = 37; // ping 周期
      const phase = input.index % period;
      if (phase < 6) {
        const startBin = Math.round((phase * 9 + (input.index % 5) * 3) / this.binStep);
        for (let k = 0; k < 10; k++) {
          const b = startBin + k;
          if (b < 0 || b >= binCount) continue;
          const lvl = noiseFloor + 20 * cross - k * 1.6 + this.noiseRng.range(-2, 2);
          accumulateDb(b, lvl);
        }
      }
    }

    // ---- 10. 海底回波(面目标,含底质粗糙度展宽与盲区) ----
    const beamWidthRad = deg2rad(tx.beamAngleDeg);
    const bottomLevel = bottomEchoLevel(sl, bottomRange, alpha, substrate.backscatter, beamWidthRad, this.rangeRes);
    const bottomBin = Math.round(bottomRange / this.binStep);
    const spreadBins = Math.max(1, Math.round((substrate.roughness * this.rangeRes + deadZone) / this.binStep));
    for (let k = -1; k <= spreadBins; k++) {
      const b = bottomBin + k;
      if (b < 0 || b >= binCount) continue;
      const falloff = k < 0 ? k * 3 : -Math.abs(k) * (2.2 / substrate.roughness);
      const lvl = bottomLevel + falloff;
      accumulateDb(b, lvl);
      addContribution(b, {
        kind: profile.substrate === 'rock' ? 'reef' : 'bottom',
        id: -1,
        level: lvl,
      });
    }

    // ---- 11. 二次回波(泥底弱、礁石强;位置在 2 倍水深) ----
    if (this.settings.display.showSecondEcho) {
      const r2 = bottomRange * 2;
      if (r2 < maxRange) {
        const lvl2 = bottomLevel - substrate.secondEchoLoss - 12;
        const b2 = Math.round(r2 / this.binStep);
        const spread2 = Math.max(1, Math.round(spreadBins * 0.7));
        for (let k = -spread2; k <= spread2; k++) {
          accumulateDb(b2 + k, lvl2 - Math.abs(k) * 3);
        }
      }
    }

    // ---- 12. 背景估计 + 杂波抑制(滚动均值;关闭抑制时不更新背景,避免首 ping 污染) ----
    let bg = this.backgroundByTx.get(tx.id);
    if (!bg || bg.length !== binCount) {
      bg = new Float32Array(binCount);
      bg.fill(noiseFloor);
      this.backgroundByTx.set(tx.id, bg);
    }
    const reject = g.clutterReject;
    if (reject > 0) {
      for (let b = 0; b < binCount; b++) {
        bg[b] = bg[b] * 0.92 + bins[b] * 0.08;
      }
    }

    // ---- 13. TVG + 总增益 + 杂波扣除 ----
    const out = new Float32Array(binCount);
    for (let b = 0; b < binCount; b++) {
      const r = Math.max(b * this.binStep, 0.5);
      const tvg = tvgGain(r, g.tvgMode, alpha, g.tvgClampM);
      const clutter = reject > 0 ? reject * (bg[b] - noiseFloor) : 0;
      out[b] = bins[b] + tvg + g.gainDb - clutter;
    }

    return {
      index: input.index,
      timeSec: input.timeSec,
      hour: input.hour,
      x: input.x,
      y: input.y,
      speed: input.speed,
      anchored: input.anchored,
      bins: out,
      background: bg,
      contributors,
      bottomRange,
      bottomSubstrate: profile.substrate as SubstrateType,
      binStep: this.binStep,
      transducerId: tx.id,
      freqKhz: tx.freqKhz,
    };
  }

  /**
   * 脉宽包络展宽:
   * 中心(最近)bin 保留全部峰值电平(保证任意距离的同一条鱼显示色阶一致),
   * 相邻 bin 以 -6dB 展宽做视觉厚度,对应脉宽分辨单元的两侧拖尾。
   */
  private smearEcho(
    range: number,
    level: number,
    contributor: EchoContributor,
    bins: Float32Array,
    contributors: EchoContributor[][],
    accumulate: (b: number, l: number) => void,
    addC: (b: number, c: EchoContributor) => void
  ) {
    const b0 = Math.round(range / this.binStep);
    accumulate(b0, level);
    addC(b0, { ...contributor, level });
    // 邻 bin 拖尾仅在回波确实跨门(小数偏移显著)时给出
    const frac = range / this.binStep - b0;
    const tail = -6 - 6 * Math.min(1, Math.abs(frac) * 2);
    if (tail > -12) {
      const dir = frac >= 0 ? 1 : -1;
      accumulate(b0 + dir, level + tail);
      addC(b0 + dir, { ...contributor, level: level + tail });
    }
  }
}

/** 声能非相干叠加(线性域求和后转回 dB) */
export function addDb(a: number, b: number): number {
  if (a <= -900) return b;
  if (b <= -900) return a;
  const mx = Math.max(a, b);
  return mx + 10 * Math.log10(1 + Math.pow(10, -Math.abs(a - b) / 10));
}

function hashCell(x: number, y: number): number {
  return ((x + 10000) * 73856093) ^ ((y + 10000) * 19349663);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
