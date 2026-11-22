// 页面 2:鱼群布放 —— 鱼种参数、鱼群形态/密度、昼夜水层

import { FishSchool, FishSpecies } from '../../types';
import { dielFactor } from '../../core/fish';
import { targetStrength } from '../../core/acoustics';
import { h, mount, toast } from '../dom';
import { store } from '../../data/store';
import { rebuildSimulation } from '../sim-context';

export function renderFishPage() {
  const s = store.state;
  const species = structuredClone(s.species) as FishSpecies[];
  const schools = structuredClone(s.schools) as FishSchool[];

  // ---- 鱼种表 ----
  const speciesRows = () =>
    species.map((sp, i) =>
      h('tr', {},
        h('td', {}, h('input', {
          value: sp.name,
          onInput: (e) => { sp.name = (e.target as HTMLInputElement).value; },
        })),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sp.b20), step: '0.5', style: 'width:70px',
          onInput: (e) => { sp.b20 = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sp.b0), step: '1', style: 'width:70px',
          onInput: (e) => { sp.b0 = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sp.typicalLengthCm), style: 'width:70px',
          onInput: (e) => { sp.typicalLengthCm = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' },
          `50k:${targetStrength(sp, sp.typicalLengthCm, 50).toFixed(1)}dB / 200k:${targetStrength(sp, sp.typicalLengthCm, 200).toFixed(1)}dB`),
        h('td', {}, h('button', {
          class: 'small danger',
          onClick: () => { species.splice(i, 1); render(); },
        }, '删除')),
      )
    );

  // ---- 鱼群表 ----
  const schoolRows = () =>
    schools.map((sc, i) => {
      const sp = species.find((x) => x.id === sc.speciesId);
      return h('tr', {},
        h('td', {}, h('select', {
          onInput: (e) => { sc.speciesId = (e.target as HTMLSelectElement).value; },
        }, ...species.map((x) => h('option', { value: x.id, selected: x.id === sc.speciesId }, x.name)))),
        h('td', {}, h('select', {
          onInput: (e) => { sc.shape = (e.target as HTMLSelectElement).value as FishSchool['shape']; render(); },
        }, ...(['ball', 'layer', 'elongated'] as const).map((sh) =>
          h('option', { value: sh, selected: sc.shape === sh }, { ball: '球团', layer: '层状', elongated: '拉长' }[sh])))),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sc.count), min: '1', style: 'width:70px',
          onInput: (e) => { sc.count = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' }, `(${sc.x},${sc.y})`),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sc.radius), style: 'width:60px',
          onInput: (e) => { sc.radius = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' }, h('input', {
          type: 'number', value: String(sc.meanLengthCm), style: 'width:60px',
          onInput: (e) => { sc.meanLengthCm = Number((e.target as HTMLInputElement).value); },
        })),
        h('td', { class: 'mono' },
          h('input', {
            type: 'number', value: String(sc.dayDepth), style: 'width:56px',
            onInput: (e) => { sc.dayDepth = Number((e.target as HTMLInputElement).value); drawDiel(); },
          }),
          ' / ',
          h('input', {
            type: 'number', value: String(sc.nightDepth), style: 'width:56px',
            onInput: (e) => { sc.nightDepth = Number((e.target as HTMLInputElement).value); drawDiel(); },
          })),
        h('td', {}, h('label', { class: 'check' }, h('input', {
          type: 'checkbox', checked: sc.enabled,
          onChange: (e) => { sc.enabled = (e.target as HTMLInputElement).checked; },
        }))),
        h('td', {}, h('button', {
          class: 'small danger',
          onClick: () => { schools.splice(i, 1); render(); },
        }, '删除')),
        h('td', { class: 'muted' }, sp ? `TS≈${targetStrength(sp, sc.meanLengthCm, 50).toFixed(1)}dB` : ''),
      );
    });

  // ---- 昼夜迁移曲线 ----
  const dielCanvas = h('canvas', { width: 720, height: 200, style: 'width:100%;max-width:720px' });
  function drawDiel() {
    const ctx = dielCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 720, 200);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, 720, 200);
    const maxD = Math.max(60, ...schools.map((x) => x.dayDepth)) + 10;
    const px = (hour: number) => (hour / 24) * 700 + 10;
    const py = (d: number) => 180 - (d / maxD) * 160;
    ctx.strokeStyle = 'rgba(120,160,220,0.2)';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(160,190,230,0.7)';
    for (let d = 0; d <= maxD; d += 10) {
      ctx.beginPath(); ctx.moveTo(10, py(d)); ctx.lineTo(710, py(d)); ctx.stroke();
      ctx.fillText(`${d}m`, 0, py(d) - 2);
    }
    for (let hr = 0; hr <= 24; hr += 3) {
      ctx.fillText(`${hr}:00`, px(hr) - 10, 196);
    }
    const colors = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8'];
    schools.forEach((sc, si) => {
      ctx.strokeStyle = colors[si % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let hr = 0; hr <= 24; hr += 0.25) {
        const f = dielFactor(hr);
        const depth = sc.nightDepth + (sc.dayDepth - sc.nightDepth) * f;
        const x = px(hr);
        const y = py(depth);
        if (hr === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const sp = species.find((x) => x.id === sc.speciesId);
      ctx.fillStyle = colors[si % colors.length];
      ctx.fillText(sp?.name ?? sc.id, px(23), py(sc.dayDepth) - 4);
    });
  }

  function render() {
    root.replaceChildren(
      h('div', { class: 'panel' },
        h('h2', {}, '鱼种参数(体长 L → 目标强度 TS = b20·log₁₀L + b0)'),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '鱼种'), h('th', {}, 'b20'), h('th', {}, 'b0'), h('th', {}, '典型体长 cm'), h('th', {}, 'TS 预览'), h('th', {}))),
          h('tbody', {}, ...speciesRows())),
        h('div', { style: 'margin-top:10px' },
          h('button', {
            class: 'small',
            onClick: () => {
              species.push({
                id: `sp-${Date.now()}`, name: '新鱼种', b20: 20, b0: -66,
                typicalLengthCm: 25, freqSlope: 0, color: [0.9, 0.6, 0.6],
              });
              render();
            },
          }, '＋ 添加鱼种'))
      ),
      h('div', { class: 'panel' },
        h('h2', {}, '鱼群布放(白天深度 / 夜间深度,昼夜自动迁移)'),
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, '鱼种'), h('th', {}, '形态'), h('th', {}, '数量(密度)'),
            h('th', {}, '位置 m'), h('th', {}, '半径 m'), h('th', {}, '均体长 cm'),
            h('th', {}, '昼/夜深度 m'), h('th', {}, '启用'), h('th', {}), h('th', {}))),
          h('tbody', {}, ...schoolRows())),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', {
            class: 'small',
            onClick: () => {
              const sp0 = species[0];
              if (!sp0) return toast('请先添加鱼种');
              schools.push({
                id: `sc-${Date.now()}`, speciesId: sp0.id, count: 50, shape: 'ball',
                x: 300, y: 300, radius: 12, radiusX: 30, radiusY: 30,
                dayDepth: 40, nightDepth: 15, meanLengthCm: sp0.typicalLengthCm, enabled: true,
              });
              render();
            },
          }, '＋ 添加鱼群')),
        h('h3', {}, '昼夜垂直迁移曲线(纵轴深度,向下加深)'),
        h('div', { class: 'canvas-wrap' }, dielCanvas),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('button', {
            class: 'primary',
            onClick: async () => {
              await store.saveSpecies(species);
              await store.saveSchools(schools);
              rebuildSimulation();
              toast('鱼种与鱼群已保存,仿真已重建');
            },
          }, '保存并应用到仿真'),
          h('span', { class: 'muted' }, '保存后到「回波显示」页观察昼夜水层差异'))
      )
    );
    drawDiel();
  }

  const root = h('div');
  mount(root);
  render();
}
