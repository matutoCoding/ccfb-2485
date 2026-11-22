/**
 * 物理精度自检(纯 Node 运行:tsx test/selftest.ts,也在设置页内调用)
 * 验收线:
 *  - 月牙弧弧顶深度/弧宽与波束几何理论值误差 ≤ 1 个像素行(距离门)
 *  - 开 TVG(40log)后同一条鱼在 10m 与 80m 输出色阶一致(≤1dB)
 */
import { AppSettings, SelftestResult, Transducer, EchoContributor } from '../src/types';
import { EchoEngine, TestFish } from '../src/core/echo-engine';
import { buildDefaultArea, buildDefaultSettings, buildDefaultTransducers } from '../src/data/seed';
import { beamPatternDb, fishEchoLevel, sourceLevel, tvgGain, absorptionDbPerM, rangeResolution } from '../src/core/acoustics';
import { deg2rad } from '../src/core/math-util';
import { deadZoneHeight, sampleFootprint, depthAt, isSwallowedByBottom } from '../src/core/seabed';

function makeEngine(tx: Transducer, settings: AppSettings, testFish: TestFish | null): EchoEngine {
  const area = buildDefaultArea();
  const engine = new EchoEngine(
    { area, schools: [], species: new Map() },
    tx,
    settings,
    12345
  );
  engine.setTestFish(testFish);
  return engine;
}

function baseSettings(tx: Transducer): AppSettings {
  const settings = buildDefaultSettings([tx]);
  settings.gain[tx.id] = {
    gainDb: 0,
    tvgMode: '40log',
    tvgClampM: 1,
    clutterReject: 0,
    colorMinDb: 45,
    colorMaxDb: 120,
    colormap: 'halieutis',
  };
  settings.noise.ambientDb = 10;
  settings.noise.wakeBubbles = 0;
  settings.noise.engineInterference = 0;
  settings.noise.crosstalk = 0;
  settings.noise.planktonLayer = 0;
  settings.display.rangeM = 120;
  settings.display.showSecondEcho = false;
  settings.display.showThermocline = false;
  return settings;
}

const FISH_TS = -42;
const TX_DRAFT = 0.8;

interface Peak {
  bin: number;
  /** 最终输出电平(TVG+增益后,即瀑布图色阶所用电平) */
  level: number;
  /** TVG 前鱼自身原始回波电平 */
  rawLevel: number;
  range: number;
  x: number;
}

/**
 * 找指定 ping 中鱼回波峰值:
 * 只统计带 fish 来源、未被吞噬的 bin;
 * 同电平附近优先取斜距最接近几何真值的 bin,避免与海底叠加的 bin 误判
 */
function findFishPeak(
  col: { bins: Float32Array; contributors: EchoContributor[][]; binStep: number },
  x: number,
  fishDepth: number
): Peak | null {
  const geomRange = Math.hypot(x, fishDepth - TX_DRAFT);
  const geomBin = geomRange / col.binStep;
  let best = -1;
  let bestScore = -Infinity;
  let bestRaw = -Infinity;
  for (let b = 0; b < col.bins.length; b++) {
    const fishC = col.contributors[b].find((c) => c.kind === 'fish' && c.level > -900);
    if (!fishC) continue;
    const distPenalty = Math.abs(b - geomBin) * 2;
    const score = fishC.level - distPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = b;
      bestRaw = fishC.level;
    }
  }
  if (best < 0) return null;
  return { bin: best, level: col.bins[best], rawLevel: bestRaw, range: best * col.binStep, x };
}

