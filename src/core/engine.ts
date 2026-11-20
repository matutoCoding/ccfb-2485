// 回波仿真引擎：每个 ping 按声束几何与距离门实时计算一列回波
// 输出原始电平(dB)与 TVG 修正两条曲线，显示端着色器再做增益/杂波/色标

import type {
  FishHit, FishSchool, FishSpecies, NoiseSettings, PingMeta, SeaArea, Transducer, Vec3,
} from './types';
import {
  absorptionDbPerM, beamTwoWayDb, clamp, fishEchoDb, knotToMs, pulseHalfGateM, rng,
  sourceLevel, targetStrengthDb, tvgDb,
} from './physics';
import {
  SUBSTRATE_ACOUSTIC, instantiateWorld, isOccluded, queryCone, rayBottom,
  slopeAt, solarFactor, substrateAt,
} from './world';

export const BIN_M = 0.1;                 // 每个距离门 0.1m（对应 1 像素行）
export const MAX_BINS = 1200;             // 最大 120m 量程
export const BOTTOM_BEAM_RAYS = 9;        // 波束内海底采样射线数
export const NL_REF = 30;                 // 人为噪声参考电平 dB（与 24dB 环境基底匹配，满 TVG 后仍低于窗口下沿）

export interface EngineChannel {
  transducer: Transducer;
  alpha: number;       // 吸收 dB/m
  sl: number;          // 声源级
  halfAngle: number;   // 波束半角 rad
  halfGate: number;    // 脉宽距离门半宽 m
}

export function makeChannel(t: Transducer, c: number): EngineChannel {
  return {
    transducer: t,
    alpha: absorptionDbPerM(t.frequency),
    sl: sourceLevel(t),
    halfAngle: (t.beamAngleDeg / 2) * Math.PI / 180,
    halfGate: pulseHalfGateM(t.pulseMs, c),
  };
}

export interface PingInput {
  time: number;
  hour: number;
  boat: Vec3;
  boatSpeed: number;      // m/s
  heading: number;        // rad
  pingRate: number;
  noise: NoiseSettings;
  tvgMode: 'off' | 'single' | 'school';
  tvgStrength: number;
}

/** 非相干叠加（压力域求和后回 dB） */
function sumDb(levels: number[]): number {
  if (levels.length === 0) return -Infinity;
  let s = 0;
  for (const l of levels) s += Math.pow(10, l / 20);
  return 20 * Math.log10(s);
}

export class EchoEngine {
  area: SeaArea;
  schools: FishSchool[];
  species: FishSpecies[];
  c: number;
  private fishCache: { hourQ: number; fish: ReturnType<EchoEngine['fishAtUncached']> } | null = null;

  constructor(area: SeaArea, schools: FishSchool[], species: FishSpecies[]) {
    this.area = area;
    this.schools = schools;
    this.species = species;
    this.c = area.soundSpeed;
  }

  private fishAtUncached(hour: number) {
    return instantiateWorld(this.area, this.schools, this.species, hour);
  }

  /** 给定小时的全部鱼目标实例（按 0.1h 量化缓存，双频通道共享） */
  fishAt(hour: number) {
    const hourQ = Math.round(hour * 10) / 10;
    if (!this.fishCache || this.fishCache.hourQ !== hourQ) {
      this.fishCache = { hourQ, fish: this.fishAtUncached(hourQ) };
    }
    return this.fishCache.fish;
  }

  /** 鱼群/鱼种编辑后使缓存失效 */
  invalidateFishCache(): void {
    this.fishCache = null;
  }

