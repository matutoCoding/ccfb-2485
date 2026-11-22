// 页面 5:航次回放 —— 航线编辑、船速曲线、时间缩放、回放验证鱼弧形态

import { RoutePoint, Voyage } from '../../types';
import { VoyageTimeline } from '../../core/voyage';
import { AreaMap } from '../../render/area-map';
import { h, mount, toast } from '../dom';
import { store } from '../../data/store';
import { rebuildSimulation } from '../sim-context';

export function renderVoyagePage() {
  const s = store.state;
  const voyage: Voyage = structuredClone(s.voyages.find((v) => v.id === s.activeVoyageId) ?? s.voyages[0]);
  let selected = 0;

  const mapCanvas = h('canvas', { width: 760, height: 570, style: 'width:100%;max-width:760px;cursor:crosshair' });
  const areaMap = new AreaMap(mapCanvas, s.area);
  areaMap.routeLine = voyage.route;
  areaMap.overlays = s.schools.map((sc) => ({
    x: sc.x, y: sc.y, radius: Math.max(sc.radius, 10),
    color: '#81c784', label: s.species.find((sp) => sp.id === sc.speciesId)?.name ?? '',
  }));

  // 点击地图追加航点
  mapCanvas.addEventListener('click', (e) => {
    const rect = mapCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * s.area.cols * s.area.cellSize;
    const y = ((e.clientY - rect.top) / rect.height) * s.area.rows * s.area.cellSize;
    voyage.route.push({ x: Math.round(x), y: Math.round(y), speed: 2.5, dwellSec: 0 });
    selected = voyage.route.length - 1;
    areaMap.routeLine = voyage.route;
    render();
  });

  // ---- 船速曲线 ----
  const speedCanvas = h('canvas', { width: 760, height: 200, style: 'width:100%;max-width:760px' });
  function drawSpeedCurve() {
    const ctx = speedCanvas.getContext('2d')!;
    const W = speedCanvas.width;
    const H = speedCanvas.height;
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);
    const timeline = new VoyageTimeline(voyage);
    const maxV = Math.max(5, ...voyage.route.map((p) => p.speed));
    const px = (t: number) => 40 + (t / timeline.totalTime) * (W - 60);
    const py = (v: number) => H - 30 - (v / maxV) * (H - 55);
    ctx.strokeStyle = 'rgba(120,160,220,0.2)';
    ctx.fillStyle = 'rgba(160,190,230,0.7)';
    ctx.font = '10px monospace';
    for (let v = 0; v <= maxV; v += 1) {
      ctx.beginPath(); ctx.moveTo(40, py(v)); ctx.lineTo(W - 20, py(v)); ctx.stroke();
      ctx.fillText(`${v}m/s`, 6, py(v) + 3);
    }
    // 速度曲线
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let t = 0; t <= timeline.totalTime; t += 0.5) {
      const st = timeline.stateAt(t);
      const x = px(t);
      const y = py(st.anchored ? 0 : st.speed);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 航点标记
    ctx.fillStyle = '#ffb74d';
    for (const seg of timeline.segments) {
      ctx.beginPath();
      ctx.arc(px(seg.t0), py(seg.from.speed), 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (seg.to.dwellSec > 0) {
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText(`抛锚${seg.to.dwellSec}s`, px(seg.t0 + seg.travel) - 20, py(0) - 8);
        ctx.fillStyle = '#ffb74d';
      }
    }
    ctx.fillStyle = 'rgba(160,190,230,0.7)';
    ctx.fillText(`总时长 ${timeline.totalTime.toFixed(0)}s · 航点 ${voyage.route.length} 个`, 44, 16);
  }

  // ---- 航点表 ----
  function pointRows() {
    return voyage.route.map((p, i) => h('tr', {
      style: i === selected ? 'background:color-mix(in srgb,var(--accent) 15%,transparent)' : '',
      onClick: () => { selected = i; render(); },
    },
      h('td', { class: 'mono' }, `P${i}`),
      h('td', { class: 'mono' }, h('input', { type: 'number', value: String(p.x), style: 'width:70px', onInput: (e) => { p.x = Number((e.target as HTMLInputElement).value); areaMap.routeLine = voyage.route; areaMap.render(); } })),
      h('td', { class: 'mono' }, h('input', { type: 'number', value: String(p.y), style: 'width:70px', onInput: (e) => { p.y = Number((e.target as HTMLInputElement).value); areaMap.routeLine = voyage.route; areaMap.render(); } })),
      h('td', { class: 'mono' }, h('input', { type: 'number', step: '0.1', value: String(p.speed), style: 'width:64px', onInput: (e) => { p.speed = Number((e.target as HTMLInputElement).value); drawSpeedCurve(); } })),
      h('td', { class: 'mono' }, h('input', { type: 'number', value: String(p.dwellSec), style: 'width:64px', onInput: (e) => { p.dwellSec = Number((e.target as HTMLInputElement).value); drawSpeedCurve(); } })),
      h('td', {}, h('button', { class: 'small danger', onClick: (e) => { e.stopPropagation(); voyage.route.splice(i, 1); selected = Math.max(0, selected - 1); render(); } }, '删除')),
    ));
  }

  const startHour = h('input', { type: 'number', min: '0', max: '23', step: '0.5', value: String(voyage.startHour) });
  const timeScale = h('input', { type: 'number', min: '1', step: '10', value: String(voyage.timeScale) });

  // ---- 回放预览(小瀑布) ----
  let playing = false;
  let raf = 0;
  const playBtn = h('button', { class: 'primary' }, '▶ 回放预览');
  const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', style: 'width:100%' });
  const boatInfo = h('div', { class: 'muted mono' }, '准备回放');

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 回放预览';
    if (playing) {
      const ctx = rebuildSimulation();
      if (!ctx) return;
      const sim = ctx.sim;
      const timeline = new VoyageTimeline(voyage);
      const loop = () => {
        if (!playing) return;
        if (sim.timeSec > timeline.totalTime) sim.reset();
        const st = timeline.stateAt(sim.timeSec);
        areaMap.boat = { x: st.x, y: st.y };
        areaMap.render();
        boatInfo.textContent = `t=${sim.timeSec.toFixed(1)}s  船位(${st.x.toFixed(0)},${st.y.toFixed(0)})  ${st.anchored ? '抛锚(鱼弧将拉成横线)' : `航速 ${st.speed.toFixed(1)}m/s(高速鱼弧压扁)`}`;
        scrub.value = String(Math.round((sim.timeSec / timeline.totalTime) * 1000));
        sim.timeSec += 0.5;
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    } else cancelAnimationFrame(raf);
  });
  scrub.addEventListener('input', () => {
    const timeline = new VoyageTimeline(voyage);
    const t = (Number(scrub.value) / 1000) * timeline.totalTime;
    const st = timeline.stateAt(t);
    areaMap.boat = { x: st.x, y: st.y };
    areaMap.render();
  });

  function render() {
    areaMap.routeLine = voyage.route;
    areaMap.render();
    drawSpeedCurve();
    const cur: RoutePoint | undefined = voyage.route[selected];
    root.replaceChildren(
      h('div', { class: 'panel' },
        h('h2', {}, '航线编辑(点击地图追加航点,航线上点为停靠点)'),
        h('div', { class: 'grid-2' },
          h('div', { class: 'canvas-wrap' }, mapCanvas),
          h('div', {},
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, '点'), h('th', {}, 'X m'), h('th', {}, 'Y m'), h('th', {}, '船速 m/s'), h('th', {}, '停留 s'), h('th', {}))),
              h('tbody', {}, ...pointRows())),
            h('div', { class: 'row', style: 'margin-top:10px' },
              h('label', { class: 'field' }, '起始时钟(小时)', startHour),
              h('label', { class: 'field' }, '时间流逝倍率', timeScale)),
            cur ? h('p', { class: 'muted', style: 'margin-top:8px' },
              `选中 P${selected}:船速决定鱼弧压扁程度,停留时间 >0 即抛锚,抛锚期间单鱼回波拉成水平横线`) : null))),
      h('div', { class: 'panel' },
        h('h2', {}, '船速曲线'),
        h('div', { class: 'canvas-wrap' }, speedCanvas)),
      h('div', { class: 'panel' },
        h('h2', {}, '回放预览(鱼弧形态随船速变化)'),
        h('div', { class: 'row' }, playBtn, boatInfo),
        scrub),
      h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('button', {
            class: 'primary',
            onClick: async () => {
              voyage.startHour = Number(startHour.value);
              voyage.timeScale = Number(timeScale.value);
              const all = structuredClone(s.voyages);
              const idx = all.findIndex((v) => v.id === voyage.id);
              if (idx >= 0) all[idx] = voyage; else all.push(voyage);
              await store.saveVoyages(all);
              store.setActiveVoyage(voyage.id);
              rebuildSimulation();
              toast('航次已保存,回「回波显示」页可直接按此航线运行');
            },
          }, '保存航次并应用'),
          h('button', {
            onClick: () => {
              voyage.route = [{ x: 80, y: 80, speed: 2.5, dwellSec: 0 }];
              selected = 0;
              render();
            },
          }, '清空航线')))
    );
  }

  const root = h('div');
  mount(root);
  render();
}