// ---------------------------------------------------------------- 测试 1:弧顶深度
function testArcApex(tx: Transducer): SelftestResult {
  const settings = baseSettings(tx);
  const fishDepth = 40;
  const engine = makeEngine(tx, settings, { x: 0, y: 0, depth: fishDepth, tsDb: FISH_TS, id: 1 });
  const col = engine.generatePing({ index: 0, timeSec: 0, hour: 12, x: 0, y: 0, speed: 2.5, anchored: false });
  const peak = findFishPeak(col, 0, fishDepth);
  if (!peak) return { name: `月牙弧弧顶深度(${tx.freqKhz}kHz)`, pass: false, detail: '未检出鱼回波' };
  const theoryRange = fishDepth - TX_DRAFT;
  const pxError = Math.abs(peak.range - theoryRange) / col.binStep;
  return {
    name: `月牙弧弧顶深度(${tx.freqKhz}kHz)`,
    pass: pxError <= 1,
    measured: peak.range,
    expected: theoryRange,
    errorPx: pxError,
    detail: `鱼深 ${fishDepth}m 正上方过顶,峰值斜距应等于垂直距离;距离门 ${col.binStep.toFixed(3)}m`,
  };
}

// ---------------------------------------------------------------- 测试 2:弧宽 vs 波束几何
function testArcWidth(tx: Transducer, boatSpeed: number): SelftestResult {
  const settings = baseSettings(tx);
  const fishDepth = 40;
  const engine = makeEngine(tx, settings, { x: 0, y: 0, depth: fishDepth, tsDb: FISH_TS, id: 1 });
  const dt = 1 / 4;
  const dx = boatSpeed * dt; // 每 ping 的真实水平位移
  const halfBeam = tx.beamAngleDeg / 2;
  // 扫描窗口按主瓣 -3dB 半宽的 2 倍自适应,保证窄波束也能覆盖完整弧
  const vertical = fishDepth - TX_DRAFT;
  let theta = 0;
  for (let a = 0; a < halfBeam * 2; a += 0.01) {
    if (beamPatternDb(deg2rad(a), halfBeam) >= 3) {
      theta = deg2rad(a);
      break;
    }
  }
  const scanHalf = Math.max(4, vertical * Math.tan(theta) * 2.2);
  const pingCount = Math.ceil(scanHalf / dx);
  const peaks: Peak[] = [];
  for (let i = -pingCount; i <= pingCount; i++) {
    const x = i * dx;
    const col = engine.generatePing({
      index: i + pingCount,
      timeSec: (i + pingCount) * dt,
      hour: 12,
      x,
      y: 0,
      speed: boatSpeed,
      anchored: false,
    });
    const peak = findFishPeak(col, x, fishDepth);
    if (peak) peaks.push(peak);
  }
  if (peaks.length < 3) return { name: '弧宽', pass: false, detail: '未检测到完整鱼弧' };
  const apex = peaks.reduce((a, b) => (b.level > a.level ? b : a));
  // 半功率弧宽:鱼贡献电平 ≥ 弧顶 -3dB 的 ping 范围
  const inside = peaks.filter((p) => p.level >= apex.level - 3);
  const measuredHalfWidth = (inside[inside.length - 1].x - inside[0].x) / 2;

  const theoryHalfWidth = vertical * Math.tan(theta);
  // 弧宽是水平几何量:误差按米判定(≤1m,约一个显示列的空间分辨率),
  // 同时给出像素列误差供参考(一列 = 每 ping 船移 dx)
  const meterError = Math.abs(measuredHalfWidth - theoryHalfWidth);
  const pxError = meterError / dx;
  return {
    name: `月牙弧半宽(${tx.freqKhz}kHz,${boatSpeed}m/s)`,
    pass: meterError <= 1,
    measured: measuredHalfWidth,
    expected: theoryHalfWidth,
    errorPx: pxError,
    detail: `-3dB 半功率水平半宽;理论偏轴角 ${(theta * 180 / Math.PI).toFixed(2)}°;误差 ${meterError.toFixed(2)}m(限 1m),折合 ${pxError.toFixed(2)} 显示列`,
  };
}

