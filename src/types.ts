// 全局领域类型定义

export type SubstrateType = 'mud' | 'sand' | 'rock';

export interface SubstrateParams {
  /** 底质反向散射强度 dB,入射角 0° 参考 */
  backscatter: number;
  /** 二次回波相对一次回波的衰减 dB(海面-海底往返再损失) */
  secondEchoLoss: number;
  /** 回声包络展宽系数(决定回波厚度) */
  roughness: number;
  label: string;
  color: [number, number, number];
}

export interface SeabedCell {
  /** 水深 m(正数,水面到海底) */
  depth: number;
  substrate: SubstrateType;
}

export interface SeaArea {
  id: string;
  name: string;
  /** 网格单元尺寸 m */
  cellSize: number;
  cols: number;
  rows: number;
  /** 行优先 cells[r*cols+c] */
  cells: SeabedCell[];
  /** 表层水温 ℃ */
  surfaceTempC: number;
  /** 盐度 ppt */
  salinity: number;
  /** 温跃层配置,null 表示关闭 */
  thermocline: ThermoclineConfig | null;
}

export interface ThermoclineConfig {
  /** 温跃层顶部深度 m */
  topDepth: number;
  /** 温跃层厚度 m */
  thickness: number;
  /** 层间温差 ℃ */
  deltaTemp: number;
  /** 温跃层弱回波散射强度 dB(体积散射 Sv 近似) */
  scatteringLevel: number;
}

export interface FishSpecies {
  id: string;
  name: string;
  /** 体长换算 TS 的截距 b20:TS = b20 * log10(L cm) + b0 */
  b20: number;
  /** 体长换算 TS 的截距 b0 */
  b0: number;
  /** 典型体长 cm */
  typicalLengthCm: number;
  /** 频率相关修正(每 kHz 附加 dB,近似) */
  freqSlope: number;
  color: [number, number, number];
}

export type SchoolShape = 'ball' | 'layer' | 'elongated';

export interface FishSchool {
  id: string;
  speciesId: string;
  /** 鱼数量 */
  count: number;
  shape: SchoolShape;
  /** 布放中心(海区网格坐标 m,相对海区左上角,x 东向 y 北向) */
  x: number;
  y: number;
  /** 分布半径 m */
  radius: number;
  /** 层状/拉长形态的水平半轴 m(shape != ball 时使用) */
  radiusX: number;
  radiusY: number;
  /** 中心所在水层(0=水面,正数向下 m),昼夜迁移围绕该深度 */
  dayDepth: number;
  nightDepth: number;
  /** 鱼体平均体长 cm(个体在 ±20% 抖动) */
  meanLengthCm: number;
  enabled: boolean;
}

export interface Transducer {
  id: string;
  name: string;
  /** 频率 kHz */
  freqKhz: number;
  /** -3dB 全波束角(度) */
  beamAngleDeg: number;
  /** 额定功率 W */
  powerW: number;
  /** 发射脉宽 ms */
  pulseMs: number;
  /** 声源级修正 dB(产品个体差异) */
  slOffsetDb: number;
  color: string;
}

export interface RoutePoint {
  /** 海区平面坐标 m */
  x: number;
  y: number;
  /** 到达该点的船速 m/s */
  speed: number;
  /** 在该点停留(抛锚)秒数,0 表示不停 */
  dwellSec: number;
}

export interface Voyage {
  id: string;
  name: string;
  route: RoutePoint[];
  /** 仿真起始时钟小时 0-24 */
  startHour: number;
  /** 时间流逝倍率(1 = 实时) */
  timeScale: number;
}

export interface GainSettings {
  /** 总增益 dB */
  gainDb: number;
  /** TVG 模式:40logR(鱼群校正)/20logR(底层校正)/off */
  tvgMode: '40log' | '20log' | 'off';
  /** TVG 近场钳制距离 m */
  tvgClampM: number;
  /** 杂波抑制 0..1(扣除滚动背景均值的比例) */
  clutterReject: number;
  /** 色标最低/最高 dB */
  colorMinDb: number;
  colorMaxDb: number;
  /** 色表 id */
  colormap: string;
}

export interface NoiseSettings {
  /** 环境噪声级 dB */
  ambientDb: number;
  /** 船尾流气泡 0..1 */
  wakeBubbles: number;
  /** 发动机线干扰 0..1 */
  engineInterference: number;
  /** 他船串频 0..1 */
  crosstalk: number;
  /** 浮游生物散射层 0..1 */
  planktonLayer: number;
}

export interface DisplaySettings {
  /** 瀑布图量程 m(0 = 自动跟底) */
  rangeM: number;
  /** 底锁放大:海底上方窗口 m,0 表示关闭 */
  bottomLockM: number;
  /** 缩放档位 1x/2x/4x */
  zoom: 1 | 2 | 4;
  /** 双频分屏 */
  splitScreen: boolean;
  /** 显示二次回波 */
  showSecondEcho: boolean;
  /** 显示温跃层 */
  showThermocline: boolean;
}

export interface AppSettings {
  gain: Record<string, GainSettings>;
  noise: NoiseSettings;
  display: DisplaySettings;
  pingRateHz: number;
}

/** 单条鱼的运行时实例 */
export interface FishInstance {
  id: number;
  schoolId: string;
  speciesId: string;
  x: number;
  y: number;
  /** 群内垂直偏移 m(相对群中心,布放后固定) */
  zOffset: number;
  /** 当前深度 m(引擎按昼夜迁移更新) */
  z: number;
  lengthCm: number;
  /** 目标强度 dB */
  tsDb: number;
}

/** 一次 ping 中某个距离门的回波来源记录(用于反查) */
export interface EchoContributor {
  kind: 'fish' | 'bottom' | 'reef' | 'plankton' | 'thermocline' | 'bubble';
  id: number;
  /** 贡献强度 dB(未加增益) */
  level: number;
}

export interface PingColumn {
  /** 逻辑 ping 序号 */
  index: number;
  /** 仿真时间 s */
  timeSec: number;
  /** 当日时钟小时 0-24 */
  hour: number;
  x: number;
  y: number;
  speed: number;
  anchored: boolean;
  /** 每距离门原始回波级 dB(含 TVG 前),长度 = binCount */
  bins: Float32Array;
  /** 每距离门背景估计 dB(杂波抑制用) */
  background: Float32Array;
  /** 每距离门主要来源(反查),与 bins 等长,空数组表示环境噪声 */
  contributors: EchoContributor[][];
  /** 检测到的海底距离 m */
  bottomRange: number;
  bottomSubstrate: SubstrateType;
  /** 距离门步长 m */
  binStep: number;
  transducerId: string;
  freqKhz: number;
}

export interface SelftestResult {
  name: string;
  pass: boolean;
  detail: string;
  measured?: number;
  expected?: number;
  errorPx?: number;
}