  /** 计算一个 ping，返回按 bin 的原始电平、TVG 曲线与反查元数据 */
  computePing(ch: EngineChannel, input: PingInput): PingMeta {
    const { area } = this;
    const nBins = MAX_BINS;
    const raw = new Float32Array(nBins).fill(-Infinity);
    const tvg = new Float32Array(nBins);
    const hits: FishHit[] = [];
    const substrateHits: PingMeta['substrateHits'] = [];
    const rand = rng((input.time * 1000 + ch.transducer.frequency) | 0);

    for (let b = 0; b < nBins; b++) {
      tvg[b] = tvgDb((b + 0.5) * BIN_M, ch.alpha, input.tvgMode, input.tvgStrength);
    }

    const fish = this.fishAt(input.hour);
    const cone = queryCone(fish, input.boat, ch.halfAngle, 2.5);
    const speciesMap = new Map(this.species.map((s) => [s.id, s]));

    // ---------- 1. 鱼回波（含月牙弧包络、贴底吞没） ----------
    for (const hit of cone) {
      const f = hit.fish;
      // 地形遮挡：声线被斜坡/礁石挡住 -> 波束盲区
      if (isOccluded(area, input.boat, { x: f.x, y: f.y, z: f.z })) continue;
      const sp = speciesMap.get(this.schoolOf(f.schoolId)?.speciesId ?? '');
      if (!sp) continue;
      const ts = targetStrengthDb(f.lengthCm, sp.b20, sp.b0);
      const bp = beamTwoWayDb(hit.thetaOff, ch.halfAngle);
      const centerLevel = fishEchoDb(ch.sl, ts, hit.range, ch.alpha, bp);
      // 脉宽包络：以斜距为中心、半宽 cτ/4 的升余弦，展宽到相邻距离门
      const bCenter = hit.range / BIN_M;
      const bHalf = Math.max(ch.halfGate / BIN_M, 0.6);
      const b0 = Math.max(0, Math.floor(bCenter - bHalf - 1));
      const b1 = Math.min(nBins - 1, Math.ceil(bCenter + bHalf + 1));
      let recorded = false;
      for (let b = b0; b <= b1; b++) {
        const d = Math.abs((b + 0.5) * BIN_M - hit.range) / ch.halfGate;
        if (d > 1) continue;
        const env = 0.5 * (1 + Math.cos(Math.PI * d)); // 升余弦 0..1
        const level = centerLevel + 20 * Math.log10(Math.max(env, 1e-4));
        // 贴底吞没：该门已在底回波包络内且更强时，鱼回波被吞（先记录，底回波后算）
        if (!recorded) {
          hits.push({
            schoolId: f.schoolId, fishIndex: f.index, range: hit.range,
            level: centerLevel, x: f.x, y: f.y, z: f.z,
          });
          recorded = true;
        }
        this.addLevel(raw, b, level);
      }
    }

    // ---------- 2. 海底回波（波束内多射线，取最近交点；按底质给强度/展宽） ----------
    let bottomRange = Infinity;
    let bottomLevel = -Infinity;
    let bottomSub = 1;
    for (let k = 0; k < BOTTOM_BEAM_RAYS; k++) {
      const ang = (k / (BOTTOM_BEAM_RAYS - 1) - 0.5) * 2 * ch.halfAngle;
      const rb = rayBottom(area, input.boat, ang, input.heading, nBins * BIN_M);
      if (!rb) continue;
      const sub = substrateAt(area, rb.x, rb.z);
      const ac = SUBSTRATE_ACOUSTIC[sub];
      const bp = beamTwoWayDb(ang, ch.halfAngle);
      // 坡度损失：声束斜射海床，镜面反射偏离换能器
      const slope = slopeAt(area, rb.x, rb.z);
      const slopeLoss = -8 * Math.pow(slope, 2) * 57.3 * 0.15;
      // 高频吸收更强已在 alpha 体现；底质反向散射 + 波束指向 + 双程传播
      const R = rb.range;
      const TL = 20 * Math.log10(Math.max(R, 0.5)) + ch.alpha * R;
      const level = ch.sl + ac.backscatter + bp + slopeLoss - 2 * TL;
      substrateHits.push({
        ix: clamp(Math.round(rb.x / area.width * (area.nx - 1)), 0, area.nx - 1),
        iz: clamp(Math.round(rb.z / area.length * (area.nz - 1)), 0, area.nz - 1),
        range: R, level,
      });
      if (R < bottomRange) {
        bottomRange = R; bottomLevel = level; bottomSub = sub;
      }
    }

    if (isFinite(bottomRange)) {
      const ac = SUBSTRATE_ACOUSTIC[bottomSub];
      // 底回波包络：脉宽门 + 底质粗糙度展宽（礁石硬底窄而强，泥底软而拖尾）
      const tailM = ch.halfGate * 2 + ac.roughness * 2.2;
      const bC = bottomRange / BIN_M;
      const b0 = Math.max(0, Math.floor(bC - ch.halfGate / BIN_M));
      const b1 = Math.min(nBins - 1, Math.ceil(bC + tailM / BIN_M));
      for (let b = b0; b <= b1; b++) {
        const d = (b + 0.5) * BIN_M - bottomRange;
        let env: number;
        if (d <= 0) env = 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.abs(d) / ch.halfGate)));
        else env = Math.exp(-d / (ac.roughness * 1.6 + 0.12)); // 向下拖尾
        const level = bottomLevel + 20 * Math.log10(Math.max(env, 1e-4));
        // 鱼贴底吞没：底回波门内，弱于海底的鱼回波被覆盖（取强者）
        this.addLevelMax(raw, b, level);
      }
      // ---------- 二次回波（多路径，2R 处，按底质衰减） ----------
      const r2 = bottomRange * 2;
      if (r2 < nBins * BIN_M) {
        const lvl2 = bottomLevel + ac.secondEchoGain;
        const bC = r2 / BIN_M;
        const b0 = Math.max(0, Math.floor(bC - 1));
        const b1 = Math.min(nBins - 1, Math.ceil(bC + tailM / BIN_M + 2));
        for (let b = b0; b <= b1; b++) {
          const d = (b + 0.5) * BIN_M - r2;
          const env = Math.exp(-Math.abs(d) / (tailM + 0.2));
          this.addLevel(raw, b, lvl2 + 20 * Math.log10(Math.max(env, 1e-4)));
        }
      }
    }

    // ---------- 3. 温跃层 ----------
    const tc = area.thermocline;
    if (tc.enabled) {
      for (let b = 0; b < nBins; b++) {
        const r = (b + 0.5) * BIN_M;
        const d = (r - tc.top) / (tc.thickness / 2);
        if (Math.abs(d) < 1) {
          const env = 0.5 * (1 + Math.cos(Math.PI * d));
          const level = NL_REF - 8 + 18 * tc.strength * env - 0.02 * r;
          this.addLevel(raw, b, level + (rand() - 0.5) * 3);
        }
      }
    }

    // ---------- 4. 浮游生物散射层（随昼夜迁移） ----------
    const pl = area.planktonLayer;
    if (pl.enabled) {
      const day = solarFactor(input.hour);
      const layerDepth = pl.nightDepth + (pl.dayDepth - pl.nightDepth) * day;
      for (let b = 0; b < nBins; b++) {
        const r = (b + 0.5) * BIN_M;
        const d = (r - layerDepth) / (pl.thickness / 2);
        if (Math.abs(d) < 1) {
          const env = 0.5 * (1 + Math.cos(Math.PI * d));
          // 高频对浮游生物散射敏感得多（频率相关 Rayleigh 散射 ~ 20log f 比）
          const freqBoost = 20 * Math.log10(ch.transducer.frequency / 50000);
          const level = NL_REF - 12 + 16 * pl.strength * env + freqBoost;
          this.addLevel(raw, b, level + (rand() - 0.5) * 4);
        }
      }
    }

    // ---------- 5. 环境与人为噪声 ----------
    let noisePeak = -Infinity;
    const boatKnot = input.boatSpeed / 0.514444;
    for (let b = 0; b < nBins; b++) {
      const r = (b + 0.5) * BIN_M;
      // 接收机底噪方差小（±2dB），避免 TVG 放大后的随机峰值成片越过显示窗口下沿
      let nl = input.noise.ambient + (rand() - 0.5) * 2;
      // 船尾流气泡：近表层强、随深度衰减，随航速增强
      if (input.noise.wakeBubbles && r < 12) {
        const w = input.noise.wakeLevel * (18 + 8 * Math.min(boatKnot / 8, 1)) * Math.exp(-r / 5);
        nl = sumDb([nl, NL_REF - 6 + w]);
      }
      // 发动机干扰：低频水平条纹（全深度周期条带）
      if (input.noise.engine) {
        const stripe = Math.sin(r * 2.4 + input.time * 9) > 0.86 ? 1 : 0;
        nl = sumDb([nl, NL_REF - 4 + input.noise.engineLevel * 16 * stripe]);
      }
      // 别船串频：偶发全深度脉冲（按 ping 时间伪随机）
      if (input.noise.crosstalk && rand() > 0.985) {
        nl = sumDb([nl, NL_REF + input.noise.crosstalkLevel * 14 + (rand() - 0.5) * 6]);
      }
      noisePeak = Math.max(noisePeak, nl);
      this.addLevel(raw, b, nl);
    }

    return {
      time: input.time,
      boatX: input.boat.x, boatZ: input.boat.z,
      boatSpeed: input.boatSpeed,
      bottomRange: isFinite(bottomRange) ? bottomRange : -1,
      raw, tvg, hits, substrateHits, noisePeak,
    };
  }

  private schoolOf(id: string): FishSchool | undefined {
    return this.schools.find((s) => s.id === id);
  }

  /** 压力域非相干叠加 */
  private addLevel(buf: Float32Array, b: number, db: number) {
    if (!isFinite(db)) return;
    if (!isFinite(buf[b])) buf[b] = db;
    else buf[b] = sumDb([buf[b], db]);
  }

  /** 强者覆盖（用于底回波吞没鱼回波） */
  private addLevelMax(buf: Float32Array, b: number, db: number) {
    if (isFinite(db) && db > buf[b]) buf[b] = db;
  }
}

