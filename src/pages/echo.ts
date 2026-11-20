// 回波显示页：双频左右分屏瀑布图 + 单 ping A 显示 + 三维反查
// 实时模式按固定 ping 率滚动；支持底锁放大、缩放档位、全部显示与噪声控制

import type { DisplaySettings, PingMeta } from '../core/types';
import { store } from '../core/store';
import { checkbox, clear, h, select, slider, span, toast } from '../ui/dom';
import { COLORMAPS } from '../core/colormaps';
import { EchoEngine, makeChannel, MAX_BINS, BIN_M, type EngineChannel } from '../core/engine';
import { WaterfallRenderer, type LockWindow } from '../render/waterfall';
import { PingBuffer, drawADisplay, strongestHit } from '../render/adisplay';
import {
  GLEngine, OrbitCamera, boatMesh, coneMesh, coneRimMesh, pointsMesh, polylineMesh, seabedMesh,
} from '../render/gl3d';
import { depthAt, instantiateWorld } from '../core/world';

const COLS = 360;
const PING_RATE = 10;
const PING_DT = 1 / PING_RATE;
const ZOOM_STEPS = [0, 15, 30, 60, 90, 120]; // m，0=自动跟底

interface ChannelView {
  ch: EngineChannel;
  wf: WaterfallRenderer;
  pbuf: PingBuffer;
  wfCanvas: HTMLCanvasElement;
  aCanvas: HTMLCanvasElement;
  rangeLabel: HTMLElement;
  scaleOverlay: HTMLElement;
}

