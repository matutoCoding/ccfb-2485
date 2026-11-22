// 页面 1:海区场景 —— 水深网格编辑、底质涂刷、温跃层、盲区提示

import { SeaArea, SubstrateType } from '../../types';
import { AreaMap, EditTool, MapMode } from '../../render/area-map';
import { SUBSTRATES, deadZoneHeight, sampleFootprint } from '../../core/seabed';
import { rangeResolution } from '../../core/acoustics';
import { h, mount, toast } from '../dom';
import { store } from '../../data/store';
import { rebuildSimulation } from '../sim-context';

export function renderAreaPage() {
  const s = store.state;
  const area: SeaArea = structuredClone(s.area);

  const canvas = h('canvas', { width: 880, height: 660, style: 'width:100%;max-width:880px' });
  const map = new AreaMap(canvas, area);
  map.routeLine = s.voyages[0]?.route ?? [];
  map.overlays = s.schools.map((sc) => ({
    x: sc.x,
    y: sc.y,
    radius: Math.max(sc.radius, 10),
    color: s.species.find((sp) => sp.id === sc.speciesId)?.color
      ? `rgb(${s.species.find((sp) => sp.id === sc.speciesId)!.color.map((v) => Math.round(v * 255)).join(',')})`
      : '#fff',
    label: s.species.find((sp) => sp.id === sc.speciesId)?.name ?? '',
  }));

  const info = h('div', { class: 'muted mono' }, '移动鼠标查看网格参数');
  map.onHover((p) => {
    if (!p) return;
    info.textContent = `坐标 (${p.x.toFixed(0)}, ${p.y.toFixed(0)})m  水深 ${p.depth.toFixed(1)}m  底质:${SUBSTRATES[p.substrate].label}`;
  });
  map.onEdit = (gx, gy) => {
    const idx = gy * area.cols + gx;
    if (map.tool === 'raise') area.cells[idx].depth = Math.max(3, area.cells[idx].depth - 1.5);
    else if (map.tool === 'lower') area.cells[idx].depth += 1.5;
    else if (map.tool === 'mud' || map.tool === 'sand' || map.tool === 'rock') {
      area.cells[idx].substrate = map.tool as SubstrateType;
    }
    map.render();
  };

  // 盲区估算面板
  const dzInfo = h('div', { class: 'muted' });
  function refreshDeadzone() {
    const tx = s.transducers[0];
    if (!tx) return;
    const c = 1500;
    const res = rangeResolution(c, tx.pulseMs);
    const samples = [
      { name: '平坦沙底', x: 120, y: 120 },
      { name: '礁石垄边缘', x: 300, y: 250 },
      { name: '深水斜坡', x: 650, y: 450 },
    ];
    dzInfo.replaceChildren(
      h('h3', {}, `波束盲区估算(换能器:${tx.name},脉宽分辨 ${res.toFixed(2)}m)`),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '位置'), h('th', {}, '水深'), h('th', {}, '坡度'), h('th', {}, '盲区高度'), h('th', {}, '底质'))),
        h('tbody', {}, ...samples.map((pt) => {
          const d = area.cells[Math.floor(pt.y / area.cellSize)]
            ? sampleFootprint(area, pt.x, pt.y, 0.8, 60, tx.beamAngleDeg / 2)
            : null;
          if (!d) return h('tr', {}, h('td', { colSpan: 5 }, pt.name));
          const dz = deadZoneHeight(d.minSlant, tx.beamAngleDeg / 2, d.slopeRad, res);
          return h('tr', {},
            h('td', {}, pt.name),
            h('td', { class: 'mono' }, `${d.meanDepth.toFixed(1)}m`),
            h('td', { class: 'mono' }, `${(d.slopeRad * 180 / Math.PI).toFixed(1)}°`),
            h('td', { class: dz > 2 ? 'warn mono' : 'good mono' }, `${dz.toFixed(2)}m`),
            h('td', {}, h('span', { class: `tag ${d.substrate}` }, SUBSTRATES[d.substrate].label)));
        }))
      )
    );
  }

  const modeBtns: Record<MapMode, HTMLButtonElement> = {
    depth: h('button', { onClick: () => { map.mode = 'depth'; map.render(); } }, '深度着色'),
    substrate: h('button', { onClick: () => { map.mode = 'substrate'; map.render(); } }, '底质着色'),
  };
  const tools: Array<[EditTool, string]> = [
    ['none', '浏览'],
    ['raise', '抬升海床'],
    ['lower', '降低海床'],
    ['mud', '刷泥底'],
    ['sand', '刷沙底'],
    ['rock', '刷礁石'],
  ];
  const toolBtns = tools.map(([tool, label]) =>
    h('button', {
      class: 'small',
      onClick: () => { map.tool = tool; toast(`工具:${label}`); },
    }, label)
  );
  const brush = h('input', { type: 'range', min: '1', max: '5', value: '2' });
  brush.addEventListener('input', () => (map.brush = Number(brush.value)));

  // 温跃层表单
  const tc = area.thermocline!;
  const tcTop = h('input', { type: 'number', value: String(tc.topDepth) });
  const tcThick = h('input', { type: 'number', value: String(tc.thickness) });
  const tcDelta = h('input', { type: 'number', value: String(tc.deltaTemp) });
  const tcEnabled = h('input', { type: 'checkbox', checked: true });
  tcTop.addEventListener('input', () => (tc.topDepth = Number(tcTop.value)));
  tcThick.addEventListener('input', () => (tc.thickness = Number(tcThick.value)));
  tcDelta.addEventListener('input', () => (tc.deltaTemp = Number(tcDelta.value)));

  const root = h('div', {},
    h('div', { class: 'panel' },
      h('h2', {}, '海区场景 · 水深网格与底质编辑'),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, ...Object.values(modeBtns), h('span', { style: 'width:12px' }), ...toolBtns,
        h('label', { class: 'check' }, '笔刷', brush)),
      h('div', { class: 'grid-2' },
        h('div', { class: 'canvas-wrap' }, canvas),
        h('div', {},
          h('div', { class: 'panel', style: 'margin:0 0 12px' }, h('h2', {}, '网格信息'), info),
          h('div', { class: 'panel', style: 'margin:0 0 12px' },
            h('h2', {}, '温跃层'),
            h('label', { class: 'check', style: 'margin-bottom:8px' }, '启用温跃层', tcEnabled),
            h('div', { class: 'grid-3' },
              h('label', { class: 'field' }, '顶部深度 m', tcTop),
              h('label', { class: 'field' }, '厚度 m', tcThick),
              h('label', { class: 'field' }, '温差 ℃', tcDelta)),
          ),
          h('div', { class: 'panel', style: 'margin:0' }, dzInfo),
        )
      ),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', {
          class: 'primary',
          onClick: async () => {
            if (!tcEnabled.checked) area.thermocline = null;
            await store.saveArea(area);
            rebuildSimulation();
            refreshDeadzone();
            toast('海区已保存到 IndexedDB,仿真已重建');
          },
        }, '保存海区并应用'),
        h('button', {
          onClick: () => {
            const blob = new Blob([JSON.stringify(area, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: `${area.id}.json` });
            a.click();
          },
        }, '导出 JSON'),
      )
    )
  );
  mount(root);
  map.render();
  refreshDeadzone();
}
