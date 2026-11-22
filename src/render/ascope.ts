// A 显示:单 ping 的回波级-距离曲线(Canvas2D)

import { GainSettings, PingColumn } from '../types';

export class AScopeRenderer {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(col: PingColumn | null, gain: GainSettings, rangeM: number, markRange = -1) {
    const ctx = this.canvas.getContext('2d')!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, w, h);

    // 网格
    ctx.strokeStyle = 'rgba(120,160,220,0.15)';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(160,190,230,0.7)';
    for (let d = 0; d <= rangeM; d += 10) {
      const x = (d / rangeM) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(`${d}m`, x + 2, h - 4);
    }
    for (let db = gain.colorMinDb; db <= gain.colorMaxDb; db += 10) {
      const y = h - ((db - gain.colorMinDb) / (gain.colorMaxDb - gain.colorMinDb)) * h;
      ctx.fillText(`${db}`, 2, y - 2);
    }

    if (!col) {
      ctx.fillStyle = '#5a7090';
      ctx.font = '13px sans-serif';
      ctx.fillText('等待 ping…', w / 2 - 30, h / 2);
      return;
    }

    // 曲线
    ctx.strokeStyle = '#57e39a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const maxBin = Math.min(col.bins.length, Math.ceil(rangeM / col.binStep));
    for (let b = 0; b < maxBin; b++) {
      const r = b * col.binStep;
      const x = (r / rangeM) * w;
      const n = Math.max(0, Math.min(1, (col.bins[b] - gain.colorMinDb) / (gain.colorMaxDb - gain.colorMinDb)));
      const y = h - n * h;
      if (b === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 海底标记
    const bx = (col.bottomRange / rangeM) * w;
    if (bx < w) {
      ctx.strokeStyle = 'rgba(255,190,80,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffbe50';
      ctx.fillText(`底 ${col.bottomRange.toFixed(1)}m`, bx + 3, 14);
    }

    // 鼠标选中距离标记
    if (markRange >= 0) {
      const mx = (markRange / rangeM) * w;
      ctx.strokeStyle = 'rgba(255,90,90,0.9)';
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, h);
      ctx.stroke();
    }
  }
}
