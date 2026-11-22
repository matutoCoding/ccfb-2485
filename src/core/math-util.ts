// 确定性随机数(可复现航次)与通用数学工具

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** xorshift32 */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  /** Box-Muller 正态分布 */
  gaussian(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const rad2deg = (r: number) => (r * 180) / Math.PI;

/** 线性插值查表(x 必须升序) */
export function interpTable(table: Array<[number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return last[1];
}

/** 对数-对数插值(吸收系数用) */
export function loglogInterp(table: Array<[number, number]>, x: number): number {
  const lx = Math.log10(x);
  const pts = table.map(([a, b]) => [Math.log10(a), Math.log10(b)] as [number, number]);
  if (lx <= pts[0][0]) return table[0][1];
  const last = pts[pts.length - 1];
  if (lx >= last[0]) return table[table.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (lx >= x0 && lx <= x1) {
      const t = (lx - x0) / (x1 - x0);
      return Math.pow(10, y0 + (y1 - y0) * t);
    }
  }
  return table[table.length - 1][1];
}

/** 深度 -> 像素行映射的精确逆函数,保证显示几何与理论值一致 */
export function rangeToRow(rangeM: number, binStep: number): number {
  return rangeM / binStep;
}
export function rowToRange(row: number, binStep: number): number {
  return row * binStep;
}
