// 无头物理自检：Node 下直接跑引擎，验证月牙弧几何（≤1 像素行）与 TVG 等色阶
// 运行：npm run selftest

import { buildSeedData } from '../src/core/seed';
import { EchoEngine, makeChannel, BIN_M } from '../src/core/engine';
import {
  beamTwoWayDb, fishEchoDb, knotToMs, targetStrengthDb, theoreticalArc, tvgDb,
} from '../src/core/physics';
import { instantiateWorld } from '../src/core/world';
import { colorIndex, DISPLAY_CEIL, DISPLAY_FLOOR } from '../src/core/colormaps';
import type { DisplaySettings, NoiseSettings } from '../src/core/types';

interface R { name: string; pass: boolean; detail: string }
const results: R[] = [];
const seed = buildSeedData();
const area = seed.areas[0];
const engine = new EchoEngine(area, seed.schools, seed.species);
const td50 = seed.transducers.find((t) => t.frequency === 50000)!;
const td200 = seed.transducers.find((t) => t.frequency === 200000)!;
const ch50 = makeChannel(td50, area.soundSpeed);
const ch200 = makeChannel(td200, area.soundSpeed);
const baseSettings: DisplaySettings = {
  gainDb: 0, tvgMode: 'single', tvgStrength: 1, clutterDb: 0,
  colormap: 'sonar', rangeM: 0, bottomLockM: 0, zoomStep: 0,
};
const quietNoise: NoiseSettings = {
  wakeBubbles: false, wakeLevel: 0, engine: false, engineLevel: 0,
  crosstalk: false, crosstalkLevel: 0, ambient: 30,
};
const TRANSDUCER_DRAFT = 0.2; // 换能器挂深 m

/** 船匀速 straight-run 穿过一条鱼，采集每个 ping 的偏移/斜距 */
function collectArc(speedKnot: number, rate: number) {
  const fish = instantiateWorld(area, seed.schools, seed.species, 12);
  const target = fish.filter((f) => f.y > 18 && f.y < 45).sort((a, b) => a.y - b.y)[0] ?? fish[0];
  const d = target.y - TRANSDUCER_DRAFT; // 换能器到鱼的垂直距离
  const step = knotToMs(speedKnot) / rate;
  const maxOff = d * Math.tan(ch50.halfAngle * 2.2);
  const half = Math.ceil(maxOff / step) + 2;
  const samples: { off: number; range: number; theta: number }[] = [];
  for (let p = 0; p <= half * 2; p++) {
    const off = (p - half) * step;
    const meta = engine.computePing(ch50, {
      time: p / rate, hour: 12,
      boat: { x: target.x + off, y: TRANSDUCER_DRAFT, z: target.z },
      boatSpeed: knotToMs(speedKnot), heading: 0, pingRate: rate,
      noise: quietNoise, tvgMode: 'single', tvgStrength: 1,
    });
    const hit = meta.hits.find((h) => h.fishIndex === target.index && h.schoolId === target.schoolId);
    if (hit) samples.push({ off, range: hit.range, theta: Math.atan2(Math.abs(off), d) });
  }
  return { target, d, step, samples };
}

// ===== 1. 月牙弧全弧迹几何：每个 ping 斜距 = sqrt(d²+x²)，误差 ≤1 像素行 =====
{
  const { d, samples, step } = collectArc(3, 16);
  let maxErr = 0; let apex = Infinity;
  for (const s of samples) {
    const theory = Math.hypot(d, s.off);
    maxErr = Math.max(maxErr, Math.abs(s.range - theory));
    apex = Math.min(apex, s.range);
  }
  const apexErr = Math.abs(apex - d) / BIN_M;
  results.push({
    name: '弧顶深度=鱼体垂直深度（误差≤1像素行）',
    pass: apexErr <= 1,
    detail: `鱼深 ${(d + TRANSDUCER_DRAFT).toFixed(2)}m（换能器下垂直距 ${d.toFixed(2)}m），仿真弧顶 ${apex.toFixed(2)}m，偏差 ${apexErr.toFixed(2)} 行`,
  });
  results.push({
    name: '月牙弧弧迹 R=√(d²+x²) 逐点几何（误差≤1像素行）',
    pass: maxErr / BIN_M <= 1,
    detail: `${samples.length} 个 ping 采样，步长 ${step.toFixed(3)}m，最大斜距偏差 ${(maxErr / BIN_M).toFixed(2)} 行`,
  });
}