export function renderEchoPage(root: HTMLElement): () => void {
  const cleaners: (() => void)[] = [];
  const area = store.area;
  const engine = new EchoEngine(area, store.schools, store.species);

  let running = true;
  let simTime = 0;
  let simHour = 10;
  // 初始船位贴在第一个鱼群北缘，朝南穿群而过，开机数秒即可见月牙弧
  const firstSchool = store.schools[0];
  let boatX = firstSchool ? firstSchool.center.x : area.width * 0.3;
  let boatZ = firstSchool ? firstSchool.center.z - firstSchool.radiusZ + 4 : area.length * 0.25;
  let boatSpeed = 2.2; // m/s
  let heading = 0;      // 朝 +z（正南）穿过鱼群
  let views: ChannelView[] = [];
  let gl3: GLEngine | null = null;
  let cam: OrbitCamera | null = null;
  let glCanvas: HTMLCanvasElement;
  let picked: { x: number; y: number; z: number; text: string } | null = null;
  let raf = 0;
  let lastFrame = performance.now();
  let pingAcc = 0;

  const head = h('div', { class: 'page-head' },
    h('h1', {}, '回波显示'),
    span('右→左滚动瀑布图，每列按声束几何与距离门实时计算；悬停查看该 ping 的 A 显示，点击回波反查三维目标', 'hint'),
    h('span', { class: 'pill', id: 'sim-clock' }, ''));

  // 控制面板
  const controlCard = h('div', { class: 'card', style: { width: '268px', flex: '0 0 268px' } },
    h('h2', {}, '显示控制'),
    h('div', { id: 'display-controls' }),
    h('h2', { class: 'mt16' }, '环境噪声叠加'),
    h('div', { id: 'noise-controls' }),
    h('h2', { class: 'mt16' }, '仿真场景'),
    h('div', { id: 'scene-controls' }));

  const wfHost = h('div', { class: 'grid fill', style: { gridTemplateColumns: '1fr' } });
  const glCanvasWrap = h('div', { class: 'canvas-wrap mt12' });
  glCanvas = document.createElement('canvas');
  glCanvas.style.width = '100%'; glCanvas.style.height = '280px';
  glCanvasWrap.append(glCanvas);
  const pickInfo = h('div', { class: 'muted small mono mt8' }, '点击瀑布图回波，在此反查三维目标（鱼/礁石/海底）');

  const right = h('div', { class: 'fill flex', style: { flexDirection: 'column', minWidth: 0 } },
    wfHost,
    h('div', { class: 'card mt12' },
      h('h2', {}, '三维场景（声束锥随船扫海，黄点=当前 ping 鱼目标，青色标记=反查结果）'),
      glCanvasWrap, pickInfo));

  root.append(head, h('div', { class: 'layout-row' }, controlCard, right));

  buildControls();
  buildViews();
  init3d();

  function s(): DisplaySettings { return store.display; }

  function rangeMax(): number {
    const auto = Math.min(120, Math.ceil(depthAt(area, boatX, boatZ) * 1.25 / 10) * 10);
    const z = ZOOM_STEPS[s().zoomStep];
    return z > 0 ? z : auto;
  }

  function lockWindow(meta: PingMeta | null): LockWindow {
    const lockM = s().bottomLockM;
    if (lockM <= 0 || !meta || meta.bottomRange <= 0) return { enabled: false, top: 0, height: rangeMax() };
    return { enabled: true, top: Math.max(0, meta.bottomRange - lockM), height: lockM };
  }

  // ---------- 控制面板 ----------
  function buildControls(): void {
    const d = store.display;
    const host = document.getElementById('display-controls')!;
    clear(host);
    host.append(
      slider('增益 Gain', d.gainDb, -30, 30, 0.5, (v) => store.updateDisplay({ gainDb: v }), (v) => `${v.toFixed(1)}dB`),
      h('div', { class: 'mt8' }, select('TVG 模式', d.tvgMode, [
        { value: 'off', text: '关闭 TVG' },
        { value: 'single', text: '单目标 40logR+2αR' },
        { value: 'school', text: '鱼群 30logR+2αR' },
      ], (v) => store.updateDisplay({ tvgMode: v }))),
      h('div', { class: 'mt8' }, slider('TVG 强度', d.tvgStrength, 0, 1, 0.05, (v) => store.updateDisplay({ tvgStrength: v }), (v) => v.toFixed(2))),
      h('div', { class: 'mt8' }, slider('杂波抑制', d.clutterDb, 0, 40, 1, (v) => store.updateDisplay({ clutterDb: v }), (v) => `${v}dB`)),
      h('div', { class: 'mt8' }, select('色标', d.colormap, Object.entries(COLORMAPS).map(([k, v]) => ({ value: k, text: v.name })), (v) => store.updateDisplay({ colormap: v }))),
      h('div', { class: 'mt8' }, select('缩放档位（量程）', String(d.zoomStep),
        ZOOM_STEPS.map((z, i) => ({ value: String(i), text: z === 0 ? '自动跟底' : `${z}m` })),
        (v) => store.updateDisplay({ zoomStep: parseInt(v) }))),
      h('div', { class: 'mt8' }, select('底锁放大', String(d.bottomLockM),
        [0, 5, 10, 20].map((m) => ({ value: String(m), text: m === 0 ? '关闭' : `海底上方 ${m}m` })),
        (v) => store.updateDisplay({ bottomLockM: parseFloat(v) }))));

    const n = store.noise;
    const nhost = document.getElementById('noise-controls')!;
    clear(nhost);
    nhost.append(
      slider('环境噪声基底', n.ambient, 5, 45, 1, (v) => store.updateNoise({ ambient: v }), (v) => `${v}dB`),
      h('div', { class: 'mt8' }, checkbox('船尾流气泡（近场强、随航速）', n.wakeBubbles, (v) => store.updateNoise({ wakeBubbles: v }))),
      slider('气泡强度', n.wakeLevel, 0, 1, 0.05, (v) => store.updateNoise({ wakeLevel: v }), (v) => v.toFixed(2)),
      h('div', { class: 'mt8' }, checkbox('发动机干扰（水平条纹）', n.engine, (v) => store.updateNoise({ engine: v }))),
      slider('干扰强度', n.engineLevel, 0, 1, 0.05, (v) => store.updateNoise({ engineLevel: v }), (v) => v.toFixed(2)),
      h('div', { class: 'mt8' }, checkbox('别船探鱼器串频（突发脉冲）', n.crosstalk, (v) => store.updateNoise({ crosstalk: v }))),
      slider('串频强度', n.crosstalkLevel, 0, 1, 0.05, (v) => store.updateNoise({ crosstalkLevel: v }), (v) => v.toFixed(2)));

    const shost = document.getElementById('scene-controls')!;
    clear(shost);
    shost.append(
      h('div', { class: 'btn-row' },
        h('button', { class: 'primary', id: 'btn-run', onclick: toggleRun }, '⏸ 暂停'),
        h('button', { onclick: resetSim }, '⟲ 清零'),
        h('button', { onclick: clearScreens }, '🧹 清屏')),
      h('div', { class: 'mt8' }, slider('船速', boatSpeed, 0, 6, 0.1, (v) => { boatSpeed = v; }, (v) => `${(v / 0.514444).toFixed(1)}节`)),
      h('div', { class: 'mt8' }, slider('航向', heading, 0, Math.PI * 2, 0.05, (v) => { heading = v; }, (v) => `${(v * 180 / Math.PI).toFixed(0)}°`)),
      h('div', { class: 'mt8' }, slider('时刻（昼夜）', simHour, 0, 24, 0.25, (v) => { simHour = v; }, (v) => `${v.toFixed(1)}h`)));
  }

  function toggleRun(): void {
    running = !running;
    const btn = document.getElementById('btn-run');
    if (btn) btn.textContent = running ? '⏸ 暂停' : '▶ 继续';
  }
  function resetSim(): void {
    simTime = 0;
    const fs = store.schools[0];
    boatX = fs ? fs.center.x : area.width * 0.3;
    boatZ = fs ? fs.center.z - fs.radiusZ + 4 : area.length * 0.25;
    heading = 0;
    clearScreens();
  }
  function clearScreens(): void {
    for (const v of views) { v.wf.clear(); v.pbuf.clear(); }
    picked = null; pickInfo.textContent = '已清屏';
  }

  // ---------- 通道视图 ----------
  function buildViews(): void {
    clear(wfHost);
    views = [];
    const tds = store.selectedTransducers;
    const gridCols = tds.length >= 2 ? '1fr 1fr' : '1fr';
    wfHost.style.gridTemplateColumns = gridCols;
    if (tds.length === 0) {
      wfHost.append(h('div', { class: 'muted' }, '请在「换能器选型」页勾选换能器'));
      return;
    }
    tds.slice(0, 2).forEach((t) => {
      const ch = makeChannel(t, area.soundSpeed);
      const wfCanvas = document.createElement('canvas');
      wfCanvas.style.width = '100%'; wfCanvas.style.height = '340px';
      const aCanvas = document.createElement('canvas');
      aCanvas.style.width = '100%'; aCanvas.style.height = '150px';
      const rangeLabel = h('div', { class: 'muted small mono mt8' }, '');
      const scaleOverlay = h('div', {
        class: 'canvas-overlay',
        style: { inset: '0', overflow: 'hidden' },
      }) as HTMLElement;
      const block = h('div', {},
        h('div', { class: 'flex between center' },
          h('strong', {}, t.name),
          h('span', { class: `tag ${t.frequency < 100000 ? 'f50' : 'f200'}` },
            `${(t.frequency / 1000).toFixed(0)}kHz · 波束角 ${t.beamAngleDeg}°`)),
        h('div', { class: 'canvas-wrap mt8' }, wfCanvas, scaleOverlay),
        h('div', { class: 'canvas-wrap mt8' }, aCanvas),
        rangeLabel);
      wfHost.append(block);
      const wf = new WaterfallRenderer(wfCanvas, COLS);
      wf.setAlpha(ch.alpha);
      const view: ChannelView = { ch, wf, pbuf: new PingBuffer(COLS), wfCanvas, aCanvas, rangeLabel, scaleOverlay };
      views.push(view);

      wfCanvas.addEventListener('pointermove', (e) => {
        const r = wfCanvas.getBoundingClientRect();
        const col = wf.screenXToColumn((e.clientX - r.left) / r.width);
        drawADisplay(aCanvas, view.pbuf.atColumn(col), s(), {
          rangeMax: rangeMax(), lock: lockWindow(view.pbuf.atColumn(col)),
        });
      });
      wfCanvas.addEventListener('click', (e) => handlePick(view, e));
    });
  }

  /** 点击瀑布图 -> 反查鱼/礁/底 */
  function handlePick(view: ChannelView, e: MouseEvent): void {
    const r = view.wfCanvas.getBoundingClientRect();
    const xFrac = (e.clientX - r.left) / r.width;
    const yFrac = 1 - (e.clientY - r.top) / r.height;
    const col = view.wf.screenXToColumn(xFrac);
    const meta = view.pbuf.atColumn(col);
    if (!meta) return;
    const lock = lockWindow(meta);
    const range = lock.enabled ? lock.top + yFrac * lock.height : yFrac * rangeMax();
    const fish = strongestHit(meta, range, 1.2);
    if (fish) {
      const sp = store.species.find((x) => x.id === store.schools.find((sc) => sc.id === fish.schoolId)?.speciesId);
      picked = {
        x: fish.x, y: fish.y, z: fish.z,
        text: `🐟 鱼目标：${sp?.name ?? ''}（${fish.schoolId} #${fish.fishIndex}）位置(${fish.x.toFixed(1)}, ${fish.y.toFixed(1)}, ${fish.z.toFixed(1)}) 斜距${fish.range.toFixed(2)}m 电平${fish.level.toFixed(1)}dB`,
      };
    } else if (Math.abs(range - meta.bottomRange) < 1.5 && meta.substrateHits.length) {
      const sh = meta.substrateHits[0];
      const gx = (sh.ix / (area.nx - 1)) * area.width;
      const gz = (sh.iz / (area.nz - 1)) * area.length;
      picked = {
        x: gx, y: depthAt(area, gx, gz), z: gz,
        text: `🪨 海底回波：格点(${sh.ix},${sh.iz}) 位置(${gx.toFixed(1)}, ${gz.toFixed(1)}) 斜距${sh.range.toFixed(2)}m 电平${sh.level.toFixed(1)}dB`,
      };
    } else {
      picked = { x: meta.boatX, y: range, z: meta.boatZ, text: `该距离门 ${range.toFixed(2)}m 无显著目标（噪声/散射层/温跃层）` };
    }
    pickInfo.textContent = picked.text;
    toast('已在三维视图标记反查结果', 'ok');
    render3d(meta);
  }

  // ---------- 三维 ----------
  function init3d(): void {
    gl3 = new GLEngine(glCanvas);
    cam = new OrbitCamera();
    cam.target = [area.width / 2, 25, area.length / 2];
    cam.dist = Math.max(area.width, area.length) * 0.85;
    cleaners.push(cam.attach(glCanvas));
  }

  function render3d(latest?: PingMeta): void {
    if (!gl3) return;
    gl3.clearMeshes();
    gl3.upload(seabedMesh(area));
    const fishNow = instantiateWorld(area, store.schools, store.species, simHour);
    gl3.upload(pointsMesh(fishNow.map((f) => {
      const sp = store.species.find((s) => s.id === store.schools.find((sc) => sc.id === f.schoolId)?.speciesId);
      const c = hexToRgb(sp?.color ?? '#9fd8ff');
      return { x: f.x, y: f.y, z: f.z, color: c };
    })));
    const depth = depthAt(area, boatX, boatZ);
    for (const v of views) {
      const color: [number, number, number] = v.ch.transducer.frequency < 100000 ? [0.22, 0.72, 0.95] : [0.78, 0.45, 0.95];
      gl3.upload(coneMesh(boatX, boatZ, depth, v.ch.halfAngle, color));
      gl3.upload(coneRimMesh(boatX, boatZ, depth, v.ch.halfAngle, color));
    }
    gl3.upload(boatMesh(boatX, boatZ, heading));
    // 航迹
    if (track.length > 1) gl3.upload(polylineMesh(track.map((p) => ({ x: p.x, y: 0.6, z: p.z })), [0.95, 0.8, 0.3], 0.8));
    // 反查标记（青色立方十字，加大）
    if (picked) {
      gl3.upload(pointsMesh([{ x: picked.x, y: picked.y, z: picked.z, color: [0.3, 0.95, 1], size: 4 }]));
    }
    gl3.render(cam!);
    void latest;
  }

  const track: { x: number; z: number }[] = [];

  /** 深度刻度叠加层（8 等分网格 + 深度数字 + 海底红线） */
  function drawScaleOverlay(v: ChannelView, lock: LockWindow): void {
    const ov = v.scaleOverlay;
    const H = v.wfCanvas.clientHeight;
    const top = lock.enabled ? lock.top : 0;
    const spanM = lock.enabled ? lock.height : rangeMax();
    const ticks = 8;
    let html = '';
    for (let i = 0; i <= ticks; i++) {
      const yPct = (i / ticks) * 100;
      const depth = top + (i / ticks) * spanM;
      html += `<div style="position:absolute;left:0;right:0;top:${yPct}%;height:1px;background:rgba(255,255,255,0.14)"></div>`;
      html += `<span style="position:absolute;left:4px;top:calc(${yPct}% + 2px);font:10px Consolas;color:#9fd8ff;text-shadow:0 0 3px #000">${depth.toFixed(0)}m</span>`;
    }
    const meta = v.pbuf.latest;
    if (meta && meta.bottomRange > 0) {
      const yPct = ((meta.bottomRange - top) / spanM) * 100;
      if (yPct >= 0 && yPct <= 100) {
        html += `<div style="position:absolute;left:0;right:0;top:${yPct}%;height:1.5px;background:rgba(230,96,96,0.85)"></div>`;
        html += `<span style="position:absolute;right:5px;top:calc(${yPct}% + 3px);font:10px Consolas;color:#ff9a9a;text-shadow:0 0 3px #000">底 ${meta.bottomRange.toFixed(1)}m</span>`;
      }
    }
    if (html !== ov.dataset.last) { ov.innerHTML = html; ov.dataset.last = html; }
    void H;
  }

  // ---------- 主循环 ----------
  function stepPing(): void {
    simTime += PING_DT;
    simHour = (simHour + PING_DT * 0.08) % 24; // 一帧约 0.02 模拟小时，方便观察昼夜
    boatX += Math.sin(heading) * boatSpeed * PING_DT;
    boatZ += Math.cos(heading) * boatSpeed * PING_DT;
    if (boatX < 8 || boatX > area.width - 8) heading = Math.PI - heading;
    if (boatZ < 8 || boatZ > area.length - 8) heading = -heading;
    boatX = Math.min(area.width - 8, Math.max(8, boatX));
    boatZ = Math.min(area.length - 8, Math.max(8, boatZ));
    track.push({ x: boatX, z: boatZ });
    if (track.length > 400) track.shift();

    for (const v of views) {
      const meta = engine.computePing(v.ch, {
        time: simTime, hour: simHour,
        boat: { x: boatX, y: 0.2, z: boatZ }, boatSpeed, heading, pingRate: PING_RATE,
        noise: store.noise, tvgMode: s().tvgMode, tvgStrength: s().tvgStrength,
      });
      v.wf.pushPing(meta);
      v.pbuf.push(meta);
    }
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (running) {
      pingAcc += dt;
      let n = 0;
      while (pingAcc >= PING_DT && n < 8) { stepPing(); pingAcc -= PING_DT; n++; }
    }
    const latestMeta = views[0]?.pbuf.latest ?? null;
    const lock = lockWindow(latestMeta);
    for (const v of views) {
      v.wf.setLut(s().colormap);
      v.wf.render(s(), rangeMax(), lock);
      drawScaleOverlay(v, lock);
      const meta = v.pbuf.latest;
      if (meta) {
        v.rangeLabel.textContent =
          `量程 ${rangeMax()}m${lock.enabled ? `（底锁 ${lock.height}m，起 ${lock.top.toFixed(1)}m）` : ''} · ` +
          `底深 ${meta.bottomRange > 0 ? meta.bottomRange.toFixed(1) + 'm' : '—'} · 距离门 ${BIN_M}m/行 · 共 ${MAX_BINS} 行`;
      }
    }
    const clock = document.getElementById('sim-clock');
    if (clock) clock.textContent = `t=${simTime.toFixed(1)}s · ${simHour.toFixed(1)}h · 船(${boatX.toFixed(0)},${boatZ.toFixed(0)}) · ${(boatSpeed / 0.514444).toFixed(1)}节`;
    render3d(latestMeta ?? undefined);
  }

  const unsub = store.sub(() => buildControls());
  cleaners.push(unsub);
  raf = requestAnimationFrame(frame);
  cleaners.push(() => cancelAnimationFrame(raf));

  return () => cleaners.forEach((fn) => fn());
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
