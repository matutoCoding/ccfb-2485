// 页面 6:设置 —— 全局参数、数据管理、物理精度自检

import { runSelftest } from '../../../test/selftest';
import { h, mount, toast } from '../dom';
import { store } from '../../data/store';
import { rebuildSimulation } from '../sim-context';
import { COLORMAPS } from '../../render/colormap';
import { SelftestResult } from '../../types';

export function renderSettingsPage() {
  const s = store.state;
  const settings = s.settings;

  const pingRate = h('input', { type: 'number', min: '1', max: '20', step: '0.5', value: String(settings.pingRateHz) });
  const resultsBox = h('div', {});

  async function runTests() {
    resultsBox.replaceChildren(h('div', { class: 'muted' }, '正在运行物理自检…'));
    await new Promise((r) => setTimeout(r, 30));
    const results = runSelftest();
    resultsBox.replaceChildren(
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '项目'), h('th', {}, '结果'), h('th', {}, '实测'), h('th', {}, '理论'), h('th', {}, '误差'), h('th', {}, '说明'))),
        h('tbody', {}, ...results.map((r: SelftestResult) =>
          h('tr', {},
            h('td', {}, r.name),
            h('td', { class: r.pass ? 'good' : 'bad' }, r.pass ? '✔ 通过' : '✘ 失败'),
            h('td', { class: 'mono' }, r.measured !== undefined ? fmt(r.measured) : '-'),
            h('td', { class: 'mono' }, r.expected !== undefined ? fmt(r.expected) : '-'),
            h('td', { class: 'mono' }, r.errorPx !== undefined ? `${r.errorPx.toFixed(2)} 像素行` : '-'),
            h('td', { class: 'muted' }, r.detail)))))
    );
    const failed = results.filter((r) => !r.pass).length;
    toast(failed === 0 ? `全部 ${results.length} 项自检通过` : `${failed} 项自检失败,请检查物理参数`);
  }

  const root = h('div', {},
    h('div', { class: 'panel' },
      h('h2', {}, '仿真全局参数'),
      h('div', { class: 'grid-3' },
        h('label', { class: 'field' }, 'ping 频率 Hz', pingRate),
        h('label', { class: 'field' }, '默认色表', h('select', {}, ...COLORMAPS.map((c) =>
          h('option', { value: c.id, selected: settings.gain.default?.colormap === c.id }, c.name)))))),
    h('div', { class: 'panel' },
      h('h2', {}, '物理精度自检(月牙弧几何 / TVG 距离一致性 / 盲区吞噬)'),
      h('p', { class: 'muted' },
        '自检直接调用回波引擎(不经渲染插值),按波束角、船速、鱼深计算理论弧顶深度与弧宽,与引擎逐 ping 输出比对;TVG 项校验同一条鱼在 10m 与 80m 的输出色阶差。判定线:几何误差 ≤ 1 个像素行,TVG 差 ≤ 1dB。'),
      h('div', { class: 'row', style: 'margin-bottom:12px' },
        h('button', { class: 'primary', onClick: runTests }, '运行自检')),
      resultsBox),
    h('div', { class: 'panel' },
      h('h2', {}, '数据管理(IndexedDB)'),
      h('div', { class: 'row' },
        h('button', {
          onClick: async () => {
            const data = {
              area: s.area, species: s.species, schools: s.schools,
              transducers: s.transducers, voyages: s.voyages, settings: s.settings,
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: 'fishfinder-sim-backup.json' });
            a.click();
            toast('已导出全部场景数据');
          },
        }, '导出全部数据 JSON'),
        h('button', {
          class: 'danger',
          onClick: async () => {
            if (!confirm('确认恢复出厂内置数据?当前编辑将被覆盖。')) return;
            await store.resetToSeed();
            rebuildSimulation(false);
            toast('已重置为内置测试数据');
          },
        }, '恢复出厂数据'),
        h('button', {
          onClick: () => {
            const input = h('input', { type: 'file', accept: '.json' });
            input.addEventListener('change', async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                const data = JSON.parse(await file.text());
                if (data.area) await store.saveArea(data.area);
                if (data.species) await store.saveSpecies(data.species);
                if (data.schools) await store.saveSchools(data.schools);
                if (data.transducers) await store.saveTransducers(data.transducers);
                if (data.voyages) await store.saveVoyages(data.voyages);
                rebuildSimulation(false);
                toast('数据导入成功,页面即将刷新');
                setTimeout(() => location.reload(), 800);
              } catch (err) {
                toast('导入失败:' + (err as Error).message);
              }
            });
            input.click();
          },
        }, '导入数据 JSON'))),
    h('div', { class: 'panel' },
      h('h2', {}, '系统说明'),
      h('ul', { class: 'muted' },
        h('li', {}, '声学链:声源级 SL → 圆活塞波束指向性(双程)→ 传播损失 20logR+αR → TS/底质反向散射 → TVG(40logR+2αR)→ 色标映射'),
        h('li', {}, '单鱼月牙弧:逐 ping 按鱼-船实时几何计算斜距与偏轴角,斜距变化自然形成弧顶与弧宽,非贴图'),
        h('li', {}, '底质回波:等效束宽法面回波,泥/沙/礁强度、粗糙度展宽与二次回波衰减各不相同'),
        h('li', {}, '盲区:斜坡几何盲区 r·tan(β/2)·tan(α) 叠加脉宽分辨单元,贴底鱼在盲区内标记为被吞噬')))
  );
  mount(root);
  // 自动跑一次
  void pingRate;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}