/** 沿航线按时间求船位/航向/航速（折线线性插值） */
export function sampleRoute(
  route: { x: number; z: number; speed: number }[], dist: number,
): { x: number; z: number; heading: number; speed: number; done: boolean } {
  if (route.length === 0) return { x: 0, z: 0, heading: 0, speed: 0, done: true };
  if (route.length === 1) {
    return { x: route[0].x, z: route[0].z, heading: 0, speed: knotToMs(route[0].speed), done: true };
  }
  let acc = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + seg >= dist || i === route.length - 2) {
      const t = seg > 1e-6 ? clamp((dist - acc) / seg, 0, 1) : 1;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        heading: Math.atan2(b.x - a.x, b.z - a.z),
        speed: knotToMs(a.speed + (b.speed - a.speed) * t),
        done: i === route.length - 2 && t >= 1,
      };
    }
    acc += seg;
  }
  const last = route[route.length - 1];
  return { x: last.x, z: last.z, heading: 0, speed: knotToMs(last.speed), done: true };
}

export function routeTotalLength(route: { x: number; z: number }[]): number {
  let L = 0;
  for (let i = 0; i < route.length - 1; i++) L += Math.hypot(route[i + 1].x - route[i].x, route[i + 1].z - route[i].z);
  return L;
}
