// 换能器选型页：换能器库管理、双频同屏左右对比、三维声束圆锥、同鱼群回波差异并排比较

import type { Transducer } from '../core/types';
import { store } from '../core/store';
import { clear, h, modal, numField, span, toast } from '../ui/dom';
import { uid } from '../core/db';
import { absorptionDbPerM, sourceLevel } from '../core/physics';
import { EchoEngine, makeChannel, BIN_M } from '../core/engine';
import { WaterfallRenderer } from '../render/waterfall';
import { PingBuffer, drawADisplay } from '../render/adisplay';
import { GLEngine, OrbitCamera, boatMesh, coneMesh, coneRimMesh, polylineMesh, seabedMesh } from '../render/gl3d';
import { depthAt, instantiateWorld } from '../core/world';

const COLS = 320;

export function renderTransducerPage(root: HTMLElement): () => void {
  const cleaners: (() => void)[] = [];
  const area = store.area;
  const engine = new EchoEngine(area, store.schools, store.species);
  const hour = 12;
  const fish = instantiateWorld(area, store.schools, store.species, hour);

  const head = h('div', { class: 'page-head' },
    h('h1', {}, '换能器选型'),
    span('50k 波束宽、探得远、适合找大鱼群；200k 分辨力高、弧更细、吸收大。下面对同一片鱼群并排比较', 'hint'));

  // 换能器库表
  const tableHost = h('div', { class: 'card' }, h('div', { id: 'td-table' }));
  const libCard = h('div', { class: 'card' },
    h('h2', {}, '换能器库'),
    tableHost,
    h('div', { class: 'btn-row mt12' },
      h('button', { class: 'primary', onclick: addTd }, '＋ 新增换能器'),
      h('button', {
        onclick: () => {
          const tds = store.selectedTransducers;
          if (tds.length < 2) toast('请在表中勾选两个换能器用于同屏对比', 'err');
          else buildComparison();
        },
      }, '🔄 重新生成对比')));

  // 三维圆锥
  const gl3dCanvas = document.createElement('canvas');
  gl3dCanvas.style.width = '100%'; gl3dCanvas.style.height = '320px';
  const coneCard = h('div', { class: 'card fill' },
    h('h2', {}, '三维声束圆锥（跟船位置，蓝色 50k / 紫色 200k）'),
    h('div', { class: 'canvas-wrap' }, gl3dCanvas));

  // 对比瀑布图
  const cmpHost = h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr' } });
  const cmpCard = h('div', { class: 'card mt12' },
    h('h2', {}, '同位置、同鱼群、同参数下的回波并排对比（各 120 ping 定点扫描）'),
    cmpHost);

  root.append(head, libCard, h('div', { class: 'layout-row mt12' }, coneCard), cmpCard);

  fillTable();
  let gl3: GLEngine | null = null;
  let cam: OrbitCamera | null = null;
  init3d();
  buildComparison();

  function fillTable(): void {
    clear(tableHost);
    const rows = store.transducers.map((t) => {
      const checked = store.selectedTransducerIds.includes(t.id);
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked;
      cb.addEventListener('change', () => {
        const ids = store.selectedTransducerIds;
        if (cb.checked) {
          if (ids.length >= 2) { cb.checked = false; toast('最多同时对比两个换能器', 'err'); return; }
          ids.push(t.id);
        } else {
          const i = ids.indexOf(t.id);
          if (i >= 0) ids.splice(i, 1);
        }
      });
      const alpha = absorptionDbPerM(t.frequency);
      return h('tr', {},
        h('td', {}, cb),
        h('td', {}, t.name),
        h('td', {}, h('span', { class: `tag ${t.frequency < 100000 ? 'f50' : 'f200'}` }, `${(t.frequency / 1000).toFixed(0)}kHz`)),
        h('td', { class: 'mono' }, `${t.beamAngleDeg}°`),
        h('td', { class: 'mono' }, `${t.powerW}W`),
        h('td', { class: 'mono' }, `${t.pulseMs}ms`),
        h('td', { class: 'mono' }, `${alpha.toFixed(4)}`),
        h('td', { class: 'mono' }, `${sourceLevel(t).toFixed(1)}`),
        h('td', {},
          h('button', { onclick: () => editTd(t) }, '编辑'),
          h('button', { class: 'danger', style: { marginLeft: '6px' }, onclick: () => removeTd(t) }, '删')));
    });
    tableHost.append(h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '选'), h('th', {}, '名称'), h('th', {}, '频率'), h('th', {}, '全波束角'),
        h('th', {}, '功率'), h('th', {}, '脉宽'), h('th', {}, '吸收 dB/m'), h('th', {}, '声源级 dB'), h('th', {}))),
      h('tbody', {}, ...rows)));
  }

  // ---------- 三维圆锥 ----------
  function init3d(): void {
    gl3 = new GLEngine(gl3dCanvas);
    cam = new OrbitCamera();
    cam.target = [area.width / 2, 25, area.length / 2];
    cam.dist = Math.max(area.width, area.length) * 0.9;
    cleaners.push(cam.attach(gl3dCanvas));
    const boat = { x: area.width * 0.42, z: area.length * 0.4 };
    const d = depthAt(area, boat.x, boat.z);
    const meshes = [seabedMesh(area)];
    const tds = store.selectedTransducers;
    tds.forEach((_t, i) => {
      const t = tds[i];
      const ch = makeChannel(t, area.soundSpeed);
      const color: [number, number, number] = t.frequency < 100000 ? [0.22, 0.72, 0.95] : [0.78, 0.45, 0.95];
      meshes.push(coneMesh(boat.x, boat.z, d, ch.halfAngle, color));
      meshes.push(coneRimMesh(boat.x, boat.z, d, ch.halfAngle, color));
    });
    meshes.push(polylineMesh(
      fish.slice(0, 200).map((f) => ({ x: f.x, y: f.y, z: f.z })),
      [0.55, 0.9, 0.6], 0.9));
    meshes.push(boatMesh(boat.x, boat.z, 0));
    for (const m of meshes) gl3.upload(m);
    let raf = 0;
    const loop = () => { gl3!.render(cam!); raf = requestAnimationFrame(loop); };
    loop();
    cleaners.push(() => cancelAnimationFrame(raf));
  }

  // ---------- 并排回波对比 ----------
  function buildComparison(): void {
    clear(cmpHost);
    const tds = store.selectedTransducers;
    if (tds.length === 0) {
      cmpHost.append(h('div', { class: 'muted' }, '请在上方勾选 1–2 个换能器'));
      return;
    }
    const boat = { x: area.width * 0.42, y: 0.2, z: area.length * 0.4 };
    const rangeMax = Math.min(120, Math.ceil(depthAt(area, boat.x, boat.z) * 1.35 / 10) * 10);
    for (const t of tds.slice(0, 2)) {
      const ch = makeChannel(t, area.soundSpeed);
      const wfCanvas = document.createElement('canvas');
      wfCanvas.style.width = '100%'; wfCanvas.style.height = '300px';
      const aCanvas = document.createElement('canvas');
      aCanvas.style.width = '100%'; aCanvas.style.height = '150px';
      const wf = new WaterfallRenderer(wfCanvas, COLS);
      wf.setAlpha(ch.alpha);
      const pbuf = new PingBuffer(COLS);
      const stat = h('div', { class: 'muted small mono mt8' }, '');
      const block = h('div', {},
        h('div', { class: 'flex between center' },
          h('strong', {}, t.name),
          h('span', { class: `tag ${t.frequency < 100000 ? 'f50' : 'f200'}` },
            `${(t.frequency / 1000).toFixed(0)}kHz · ${t.beamAngleDeg}° · ${t.pulseMs}ms`)),
        h('div', { class: 'canvas-wrap mt8' }, wfCanvas),
        h('div', { class: 'canvas-wrap mt8' }, aCanvas),
        stat);
      cmpHost.append(block);

      // 定点扫描 120 ping（船微漂，保证出月牙弧）
      const settings = { ...store.display };
      let fishLevels: number[] = [];
      // 填满整个瀑布图（COLS 列），船匀速漂移扫过鱼群形成完整月牙弧
      const driftStep = 0.35;
      for (let p = 0; p < COLS; p++) {
        const drift = (p - COLS / 2) * driftStep;
        const meta = engine.computePing(ch, {
          time: p * 0.25, hour,
          boat: { x: boat.x + drift, y: boat.y, z: boat.z },
          boatSpeed: 1.4, heading: 0, pingRate: 4,
          noise: store.noise, tvgMode: settings.tvgMode, tvgStrength: settings.tvgStrength,
        });
        wf.pushPing(meta); pbuf.push(meta);
        if (meta.hits.length) fishLevels.push(...meta.hits.map((x) => x.level));
      }
      wf.setLut(settings.colormap);
      wf.render(settings, rangeMax, { enabled: false, top: 0, height: rangeMax });
      drawADisplay(aCanvas, pbuf.latest, settings, { rangeMax });
      const meanFish = fishLevels.length ? fishLevels.reduce((a, b) => a + b, 0) / fishLevels.length : NaN;
      stat.textContent =
        `α=${ch.alpha.toFixed(4)}dB/m  SL=${ch.sl.toFixed(1)}dB  门宽=${(BIN_M * 2).toFixed(2)}m  ` +
        `鱼回波均值=${isFinite(meanFish) ? meanFish.toFixed(1) : '—'}dB  底深=${depthAt(area, boat.x, boat.z).toFixed(1)}m`;

      // 悬停联动 A 显示
      const onMove = (e: PointerEvent) => {
        const r = wfCanvas.getBoundingClientRect();
        const col = wf.screenXToColumn((e.clientX - r.left) / r.width);
        const meta = pbuf.atColumn(col);
        drawADisplay(aCanvas, meta, settings, { rangeMax });
      };
      wfCanvas.addEventListener('pointermove', onMove);
      cleaners.push(() => wfCanvas.removeEventListener('pointermove', onMove));
    }
  }

  // ---------- 库管理 ----------
  function addTd(): void {
    const draft: Transducer = {
      id: uid('td'), name: '新换能器', frequency: 200000, beamAngleDeg: 15,
      powerW: 600, pulseMs: 0.3, gainCalib: 0,
    };
    tdDialog(draft, true);
  }
  function editTd(t: Transducer): void { tdDialog({ ...t }, false); }

  function tdDialog(draft: Transducer, isNew: boolean): void {
    const nameI = document.createElement('input'); nameI.value = draft.name;
    const fI = numField('频率 Hz', draft.frequency, 1000, (v) => { draft.frequency = v; }, 10000, 1000000);
    const bI = numField('全波束角 °', draft.beamAngleDeg, 0.5, (v) => { draft.beamAngleDeg = v; }, 3, 90);
    const pI = numField('功率 W', draft.powerW, 10, (v) => { draft.powerW = v; }, 10, 5000);
    const tauI = numField('脉宽 ms', draft.pulseMs, 0.05, (v) => { draft.pulseMs = v; }, 0.05, 5);
    const gI = numField('标定修正 dB', draft.gainCalib, 0.1, (v) => { draft.gainCalib = v; }, -10, 10);
    const body = h('div', { class: 'modal-grid' }, nameI, fI, bI, pI, tauI, gI);
    modal(isNew ? '新增换能器' : '编辑换能器', body, () => {
      draft.name = nameI.value || draft.name;
      store.saveTransducer(draft).then(() => {
        fillTable(); toast('换能器已保存', 'ok');
      });
    });
  }

  function removeTd(t: Transducer): void {
    store.deleteTransducer(t.id).then(() => { fillTable(); toast('已删除'); });
  }

  return () => cleaners.forEach((fn) => fn());
}
