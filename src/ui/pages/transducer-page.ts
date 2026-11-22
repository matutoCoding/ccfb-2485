// 页面 3:换能器选型 —— 参数库、同场景并排回波对比、声束锥几何

import { Transducer } from '../../types';
import { EchoEngine } from '../../core/echo-engine';
import { PingColumn } from '../../types';
import { absorptionDbPerM, sourceLevel } from '../../core/acoustics';
import { footprintRadius } from '../../core/seabed';
import { h, mount, toast } from '../dom';
import { store } from '../../data/store';
import { rebuildSimulation } from '../sim-context';
import { WaterfallRenderer } from '../../render/waterfall';

const WF_W = 360;
const WF_H = 420;
const COMPARE_PINGS = 260;

export function renderTransducerPage() {
  const s = store.state;
  const list = structuredClone(s.transducers) as Transducer[];
  const selected = new Set(s.selectedTxIds);
  let compareA = list[0]?.id;
  let compareB = list[1]?.id;

  // ---- 对比仿真:固定船位穿过一个球团鱼群 ----
  function runCompare(txId: string): { renderer: WaterfallRenderer; cols: PingColumn[] } | null {
    const tx = list.find((t) => t.id === txId);
    if (!tx) return null;
    const settings = structuredClone(s.settings);
    settings.display.rangeM = 0;
    settings.display.showSecondEcho = true;
    const engine = new EchoEngine(
      {
        area: s.area,
        schools: s.schools.filter((x) => x.enabled),
        species: new Map(s.species.map((sp) => [sp.id, sp])),
      },
      tx,
      settings,
      99117
    );
    const rangeM = Math.max(...s.area.cells.map((c) => c.depth)) + 15;
    const gain = settings.gain[tx.id] ?? settings.gain.default!;
    const renderer = new WaterfallRenderer(h('canvas', { width: WF_W, height: WF_H }), WF_W, WF_H, gain);
    const cols: PingColumn[] = [];
    // 船以 2.5m/s 横向穿过鱼群中心,每 ping 间隔 0.25s
    const target = s.schools[0];
    const y = target?.y ?? 300;
    const x0 = (target?.x ?? 400) - 180;
    for (let i = 0; i < COMPARE_PINGS; i++) {
      const t = i * 0.25;
      const col = engine.generatePing({
        index: i,
        timeSec: t,
        hour: 12,
        x: x0 + 2.5 * t,
        y,
        speed: 2.5,
        anchored: false,
      });
      renderer.pushColumn(col, gain, rangeM);
      cols.push(col);
    }
    renderer.render({ rangeM, binStep: cols[0].binStep, bottomLockM: 0, zoom: 1 });
    return { renderer, cols };
  }

  // ---- 声束几何示意 ----
  const coneCanvas = h('canvas', { width: 360, height: 420 });
  function drawCones() {
    const ctx = coneCanvas.getContext('2d')!;
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, 360, 420);
    const maxD = 100;
    const py = (d: number) => 30 + (d / maxD) * 360;
    const px = (r: number) => 180 + r * 1.6;
    ctx.strokeStyle = 'rgba(120,160,220,0.25)';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(160,190,230,0.7)';
    for (let d = 0; d <= maxD; d += 10) {
      ctx.beginPath(); ctx.moveTo(20, py(d)); ctx.lineTo(340, py(d)); ctx.stroke();
      ctx.fillText(`${d}m`, 2, py(d) - 2);
    }
    const shown = list.filter((t) => selected.has(t.id));
    shown.forEach((t) => {
      ctx.strokeStyle = t.color;
      ctx.fillStyle = t.color + '22';
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      ctx.lineTo(px(footprintRadius(maxD, t.beamAngleDeg / 2)), py(maxD));
      ctx.lineTo(px(-footprintRadius(maxD, t.beamAngleDeg / 2)), py(maxD));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const r50 = footprintRadius(50, t.beamAngleDeg / 2);
      ctx.fillStyle = t.color;
      ctx.fillText(`${t.name}  50m脚印Ø${(r50 * 2).toFixed(1)}m`, px(r50) + 4, py(50));
    });
  }

  function comparePanel() {
    const wrap = h('div', { class: 'split two' });
    for (const id of [compareA, compareB]) {
      const tx = list.find((t) => t.id === id);
      if (!tx) continue;
      const result = runCompare(id);
      const alpha = absorptionDbPerM(tx.freqKhz, s.area.surfaceTempC);
      wrap.append(
        h('div', { class: 'panel', style: 'margin:0' },
          h('h2', { style: `color:${tx.color}` }, tx.name),
          h('div', { class: 'muted', style: 'margin-bottom:8px' },
            `频率 ${tx.freqKhz}kHz · 波束角 ${tx.beamAngleDeg}° · 功率 ${tx.powerW}W · 脉宽 ${tx.pulseMs}ms · SL ${sourceLevel(tx).toFixed(0)}dB · α ${(alpha * 1000).toFixed(1)}dB/km`),
          h('div', { class: 'canvas-wrap' }, canvasOf(result!.renderer)),
          h('div', { class: 'muted mono', style: 'margin-top:6px' },
            result ? `距离门 ${(result.cols[0].binStep * 100).toFixed(1)}cm · 同场景 ${COMPARE_PINGS} ping,观察弧宽与底回波差异` : ''))
      );
    }
    return wrap;
  }

  // WaterfallRenderer 持有 canvas,取出用
  function canvasOf(r: WaterfallRenderer): HTMLCanvasElement {
    return (r as unknown as { gl: WebGL2RenderingContext }).gl.canvas as HTMLCanvasElement;
  }

  function render() {
    drawCones();
    const tableEl = h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, '选用'), h('th', {}, '名称'), h('th', {}, '频率 kHz'),
          h('th', {}, '全波束角 °'), h('th', {}, '功率 W'), h('th', {}, '脉宽 ms'),
          h('th', {}, 'SL 修正 dB'), h('th', {}, '50m 脚印直径'), h('th', {})
        )
      ),
      h(
        'tbody',
        {},
        ...list.map((t, i) =>
          h(
            'tr',
            {},
            h(
              'td',
              {},
              h('input', {
                type: 'checkbox',
                checked: selected.has(t.id),
                onChange: (e) => {
                  const ck = (e.target as HTMLInputElement).checked;
                  if (ck) {
                    if (selected.size >= 2) {
                      (e.target as HTMLInputElement).checked = false;
                      return toast('最多同屏两个换能器');
                    }
                    selected.add(t.id);
                  } else selected.delete(t.id);
                  drawCones();
                },
              })
            ),
            h('td', {}, h('input', { value: t.name, onInput: (e) => (t.name = (e.target as HTMLInputElement).value) })),
            h('td', { class: 'mono' }, h('input', { type: 'number', value: String(t.freqKhz), style: 'width:80px', onInput: (e) => (t.freqKhz = Number((e.target as HTMLInputElement).value)) })),
            h('td', { class: 'mono' }, h('input', { type: 'number', value: String(t.beamAngleDeg), style: 'width:70px', onInput: (e) => (t.beamAngleDeg = Number((e.target as HTMLInputElement).value)) })),
            h('td', { class: 'mono' }, h('input', { type: 'number', value: String(t.powerW), style: 'width:80px', onInput: (e) => (t.powerW = Number((e.target as HTMLInputElement).value)) })),
            h('td', { class: 'mono' }, h('input', { type: 'number', step: '0.05', value: String(t.pulseMs), style: 'width:70px', onInput: (e) => (t.pulseMs = Number((e.target as HTMLInputElement).value)) })),
            h('td', { class: 'mono' }, h('input', { type: 'number', step: '0.5', value: String(t.slOffsetDb), style: 'width:70px', onInput: (e) => (t.slOffsetDb = Number((e.target as HTMLInputElement).value)) })),
            h('td', { class: 'mono' }, `${(footprintRadius(50, t.beamAngleDeg / 2) * 2).toFixed(1)}m`),
            h('td', {}, h('button', { class: 'small danger', onClick: () => { list.splice(i, 1); render(); } }, '删除'))
          )
        )
      )
    );

    const libraryPanel = h(
      'div',
      { class: 'panel' },
      h('h2', {}, '换能器库(频率 / 波束角 / 功率 / 脉宽)'),
      tableEl,
      h(
        'div',
        { class: 'row', style: 'margin-top:10px' },
        h('button', {
          class: 'small',
          onClick: () => {
            list.push({
              id: `tx-${Date.now()}`, name: '新换能器', freqKhz: 120, beamAngleDeg: 18,
              powerW: 400, pulseMs: 0.3, slOffsetDb: 0, color: '#ba68c8',
            });
            render();
          },
        }, '＋ 添加换能器'),
        h('button', {
          class: 'primary',
          onClick: async () => {
            await store.saveTransducers(list);
            store.selectTransducers([...selected]);
            rebuildSimulation();
            toast('换能器库已保存,同屏选择已应用');
          },
        }, '保存并应用')
      )
    );

    const conePanel = h(
      'div',
      { class: 'panel' },
      h('h2', {}, '声束圆锥几何(按各换能器波束角,深度 100m)'),
      h('div', { class: 'canvas-wrap', style: 'max-width:380px' }, coneCanvas)
    );

    const comparePanelEl = h(
      'div',
      { class: 'panel' },
      h('h2', {}, '同场景并排回波对比(船以 2.5m/s 横越同一鱼群,正午)'),
      h(
        'div',
        { class: 'row', style: 'margin-bottom:10px' },
        h('span', { class: 'muted' }, '左:'),
        txSelect(list, compareA, (v) => { compareA = v; render(); }),
        h('span', { class: 'muted' }, '右:'),
        txSelect(list, compareB, (v) => { compareB = v; render(); }),
        h('button', { class: 'small', onClick: () => render() }, '重新计算')
      ),
      comparePanel()
    );

    root.replaceChildren(libraryPanel, conePanel, comparePanelEl);
  }

  const root = h('div');
  mount(root);
  render();
}

function txSelect(list: Transducer[], value: string | undefined, onChange: (id: string) => void) {
  const sel = h('select', {}, ...list.map((t) => h('option', { value: t.id, selected: t.id === value }, t.name)));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
