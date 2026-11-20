// 海区场景页：海区列表、2D 水深/底质编辑、纵剖面坡度显示、温跃层与散射层开关

import type { SeaArea, Substrate } from '../core/types';
import { store } from '../core/store';
import { checkbox, clear, h, modal, numField, slider, span, toast } from '../ui/dom';
import { depthAt, gridIndex, slopeAt, SUBSTRATE_ACOUSTIC, SUBSTRATE_KEY, SUBSTRATE_NAME } from '../core/world';
import { uid } from '../core/db';

const SUB_COLORS = ['#8a7040', '#b0a458', '#6a748c'];

export function renderAreaPage(root: HTMLElement): () => void {
  let paintSub = 1;
  let brush = 1;
  let editingArea = store.area;
  let mouseDown = false;
  let raf = 0;

  const head = h('div', { class: 'page-head' },
    h('h1', {}, '海区场景'),
    span('按水深网格建立海区，泥/沙/礁三类底质决定回波强度、粗糙度与二次回波', 'hint'));

  // 左侧海区列表
  const listCard = h('div', { class: 'card', style: { width: '250px', flex: '0 0 250px' } },
    h('h2', {}, '海区列表'),
    h('div', { class: 'sel-list', id: 'area-list' }),
    h('div', { class: 'btn-row mt12' },
      h('button', { class: 'primary', onclick: createArea }, '＋ 新建海区')));

  const planCanvas = document.createElement('canvas');
  planCanvas.style.width = '100%';
  planCanvas.style.height = '380px';
  planCanvas.style.cursor = 'crosshair';
  const profileCanvas = document.createElement('canvas');
  profileCanvas.style.width = '100%';
  profileCanvas.style.height = '180px';

  const planWrap = h('div', { class: 'canvas-wrap' }, planCanvas);
  const profileWrap = h('div', { class: 'canvas-wrap mt12' }, profileCanvas);

  const info = h('div', { class: 'muted small mono mt8' }, '');
  const titleEl = h('h2', {}, `水深 / 底质编辑 — ${editingArea.name}`);
  const layerGrid = h('div', { class: 'grid mt12', style: { gridTemplateColumns: '1fr 1fr' } });

  const right = h('div', { class: 'card fill' },
    titleEl,
    h('div', { class: 'flex gap8 wrap center mb8' },
      ...(['mud', 'sand', 'rock'] as Substrate[]).map((_k, i) =>
        h('button', {
          class: paintSub === i ? 'primary' : '',
          onclick: () => { paintSub = i; refreshList(); },
        }, `涂刷：${SUBSTRATE_NAME[i]}`)),
      h('span', { class: 'pill' }, '笔刷格数'),
      h('input', {
        type: 'number', min: '1', max: '6', value: '1', style: { width: '64px' },
        onchange: (e: Event) => { brush = parseInt((e.target as HTMLInputElement).value) || 1; },
      }),
      h('button', {
        onclick: () => { paintSub = -1; refreshList(); },
        title: '按住左键拖动抬高水深，右键降低',
      }, '✎ 改水深模式'),
      h('button', { onclick: () => store.saveArea(editingArea) }, '💾 保存'),
    ),
    planWrap,
    info,
    h('div', { class: 'legend mt8' },
      ...SUBSTRATE_NAME.map((n, i) => h('span', {}, h('i', { style: { background: SUB_COLORS[i] } }), n))),
    h('h2', { class: 'mt16' }, '纵剖面（z 向中线，坡度与盲区来源）'),
    profileWrap,
    layerGrid);

  function rebuildLayerCards(): void {
    clear(layerGrid);
    layerGrid.append(thermoCard(), planktonCard());
  }
  root.append(head, h('div', { class: 'layout-row' }, listCard, right));
  rebuildLayerCards();

  function thermoCard() {
    const tc = editingArea.thermocline;
    return h('div', { class: 'card' },
      h('h2', {}, '温跃层'),
      checkbox('启用温跃层弱回波带', tc.enabled, (v) => { tc.enabled = v; store.saveArea(editingArea); }),
      h('div', { class: 'mt8' }, slider('顶界深度 m', tc.top, 5, 80, 0.5, (v) => { tc.top = v; store.saveArea(editingArea); draw(); }, (v) => v.toFixed(1))),
      slider('厚度 m', tc.thickness, 2, 25, 0.5, (v) => { tc.thickness = v; store.saveArea(editingArea); }, (v) => v.toFixed(1)),
      slider('散射强度', tc.strength, 0, 1, 0.05, (v) => { tc.strength = v; store.saveArea(editingArea); }, (v) => v.toFixed(2)));
  }

  function planktonCard() {
    const pl = editingArea.planktonLayer;
    return h('div', { class: 'card' },
      h('h2', {}, '浮游生物散射层（DSL）'),
      checkbox('启用散射层（高频更明显）', pl.enabled, (v) => { pl.enabled = v; store.saveArea(editingArea); }),
      h('div', { class: 'mt8' }, slider('白天深度 m', pl.dayDepth, 10, 100, 1, (v) => { pl.dayDepth = v; store.saveArea(editingArea); })),
      slider('夜间深度 m', pl.nightDepth, 5, 80, 1, (v) => { pl.nightDepth = v; store.saveArea(editingArea); }),
      slider('厚度 m', pl.thickness, 2, 25, 0.5, (v) => { pl.thickness = v; store.saveArea(editingArea); }, (v) => v.toFixed(1)),
      slider('散射强度', pl.strength, 0, 1, 0.05, (v) => { pl.strength = v; store.saveArea(editingArea); }, (v) => v.toFixed(2)));
  }

  function refreshList(): void {
    const el = document.getElementById('area-list')!;
    clear(el);
    for (const a of store.data!.areas) {
      el.append(h('div', {
        class: `sel-item ${a.id === editingArea.id ? 'sel' : ''}`,
        onclick: () => { editingArea = a; store.selectedAreaId = a.id; routeRefresh(); },
      },
        h('div', { class: 't' }, a.name),
        h('div', { class: 'd' }, `${a.nx}×${a.nz} 格 · ${a.width}×${a.length}m · 声速 ${a.soundSpeed}m/s`)));
    }
  }

  function routeRefresh(): void {
    titleEl.textContent = `水深 / 底质编辑 — ${editingArea.name}`;
    rebuildLayerCards();
    refreshList();
    draw();
  }

  function createArea(): void {
    const nameI = document.createElement('input'); nameI.value = '新海区';
    const wI = numField('宽 m', 400, 10, (v) => v, 100, 2000);
    const lI = numField('长 m', 400, 10, (v) => v, 100, 2000);
    const nI = numField('网格分辨率（每边格点）', 25, 2, (v) => v, 10, 60);
    (nI.querySelector('input') as HTMLInputElement).value = '25';
    const body = h('div', { class: 'modal-grid' }, nameI, wI, lI, nI);
    modal('新建海区', body, () => {
      const nx = parseInt((nI.querySelector('input') as HTMLInputElement).value);
      const width = parseFloat((wI.querySelector('input') as HTMLInputElement).value);
      const length = parseFloat((lI.querySelector('input') as HTMLInputElement).value);
      const area: SeaArea = {
        id: uid('area'), name: nameI.value || '新海区',
        width, length, nx, nz: nx,
        depth: new Float32Array(nx * nx).fill(40),
        substrate: new Uint8Array(nx * nx).fill(1),
        soundSpeed: 1500,
        thermocline: { enabled: false, top: 20, thickness: 8, strength: 0.5 },
        planktonLayer: { enabled: false, dayDepth: 45, nightDepth: 15, thickness: 10, strength: 0.45 },
      };
      store.saveArea(area).then(() => {
        editingArea = area; store.selectedAreaId = area.id;
        refreshList(); routeRefresh(); toast('海区已创建', 'ok');
      });
    });
  }

  // ---------- 画布绘制与交互 ----------
  function draw(): void {
    drawPlan();
    drawProfile();
  }

  function drawPlan(): void {
    const a = editingArea;
    const cv = planCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a1322'; ctx.fillRect(0, 0, W, H);
    let minD = Infinity, maxD = 0;
    for (const d of a.depth) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
    const cw = W / a.nx, ch = H / a.nz;
    for (let iz = 0; iz < a.nz; iz++) {
      for (let ix = 0; ix < a.nx; ix++) {
        const i = gridIndex(a, ix, iz);
        const base = SUB_COLORS[a.substrate[i]];
        const t = (a.depth[i] - minD) / Math.max(1, maxD - minD);
        ctx.fillStyle = shade(base, 0.55 + t * 0.7);
        ctx.fillRect(ix * cw, iz * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    for (let ix = 0; ix <= a.nx; ix += 5) {
      ctx.beginPath(); ctx.moveTo(ix * cw, 0); ctx.lineTo(ix * cw, H); ctx.stroke();
    }
    for (let iz = 0; iz <= a.nz; iz += 5) {
      ctx.beginPath(); ctx.moveTo(0, iz * ch); ctx.lineTo(W, iz * ch); ctx.stroke();
    }
    // 深度等值线
    ctx.strokeStyle = 'rgba(120,200,255,0.55)';
    ctx.font = '10px Consolas';
    ctx.fillStyle = '#9fd8ff';
    for (const lvl of [20, 40, 60, 80]) {
      ctx.beginPath();
      let started = false;
      for (let ix = 0; ix < a.nx; ix++) {
        for (let iz = 0; iz < a.nz - 1; iz++) {
          const d0 = a.depth[gridIndex(a, ix, iz)], d1 = a.depth[gridIndex(a, ix, iz + 1)];
          if ((d0 - lvl) * (d1 - lvl) < 0) {
            const t = (lvl - d0) / (d1 - d0);
            const x = (ix + 0.5) * cw, y = (iz + t) * ch;
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#cfeaff';
    ctx.fillText(`水深 ${minD.toFixed(0)}–${maxD.toFixed(0)}m`, 8, 16);
  }

  function drawProfile(): void {
    const a = editingArea;
    const cv = profileCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a1322'; ctx.fillRect(0, 0, W, H);
    const iz = Math.floor(a.nz / 2);
    let maxD = 0;
    const depths: number[] = [];
    for (let ix = 0; ix < a.nx; ix++) {
      const d = a.depth[gridIndex(a, ix, iz)];
      depths.push(d); maxD = Math.max(maxD, d);
    }
    const pad = 28;
    const plotH = H - pad * 2;
    const xStep = (W - pad * 2) / (a.nx - 1);
    // 水体
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    depths.forEach((d, ix) => ctx.lineTo(pad + ix * xStep, pad + (d / maxD) * plotH));
    ctx.lineTo(W - pad, pad); ctx.closePath();
    ctx.fillStyle = 'rgba(40,110,170,0.18)'; ctx.fill();
    // 海底（按底质着色段）
    for (let ix = 0; ix < a.nx - 1; ix++) {
      const s = a.substrate[gridIndex(a, ix, iz)];
      ctx.strokeStyle = SUB_COLORS[s];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(pad + ix * xStep, pad + (depths[ix] / maxD) * plotH);
      ctx.lineTo(pad + (ix + 1) * xStep, pad + (depths[ix + 1] / maxD) * plotH);
      ctx.stroke();
    }
    // 坡度标注
    ctx.fillStyle = '#8ea3c0'; ctx.font = '10px Consolas';
    for (let ix = 2; ix < a.nx - 2; ix += 4) {
      const x = (ix / (a.nx - 1)) * a.width;
      const z = (iz / (a.nz - 1)) * a.length;
      const sl = slopeAt(a, x, z) * 180 / Math.PI;
      if (sl > 8) {
        ctx.fillStyle = '#f0a838';
        ctx.fillText(`${sl.toFixed(0)}°`, pad + ix * xStep - 8, pad + (depths[ix] / maxD) * plotH - 6);
      }
    }
    ctx.fillStyle = '#5f7595';
    ctx.fillText(`最大水深 ${maxD.toFixed(1)}m`, 8, H - 8);
    ctx.fillText('坡度 >8° 区域声束照射形成盲区（橙色标注）', W - 250, H - 8);
  }

  function eventToGrid(e: PointerEvent): { ix: number; iz: number } {
    const r = planCanvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fz = (e.clientY - r.top) / r.height;
    return {
      ix: Math.min(editingArea.nx - 1, Math.max(0, Math.floor(fx * editingArea.nx))),
      iz: Math.min(editingArea.nz - 1, Math.max(0, Math.floor(fz * editingArea.nz))),
    };
  }

  function paint(e: PointerEvent): void {
    const { ix, iz } = eventToGrid(e);
    const a = editingArea;
    for (let dz = -brush + 1; dz < brush; dz++) {
      for (let dx = -brush + 1; dx < brush; dx++) {
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= a.nx || z >= a.nz) continue;
        const i = gridIndex(a, x, z);
        if (paintSub >= 0) a.substrate[i] = paintSub;
        else a.depth[i] = Math.max(3, a.depth[i] + (e.buttons === 2 ? -1.2 : 1.2));
      }
    }
    draw();
    const x = (ix / (a.nx - 1)) * a.width, z = (iz / (a.nz - 1)) * a.length;
    info.textContent = `格点(${ix},${iz}) 坐标(${x.toFixed(0)},${z.toFixed(0)})m 水深${depthAt(a, x, z).toFixed(1)}m 底质:${SUBSTRATE_NAME[substrateAtLocal(a, ix, iz)]} 坡度:${(slopeAt(a, x, z) * 180 / Math.PI).toFixed(1)}°`;
  }

  function substrateAtLocal(a: SeaArea, ix: number, iz: number): number {
    return a.substrate[gridIndex(a, ix, iz)];
  }

  function bindCanvas(): void {
    const cv = planCanvas;
    const down = (e: PointerEvent) => { mouseDown = true; paint(e); };
    const move = (e: PointerEvent) => { if (mouseDown) paint(e); else hoverInfo(e); };
    const up = () => { mouseDown = false; };
    const ctxMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    cv.addEventListener('contextmenu', ctxMenu);
    cleaners.push(() => {
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cv.removeEventListener('contextmenu', ctxMenu);
    });
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    cleaners.push(() => window.removeEventListener('resize', onResize));
  }

  function hoverInfo(e: PointerEvent): void {
    const { ix, iz } = eventToGrid(e);
    const a = editingArea;
    const x = (ix / (a.nx - 1)) * a.width, z = (iz / (a.nz - 1)) * a.length;
    info.textContent = `格点(${ix},${iz}) 坐标(${x.toFixed(0)},${z.toFixed(0)})m 水深${depthAt(a, x, z).toFixed(1)}m 底质:${SUBSTRATE_NAME[a.substrate[gridIndex(a, ix, iz)]]} 坡度:${(slopeAt(a, x, z) * 180 / Math.PI).toFixed(1)}° 二次回波增益:${SUBSTRATE_ACOUSTIC[a.substrate[gridIndex(a, ix, iz)]].secondEchoGain}dB`;
  }

  const cleaners: (() => void)[] = [];
  bindCanvas();
  refreshList();
  raf = requestAnimationFrame(draw);
  void raf;

  return () => cleaners.forEach((fn) => fn());
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * k);
  const g = Math.min(255, ((n >> 8) & 255) * k);
  const b = Math.min(255, (n & 255) * k);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// 底质声学参数表（供设置页等复用说明）
export function substrateSummary(): string {
  return SUBSTRATE_KEY.map((_k, i) =>
    `${SUBSTRATE_NAME[i]}: 反向散射${SUBSTRATE_ACOUSTIC[i].backscatter}dB, 二次回波${SUBSTRATE_ACOUSTIC[i].secondEchoGain}dB`).join('；');
}
