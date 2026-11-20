// 鱼群布放页：海区顶视图拖拽布放鱼群、鱼种管理（TS-体长换算）、昼夜层位设置

import type { FishSchool, FishSpecies, SchoolShape } from '../core/types';
import { store } from '../core/store';
import { clear, h, modal, numField, select, slider, span, toast } from '../ui/dom';
import { depthAt } from '../core/world';
import { targetStrengthDb } from '../core/physics';
import { uid } from '../core/db';

const SHAPE_NAME: Record<SchoolShape, string> = { ball: '球状', layer: '层状', streak: '长条状' };

export function renderSchoolPage(root: HTMLElement): () => void {
  let selectedId = store.schools[0]?.id ?? '';
  let hour = 12;
  const cleaners: (() => void)[] = [];

  const head = h('div', { class: 'page-head' },
    h('h1', {}, '鱼群布放'),
    span('单体目标强度按体长换算 TS=20logL+b0；鱼群形状/密度/水层随昼夜变化（白天沉底、夜晚上浮）', 'hint'));

  const cv = document.createElement('canvas');
  cv.style.width = '100%'; cv.style.height = '460px'; cv.style.cursor = 'crosshair';
  const mapWrap = h('div', { class: 'card fill' },
    h('h2', {}, `顶视图 — ${store.area.name}（拖动鱼群中心布放）`),
    h('div', { class: 'canvas-wrap' }, cv),
    h('div', { class: 'flex gap12 center mt8 wrap' },
      h('span', { class: 'dim small' }, '仿真时刻'),
      timeSlider(),
      h('span', { class: 'pill', id: 'day-pill' }, '')));

  root.append(head, h('div', { class: 'layout-row' }, mapWrap,
    h('div', { class: 'flex', style: { flexDirection: 'column', gap: '14px', width: '340px', flex: '0 0 340px' } },
      schoolsCard(), speciesCard())));

  function timeSlider() {
    return slider('小时', hour, 0, 24, 0.5, (v) => { hour = v; draw(); }, (v) => `${v.toFixed(1)}h`);
  }

  function schoolsCard() {
    const card = h('div', { class: 'card' },
      h('h2', {}, '鱼群列表'),
      h('div', { class: 'sel-list', id: 'school-list' }),
      h('div', { class: 'btn-row mt12' },
        h('button', { class: 'primary', onclick: addSchool }, '＋ 布放鱼群'),
        h('button', { class: 'danger', onclick: removeSchool }, '删除')));
    refreshList(card);
    return card;
  }

  function refreshList(card?: HTMLElement): void {
    const el = (card ?? document.querySelector('#school-list')) as HTMLElement;
    if (!el) return;
    clear(el);
    for (const sc of store.schools) {
      const sp = store.species.find((s) => s.id === sc.speciesId);
      el.append(h('div', {
        class: `sel-item ${sc.id === selectedId ? 'sel' : ''}`,
        onclick: () => { selectedId = sc.id; draw(); refreshList(); },
        ondblclick: () => editSchool(sc),
      },
        h('div', { class: 'flex between center' },
          h('span', { class: 't' }, sc.name),
          h('span', { class: 'pill' }, SHAPE_NAME[sc.shape])),
        h('div', { class: 'd' },
          `${sp?.name ?? '?'} · ${sc.count} 尾 · 中心水深 ${depthAt(store.area, sc.center.x, sc.center.z).toFixed(0)}m · 昼${(sc.dayDepthFrac * 100).toFixed(0)}%/夜${(sc.nightDepthFrac * 100).toFixed(0)}% 深度`)));
    }
  }

  function speciesCard() {
    const card = h('div', { class: 'card' },
      h('h2', {}, '鱼种与目标强度（10cm / 30cm 体长 TS, dB）'),
      h('div', { class: 'scroll', id: 'species-table' }),
      h('div', { class: 'btn-row mt12' }, h('button', { class: 'primary', onclick: addSpecies }, '＋ 鱼种')));
    fillSpeciesTable();
    return card;
  }

  function fillSpeciesTable(): void {
    const host = document.getElementById('species-table');
    if (!host) return;
    clear(host);
    const rows = store.species.map((sp) => {
      const ts10 = targetStrengthDb(10, sp.b20, sp.b0);
      const ts30 = targetStrengthDb(30, sp.b20, sp.b0);
      return h('tr', {},
        h('td', {}, sp.name),
        h('td', { class: 'mono' }, `${sp.minLength}–${sp.maxLength}`),
        h('td', { class: 'mono' }, `${ts10.toFixed(1)} / ${ts30.toFixed(1)}`),
        h('td', {}, h('button', { onclick: () => editSpecies(sp) }, '编辑')));
    });
    host.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '鱼种'), h('th', {}, '体长 cm'), h('th', {}, 'TS dB'), h('th', {}))),
      h('tbody', {}, ...rows)));
  }

  // ---------- 顶视图 ----------
  function draw(): void {
    const a = store.area;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a1322'; ctx.fillRect(0, 0, W, H);
    const sx = W / a.width, sz = H / a.length;
    // 水深底色
    let minD = Infinity, maxD = 0;
    for (const d of a.depth) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
    for (let iz = 0; iz < a.nz; iz++) {
      for (let ix = 0; ix < a.nx; ix++) {
        const t = (a.depth[iz * a.nx + ix] - minD) / Math.max(1, maxD - minD);
        ctx.fillStyle = `rgba(30,80,130,${0.25 + t * 0.55})`;
        ctx.fillRect(ix * (W / a.nx), iz * (H / a.nz), Math.ceil(W / a.nx), Math.ceil(H / a.nz));
      }
    }
    // 鱼群（含当前时刻的垂直位置投影）
    const solar = 0.5 - 0.5 * Math.cos(((hour - 6) / 12) * Math.PI);
    const day = Math.min(1, Math.max(0, solar));
    for (const sc of store.schools) {
      const sp = store.species.find((s) => s.id === sc.speciesId)!;
      const frac = sc.nightDepthFrac + (sc.dayDepthFrac - sc.nightDepthFrac) * day;
      const cx = sc.center.x * sx, cz = sc.center.z * sz;
      const rx = sc.radiusX * sx, rz = sc.radiusZ * sz;
      ctx.beginPath();
      ctx.ellipse(cx, cz, rx, rz, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexA(sp.color, 0.25);
      ctx.fill();
      ctx.strokeStyle = sp.color;
      ctx.lineWidth = sc.id === selectedId ? 2.5 : 1.2;
      ctx.stroke();
      // 鱼点（按数量抽样）
      ctx.fillStyle = sp.color;
      const nShow = Math.min(sc.count, 60);
      for (let i = 0; i < nShow; i++) {
        const ang = (i / nShow) * Math.PI * 2 + sc.seed;
        const rr = Math.sqrt((i + 0.5) / nShow);
        ctx.fillRect(cx + Math.cos(ang) * rr * rx - 1, cz + Math.sin(ang) * rr * rz - 1, 2, 2);
      }
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.fillText(`${sc.name} ${(frac * 100).toFixed(0)}%水层`, cx + 6, cz - 6);
    }
    const pill = document.getElementById('day-pill');
    if (pill) pill.textContent = day > 0.6 ? '☀ 白天（鱼群沉底）' : day < 0.1 ? '🌙 夜间（鱼群上浮）' : '🌗 晨昏过渡';
  }

  let dragging = false;
  const onDown = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * store.area.width;
    const z = (e.clientY - r.top) / r.height * store.area.length;
    const hit = store.schools.find((sc) =>
      Math.hypot(sc.center.x - x, sc.center.z - z) < Math.max(sc.radiusX, sc.radiusZ) + 6);
    if (hit) { selectedId = hit.id; dragging = true; refreshList(); draw(); }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging || !selectedId) return;
    const r = cv.getBoundingClientRect();
    const sc = store.schools.find((s) => s.id === selectedId)!;
    sc.center.x = Math.min(store.area.width, Math.max(0, (e.clientX - r.left) / r.width * store.area.width));
    sc.center.z = Math.min(store.area.length, Math.max(0, (e.clientY - r.top) / r.height * store.area.length));
    store.saveSchool(sc);
    draw();
  };
  const onUp = () => { dragging = false; };
  cv.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cleaners.push(() => {
    cv.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  });
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  cleaners.push(() => window.removeEventListener('resize', onResize));
  draw();

  // ---------- 编辑对话框 ----------
  function addSchool(): void {
    const sp = store.species[0];
    const draft: FishSchool = {
      id: uid('sc'), areaId: store.area.id, speciesId: sp.id, name: '新鱼群',
      count: 30, shape: 'ball',
      center: { x: store.area.width / 2, y: 0, z: store.area.length / 2 },
      radiusX: 25, radiusY: 10, radiusZ: 25,
      dayDepthFrac: 0.8, nightDepthFrac: 0.3, seed: (Math.random() * 1e5) | 0,
    };
    schoolDialog(draft, true);
  }

  function editSchool(sc: FishSchool): void {
    schoolDialog({ ...sc, center: { ...sc.center } }, false);
  }

  function schoolDialog(draft: FishSchool, isNew: boolean): void {
    const nameI = document.createElement('input'); nameI.value = draft.name;
    const spI = select('鱼种', draft.speciesId, store.species.map((s) => ({ value: s.id, text: s.name })), (v) => { draft.speciesId = v; });
    const shapeI = select('形状', draft.shape, (['ball', 'layer', 'streak'] as SchoolShape[]).map((k) => ({ value: k, text: SHAPE_NAME[k] })), (v) => { draft.shape = v; });
    const countI = numField('数量（尾）', draft.count, 1, (v) => { draft.count = Math.max(1, Math.round(v)); }, 1, 400);
    const xI = numField('中心 X m', draft.center.x, 1, (v) => { draft.center.x = v; }, 0, store.area.width);
    const zI = numField('中心 Z m', draft.center.z, 1, (v) => { draft.center.z = v; }, 0, store.area.length);
    const rxI = numField('水平半径 X m', draft.radiusX, 1, (v) => { draft.radiusX = v; }, 2, 200);
    const rzI = numField('水平半径 Z m', draft.radiusZ, 1, (v) => { draft.radiusZ = v; }, 2, 200);
    const ryI = numField('垂直厚度半径 m', draft.radiusY, 0.5, (v) => { draft.radiusY = v; }, 1, 60);
    const dayI = numField('白天深度比例 0-1', draft.dayDepthFrac, 0.05, (v) => { draft.dayDepthFrac = v; }, 0.05, 1);
    const nightI = numField('夜间深度比例 0-1', draft.nightDepthFrac, 0.05, (v) => { draft.nightDepthFrac = v; }, 0.05, 1);
    const seedI = numField('随机种子', draft.seed, 1, (v) => { draft.seed = Math.round(v); }, 1, 1e9);
    const body = h('div', { class: 'modal-grid' },
      nameI, spI, shapeI, countI, xI, zI, rxI, rzI, ryI, dayI, nightI, seedI);
    modal(isNew ? '布放鱼群' : '编辑鱼群', body, () => {
      draft.name = nameI.value || draft.name;
      // 重新生成实例缓存
      draft.lengths = undefined; draft.offsets = undefined;
      store.saveSchool(draft).then(() => {
        selectedId = draft.id; refreshList(); draw();
        toast(isNew ? '鱼群已布放' : '鱼群已更新', 'ok');
      });
    });
  }

  function removeSchool(): void {
    if (!selectedId) return;
    store.deleteSchool(selectedId).then(() => {
      selectedId = store.schools[0]?.id ?? '';
      refreshList(); draw(); toast('鱼群已删除');
    });
  }

  function addSpecies(): void {
    const draft: FishSpecies = { id: uid('sp'), name: '新鱼种', b20: 20, b0: -66, minLength: 15, maxLength: 40, color: '#8fd0a0' };
    speciesDialog(draft, true);
  }
  function editSpecies(sp: FishSpecies): void { speciesDialog({ ...sp }, false); }

  function speciesDialog(draft: FishSpecies, isNew: boolean): void {
    const nameI = document.createElement('input'); nameI.value = draft.name;
    const b20I = numField('TS 斜率 b20', draft.b20, 1, (v) => { draft.b20 = v; }, 5, 40);
    const b0I = numField('TS 截距 b0 (dB)', draft.b0, 0.5, (v) => { draft.b0 = v; }, -90, -40);
    const minI = numField('最小体长 cm', draft.minLength, 1, (v) => { draft.minLength = v; }, 2, 200);
    const maxI = numField('最大体长 cm', draft.maxLength, 1, (v) => { draft.maxLength = v; }, 2, 300);
    const colorI = document.createElement('input'); colorI.type = 'color'; colorI.value = draft.color;
    colorI.addEventListener('change', () => { draft.color = colorI.value; });
    const body = h('div', { class: 'modal-grid' }, nameI, h('label', { class: 'field' }, span('显示颜色'), colorI), b20I, b0I, minI, maxI);
    modal(isNew ? '新增鱼种' : '编辑鱼种', body, () => {
      draft.name = nameI.value || draft.name;
      store.saveSpecies(draft).then(() => {
        toast('鱼种已保存', 'ok');
        fillSpeciesTable();
        refreshList();
        draw();
      });
    });
  }

  return () => cleaners.forEach((fn) => fn());
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