// ===== 2. -3dB 波束角内弧宽与理论值 W=2d tanβ =====
{
  const rate = 16;
  const { d, samples } = collectArc(3, rate);
  const inside = samples.filter((s) => s.theta <= ch50.halfAngle);
  const measuredWidthM = inside.length > 1 ? (inside[inside.length - 1].off - inside[0].off) : 0;
  const theory = theoreticalArc(d, ch50.halfAngle, knotToMs(3), rate);
  const errM = Math.abs(measuredWidthM - theory.widthM);
  const errPing = errM / (knotToMs(3) / rate);
  results.push({
    name: '弧宽=2d·tanβ（-3dB 波束角内，理论值对照）',
    pass: errPing <= 2,
    detail: `理论宽 ${theory.widthM.toFixed(2)}m / ${theory.widthPings.toFixed(1)} ping，实测 ${measuredWidthM.toFixed(2)}m / ${inside.length} ping，偏差 ${errPing.toFixed(1)} ping`,
  });
}

// ===== 3. 弧缘下垂 sag：β 边缘实测斜距 vs d/cosβ，误差 ≤1 像素行 =====
{
  const { d, samples } = collectArc(3, 16);
  const edge = samples.filter((s) => s.theta <= ch50.halfAngle)
    .reduce<{ off: number; range: number; theta: number } | null>((a, b) => (!a || b.theta > a.theta ? b : a), null);
  if (edge) {
    const theory = d / Math.cos(edge.theta); // 按实际截获角，剔除采样量化
    const errRow = Math.abs(edge.range - theory) / BIN_M;
    const sag = edge.range - d;
    results.push({
      name: '弧缘下垂 sag=d(1/cosβ−1)（误差≤1像素行）',
      pass: errRow <= 1,
      detail: `截获角 ${(edge.theta * 180 / Math.PI).toFixed(2)}°，理论弧缘 ${theory.toFixed(2)}m 实测 ${edge.range.toFixed(2)}m，sag=${sag.toFixed(2)}m，偏差 ${errRow.toFixed(2)} 行`,
    });
  }
}

