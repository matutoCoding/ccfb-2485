// ping 元数据环形缓冲 + 单 ping A 显示曲线（Canvas 2D）

import type { FishHit, PingMeta } from '../core/types';
import { BIN_M } from '../core/engine';
import { displayLevel, DISPLAY_CEIL, DISPLAY_FLOOR } from '../core/colormaps';
import type { DisplaySettings } from '../core/types';

export class PingBuffer {
  private buf: (PingMeta | null)[];
  cols: number;
  private head = -1;

  constructor(cols: number) {
    this.cols = cols;
    this.buf = new Array(cols).fill(null);
  }

  push(meta: PingMeta): void {
    this.head = (this.head + 1) % this.cols;
    this.buf[this.head] = meta;
  }

  /** 列序号（与瀑布图 screenXToColumn 同构） */
  atColumn(col: number): PingMeta | null {
    if (this.head < 0) return null;
    return this.buf[col];
  }

  get latest(): PingMeta | null {
    return this.head < 0 ? null : this.buf[this.head];
  }

  clear(): void {
    this.buf.fill(null);
    this.head = -1;
  }
}

export interface ADisplayOptions {
  rangeMax: number;
  lock?: { enabled: boolean; top: number; height: number };
  markedRange?: number; // 反查命中的距离门，画竖线
}

export function drawADisplay(
  canvas: HTMLCanvasElement,
  meta: PingMeta | null,
  settings: DisplaySettings,
  opts: ADisplayOptions,
): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#070c16';
  ctx.fillRect(0, 0, w, h);

  const padL = 44 * dpr, padR = 10 * dpr, padT = 10 * dpr, padB = 18 * dpr;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  // 网格 + 深度刻度（纵轴向下为深）
  ctx.strokeStyle = '#1a2740';
  ctx.fillStyle = '#5f7595';
  ctx.font = `${10 * dpr}px Consolas`;
  ctx.lineWidth = 1;
  const rangeMax = opts.lock?.enabled ? opts.lock.height : opts.rangeMax;
  const top = opts.lock?.enabled ? opts.lock.top : 0;
  const ticks = 8;
  for (let i = 0; i <= ticks; i++) {
    const y = padT + (i / ticks) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const depth = top + (i / ticks) * rangeMax;
    ctx.fillText(`${depth.toFixed(0)}m`, 4 * dpr, y + 3 * dpr);
  }

  if (!meta) {
    ctx.fillStyle = '#3a4d6b';
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillText('悬停瀑布图查看该 ping 的 A 显示', padL + 10 * dpr, padT + plotH / 2);
    return;
  }

  // 电平窗口刻度（顶部）
  ctx.fillStyle = '#5f7595';
  for (let db = DISPLAY_FLOOR; db <= DISPLAY_CEIL; db += 22) {
    const x = padL + ((db - DISPLAY_FLOOR) / (DISPLAY_CEIL - DISPLAY_FLOOR)) * plotW;
    ctx.fillText(`${db}`, x - 8 * dpr, h - 4 * dpr);
  }

  const b0 = Math.floor(top / BIN_M);
  const b1 = Math.min(meta.raw.length - 1, Math.floor((top + rangeMax) / BIN_M));

  // A 显示包络曲线（应用与瀑布图完全相同的 displayLevel）
  ctx.beginPath();
  for (let b = b0; b <= b1; b++) {
    const lvl = displayLevel(meta.raw[b], meta.tvg[b], settings);
    const x = padL + lvl * plotW;
    const y = padT + ((b - b0) / Math.max(1, b1 - b0)) * plotH;
    if (b === b0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#48c08a';
  ctx.lineWidth = 1.4 * dpr;
  ctx.stroke();

  // 填充
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL, padT);
  ctx.closePath();
  ctx.fillStyle = 'rgba(72,192,138,0.12)';
  ctx.fill();

  // 海底位置红线
  if (meta.bottomRange > 0 && meta.bottomRange >= top && meta.bottomRange <= top + rangeMax) {
    const y = padT + ((meta.bottomRange - top) / rangeMax) * plotH;
    ctx.strokeStyle = '#e66060';
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e66060';
    ctx.fillText(`底 ${meta.bottomRange.toFixed(1)}m`, w - padR - 56 * dpr, y - 2 * dpr);
  }

  // 鱼命中点
  ctx.fillStyle = '#f0d060';
  for (const hit of meta.hits) {
    if (hit.range < top || hit.range > top + rangeMax) continue;
    const b = hit.range / BIN_M;
    const y = padT + ((b - b0) / Math.max(1, b1 - b0)) * plotH;
    const lvl = displayLevel(hit.level, meta.tvg[Math.floor(b)] ?? 0, settings);
    ctx.beginPath();
    ctx.arc(padL + lvl * plotW, y, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  // 反查标记
  if (opts.markedRange && opts.markedRange >= top && opts.markedRange <= top + rangeMax) {
    const y = padT + ((opts.markedRange - top) / rangeMax) * plotH;
    ctx.strokeStyle = '#38b6e6';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
}

export function strongestHit(meta: PingMeta | null, range: number, tolM = 1.0): FishHit | null {
  if (!meta) return null;
  let best: FishHit | null = null;
  for (const hit of meta.hits) {
    if (Math.abs(hit.range - range) <= tolM && (!best || hit.level > best.level)) best = hit;
  }
  return best;
}
