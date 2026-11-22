// 共享仿真上下文:全应用唯一 Simulation 实例,数据变更时重建

import { Simulation } from '../core/simulation';
import { store } from '../data/store';

let sim: Simulation | null = null;

export function getSimContext(silent = false): { sim: Simulation } | null {
  const s = store.state;
  if (!s.loaded) {
    if (!silent) throw new Error('数据未加载');
    return null;
  }
  if (!sim) {
    const voyage = s.voyages.find((v) => v.id === s.activeVoyageId) ?? s.voyages[0];
    const txs = s.transducers.filter((t) => s.selectedTxIds.includes(t.id));
    sim = new Simulation(
      s.area,
      s.schools,
      new Map(s.species.map((sp) => [sp.id, sp])),
      txs.length ? txs : s.transducers.slice(0, 2),
      s.settings,
      voyage
    );
  }
  return { sim };
}

/** 数据编辑后重建仿真(保留时钟) */
export function rebuildSimulation(preserveTime = true) {
  const t = sim?.timeSec ?? 0;
  sim = null;
  const ctx = getSimContext();
  if (ctx && preserveTime) ctx.sim.seek(t);
  return ctx;
}
