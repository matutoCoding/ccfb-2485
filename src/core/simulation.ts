// 仿真编排:时钟驱动航线 + 一个或多个换能器引擎,产出逐 ping 列

import { AppSettings, FishSchool, PingColumn, SeaArea, Transducer, Voyage } from '../types';
import { EchoEngine, EngineWorld } from './echo-engine';
import { VoyageTimeline } from './voyage';

export class Simulation {
  timeline: VoyageTimeline;
  engines: EchoEngine[] = [];
  timeSec = 0;
  private pingIndex = 0;
  /** 累计的 ping 列(每个引擎独立一条环形缓冲由 view 层管理,这里保留全量供回放) */
  history: PingColumn[][] = [];
  maxHistory = 4000;

  constructor(
    public area: SeaArea,
    public schools: FishSchool[],
    species: EngineWorld['species'],
    public transducers: Transducer[],
    public settings: AppSettings,
    voyage: Voyage
  ) {
    this.timeline = new VoyageTimeline(voyage);
    const world: EngineWorld = { area, schools, species };
    for (const tx of transducers) {
      this.engines.push(new EchoEngine(world, tx, settings, hashStr(tx.id)));
      this.history.push([]);
    }
  }

  get voyage() {
    return this.timeline.voyage;
  }

  get pingInterval() {
    return 1 / Math.max(0.5, this.settings.pingRateHz);
  }

  /** 推进一个 ping 周期,返回各换能器的新列 */
  step(): PingColumn[] {
    const out: PingColumn[] = [];
    const state = this.timeline.stateAt(this.timeSec);
    const hour = (this.voyage.startHour + (this.timeSec * this.voyage.timeScale) / 3600) % 24;
    for (let i = 0; i < this.engines.length; i++) {
      const col = this.engines[i].generatePing({
        index: this.pingIndex,
        timeSec: this.timeSec,
        hour,
        x: state.x,
        y: state.y,
        speed: state.speed,
        anchored: state.anchored,
      });
      out.push(col);
      const h = this.history[i];
      h.push(col);
      if (h.length > this.maxHistory) h.shift();
    }
    this.pingIndex++;
    this.timeSec += this.pingInterval;
    return out;
  }

  /** 跳到指定仿真时间并清空历史(回放拖动用) */
  seek(timeSec: number) {
    this.timeSec = Math.max(0, timeSec);
    this.pingIndex = Math.round(this.timeSec / this.pingInterval);
    for (const h of this.history) h.length = 0;
  }

  reset() {
    this.seek(0);
  }

  rebuildFish() {
    for (const e of this.engines) e.rebuildFish();
    for (const h of this.history) h.length = 0;
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
