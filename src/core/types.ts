// 全局领域类型定义

export type Substrate = 'mud' | 'sand' | 'rock';

export interface Vec3 { x: number; y: number; z: number; }

/** 海区：按水深网格建立 */
export interface SeaArea {
  id: string;
  name: string;
  // 网格覆盖范围（米），x: 东西, z: 南北，y: 深度（向下为正）
  width: number;   // x 方向尺寸
  length: number;  // z 方向尺寸
  nx: number;      // x 格点数
  nz: number;      // z 格点数
  /** 每格水深（米，y 向下），长度 nx*nz，行主序 [iz*nx+ix] */
  depth: Float32Array;
  /** 每格底质 */
  substrate: Uint8Array;
  soundSpeed: number; // m/s，默认 1500
  /** 温跃层参数（可开关） */
  thermocline: {
    enabled: boolean;
    top: number;      // 温跃层顶界深度 m
    thickness: number;
    strength: number; // 散射强度系数 0..1
  };
  /** 浮游生物散射层（深海散射层 DSL） */
  planktonLayer: {
    enabled: boolean;
    dayDepth: number;
    nightDepth: number;
    thickness: number;
    strength: number; // 0..1
  };
}

export interface FishSpecies {
  id: string;
  name: string;
  /** 目标强度换算参数：TS = b20 * log10(L_cm) + b0 (dB) */
  b20: number;
  b0: number;
  minLength: number; // cm
  maxLength: number;
  color: string; // 三维显示颜色
}

export type SchoolShape = 'ball' | 'layer' | 'streak';

export interface FishSchool {
  id: string;
  areaId: string;
  speciesId: string;
  name: string;
  count: number;
  shape: SchoolShape;
  /** 布放中心（米），y 为深度 */
  center: Vec3;
  /** 分布半径（米） */
  radiusX: number;
  radiusY: number;
  radiusZ: number;
  /** 昼夜垂直迁移：白天所在深度比例（0=表层 1=贴底），夜间比例 */
  dayDepthFrac: number;
  nightDepthFrac: number;
  /** 随机种子（确定性生成鱼的位置/体长） */
  seed: number;
  /** 单体体长（cm），由种子在种属范围内确定性抽取，运行时缓存 */
  lengths?: Float32Array;
  /** 相对中心的归一化位置（-1..1），确定性缓存 */
  offsets?: Float32Array; // count*3
}

export interface Transducer {
  id: string;
  name: string;
  frequency: number;    // Hz，50k / 200k
  beamAngleDeg: number; // 全波束角（-3dB 点之间），度
  powerW: number;       // 发射功率 W
  pulseMs: number;      // 脉宽 ms
  /** 指向性指数修正、灵敏度等综合系数（dB），用于标定 */
  gainCalib: number;
}

export interface RoutePoint {
  x: number; z: number;       // 海区坐标 m
  speed: number;             // 节
}

export interface Voyage {
  id: string;
  areaId: string;
  name: string;
  route: RoutePoint[];
  /** 模拟时间起点的小时（0-24），决定昼夜鱼群层位 */
  startHour: number;
  durationMin: number;
}

/** 环境噪声开关与强度 */
export interface NoiseSettings {
  wakeBubbles: boolean;   // 船尾流气泡
  wakeLevel: number;      // 0..1
  engine: boolean;        // 发动机干扰（水平条纹）
  engineLevel: number;
  crosstalk: boolean;     // 别的船探鱼器串频
  crosstalkLevel: number;
  ambient: number;        // 环境噪声基底 dB
}

export interface DisplaySettings {
  gainDb: number;         // 总增益
  tvgMode: 'off' | 'single' | 'school'; // 单目标 40logR / 鱼群 30logR
  tvgStrength: number;    // 0..1 混合系数
  clutterDb: number;      // 杂波抑制阈值 dB
  colormap: string;       // 色标 key
  rangeM: number;         // 当前显示量程 m（0 = 自动跟底）
  bottomLockM: number;    // 底锁放大高度 m，0 表示关闭
  zoomStep: number;       // 缩放档位索引
}

/** 单个鱼目标在某 ping 的命中信息（供反查） */
export interface FishHit {
  schoolId: string;
  fishIndex: number;
  range: number;    // 斜距 m
  level: number;    // 输出电平 dB
  x: number; y: number; z: number;
}

/** 一列 ping 的元数据（环形缓冲，用于 A 显示与反查） */
export interface PingMeta {
  time: number;           // 仿真秒
  boatX: number; boatZ: number;
  boatSpeed: number;      // m/s
  bottomRange: number;    // 正下方底斜距 m
  raw: Float32Array;      // 原始电平 dB（按 bin）
  tvg: Float32Array;      // 该列 TVG 修正 dB（按 bin）
  hits: FishHit[];        // 鱼目标命中
  substrateHits: { ix: number; iz: number; range: number; level: number }[];
  noisePeak: number;
}

export interface DBSchema {
  areas: SeaArea[];
  species: FishSpecies[];
  schools: FishSchool[];
  transducers: Transducer[];
  voyages: Voyage[];
  settings: { id: 'global'; display: DisplaySettings; noise: NoiseSettings };
}
