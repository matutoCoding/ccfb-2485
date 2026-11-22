// 页面 4:回波显示 —— 双频瀑布图 + A 显示 + 全部调节 + 反查三维

import { COLORMAPS } from '../../render/colormap';
import { AScopeRenderer } from '../../render/ascope';
import { WaterfallRenderer } from '../../render/waterfall';
import { View3D } from '../../render/view3d';
import { h, mount, slider, toast } from '../dom';
import { store } from '../../data/store';
import { getSimContext, rebuildSimulation } from '../sim-context';
import { EchoContributor, PingColumn, Transducer } from '../../types';
import { SUBSTRATES } from '../../core/seabed';

const WF_W = 460;
const WF_H = 480;
const A_W = 460;
const A_H = 150;

const KIND_LABEL: Record<string, string> = {
  fish: '鱼',
  bottom: '海底',
  reef: '礁石',
  plankton: '浮游生物',
  thermocline: '温跃层',
  bubble: '气泡',
};

function formatPick(col: PingColumn, rangeM: number, contributors: EchoContributor[]): string {
  const t = col.anchored ? '抛锚' : `${col.speed.toFixed(1)}m/s`;
  if (contributors.length === 0) {
    return `ping#${col.index} 距离 ${rangeM.toFixed(1)}m · 仅环境噪声 · 船${t}`;
  }
  const desc = contributors
    .slice()
    .sort((a, b) => b.level - a.level)
    .map((c) => {
      if (c.level <= -900) return `${KIND_LABEL[c.kind] ?? c.kind}#${c.id}(被海底盲区吞噬)`;
      return `${KIND_LABEL[c.kind] ?? c.kind}${c.id >= 0 ? '#' + c.id : ''} ${c.level.toFixed(1)}dB`;
    })
    .join(' | ');
  return `ping#${col.index} 距离 ${rangeM.toFixed(1)}m · ${desc} · 船${t}`;
}

interface Panel {
  tx: Transducer;
  waterfall: WaterfallRenderer;
  ascope: AScopeRenderer;
  wfCanvas: HTMLCanvasElement;
  aCanvas: HTMLCanvasElement;
  pickedRange: number;
  pickedCol: PingColumn | null;
}

