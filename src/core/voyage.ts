// 航线时间线:航点 -> 任意时刻船位/船速/抛锚状态

import { RoutePoint, Voyage } from '../types';

export interface BoatState {
  x: number;
  y: number;
  speed: number;
  anchored: boolean;
  /** 当前所在航段索引 */
  segment: number;
  /** 航段内 0..1 进度 */
  progress: number;
}

interface Segment {
  from: RoutePoint;
  to: RoutePoint;
  dist: number;
  /** 航行耗时 s */
  travel: number;
  /** 该段起始时刻 s */
  t0: number;
  /** 到达 to 后的停留结束时刻 s */
  dwellEnd: number;
}

export class VoyageTimeline {
  readonly segments: Segment[] = [];
  readonly totalTime: number;
  /** 循环航行 */
  loop = true;

  constructor(readonly voyage: Voyage) {
    let t = 0;
    const pts = voyage.route;
    for (let i = 0; i < pts.length - 1; i++) {
      const from = pts[i];
      const to = pts[i + 1];
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const speed = Math.max(from.speed, 0.1);
      const travel = dist / speed;
      this.segments.push({
        from,
        to,
        dist,
        travel,
        t0: t,
        dwellEnd: t + travel + (to.dwellSec || 0),
      });
      t += travel + (to.dwellSec || 0);
    }
    this.totalTime = Math.max(t, 1);
  }

  stateAt(timeSec: number): BoatState {
    let t = this.loop ? timeSec % this.totalTime : Math.min(timeSec, this.totalTime);
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (t <= seg.dwellEnd || i === this.segments.length - 1) {
        if (t < seg.t0 + seg.travel) {
          const p = seg.travel > 0 ? (t - seg.t0) / seg.travel : 1;
          const s = p * p * (3 - 2 * p); // smoothstep 缓入缓出
          return {
            x: seg.from.x + (seg.to.x - seg.from.x) * s,
            y: seg.from.y + (seg.to.y - seg.from.y) * s,
            speed: seg.dist / Math.max(seg.travel, 1e-6),
            anchored: false,
            segment: i,
            progress: p,
          };
        }
        return {
          x: seg.to.x,
          y: seg.to.y,
          speed: 0,
          anchored: true,
          segment: i,
          progress: 1,
        };
      }
    }
    const last = this.voyage.route[this.voyage.route.length - 1];
    return { x: last.x, y: last.y, speed: 0, anchored: true, segment: 0, progress: 1 };
  }
}
