// 航次回放页：航线与船速曲线编辑、按航次回放、抛锚漂航出横线、高速鱼弧变扁

import type { PingMeta, Voyage } from '../core/types';
import { store } from '../core/store';
import { clear, h, numField, slider, span, toast } from '../ui/dom';
import { EchoEngine, makeChannel, routeTotalLength, sampleRoute, BIN_M } from '../core/engine';
import { knotToMs, theoreticalArc } from '../core/physics';
import { WaterfallRenderer, type LockWindow } from '../render/waterfall';
import { PingBuffer, drawADisplay } from '../render/adisplay';
import { depthAt } from '../core/world';
import { uid } from '../core/db';

const COLS = 420;

export function renderVoyagePage(root: HTMLElement): () => void {
  const cleaners: (() => void)[] = [];
  const area = store.area;
  const engine = new EchoEngine(area, store.schools, store.species);
  let voyage: Voyage = store.voyage;
  let playing = false;
  let dist = 0;
  let raf = 0;
  let lastT = performance.now();
  let playSpeed = 4; // 仿真倍速
  let wf: WaterfallRenderer | null = null;
  let wf2: WaterfallRenderer | null = null;
  let pbuf: PingBuffer;
  let pbuf2: PingBuffer;

  const head = h('div', { class: 'page-head' },
    h('h1', {}, '航次回放'),
    span('船按航线航点走，船速曲线可编辑；高速鱼弧压扁，速度为 0 抛锚漂航时鱼弧拉成横线', 'hint'));

  // 航线编辑画布
  const routeCanvas = document.createElement('canvas');
  routeCanvas.style.width = '100%'; routeCanvas.style.height = '380px';
  routeCanvas.style.cursor = 'crosshair';
  const speedCanvas = document.createElement('canvas');
  speedCanvas.style.width = '100%'; speedCanvas.style.height = '140px';

  const routeCard = h('div', { class: 'card fill' },
    h('h2', {}, '航线编辑（点击空白添加航点，拖动航点改位置，双击航点删除）'),
    h('div', { class: 'canvas-wrap' }, routeCanvas),
    h('div', { class: 'btn-row mt8' },
      h('button', { onclick: () => { voyage.route = []; saveAndDraw(); } }, '清空航线'),
      h('button', { onclick: () => { voyage.route.push({ x: area.width / 2, z: area.length / 2, speed: 6 }); saveAndDraw(); } }, '＋ 航点'),
    ),
    h('h2', { class: 'mt12' }, '船速曲线（节，按航点顺序；0=抛锚漂航）'),
    h('div', { class: 'canvas-wrap' }, speedCanvas),
    h('div', { class: 'muted small mt8', id: 'route-stat' }, ''));

  // 回放区
  const wfCanvas = document.createElement('canvas');
  wfCanvas.style.width = '100%'; wfCanvas.style.height = '300px';
  const wfCanvas2 = document.createElement('canvas');
  wfCanvas2.style.width = '100%'; wfCanvas2.style.height = '300px';
  const aCanvas = document.createElement('canvas');
  aCanvas.style.width = '100%'; aCanvas.style.height = '150px';
  const arcInfo = h('div', { class: 'muted small mono mt8' }, '');

  const playCard = h('div', { class: 'card fill' },
    h('h2', {}, '回放瀑布图（左：所选换能器 A / 右：换能器 B）'),
    h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr' } },
      h('div', { class: 'canvas-wrap' }, wfCanvas),
      h('div', { class: 'canvas-wrap' }, wfCanvas2)),
    h('div', { class: 'canvas-wrap mt8' }, aCanvas),
    arcInfo);

  const side = h('div', { class: 'card', style: { width: '280px', flex: '0 0 280px' } },
    h('h2', {}, '航次'),
    h('div', { class: 'sel-list', id: 'vy-list' }),
    h('button', { class: 'primary mt12', style: { width: '100%' }, onclick: addVoyage }, '＋ 新建航次'),
    h('h2', { class: 'mt16' }, '回放控制'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'primary', id: 'btn-play', onclick: togglePlay }, '▶ 播放'),
      h('button', { onclick: restart }, '⟲ 回到起点'),
      h('button', { onclick: clearAll }, '🧹 清屏')),
    h('div', { class: 'mt8' }, slider('回放倍速', playSpeed, 0.5, 12, 0.5, (v) => { playSpeed = v; }, (v) => `${v}×`)),
    h('div', { class: 'mt8' }, slider('起始时刻 h', voyage.startHour, 0, 24, 0.25, (v) => { voyage.startHour = v; store.saveVoyage(voyage); }, (v) => v.toFixed(2))),
    h('div', { class: 'mt8' }, numField('航次时长 min', voyage.durationMin, 1, (v) => { voyage.durationMin = v; store.saveVoyage(voyage); }, 1, 600)),
    h('div', { class: 'mt8 muted small' }, '总航程'),
    h('div', { class: 'mono', id: 'voyage-len' }, ''));

  root.append(head, h('div', { class: 'layout-row' }, routeCard, h('div', { class: 'fill flex', style: { flexDirection: 'column', gap: '14px', minWidth: 0 } }, playCard)), side);

  pbuf = new PingBuffer(COLS);
  pbuf2 = new PingBuffer(COLS);
  initWaterfalls();
  refreshList();
  drawRoute();
  drawSpeed();

  function initWaterfalls(): void {
    const tds = store.selectedTransducers;
    wf = new WaterfallRenderer(wfCanvas, COLS);
    wf2 = new WaterfallRenderer(wfCanvas2, COLS);
    const ch0 = tds[0] ? makeChannel(tds[0], area.soundSpeed) : null;
    const ch1 = tds[1] ? makeChannel(tds[1], area.soundSpeed) : null;
    if (ch0) wf.setAlpha(ch0.alpha);
    if (ch1) wf2.setAlpha(ch1.alpha);
    wfCanvas.addEventListener('pointermove', (e) => {
      const r = wfCanvas.getBoundingClientRect();
      drawADisplay(aCanvas, pbuf.atColumn(wf!.screenXToColumn((e.clientX - r.left) / r.width)), store.display, { rangeMax: currentRange() });
    });
    wfCanvas2.addEventListener('pointermove', (e) => {
      const r = wfCanvas2.getBoundingClientRect();
      drawADisplay(aCanvas, pbuf2.atColumn(wf2!.screenXToColumn((e.clientX - r.left) / r.width)), store.display, { rangeMax: currentRange() });
    });
  }

  function currentRange(): number {
    const rp = sampleRoute(voyage.route, dist);
    return Math.min(120, Math.ceil(depthAt(area, rp.x, rp.z) * 1.25 / 10) * 10);
  }

  function refreshList(): void {
    const el = document.getElementById('vy-list')!;
    clear(el);
    for (const v of store.data!.voyages) {
      el.append(h('div', {
        class: `sel-item ${v.id === voyage.id ? 'sel' : ''}`,
        onclick: () => { voyage = v; store.selectedVoyageId = v.id; dist = 0; refreshList(); drawRoute(); drawSpeed(); },
      },
        h('div', { class: 't' }, v.name),
        h('div', { class: 'd' }, `${v.route.length} 航点 · ${v.durationMin}min · ${v.startHour.toFixed(1)}h 起航`)));
    }
    document.getElementById('voyage-len')!.textContent = `${routeTotalLength(voyage.route).toFixed(0)} m`;
  }

  function addVoyage(): void {
    const v: Voyage = {
      id: uid('vy'), areaId: area.id, name: '新航次',
      route: [{ x: 60, z: 60, speed: 6 }, { x: area.width - 60, z: area.length - 60, speed: 6 }],
      startHour: 9, durationMin: 20,
    };
    store.saveVoyage(v).then(() => { voyage = v; refreshList(); drawRoute(); drawSpeed(); toast('航次已创建', 'ok'); });
  }

  function saveAndDraw(): void {
    store.saveVoyage(voyage);
    drawRoute(); drawSpeed();
    document.getElementById('voyage-len')!.textContent = `${routeTotalLength(voyage.route).toFixed(0)} m`;
  }

  // ---------- 航线画布 ----------
  function drawRoute(activeDist = dist): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = routeCanvas.clientWidth, H = routeCanvas.clientHeight;
    routeCanvas.width = W * dpr; routeCanvas.height = H * dpr;
    const ctx = routeCanvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a1322'; ctx.fillRect(0, 0, W, H);
    const sx = W / area.width, sz = H / area.length;
    // 水深底图
    for (let iz = 0; iz < area.nz; iz++) {
      for (let ix = 0; ix < area.nx; ix++) {
        const d = area.depth[iz * area.nx + ix];
        ctx.fillStyle = `rgba(30,80,130,${0.2 + Math.min(0.6, d / 120)})`;
        ctx.fillRect(ix * (W / area.nx), iz * (H / area.nz), Math.ceil(W / area.nx), Math.ceil(H / area.nz));
      }
    }
    // 航线
    ctx.strokeStyle = '#f0c850'; ctx.lineWidth = 2;
    ctx.beginPath();
    voyage.route.forEach((p, i) => {
      const x = p.x * sx, z = p.z * sz;
      if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    });
    ctx.stroke();
    voyage.route.forEach((p, i) => {
      const x = p.x * sx, z = p.z * sz;
      ctx.beginPath();
      ctx.arc(x, z, 7, 0, Math.PI * 2);
      ctx.fillStyle = p.speed === 0 ? '#e66060' : '#f0c850';
      ctx.fill();
      ctx.fillStyle = '#0a1322';
      ctx.font = 'bold 10px Consolas';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, z);
      ctx.fillStyle = '#cfe0f5';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${p.speed.toFixed(1)}kn`, x + 9, z - 6);
    });
    // 当前船位
    const rp = sampleRoute(voyage.route, activeDist);
    ctx.beginPath();
    ctx.arc(rp.x * sx, rp.z * sz, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#48e0a0'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.stroke();
    document.getElementById('route-stat')!.textContent =
      `船位(${rp.x.toFixed(0)},${rp.z.toFixed(0)}) 航速 ${(rp.speed / 0.514444).toFixed(2)}节 航向 ${(rp.heading * 180 / Math.PI).toFixed(0)}° 水深 ${depthAt(area, rp.x, rp.z).toFixed(1)}m`;
  }

  function drawSpeed(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = speedCanvas.clientWidth, H = speedCanvas.clientHeight;
    speedCanvas.width = W * dpr; speedCanvas.height = H * dpr;
    const ctx = speedCanvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a1322'; ctx.fillRect(0, 0, W, H);
    const pad = 26;
    const maxSp = 12;
    ctx.strokeStyle = '#243650';
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - pad * 2);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      ctx.fillStyle = '#5f7595'; ctx.font = '10px Consolas';
      ctx.fillText(`${(maxSp * (1 - i / 4)).toFixed(0)}kn`, 2, y + 3);
    }
    const n = voyage.route.length;
    if (n < 2) return;
    ctx.strokeStyle = '#48c08a'; ctx.lineWidth = 2;
    ctx.beginPath();
    voyage.route.forEach((p, i) => {
      const x = pad + (i / (n - 1)) * (W - pad * 2);
      const y = pad + (1 - p.speed / maxSp) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    voyage.route.forEach((p, i) => {
      const x = pad + (i / (n - 1)) * (W - pad * 2);
      const y = pad + (1 - p.speed / maxSp) * (H - pad * 2);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = p.speed === 0 ? '#e66060' : '#48c08a'; ctx.fill();
    });
  }

  // 航点拖拽/添加/删除
  let dragIdx = -1;
  const toWorld = (e: PointerEvent) => {
    const r = routeCanvas.getBoundingClientRect();
    return {
      x: Math.min(area.width, Math.max(0, (e.clientX - r.left) / r.width * area.width)),
      z: Math.min(area.length, Math.max(0, (e.clientY - r.top) / r.height * area.length)),
    };
  };
  const hitPoint = (e: PointerEvent): number => {
    const r = routeCanvas.getBoundingClientRect();
    const sx = r.width / area.width, sz = r.height / area.length;
    for (let i = 0; i < voyage.route.length; i++) {
      const p = voyage.route[i];
      if (Math.hypot((e.clientX - r.left) - p.x * sx, (e.clientY - r.top) - p.z * sz) < 10) return i;
    }
    return -1;
  };
  const onDown = (e: PointerEvent) => {
    dragIdx = hitPoint(e);
    if (dragIdx < 0) {
      const w = toWorld(e);
      voyage.route.push({ x: w.x, z: w.z, speed: 6 });
      dragIdx = voyage.route.length - 1;
      saveAndDraw();
    }
  };
  const onMove = (e: PointerEvent) => {
    if (dragIdx < 0) return;
    const w = toWorld(e);
    voyage.route[dragIdx].x = w.x;
    voyage.route[dragIdx].z = w.z;
    saveAndDraw();
  };
  const onUp = () => { dragIdx = -1; };
  const onDbl = (e: MouseEvent) => {
    const i = hitPoint(e as unknown as PointerEvent);
    if (i >= 0 && voyage.route.length > 2) { voyage.route.splice(i, 1); saveAndDraw(); }
  };
  const onSpeedClick = (e: PointerEvent) => {
    const r = speedCanvas.getBoundingClientRect();
    const pad = 26;
    const idx = Math.round(((e.clientX - r.left - pad) / (r.width - pad * 2)) * (voyage.route.length - 1));
    if (idx < 0 || idx >= voyage.route.length) return;
    const maxSp = 12;
    const sp = Math.max(0, (1 - (e.clientY - r.top - pad) / (r.height - pad * 2)) * maxSp);
    voyage.route[idx].speed = Math.round(sp * 2) / 2;
    saveAndDraw();
  };
  routeCanvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  routeCanvas.addEventListener('dblclick', onDbl);
  speedCanvas.addEventListener('pointerdown', onSpeedClick);
  cleaners.push(() => {
    routeCanvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    routeCanvas.removeEventListener('dblclick', onDbl);
    speedCanvas.removeEventListener('pointerdown', onSpeedClick);
  });

  // ---------- 回放 ----------
  function togglePlay(): void {
    playing = !playing;
    document.getElementById('btn-play')!.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  }
  function restart(): void { dist = 0; clearAll(); }
  function clearAll(): void { wf?.clear(); wf2?.clear(); pbuf.clear(); pbuf2.clear(); }

  function emitPing(): void {
    const rp = sampleRoute(voyage.route, dist);
    const hour = (voyage.startHour + (dist / Math.max(1, knotToMs(2))) / 3600) % 24;
    const tds = store.selectedTransducers;
    const lock: LockWindow = { enabled: false, top: 0, height: currentRange() };
    tds.slice(0, 2).forEach((t, i) => {
      const ch = makeChannel(t, area.soundSpeed);
      const meta: PingMeta = engine.computePing(ch, {
        time: dist, hour,
        boat: { x: rp.x, y: 0.2, z: rp.z }, boatSpeed: rp.speed, heading: rp.heading, pingRate: 8,
        noise: store.noise, tvgMode: store.display.tvgMode, tvgStrength: store.display.tvgStrength,
      });
      const view = i === 0 ? { w: wf!, b: pbuf } : { w: wf2!, b: pbuf2 };
      view.w.setLut(store.display.colormap);
      view.w.pushPing(meta);
      view.b.push(meta);
      view.w.render(store.display, currentRange(), lock);
      if (i === 0) {
        // 弧几何理论值对照（取该 ping 命中的最近鱼）
        const hit = meta.hits[0];
        if (hit) {
          const arc = theoreticalArc(hit.y, ch.halfAngle, rp.speed, 8);
          arcInfo.textContent =
            `鱼深 ${hit.y.toFixed(1)}m 波束半角 ${(ch.halfAngle * 180 / Math.PI).toFixed(1)}° 船速 ${(rp.speed / 0.514444).toFixed(2)}节 → ` +
            `理论弧宽 ${isFinite(arc.widthPings) ? arc.widthPings.toFixed(1) : '∞(漂航)'} ping / ${arc.widthM.toFixed(1)}m，` +
            `弧缘下垂 ${arc.sagM.toFixed(2)}m（${(arc.sagM / BIN_M).toFixed(1)} 像素行）；${rp.speed < 0.2 ? '当前抛锚漂航，弧线趋近水平直线' : ''}`;
        }
      }
    });
    drawADisplay(aCanvas, pbuf.latest, store.display, { rangeMax: currentRange() });
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (playing && voyage.route.length >= 2) {
      const rp = sampleRoute(voyage.route, dist);
      dist += Math.max(rp.speed, 0.15) * dt * playSpeed; // 抛锚时保留极小漂移
      const total = routeTotalLength(voyage.route);
      if (dist >= total) { dist = total; playing = false; document.getElementById('btn-play')!.textContent = '▶ 播放'; toast('航次回放结束'); }
      emitPing();
      drawRoute();
    }
  }
  raf = requestAnimationFrame(loop);
  cleaners.push(() => cancelAnimationFrame(raf));

  return () => cleaners.forEach((fn) => fn());
}
