// 探鱼器常用色标,生成 256x1 RGBA LUT

export interface ColormapDef {
  id: string;
  name: string;
  stops: Array<[number, [number, number, number]]>;
}

export const COLORMAPS: ColormapDef[] = [
  {
    id: 'halieutis',
    name: '渔用蓝-红(经典)',
    stops: [
      [0, [6, 8, 28]],
      [0.25, [18, 52, 120]],
      [0.5, [35, 150, 120]],
      [0.7, [225, 200, 70]],
      [0.86, [235, 110, 40]],
      [1, [245, 240, 230]],
    ],
  },
  {
    id: 'gray',
    name: '灰度',
    stops: [
      [0, [4, 4, 6]],
      [1, [245, 245, 245]],
    ],
  },
  {
    id: 'sepia',
    name: '琥珀底质',
    stops: [
      [0, [10, 6, 2]],
      [0.4, [90, 50, 18]],
      [0.75, [200, 140, 50]],
      [1, [255, 240, 200]],
    ],
  },
  {
    id: 'turbo',
    name: 'Turbo 高对比',
    stops: [
      [0, [28, 16, 90]],
      [0.25, [20, 120, 200]],
      [0.5, [30, 200, 120]],
      [0.75, [240, 200, 40]],
      [1, [160, 20, 30]],
    ],
  },
];

export function buildColormapLut(id: string): Uint8Array {
  const def = COLORMAPS.find((c) => c.id === id) ?? COLORMAPS[0];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = def.stops[0];
    let b = def.stops[def.stops.length - 1];
    for (let k = 0; k < def.stops.length - 1; k++) {
      if (t >= def.stops[k][0] && t <= def.stops[k + 1][0]) {
        a = def.stops[k];
        b = def.stops[k + 1];
        break;
      }
    }
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    const s = f * f * (3 - 2 * f);
    for (let ch = 0; ch < 3; ch++) {
      lut[i * 4 + ch] = Math.round(a[1][ch] + (b[1][ch] - a[1][ch]) * s);
    }
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