export function renderEchoPage() {
  const s = store.state;
  const ctx = getSimContext();
  if (!ctx) return;
  const sim = ctx.sim;
  const panels: Panel[] = [];

  const maxDepth = Math.max(...s.area.cells.map((c) => c.depth)) + 15;
  // 动态读取:用户在量程下拉切换后立即生效
  const currentRange = () => (s.settings.display.rangeM > 0 ? s.settings.display.rangeM : maxDepth);

  // ---- 三维视图 ----
  const view3dCanvas = h('canvas', { width: 560, height: 420, style: 'width:100%;max-width:560px' });
  let view3d: View3D;
  try {
    view3d = new View3D(view3dCanvas, s.area);
    view3d.updateRoute(sim.voyage);
    view3d.updateCones(sim.transducers, 80, 80, 0);
    view3d.updateFish(
      sim.engines[0].fish,
      new Map(s.species.map((sp) => [sp.id, sp.color]))
    );
  } catch (err) {
    mount(h('div', { class: 'panel bad' }, `三维初始化失败:${(err as Error).message}`));
    return;
  }

  // ---- 构建每个换能器面板 ----
  const panelWrap = h('div', { class: sim.transducers.length > 1 ? 'split two' : 'split' });
  for (const tx of sim.transducers) {
    const gain = s.settings.gain[tx.id] ?? s.settings.gain.default!;
    const wfCanvas = h('canvas', { width: WF_W, height: WF_H, style: 'width:100%;cursor:crosshair' });
    const aCanvas = h('canvas', { width: A_W, height: A_H, style: 'width:100%' });
    const waterfall = new WaterfallRenderer(wfCanvas, WF_W, WF_H, gain);
    const ascope = new AScopeRenderer(aCanvas);
    const panel: Panel = { tx, waterfall, ascope, wfCanvas, aCanvas, pickedRange: -1, pickedCol: null };

    wfCanvas.addEventListener('pointermove', (e) => {
      const rect = wfCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * WF_W;
      const y = ((e.clientY - rect.top) / rect.height) * WF_H;
      const picked = waterfall.pick(x, y, currentRange(), s.settings.display.bottomLockM);
      if (!picked) return;
      panel.pickedRange = picked.rangeM;
      panel.pickedCol = picked.column;
      ascope.draw(picked.column, gain, currentRange(), picked.rangeM);
      pickInfo.textContent = formatPick(picked.column, picked.rangeM, picked.contributors);
    });    wfCanvas.addEventListener('pointerleave', () => {
      panel.pickedRange = -1;
      const latest = waterfall.latest();
      if (latest) ascope.draw(latest, gain, currentRange());
    });
    wfCanvas.addEventListener('click', (e) => {
      const rect = wfCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * WF_W;
      const y = ((e.clientY - rect.top) / rect.height) * WF_H;
      const picked = waterfall.pick(x, y, currentRange(), s.settings.display.bottomLockM);
      if (!picked) return;
      handleReverseLookup(picked.column, picked.contributors, picked.rangeM);
    });

    panelWrap.append(
      h('div', { class: 'panel', style: 'margin:0' },
        h('h2', { style: `color:${tx.color}` },
          `${tx.name}  ${tx.freqKhz}kHz / ${tx.beamAngleDeg}° / ${tx.powerW}W / ${tx.pulseMs}ms`),
        h('div', { class: 'canvas-wrap' }, wfCanvas),
        h('div', { class: 'muted', style: 'margin:6px 0' }, 'A 显示(鼠标悬停瀑布图联动该 ping)'),
        h('div', { class: 'canvas-wrap' }, aCanvas))
    );
    panels.push(panel);
  }

  const pickInfo = h('div', { class: 'muted mono' }, '点击瀑布图回波可反查三维目标');

  function handleReverseLookup(col: PingColumn, contributors: EchoContributor[], atRange: number) {
    const fish = sim.engines[0].fish;
    const strong = contributors.filter((c) => c.level > -900).sort((a, b) => b.level - a.level)[0];
    if (!strong) {
      toast('该位置只有环境噪声');
      return;
    }
    if (strong.kind === 'fish') {
      const target = fish.find((f) => f.id === strong.id);
      if (target) {
        const sp = s.species.find((x) => x.id === target.speciesId);
        view3d.focusOn({ x: target.x, y: target.y, z: target.z, label: sp?.name ?? '鱼' });
        toast(`反查:${sp?.name ?? '鱼'} #${target.id},体长 ${target.lengthCm.toFixed(0)}cm,位于 (${target.x.toFixed(0)},${target.y.toFixed(0)},深${target.z.toFixed(1)}m)`);
      }
    } else if (strong.kind === 'reef' || strong.kind === 'bottom') {
      view3d.focusOn({ x: col.x, y: col.y, z: col.bottomRange, label: strong.kind === 'reef' ? '礁石' : '海底' });
      toast(`反查:${strong.kind === 'reef' ? '礁石回波' : `${SUBSTRATES[col.bottomSubstrate].label}海底`},距离 ${col.bottomRange.toFixed(1)}m`);
    } else {
      view3d.focusOn({ x: col.x, y: col.y, z: atRange, label: strong.kind });
      toast(`反查:${strong.kind} 散射,距离 ${atRange.toFixed(1)}m`);
    }
  }

  // ---- 控制面板 ----
  const tx0 = sim.transducers[0];
  const g0 = s.settings.gain[tx0.id] ?? s.settings.gain.default!;
  const noise = s.settings.noise;
  const disp = s.settings.display;

  const gainSlider = slider(g0.gainDb, -30, 30, 0.5, (v) => { g0.gainDb = v; applyToAllGain(); });
  const minSlider = slider(g0.colorMinDb, 0, 120, 1, (v) => { g0.colorMinDb = v; });
  const maxSlider = slider(g0.colorMaxDb, 40, 160, 1, (v) => { g0.colorMaxDb = v; });
  const clutter = slider(g0.clutterReject, 0, 1, 0.05, (v) => { g0.clutterReject = v; applyToAllGain(); });
  const tvgSel = h('select', {}, ...(['40log', '20log', 'off'] as const).map((m) =>
    h('option', { value: m, selected: g0.tvgMode === m }, { '40log': '40logR 鱼群校正', '20log': '20logR 底质校正', off: '关闭 TVG' }[m])));
  tvgSel.addEventListener('change', () => {
    g0.tvgMode = tvgSel.value as typeof g0.tvgMode;
    applyToAllGain();
  });
  const cmapSel = h('select', {}, ...COLORMAPS.map((c) => h('option', { value: c.id, selected: c.id === g0.colormap }, c.name)));
  cmapSel.addEventListener('change', () => {
    g0.colormap = cmapSel.value;
    for (const p of panels) {
      const g = s.settings.gain[p.tx.id] ?? g0;
      g.colormap = cmapSel.value;
      p.waterfall.setColormap(cmapSel.value);
    }
  });
  function applyToAllGain() {
    for (const p of panels) {
      const g = s.settings.gain[p.tx.id];
      if (!g) continue;
      g.gainDb = g0.gainDb;
      g.tvgMode = g0.tvgMode;
      g.clutterReject = g0.clutterReject;
    }
  }

  const wake = slider(noise.wakeBubbles, 0, 1, 0.05, (v) => (noise.wakeBubbles = v));
  const engine = slider(noise.engineInterference, 0, 1, 0.05, (v) => (noise.engineInterference = v));
  const cross = slider(noise.crosstalk, 0, 1, 0.05, (v) => (noise.crosstalk = v));
  const plankton = slider(noise.planktonLayer, 0, 1, 0.05, (v) => (noise.planktonLayer = v));
  const ambient = slider(noise.ambientDb, 20, 70, 1, (v) => (noise.ambientDb = v));

  const bottomLockSel = h('select', {}, ...[0, 5, 10, 20].map((m) =>
    h('option', { value: String(m), selected: disp.bottomLockM === m }, m === 0 ? '关闭底锁' : `海底上方 ${m}m`)));
  bottomLockSel.addEventListener('change', () => (disp.bottomLockM = Number(bottomLockSel.value)));
  const zoomSel = h('select', {}, ...([1, 2, 4] as const).map((z) =>
    h('option', { value: String(z), selected: disp.zoom === z }, `${z}x 缩放`)));
  zoomSel.addEventListener('change', () => (disp.zoom = Number(zoomSel.value) as 1 | 2 | 4));
  const rangeSel = h('select', {}, ...[0, 30, 50, 80, 120].map((m) =>
    h('option', { value: String(m), selected: disp.rangeM === m }, m === 0 ? '自动跟底' : `${m}m 量程`)));
  rangeSel.addEventListener('change', () => {
    disp.rangeM = Number(rangeSel.value);
    toast('量程已切换,重建瀑布图');
    sim.seek(sim.timeSec);
    for (const p of panels) p.waterfall.clear();
  });
  const secondEcho = h('input', { type: 'checkbox', checked: disp.showSecondEcho, onChange: (e) => (disp.showSecondEcho = (e.target as HTMLInputElement).checked) });
  const thermo = h('input', { type: 'checkbox', checked: disp.showThermocline, onChange: (e) => (disp.showThermocline = (e.target as HTMLInputElement).checked) });

  // ---- 播放控制 ----
  let running = false;
  let raf = 0;
  let last = 0;
  const playBtn = h('button', { class: 'primary' }, '▶ 开始仿真');
  const stepBtn = h('button', {}, '单 ping');
  const resetBtn = h('button', {}, '复位');
  const speedSel = h('select', {}, ...[1, 2, 4, 8].map((x) =>
    h('option', { value: String(x), selected: x === 4 }, `${x}x 播放`)));
  const stateLine = h('div', { class: 'muted mono' }, '船位:--  航速:--');

  function pushAll(cols: PingColumn[]) {
    panels.forEach((p, i) => {
      const g = s.settings.gain[p.tx.id] ?? g0;
      p.waterfall.pushColumn(cols[i], g, currentRange());
      if (p.pickedRange < 0) p.ascope.draw(cols[i], g, currentRange());
    });
  }

  function renderAll() {
    for (const p of panels) {
      p.waterfall.render({ rangeM: currentRange(), binStep: sim.engines[0].binStep, bottomLockM: disp.bottomLockM, zoom: disp.zoom });
      const latest = p.waterfall.latest();
      if (latest && p.pickedRange < 0) p.ascope.draw(latest, s.settings.gain[p.tx.id] ?? g0, currentRange());
    }
    const boat = sim.timeline.stateAt(sim.timeSec);
    view3d.updateBoat(boat.x, boat.y);
    view3d.updateCones(sim.transducers, boat.x, boat.y, 0);
    view3d.render(view3dCanvas);
    stateLine.textContent = `船位:(${boat.x.toFixed(0)},${boat.y.toFixed(0)})m  航速:${boat.speed.toFixed(1)}m/s  ${boat.anchored ? '【抛锚】' : ''}  ping#${sim.history[0]?.length ?? 0}`;
  }

  function tick(ts: number) {
    if (!running) return;
    const mult = Number(speedSel.value);
    const interval = 1000 / (s.settings.pingRateHz * mult);
    if (ts - last >= interval) {
      const cols = sim.step();
      pushAll(cols);
      last = ts;
    }
    renderAll();
    raf = requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', () => {
    running = !running;
    playBtn.textContent = running ? '⏸ 暂停' : '▶ 开始仿真';
    if (running) {
      last = 0;
      raf = requestAnimationFrame(tick);
    } else cancelAnimationFrame(raf);
  });
  stepBtn.addEventListener('click', () => {
    pushAll(sim.step());
    renderAll();
  });
  resetBtn.addEventListener('click', () => {
    sim.reset();
    for (const p of panels) p.waterfall.clear();
    renderAll();
  });

  const root = h('div', {},
    h('div', { class: 'panel' },
      h('h2', {}, '仿真控制'),
      h('div', { class: 'row' }, playBtn, stepBtn, resetBtn, speedSel, stateLine,
        h('span', { class: 'spacer' }),
        h('button', {
          onClick: async () => {
            await store.saveSettings();
            toast('调节参数已保存到 IndexedDB');
          },
        }, '保存设置'))),
    panelWrap,
    h('div', { class: 'panel' }, h('h2', {}, '回波反查'), pickInfo),
    h('div', { class: 'grid-2' },
      h('div', { class: 'panel' },
        h('h2', {}, '增益 / TVG / 色标(双频联动)'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, '总增益 dB', gainSlider.wrap),
          h('label', { class: 'field' }, '杂波抑制', clutter.wrap),
          h('label', { class: 'field' }, '色标下限 dB', minSlider.wrap),
          h('label', { class: 'field' }, '色标上限 dB', maxSlider.wrap),
          h('label', { class: 'field' }, 'TVG 模式', tvgSel),
          h('label', { class: 'field' }, '色表', cmapSel))),
      h('div', { class: 'panel' },
        h('h2', {}, '显示窗口'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, '量程', rangeSel),
          h('label', { class: 'field' }, '底锁放大', bottomLockSel),
          h('label', { class: 'field' }, '缩放档位', zoomSel),
          h('div', { class: 'row' },
            h('label', { class: 'check' }, '二次回波', secondEcho),
            h('label', { class: 'check' }, '温跃层', thermo))))),
    h('div', { class: 'grid-2' },
      h('div', { class: 'panel' },
        h('h2', {}, '环境与干扰叠加'),
        h('label', { class: 'field' }, '环境噪声 dB', ambient.wrap),
        h('label', { class: 'field' }, '船尾流气泡', wake.wrap),
        h('label', { class: 'field' }, '发动机线干扰', engine.wrap),
        h('label', { class: 'field' }, '他船串频', cross.wrap),
        h('label', { class: 'field' }, '浮游生物散射层', plankton.wrap)),
      h('div', { class: 'panel' },
        h('h2', {}, '三维声束视图(点击瀑布图在此定位)'),
        h('div', { class: 'canvas-wrap' }, view3dCanvas),
        h('div', { class: 'muted', style: 'margin-top:6px' }, '拖拽旋转 · 滚轮缩放 · 圆锥为各换能器声束,点为鱼群实例'))),
  );
  mount(root);
  // 初始画几列
  for (let i = 0; i < 60; i++) pushAll(sim.step());
  renderAll();
  void rebuildSimulation;
}
