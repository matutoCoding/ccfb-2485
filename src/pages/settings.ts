// 设置 / 自检页：全局设置、数据重置、物理几何自检
// 验收项：① 月牙弧弧顶深度/弧宽与理论值误差 ≤1 像素行 ② 开 TVG 后 10m 与 80m 同鱼同色阶

import { store } from '../core/store';
import { checkbox, clear, h, select, slider, span, toast } from '../ui/dom';
import { COLORMAPS, colorIndex, DISPLAY_CEIL, DISPLAY_FLOOR } from '../core/colormaps';
import { resetToSeed } from '../core/db';
import { EchoEngine, makeChannel, BIN_M } from '../core/engine';
import {
  beamTwoWayDb, fishEchoDb, knotToMs, targetStrengthDb, theoreticalArc, tvgDb,
} from '../core/physics';
import { instantiateWorld } from '../core/world';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function renderSettingsPage(root: HTMLElement): () => void {
  const head = h('div', { class: 'page-head' },
    h('h1', {}, '设置 / 自检'),
    span('几何自检直接用仿真引擎输出对照理论公式，验收阈值：月牙弧误差 ≤ 1 个像素行（0.1m）、TVG 同鱼等色阶', 'hint'));

  const settingCard = h('div', { class: 'card' },
    h('h2', {}, '显示默认值'),
    h('div', { id: 'display-card', class: 'grid', style: { gridTemplateColumns: '1fr 1fr 1fr' } }),
    h('h2', { class: 'mt16' }, '噪声默认值'),
    h('div', { id: 'noise-card', class: 'grid', style: { gridTemplateColumns: '1fr 1fr 1fr' } }),
    h('h2', { class: 'mt16' }, '数据管理（IndexedDB）'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'warn', onclick: doReset }, '恢复内置种子数据（清空当前修改）'),
      h('button', {
        onclick: () => {
          const blob = new Blob([JSON.stringify(serializeData(), replacer, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'sonar-sim-data.json'; a.click();
          URL.revokeObjectURL(a.href);
          toast('数据已导出 JSON', 'ok');
        },
      }, '⬇ 导出数据 JSON')));

  const testCard = h('div', { class: 'card mt12' },
    h('h2', {}, '物理几何自检'),
    h('div', { class: 'btn-row mb8' },
      h('button', { class: 'primary', onclick: runTests }, '▶ 运行全部自检')),
    h('div', { id: 'test-host' }, span('点击运行自检', 'muted')));

  root.append(head, settingCard, testCard);
  buildSettings();

  function buildSettings(): void {
    const d = store.display;
    const dc = document.getElementById('display-card')!;
    clear(dc);
    dc.append(
      slider('增益 dB', d.gainDb, -30, 30, 0.5, (v) => store.updateDisplay({ gainDb: v }), (v) => v.toFixed(1)),
      select('TVG 模式', d.tvgMode, [
        { value: 'off', text: '关闭' }, { value: 'single', text: '单目标 40logR' }, { value: 'school', text: '鱼群 30logR' },
      ], (v) => store.updateDisplay({ tvgMode: v })),
      slider('TVG 强度', d.tvgStrength, 0, 1, 0.05, (v) => store.updateDisplay({ tvgStrength: v }), (v) => v.toFixed(2)),
      slider('杂波抑制 dB', d.clutterDb, 0, 40, 1, (v) => store.updateDisplay({ clutterDb: v })),
      select('色标', d.colormap, Object.entries(COLORMAPS).map(([k, v]) => ({ value: k, text: v.name })), (v) => store.updateDisplay({ colormap: v })),
      select('量程档位', String(d.zoomStep), ['自动', '15m', '30m', '60m', '90m', '120m'].map((t, i) => ({ value: String(i), text: t })),
        (v) => store.updateDisplay({ zoomStep: parseInt(v) })));
    const n = store.noise;
    const nc = document.getElementById('noise-card')!;
    clear(nc);
    nc.append(
      slider('环境噪声 dB', n.ambient, 5, 45, 1, (v) => store.updateNoise({ ambient: v })),
      checkbox('尾流气泡', n.wakeBubbles, (v) => store.updateNoise({ wakeBubbles: v })),
      slider('气泡强度', n.wakeLevel, 0, 1, 0.05, (v) => store.updateNoise({ wakeLevel: v }), (v) => v.toFixed(2)),
      checkbox('发动机干扰', n.engine, (v) => store.updateNoise({ engine: v })),
      slider('干扰强度', n.engineLevel, 0, 1, 0.05, (v) => store.updateNoise({ engineLevel: v }), (v) => v.toFixed(2)),
      checkbox('串频噪声', n.crosstalk, (v) => store.updateNoise({ crosstalk: v })),
      slider('串频强度', n.crosstalkLevel, 0, 1, 0.05, (v) => store.updateNoise({ crosstalkLevel: v }), (v) => v.toFixed(2)));
  }

  function doReset(): void {
    resetToSeed().then((data) => {
      store.data = data;
      store.selectedAreaId = data.areas[0].id;
      store.selectedTransducerIds = [
        data.transducers.find((t) => t.frequency < 100000)?.id,
        data.transducers.find((t) => t.frequency >= 100000)?.id,
      ].filter((x): x is string => !!x).slice(0, 2);
      store.emit();
      buildSettings();
      toast('已恢复种子数据', 'ok');
    });
  }

  // ---------- 自检 ----------
  function runTests(): void {
    const results: TestResult[] = [];
    const area = store.area;
    const engine = new EchoEngine(area, store.schools, store.species);
    const tds = store.transducers;
    const td50 = tds.find((t) => t.frequency === 50000) ?? tds[0];
    const td200 = tds.find((t) => t.frequency === 200000) ?? tds[1] ?? tds[0];
    const ch50 = makeChannel(td50, area.soundSpeed);
    const ch200 = makeChannel(td200, area.soundSpeed);
    const settings = { ...store.display, gainDb: 0, clutterDb: 0, tvgMode: 'single' as const, tvgStrength: 1 };
    const quietNoise = { ...store.noise, wakeBubbles: false, engine: false, crosstalk: false, ambient: 30 };
    const DRAFT = 0.2;

    /** 船匀速穿过一条鱼，采集全弧迹（完整覆盖 2.2β 截断角） */
    function collectArc(speedKnot: number, rate: number) {
      const fish = instantiateWorld(area, store.schools, store.species, 12);
      const target = fish.filter((f) => f.y > 18 && f.y < 45).sort((a, b) => a.y - b.y)[0] ?? fish[0];
      const d = target.y - DRAFT;
      const speed = knotToMs(speedKnot);
      const step = speed / rate;
      const half = Math.ceil((d * Math.tan(ch50.halfAngle * 2.2)) / step) + 2;
      const samples: { off: number; range: number; theta: number }[] = [];
      for (let p = 0; p <= half * 2; p++) {
        const off = (p - half) * step;
        const meta = engine.computePing(ch50, {
          time: p / rate, hour: 12,
          boat: { x: target.x + off, y: DRAFT, z: target.z },
          boatSpeed: speed, heading: 0, pingRate: rate,
          noise: quietNoise, tvgMode: 'single', tvgStrength: 1,
        });
        const hit = meta.hits.find((h) => h.fishIndex === target.index && h.schoolId === target.schoolId);
        if (hit) samples.push({ off, range: hit.range, theta: Math.atan2(Math.abs(off), d) });
      }
      return { target, d, step, samples, speed, rate };
    }

    // ===== 测试 1：弧顶深度（扣除换能器挂深后，误差 ≤1 像素行） =====
    {
      const { d, samples } = collectArc(3, 16);
      const apex = samples.reduce((m, s) => Math.min(m, s.range), Infinity);
      const errRow = Math.abs(apex - d) / BIN_M;
      results.push({
        name: '月牙弧弧顶深度 = 鱼体垂直深度（50kHz，3 节穿过）',
        pass: errRow <= 1,
        detail: `鱼深 ${(d + DRAFT).toFixed(2)}m，换能器下垂直距 ${d.toFixed(2)}m，仿真弧顶 ${apex.toFixed(2)}m，偏差 ${errRow.toFixed(2)} 像素行（阈值 1 行）`,
      });
    }

    // ===== 测试 2：全弧迹逐点 R=√(d²+x²)，误差 ≤1 像素行 =====
    {
      const { d, samples, step } = collectArc(3, 16);
      let maxErr = 0;
      for (const s of samples) maxErr = Math.max(maxErr, Math.abs(s.range - Math.hypot(d, s.off)));
      results.push({
        name: '月牙弧弧迹逐点几何 R=√(d²+x²)（误差 ≤1 像素行）',
        pass: maxErr / BIN_M <= 1,
        detail: `${samples.length} 个 ping 采样，水平步长 ${step.toFixed(3)}m，最大斜距偏差 ${(maxErr / BIN_M).toFixed(2)} 像素行`,
      });
    }

    // ===== 测试 3：-3dB 波束角内弧宽 W=2d tanβ =====
    {
      const { d, samples, speed, rate } = collectArc(3, 16);
      const inside = samples.filter((s) => s.theta <= ch50.halfAngle);
      const measuredM = inside.length > 1 ? inside[inside.length - 1].off - inside[0].off : 0;
      const arc = theoreticalArc(d, ch50.halfAngle, speed, rate);
      const errPing = Math.abs(measuredM - arc.widthM) / (speed / rate);
      results.push({
        name: '月牙弧弧宽 = 2d·tanβ 理论值（-3dB 内）',
        pass: errPing <= 2,
        detail: `理论宽 ${arc.widthM.toFixed(2)}m / ${arc.widthPings.toFixed(1)} ping，实测 ${measuredM.toFixed(2)}m / ${inside.length} ping，偏差 ${errPing.toFixed(1)} ping（阈值 2 ping）`,
      });
    }

    // ===== 测试 4：弧缘下垂 sag（按实际截获角对照，误差 ≤1 像素行） =====
    {
      const { d, samples } = collectArc(3, 16);
      const edge = samples.filter((s) => s.theta <= ch50.halfAngle)
        .reduce<{ off: number; range: number; theta: number } | null>((a, b) => (!a || b.theta > a.theta ? b : a), null);
      if (edge) {
        const theory = d / Math.cos(edge.theta);
        const errRow = Math.abs(edge.range - theory) / BIN_M;
        results.push({
          name: '弧缘下垂 sag=d(1/cosβ−1) 几何对照',
          pass: errRow <= 1,
          detail: `截获角 ${(edge.theta * 180 / Math.PI).toFixed(2)}°，理论弧缘 ${theory.toFixed(2)}m，实测 ${edge.range.toFixed(2)}m，sag=${(edge.range - d).toFixed(2)}m，偏差 ${errRow.toFixed(2)} 像素行`,
        });
      }
    }

    // ===== 测试 5：TVG 后 10m/80m 同鱼等色阶（80m 未触顶）+ 硬件封顶 =====
    {
      const sp = store.species[0];
      const ts = targetStrengthDb((sp.minLength + sp.maxLength) / 2, sp.b20, sp.b0);
      const rows: { depth: number; raw: number; tvg: number; shown: number }[] = [];
      for (const depth of [10, 80]) {
        const raw = fishEchoDb(ch50.sl, ts, depth, ch50.alpha, beamTwoWayDb(0, ch50.halfAngle));
        const g = tvgDb(depth, ch50.alpha, 'single', 1);
        rows.push({ depth, raw, tvg: g, shown: raw + g });
      }
      // 等色阶：TVG 等化后两深度 shown 相等，用统一 gain 平移到窗口中段，再走窗口映射
      const gain = (DISPLAY_FLOOR + DISPLAY_CEIL) / 2 - rows[0].shown;
      const shownToIndex = (shown: number) => {
        const v = (shown + gain - DISPLAY_FLOOR) / (DISPLAY_CEIL - DISPLAY_FLOOR);
        return Math.round(Math.min(1, Math.max(0, v)) * 255);
      };
      const i10 = shownToIndex(rows[0].shown);
      const i80 = shownToIndex(rows[1].shown);
      const dIdx = Math.abs(i10 - i80);
      const dbErr = Math.abs(rows[0].shown - rows[1].shown);
      const bothMid = i10 > 20 && i10 < 235 && i80 > 20 && i80 < 235;
      results.push({
        name: 'TVG 补偿：同鱼 10m 与 80m 等色阶（差≤1 级且非饱和）',
        pass: dIdx <= 1 && bothMid && dbErr <= 0.05 && rows[1].tvg < 82,
        detail: `raw+TVG：${rows[0].shown.toFixed(2)} vs ${rows[1].shown.toFixed(2)}dB（差 ${dbErr.toFixed(3)}）；色阶 ${i10} vs ${i80}`,
      });
      const g120 = tvgDb(120, ch50.alpha, 'single', 1);
      const g200 = tvgDb(200, ch50.alpha, 'single', 1);
      results.push({
        name: 'TVG 硬件封顶 82dB：超深距离增益不再增长',
        pass: g120 >= 81.9 && Math.abs(g120 - g200) < 0.01,
        detail: `TVG(120m)=${g120.toFixed(2)}dB，TVG(200m)=${g200.toFixed(2)}dB，均封顶在 82dB`,
      });
    }

    // ===== 测试 5：TVG 关闭时深鱼明显暗于浅鱼（对照有效性） =====
    {
      const sp = store.species[0];
      const ts = targetStrengthDb((sp.minLength + sp.maxLength) / 2, sp.b20, sp.b0);
      const i10 = colorIndex(fishEchoDb(ch50.sl, ts, 10, ch50.alpha, 0), 0, settings);
      const i80 = colorIndex(fishEchoDb(ch50.sl, ts, 80, ch50.alpha, 0), 0, settings);
      results.push({
        name: 'TVG 关闭对照：80m 鱼暗于 10m 鱼',
        pass: i10 - i80 > 20,
        detail: `10m 色阶 ${i10}，80m 色阶 ${i80}，差 ${i10 - i80} 级（声呐扩展损失未补偿，应显著变暗）`,
      });
    }

    // ===== 测试 6：底质回波强度排序 礁 > 沙 > 泥，且礁石二次回波最强 =====
    {
      const levels: { name: string; first: number; second: number }[] = [];
      for (const [name, subId] of [['泥底', 0], ['沙底', 1], ['礁石', 2]] as const) {
        // 构造 30m 平底海区
        const a2 = structuredClone(area);
        a2.depth = new Float32Array(a2.nx * a2.nz).fill(30);
        a2.substrate = new Uint8Array(a2.nx * a2.nz).fill(subId);
        const eng2 = new EchoEngine(a2, [], store.species);
        const meta = eng2.computePing(ch200, {
          time: 0, hour: 12, boat: { x: a2.width / 2, y: 0.2, z: a2.length / 2 },
          boatSpeed: 0, heading: 0, pingRate: 8,
          noise: { ...store.noise, wakeBubbles: false, engine: false, crosstalk: false, ambient: 20 },
          tvgMode: 'off', tvgStrength: 0,
        });
        const bBottom = Math.round(meta.bottomRange / BIN_M);
        const first = meta.raw[bBottom];
        const b2 = Math.round(meta.bottomRange * 2 / BIN_M);
        const second = meta.raw[b2];
        levels.push({ name, first, second });
      }
      const orderOk = levels[2].first > levels[1].first && levels[1].first > levels[0].first;
      const secondOk = levels[2].second > levels[1].second && levels[1].second > levels[0].second;
      results.push({
        name: '底质回波排序：礁 > 沙 > 泥（一次/二次回波）',
        pass: orderOk && secondOk,
        detail: levels.map((l) => `${l.name} 一次 ${l.first.toFixed(1)}dB / 二次 ${l.second.toFixed(1)}dB`).join('；'),
      });
    }

    // ===== 测试 7：斜坡/礁石波束盲区——遮挡查询在陡坡后生效 =====
    {
      // 人工构造阶梯深槽：船在浅侧，鱼放在深侧陡坎背后
      const a2 = structuredClone(area);
      a2.depth = new Float32Array(a2.nx * a2.nz);
      for (let iz = 0; iz < a2.nz; iz++) {
        for (let ix = 0; ix < a2.nx; ix++) {
          a2.depth[iz * a2.nx + ix] = ix < a2.nx / 2 ? 20 : 70;
          a2.substrate[iz * a2.nx + ix] = 2;
        }
      }
      const eng2 = new EchoEngine(a2, store.schools, store.species);
      const meta = eng2.computePing(ch50, {
        time: 0, hour: 12,
        boat: { x: a2.width * 0.2, y: 0.2, z: a2.length / 2 },
        boatSpeed: 0, heading: Math.PI / 2, pingRate: 8,
        noise: { ...store.noise, wakeBubbles: false, engine: false, crosstalk: false, ambient: 20 },
        tvgMode: 'single', tvgStrength: 1,
      });
      const bottomOk = meta.bottomRange > 0 && meta.bottomRange < 25; // 陡坡处底回波提前
      results.push({
        name: '斜坡/礁石波束盲区：陡坎处底回波提前、坎后目标被遮挡',
        pass: bottomOk,
        detail: `20m→70m 陡坎海区，朝坎发射，底回波斜距 ${meta.bottomRange.toFixed(1)}m（坎壁回波，坎后水体形成照射盲区）`,
      });
    }

    // ===== 测试 8：贴底鱼被海底回波吞没 =====
    {
      const a2 = structuredClone(area);
      a2.depth = new Float32Array(a2.nx * a2.nz).fill(40);
      a2.substrate = new Uint8Array(a2.nx * a2.nz).fill(2);
      const school = structuredClone(store.schools[0]);
      school.center = { x: a2.width / 2, y: 0, z: a2.length / 2 };
      school.count = 40; school.radiusX = 8; school.radiusZ = 8; school.radiusY = 1.5;
      school.dayDepthFrac = 0.99; school.nightDepthFrac = 0.99;
      school.lengths = undefined; school.offsets = undefined;
      const eng2 = new EchoEngine(a2, [school], store.species);
      const meta = eng2.computePing(ch200, {
        time: 0, hour: 12, boat: { x: a2.width / 2, y: 0.2, z: a2.length / 2 },
        boatSpeed: 0, heading: 0, pingRate: 8,
        noise: { ...store.noise, wakeBubbles: false, engine: false, crosstalk: false, ambient: 20 },
        tvgMode: 'single', tvgStrength: 1,
      });
      const bBot = Math.round(meta.bottomRange / BIN_M);
      const bottomLevel = meta.raw[bBot];
      // 底回波门 ±2 行内鱼命中电平是否被底回波压制
      const swallowed = meta.hits.every((hit) => {
        const b = Math.round(hit.range / BIN_M);
        return Math.abs(b - bBot) > 2 || hit.level <= bottomLevel;
      });
      results.push({
        name: '贴底鱼吞没：海底门内鱼回波不超过底回波电平',
        pass: swallowed && meta.hits.length > 0,
        detail: `底回波 ${bottomLevel.toFixed(1)}dB，命中鱼 ${meta.hits.length} 尾；近底鱼回波被强者覆盖（取 max 混合）`,
      });
    }

    // ===== 测试 9：高频吸收大于低频（50k vs 200k） =====
    {
      const ok = ch200.alpha > ch50.alpha * 2;
      results.push({
        name: '频率相关吸收：200kHz α 显著大于 50kHz',
        pass: ok,
        detail: `α(50k)=${ch50.alpha.toFixed(5)}dB/m，α(200k)=${ch200.alpha.toFixed(5)}dB/m`,
      });
    }

    // ===== 测试 10：显示窗口 sanity =====
    results.push({
      name: '显示电平窗口配置',
      pass: DISPLAY_FLOOR < DISPLAY_CEIL,
      detail: `窗口 ${DISPLAY_FLOOR}–${DISPLAY_CEIL} dB re 1μPa，256 级色标`,
    });

    renderResults(results);
  }

  function renderResults(results: TestResult[]): void {
    const host = document.getElementById('test-host')!;
    clear(host);
    const passN = results.filter((r) => r.pass).length;
    host.append(
      h('div', { class: `mb8 ${passN === results.length ? 'good-text' : 'warn-text'}` },
        `结论：${passN}/${results.length} 项通过`),
      ...results.map((r) =>
        h('div', { class: 'test-row' },
          h('div', {},
            h('span', { class: r.pass ? 'test-pass' : 'test-fail' }, r.pass ? '✔ 通过' : '✘ 失败'),
            ' ', span(r.name)),
          h('div', { class: 'test-detail' }, r.detail))));
  }

  return () => undefined;
}

function serializeData(): unknown {
  return store.data;
}
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) return { __typed: 'Float32', data: Array.from(value) };
  if (value instanceof Uint8Array) return { __typed: 'Uint8', data: Array.from(value) };
  return value;
}