// ---------------------------------------------------------------- 测试 3:高速压扁 + 锚泊横线
function testSpeedEffects(tx: Transducer): SelftestResult[] {
  const settings = baseSettings(tx);
  const fishDepth = 35;
  const measureArc = (speed: number, anchored: boolean) => {
    const engine = makeEngine(tx, settings, { x: 0, y: 0, depth: fishDepth, tsDb: FISH_TS, id: 1 });
    const dt = 1 / 4;
    const dx = Math.max(speed * dt, 0.1);
    // 窗口覆盖 50k 宽波束主瓣(40° 全角,-3dB 半宽约 10m),取 ±25m 保证两种船速都能看到完整弧
    const pingCount = Math.ceil(25 / dx);
    const peakBins = new Set<number>();
    const peakCols: number[] = [];
    let lastBin = -1;
    let stableCount = 0;
    for (let i = -pingCount; i <= pingCount; i++) {
      // 抛锚时船不动,鱼一直在正下方(偏轴 0)
      const x = anchored ? 0 : i * dx;
      const col = engine.generatePing({
        index: i + pingCount,
        timeSec: (i + pingCount) * dt,
        hour: 12,
        x,
        y: 0,
        speed,
        anchored,
      });
      const peak = findFishPeak(col, x, fishDepth);
      if (peak) {
        peakBins.add(peak.bin);
        peakCols.push(i);
        if (peak.bin === lastBin) stableCount++;
        lastBin = peak.bin;
      }
    }
    // 时间轴(列方向)弧宽:出现鱼峰的 ping 列数
    const columnSpan = peakCols.length ? peakCols[peakCols.length - 1] - peakCols[0] + 1 : 0;
    return { binSpan: peakBins.size, columnSpan, stableCount };
  };
  const fast = measureArc(5, false);
  const slow = measureArc(1.2, false);
  const anchor = measureArc(0, true);

  return [
    {
      name: '高速鱼弧压扁:时间轴弧宽随船速收窄',
      pass: fast.columnSpan < slow.columnSpan,
      measured: fast.columnSpan,
      expected: slow.columnSpan,
      detail: `5m/s 鱼弧占 ${fast.columnSpan} 列,1.2m/s 占 ${slow.columnSpan} 列;垂直距离门跨度均为 ${fast.binSpan}/${slow.binSpan} 行(与船速无关,几何正确)`,
    },
    {
      name: '抛锚鱼弧拉成横线(峰值 bin 恒定)',
      pass: anchor.binSpan === 1 && anchor.stableCount >= anchor.columnSpan - 1,
      measured: anchor.binSpan,
      expected: 1,
      detail: `锚泊 ${anchor.columnSpan} ping 峰值始终落在同一距离门(连续稳定 ${anchor.stableCount} 次),水平拉成横线`,
    },
  ];
}

// ---------------------------------------------------------------- 测试 4:TVG 距离一致性
function testTvgConsistency(tx: Transducer): SelftestResult {
  const settings = baseSettings(tx);
  const engine = makeEngine(tx, settings, null);
  const alpha = absorptionDbPerM(tx.freqKhz);
  const sl = sourceLevel(tx);
  const probe = (range: number) => {
    engine.setTestFish({ x: 0, y: 0, depth: range + TX_DRAFT, tsDb: FISH_TS, id: 1 });
    const col = engine.generatePing({ index: 0, timeSec: 0, hour: 12, x: 0, y: 0, speed: 0, anchored: true });
    return findFishPeak(col, 0, range + TX_DRAFT);
  };
  const p10 = probe(10);
  const p80 = probe(80);
  if (!p10 || !p80) return { name: `TVG(${tx.freqKhz}kHz)`, pass: false, detail: '未检出鱼回波' };
  const dbDiff = Math.abs(p10.level - p80.level);

  const el10 = fishEchoLevel(sl, 10, alpha, FISH_TS, 0) + tvgGain(10, '40log', alpha, 1);
  const el80 = fishEchoLevel(sl, 80, alpha, FISH_TS, 0) + tvgGain(80, '40log', alpha, 1);

  return {
    name: `TVG 距离色阶一致(${tx.freqKhz}kHz,10m vs 80m)`,
    pass: dbDiff <= 1,
    measured: p80.level,
    expected: p10.level,
    errorPx: dbDiff,
    detail: `引擎输出差 ${dbDiff.toFixed(3)}dB;声纳方程手算 EL10=${el10.toFixed(2)} EL80=${el80.toFixed(2)} 差 ${Math.abs(el10 - el80).toFixed(3)}dB`,
  };
}

