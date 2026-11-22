// 海区 2D 地形图:深度等值着色 + 底质叠加 + 网格编辑

import { SeaArea, SubstrateType } from '../types';
import { SUBSTRATES, depthAt } from '../core/seabed';

export interface MapOverlay {
  x: number;
  y: number;
  color: string;
  label?: string;
  radius?: number;
}

const DEPTH_COLORS: Array<[number, [number, number, number]]> = [
  [0, [30, 96, 150]],
  [20, [26, 80, 130]],
  [50, [20, 58, 100]],
  [80, [14, 38, 72]],
  [120, [8, 22, 48]],
];

function depthColor(d: number): [number, number, number] {
  for (let i = 0; i < DEPTH_COLORS.length - 1; i++) {
    const [d0, c0] = DEPTH_COLORS[i];
    const [d1, c1] = DEPTH_COLORS[i + 1];
    if (d <= d1) {
      const t = (d - d0) / (d1 - d0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return DEPTH_COLORS[DEPTH_COLORS.length - 1][1];
}

export type MapMode = 'depth' | 'substrate';
export type EditTool = 'none' | 'raise' | 'lower' | SubstrateType;

export class AreaMap {
  private ctx: CanvasRenderingContext2D;
  mode: MapMode = 'depth';
  tool: EditTool = 'none';
  brush = 2;
  onEdit: ((gridX: number, gridY: number) => void) | null = null;
  overlays: MapOverlay[] = [];
  routeLine: Array<{ x: number; y: number }> = [];
  boat: { x: number; y: number } | null = null;
  private painting = false;

  constructor(private canvas: HTMLCanvasElement, private area: SeaArea) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => {
      this.painting = true;
      this.handlePointer(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.painting) this.handlePointer(e);
      this.hoverCb?.(this.probeAt(e));
    });
    canvas.addEventListener('pointerup', () => (this.painting = false));
  }

  private hoverCb: ((p: { x: number; y: number; depth: number; substrate: SubstrateType } | null) => void) | null = null;
  onHover(cb: typeof this.hoverCb) {
    this.hoverCb = cb;
  }

  private toWorld(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    const sx = (this.area.cols * this.area.cellSize) / this.canvas.width;
    const sy = (this.area.rows * this.area.cellSize) / this.canvas.height;
    return { x: px * sx, y: py * sy };
  }

  private handlePointer(e: PointerEvent) {
    if (this.tool === 'none' || !this.onEdit) return;
    const w = this.toWorld(e);
    const gx = Math.floor(w.x / this.area.cellSize);
    const gy = Math.floor(w.y / this.area.cellSize);
    for (let dy = -this.brush + 1; dy < this.brush; dy++) {
      for (let dx = -this.brush + 1; dx < this.brush; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (x >= 0 && y >= 0 && x < this.area.cols && y < this.area.rows) this.onEdit(x, y);
      }
    }
  }

  render() {
    const { ctx, canvas, area } = this;
    const W = canvas.width;
    const H = canvas.height;
    const cw = W / area.cols;
    const ch = H / area.rows;
    for (let r = 0; r < area.rows; r++) {
      for (let c = 0; c < area.cols; c++) {
        const cell = area.cells[r * area.cols + c];
        let color: string;
        if (this.mode === 'depth') {
          const [rr, gg, bb] = depthColor(cell.depth);
          color = `rgb(${rr},${gg},${bb})`;
        } else {
          const [rr, gg, bb] = SUBSTRATES[cell.substrate].color;
          color = `rgb(${rr * 255},${gg * 255},${bb * 255})`;
        }
        ctx.fillStyle = color;
        ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }

    // 等深线
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const step = 10;
    const maxD = Math.max(...area.cells.map((c) => c.depth));
    for (let d = step; d < maxD; d += step) {
      ctx.beginPath();
      let started = false;
      for (let r = 0; r < area.rows; r += 1) {
        for (let c = 0; c < area.cols - 1; c += 1) {
          const d0 = area.cells[r * area.cols + c].depth;
          const d1 = area.cells[r * area.cols + c + 1].depth;
          if ((d0 - d) * (d1 - d) < 0) {
            const t = (d - d0) / (d1 - d0);
            const x = (c + t) * cw;
            const y = (r + 0.5) * ch;
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
      // 标注
      outer: for (let r = 0; r < area.rows; r++) {
        for (let c = 0; c < area.cols - 1; c++) {
          const d0 = area.cells[r * area.cols + c].depth;
          const d1 = area.cells[r * area.cols + c + 1].depth;
          if ((d0 - d) * (d1 - d) < 0) {
            ctx.fillText(`${d}m`, (c + 0.5) * cw, (r + 0.5) * ch);
            break outer;
          }
        }
      }
    }

    // 航线
    if (this.routeLine.length > 1) {
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const toPx = (p: { x: number; y: number }) => [
        (p.x / (area.cols * area.cellSize)) * W,
        (p.y / (area.rows * area.cellSize)) * H,
      ];
      this.routeLine.forEach((p, i) => {
        const [x, y] = toPx(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of this.routeLine) {
        const [x, y] = toPx(p);
        ctx.fillStyle = '#4fc3f7';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 覆盖物(鱼群)
    for (const ov of this.overlays) {
      const x = (ov.x / (area.cols * area.cellSize)) * W;
      const y = (ov.y / (area.rows * area.cellSize)) * H;
      const rad = ((ov.radius ?? 6) / (area.cols * area.cellSize)) * W;
      ctx.strokeStyle = ov.color;
      ctx.fillStyle = ov.color + '33';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (ov.label) {
        ctx.fillStyle = ov.color;
        ctx.font = '11px sans-serif';
        ctx.fillText(ov.label, x + rad + 2, y);
      }
    }

    // 船位
    if (this.boat) {
      const x = (this.boat.x / (area.cols * area.cellSize)) * W;
      const y = (this.boat.y / (area.rows * area.cellSize)) * H;
      ctx.fillStyle = '#ffe082';
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 5, y + 6);
      ctx.lineTo(x - 5, y + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  probe(x: number, y: number) {
    return {
      depth: depthAt(this.area, x, y),
      substrate: this.area.cells[
        Math.min(this.area.rows - 1, Math.max(0, Math.floor(y / this.area.cellSize))) * this.area.cols +
          Math.min(this.area.cols - 1, Math.max(0, Math.floor(x / this.area.cellSize)))
      ].substrate,
    };
  }

  private probeAt(e: PointerEvent) {
    const w = this.toWorld(e);
    return { x: w.x, y: w.y, ...this.probe(w.x, w.y) };
  }
}