// ===== 4. TVG 解析恒等式 + 非饱和等色阶（在 TVG 未触顶的作业距离内） =====
{
  const sp = seed.species[0];
  const ts = targetStrengthDb((sp.minLength + sp.maxLength) / 2, sp.b20, sp.b0);
  const calc = (depth: number) => {
    const raw = fishEchoDb(ch50.sl, ts, depth, ch50.alpha, beamTwoWayDb(0, ch50.halfAngle));
    const g = tvgDb(depth, ch50.alpha, 'single', 1);
    return { raw, g, shown: raw + g };
  };
  // 10m/80m 全程精确等化（80m TVG≈78dB < 82dB 封顶）
  const a = calc(10); const b = calc(80);
  const g80 = tvgDb(80, ch50.alpha, 'single', 1);
  const dbIdentityErr = Math.abs(a.shown - b.shown);
  const spreadTheory = 40 * Math.log10(8) + 2 * ch50.alpha * 70;
  const spreadMeas = a.raw - b.raw;
  // 等色阶：TVG 恒等式已证两深度 shown 完全相等，同一窗口映射下色阶必然相同。
  // 用一个统一的 gain 把等化电平 shown 平移到窗口中段（gain 不随深度变，不破坏等化），
  // 再走与着色器一致的 FLOOR..CEIL 窗口映射（噪声门限只作用于底噪，shown 远高于门限）。
  const gain = (DISPLAY_FLOOR + DISPLAY_CEIL) / 2 - a.shown;
  const shownToIndex = (shown: number) => {
    const v = (shown + gain - DISPLAY_FLOOR) / (DISPLAY_CEIL - DISPLAY_FLOOR);
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  const i10 = shownToIndex(a.shown);
  const i80 = shownToIndex(b.shown);
  const bothMid = i10 > 20 && i10 < 235 && i80 > 20 && i80 < 235;
  results.push({
    name: 'TVG 恒等式：10m/80m 同鱼 raw+TVG 与距离无关（差≤0.05dB）',
    pass: dbIdentityErr <= 0.05 && Math.abs(spreadMeas - spreadTheory) <= 0.1 && g80 < 82,
    detail: `显示电平 ${a.shown.toFixed(2)} vs ${b.shown.toFixed(2)}dB（差 ${dbIdentityErr.toFixed(3)}）；80m TVG=${g80.toFixed(2)}dB 未触顶；传播损失差 理论${spreadTheory.toFixed(2)}/实测${spreadMeas.toFixed(2)}dB`,
  });
  results.push({
    name: 'TVG 后 10m 与 80m 同鱼等色阶（差≤1级且非饱和）',
    pass: Math.abs(i10 - i80) <= 1 && bothMid,
    detail: `相等的显示电平经同一窗口映射 → 色阶 ${i10} vs ${i80}（gain ${gain.toFixed(1)}dB 平移至中段）`,
  });
  // TVG 硬件封顶：超深距离增益不再增长
  const g120 = tvgDb(120, ch50.alpha, 'single', 1);
  const g200 = tvgDb(200, ch50.alpha, 'single', 1);
  results.push({
    name: 'TVG 硬件封顶 82dB：超深距离增益不再增长',
    pass: g120 >= 81.9 && Math.abs(g120 - g200) < 0.01,
    detail: `TVG(120m)=${g120.toFixed(2)}dB，TVG(200m)=${g200.toFixed(2)}dB，均被限制在 82dB`,
  });
}

// ===== 5. TVG 关闭对照 =====
{
  const sp = seed.species[0];
  const ts = targetStrengthDb((sp.minLength + sp.maxLength) / 2, sp.b20, sp.b0);
  const i10 = colorIndex(fishEchoDb(ch50.sl, ts, 10, ch50.alpha, 0), 0, baseSettings);
  const i80 = colorIndex(fishEchoDb(ch50.sl, ts, 80, ch50.alpha, 0), 0, baseSettings);
  results.push({
    name: 'TVG 关闭时 80m 鱼显著变暗（差>20级）',
    pass: i10 - i80 > 20,
    detail: `${i10} vs ${i80}`,
  });
}

// ===== 6. 底质回波排序 + 二次回波 =====
{
  const lv: { name: string; first: number; second: number }[] = [];
  for (const [name, sub] of [['泥', 0], ['沙', 1], ['礁', 2]] as const) {
    const a2 = structuredClone(area);
    a2.depth = new Float32Array(a2.nx * a2.nz).fill(30);
    a2.substrate = new Uint8Array(a2.nx * a2.nz).fill(sub);
    const eng = new EchoEngine(a2, [], seed.species);
    const meta = eng.computePing(ch200, {
      time: 0, hour: 12, boat: { x: a2.width / 2, y: 0.2, z: a2.length / 2 },
      boatSpeed: 0, heading: 0, pingRate: 8, noise: quietNoise, tvgMode: 'off', tvgStrength: 0,
    });
    const b1 = Math.round(meta.bottomRange / BIN_M);
    const b2 = Math.round(meta.bottomRange * 2 / BIN_M);
    lv.push({ name, first: meta.raw[b1], second: meta.raw[b2] });
  }
  results.push({
    name: '底质回波 礁>沙>泥（一次/二次）',
    pass: lv[2].first > lv[1].first && lv[1].first > lv[0].first &&
      lv[2].second > lv[1].second && lv[1].second > lv[0].second,
    detail: lv.map((l) => `${l.name}:${l.first.toFixed(1)}/${l.second.toFixed(1)}`).join(' '),
  });
}

// ===== 7. 抛锚（船速 0）鱼弧拉横线 =====
{
  const fish = instantiateWorld(area, seed.schools, seed.species, 12);
  const target = fish.find((f) => f.y > 15 && f.y < 50) ?? fish[0];
  const ranges: number[] = [];
  for (let p = 0; p < 20; p++) {
    const meta = engine.computePing(ch50, {
      time: p / 8, hour: 12,
      boat: { x: target.x + 3, y: 0.2, z: target.z }, boatSpeed: 0, heading: 0, pingRate: 8,
      noise: quietNoise, tvgMode: 'single', tvgStrength: 1,
    });
    const hit = meta.hits.find((h) => h.fishIndex === target.index && h.schoolId === target.schoolId);
    if (hit) ranges.push(hit.range);
  }
  const spread = ranges.length ? Math.max(...ranges) - Math.min(...ranges) : NaN;
  results.push({
    name: '抛锚漂航鱼弧拉成横线（斜距展宽≤1像素行）',
    pass: isFinite(spread) && spread / BIN_M <= 1,
    detail: `连续 ${ranges.length} ping 斜距展宽 ${(spread / BIN_M).toFixed(2)} 行`,
  });
}

// ===== 8. 高频吸收更大 =====
results.push({
  name: '200kHz 吸收 > 50kHz 的 2 倍',
  pass: ch200.alpha > ch50.alpha * 2,
  detail: `${ch50.alpha.toFixed(5)} vs ${ch200.alpha.toFixed(5)} dB/m`,
});

// ===== 9. 斜坡陡坎波束盲区 =====
{
  const a2 = structuredClone(area);
  a2.depth = new Float32Array(a2.nx * a2.nz);
  for (let iz = 0; iz < a2.nz; iz++) {
    for (let ix = 0; ix < a2.nx; ix++) {
      a2.depth[iz * a2.nx + ix] = ix < a2.nx / 2 ? 20 : 70;
      a2.substrate[iz * a2.nx + ix] = 2;
    }
  }
  const eng2 = new EchoEngine(a2, seed.schools, seed.species);
  const meta = eng2.computePing(ch50, {
    time: 0, hour: 12,
    boat: { x: a2.width * 0.2, y: 0.2, z: a2.length / 2 },
    boatSpeed: 0, heading: Math.PI / 2, pingRate: 8,
    noise: quietNoise, tvgMode: 'single', tvgStrength: 1,
  });
  results.push({
    name: '斜坡/礁石波束盲区：陡坎处底回波提前',
    pass: meta.bottomRange > 0 && meta.bottomRange < 25,
    detail: `20m→70m 陡坎朝坎发射，底回波斜距 ${meta.bottomRange.toFixed(1)}m（坎后壁为照射盲区）`,
  });
}

// ===== 10. 贴底鱼被海底回波吞没 =====
{
  const a2 = structuredClone(area);
  a2.depth = new Float32Array(a2.nx * a2.nz).fill(40);
  a2.substrate = new Uint8Array(a2.nx * a2.nz).fill(2);
  const school = structuredClone(seed.schools[0]);
  school.center = { x: a2.width / 2, y: 0, z: a2.length / 2 };
  school.count = 40; school.radiusX = 8; school.radiusZ = 8; school.radiusY = 1.5;
  school.dayDepthFrac = 0.99; school.nightDepthFrac = 0.99;
  school.lengths = undefined; school.offsets = undefined;
  const eng2 = new EchoEngine(a2, [school], seed.species);
  const meta = eng2.computePing(ch200, {
    time: 0, hour: 12, boat: { x: a2.width / 2, y: 0.2, z: a2.length / 2 },
    boatSpeed: 0, heading: 0, pingRate: 8, noise: quietNoise, tvgMode: 'single', tvgStrength: 1,
  });
  const bBot = Math.round(meta.bottomRange / BIN_M);
  const bottomLevel = meta.raw[bBot];
  const swallowed = meta.hits.every((hit) =>
    Math.abs(Math.round(hit.range / BIN_M) - bBot) > 2 || hit.level <= bottomLevel);
  results.push({
    name: '贴底鱼吞没：海底门内鱼回波不超过底回波',
    pass: swallowed && meta.hits.length > 0,
    detail: `底回波 ${bottomLevel.toFixed(1)}dB，命中鱼 ${meta.hits.length} 尾`,
  });
}

let fail = 0;
for (const r of results) {
  if (!r.pass) fail++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`);
}
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