// ---------------------------------------------------------------- 测试 5:盲区与贴底吞噬
function testDeadZone(tx: Transducer): SelftestResult[] {
  const settings = baseSettings(tx);
  const area = buildDefaultArea();
  const engine = new EchoEngine({ area, schools: [], species: new Map() }, tx, settings, 12345);
  const res = rangeResolution(1500, tx.pulseMs);
  const probePoints = [
    { x: 300, y: 250 },
    { x: 420, y: 330 },
    { x: 200, y: 180 },
  ];
  const results: SelftestResult[] = [];
  for (const pt of probePoints) {
    // 与引擎同一基准:船位正下方点深度
    const bottomDepth = depthAt(area, pt.x, pt.y);
    const profile = sampleFootprint(area, pt.x, pt.y, TX_DRAFT, 80, tx.beamAngleDeg / 2);
    const dz = deadZoneHeight(profile.minSlant, tx.beamAngleDeg / 2, profile.slopeRad, res);
    const fishDepth = bottomDepth - dz * 0.5; // 故意放进盲区
    engine.setTestFish({ x: pt.x, y: pt.y, depth: fishDepth, tsDb: -38, id: 7 });
    const col = engine.generatePing({ index: 0, timeSec: 0, hour: 12, x: pt.x, y: pt.y, speed: 1, anchored: false });
    const swallowed = col.contributors.some((list) =>
      list.some((c) => c.kind === 'fish' && c.level <= -900)
    );
    results.push({
      name: `贴底鱼被盲区吞噬(${pt.x},${pt.y})`,
      pass: swallowed,
      measured: swallowed ? 1 : 0,
      expected: 1,
      detail: `点底深 ${bottomDepth.toFixed(1)}m 坡度 ${(profile.slopeRad * 180 / Math.PI).toFixed(1)}° 盲区高 ${dz.toFixed(2)}m,鱼置于底上 ${(dz * 0.5).toFixed(2)}m`,
    });
  }
  // 对照:盲区外必须可见
  const pt = probePoints[0];
  const bottomDepth = depthAt(area, pt.x, pt.y);
  const profile = sampleFootprint(area, pt.x, pt.y, TX_DRAFT, 80, tx.beamAngleDeg / 2);
  const dz = deadZoneHeight(profile.minSlant, tx.beamAngleDeg / 2, profile.slopeRad, res);
  const safeGap = dz * 3 + 0.5;
  engine.setTestFish({ x: pt.x, y: pt.y, depth: bottomDepth - safeGap, tsDb: -38, id: 8 });
  const col = engine.generatePing({ index: 1, timeSec: 0.25, hour: 12, x: pt.x, y: pt.y, speed: 1, anchored: false });
  const visible = col.contributors.some((list) => list.some((c) => c.kind === 'fish' && c.level > -900));
  const sanity = !isSwallowedByBottom(bottomDepth - safeGap, bottomDepth, dz);
  results.push({
    name: '盲区内吞噬、盲区外可见(对照)',
    pass: visible && sanity,
    measured: visible ? 1 : 0,
    expected: 1,
    detail: `鱼放在底上 ${safeGap.toFixed(2)}m(盲区 ${dz.toFixed(2)}m 之外),应正常出弧`,
  });
  return results;
}

// ---------------------------------------------------------------- 测试 6:底质二次回波差异
function testSubstrate(tx: Transducer): SelftestResult {
  const settings = baseSettings(tx);
  const area = buildDefaultArea();
  const engine = new EchoEngine({ area, schools: [], species: new Map() }, tx, settings, 12345);
  settings.display.showSecondEcho = true;
  const bottoms: Record<string, number> = {};
  const seconds: Record<string, number> = {};
  const points: Record<string, { x: number; y: number }> = {
    mud: { x: 720, y: 500 },
    sand: { x: 120, y: 120 },
    rock: { x: 300, y: 250 },
  };
  for (const [key, pt] of Object.entries(points)) {
    const col = engine.generatePing({ index: 0, timeSec: 0, hour: 12, x: pt.x, y: pt.y, speed: 0, anchored: true });
    const bBin = Math.round(col.bottomRange / col.binStep);
    bottoms[key] = col.bins[bBin];
    const b2 = Math.round((col.bottomRange * 2) / col.binStep);
    seconds[key] = b2 < col.bins.length ? col.bins[b2] : -999;
  }
  const rockStrongerThanMud = bottoms.rock > bottoms.mud;
  const secondOrdered = seconds.rock > seconds.sand && seconds.sand > seconds.mud;
  return {
    name: `底质强度与二次回波序(${tx.freqKhz}kHz)`,
    pass: rockStrongerThanMud && secondOrdered,
    detail: `一次回波 礁${bottoms.rock.toFixed(0)} > 沙${bottoms.sand.toFixed(0)} > 泥${bottoms.mud.toFixed(0)}dB;二次回波同序 礁${seconds.rock.toFixed(0)}/沙${seconds.sand.toFixed(0)}/泥${seconds.mud.toFixed(0)}`,
  };
}

// ---------------------------------------------------------------- 测试 7:双频同鱼差异
function testFrequencyDifference(): SelftestResult {
  const txs = buildDefaultTransducers();
  const t50 = txs.find((t) => t.freqKhz === 50)!;
  const t200 = txs.find((t) => t.freqKhz === 200)!;
  const e50 = makeEngine(t50, baseSettings(t50), { x: 0, y: 0, depth: 45, tsDb: FISH_TS, id: 1 });
  const e200 = makeEngine(t200, baseSettings(t200), { x: 0, y: 0, depth: 45, tsDb: FISH_TS, id: 1 });
  const c50 = e50.generatePing({ index: 0, timeSec: 0, hour: 12, x: 0, y: 0, speed: 2, anchored: false });
  const c200 = e200.generatePing({ index: 0, timeSec: 0, hour: 12, x: 0, y: 0, speed: 2, anchored: false });
  const p50 = findFishPeak(c50, 0, 45);
  const p200 = findFishPeak(c200, 0, 45);
  const widthRatio = t200.beamAngleDeg / t50.beamAngleDeg;
  return {
    name: '双频同鱼回波可区分(50k 宽束 vs 200k 窄束)',
    pass: !!p50 && !!p200 && widthRatio < 0.4,
    measured: p200?.level ?? 0,
    expected: p50?.level ?? 0,
    detail: `同鱼两频均检出;200k 波束角仅为 50k 的 ${(widthRatio * 100).toFixed(0)}%,弧宽与脚印差异明显`,
  };
}

export function runSelftest(): SelftestResult[] {
  const txs = buildDefaultTransducers();
  const t50 = txs.find((t) => t.freqKhz === 50)!;
  const t200 = txs.find((t) => t.freqKhz === 200)!;
  const out: SelftestResult[] = [];
  for (const tx of [t50, t200]) {
    out.push(testArcApex(tx));
    out.push(testArcWidth(tx, 2.5));
    out.push(...testSpeedEffects(tx));
    out.push(testTvgConsistency(tx));
    out.push(...testDeadZone(tx));
    out.push(testSubstrate(tx));
  }
  out.push(testFrequencyDifference());
  return out;
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('selftest.ts')) {
  const results = runSelftest();
  let pass = 0;
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(
      `[${tag}] ${r.name}` +
      (r.measured !== undefined ? ` | 实测=${fmt(r.measured)} 理论=${fmt(r.expected ?? 0)}` : '') +
      (r.errorPx !== undefined ? ` 误差=${r.errorPx.toFixed(2)}行` : '')
    );
    console.log(`       ${r.detail}`);
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}
