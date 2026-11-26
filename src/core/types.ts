// 核心数据类型定义 —— 所有计算层共用，不依赖 DOM

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x,y,z,w

/** 三角网格（扁平数组，单位毫米） */
export interface MeshData {
  positions: Float32Array; // length = vcount * 3
  normals: Float32Array;
  indices: Uint32Array; // length = tcount * 3
}

/** 局部坐标系：origin 为牙冠解剖中心，axes 列向量 [近远中, 颊舌, 长轴(根向)] */
export interface LocalFrame {
  origin: Vec3;
  axes: [Vec3, Vec3, Vec3]; // 互相正交的单位向量
}

export type JawType = 'upper' | 'lower';

/** FDI 牙位：18-11,21-28（上颌）；48-41,31-38（下颌），演示用 7-7 共 14 颗 */
export interface ToothDef {
  fdi: number;
  jaw: JawType;
  /** 牙弓序号 -6..6（不含 0），负=患者右侧，正=左侧 */
  archIndex: number;
  name: string;
  toothClass: 'incisor' | 'canine' | 'premolar' | 'molar';
  /** 初始位姿（相对全局） */
  pose: Pose;
  /** 目标位姿（相对全局），未排牙时等于 pose */
  targetPose: Pose;
  localFrame: LocalFrame;
  /** 牙冠网格（局部坐标，相对 localFrame.origin） */
  crown: MeshData;
  /** 统计模型生成的牙根网格（局部坐标），可能为空（未生成） */
  root: MeshData | null;
  /** 冠根整体包围盒半径，用于碰撞粗筛 */
  boundsRadius: number;
  /** 该牙上的附件列表 */
  attachments: Attachment[];
}

/** 刚体位姿：平移 + 旋转（无缩放） */
export interface Pose {
  t: Vec3;
  q: Quat;
}

export interface Attachment {
  id: string;
  fdi: number;
  /** 附件类型 */
  kind: 'rectangular' | 'ellipsoid' | 'beveled';
  /** 附着面朝向：buccal(颊) / lingual(舌) */
  face: 'buccal' | 'lingual';
  /** 沿长轴方向的偏移（mm，正=龈向） */
  axialOffset: number;
  /** 尺寸 [宽(近远中), 高(长轴), 厚(突出)] mm */
  size: [number, number, number];
}

/** 邻面去釉条目（邻接两牙之间） */
export interface IprEntry {
  id: string;
  jaw: JawType;
  fdiA: number;
  fdiB: number;
  /** 总去釉量 mm（两侧各分一半的语义由显示层处理） */
  amount: number;
  /** 计划在第几步执行（1 基） */
  atStep: number;
}

/** 牙龈/口扫底衬网格（每颌一块） */
export interface GingivaMesh {
  jaw: JawType;
  mesh: MeshData;
}

/** 分割结果（针对导入 STL 的自动/手动分割） */
export interface Segmentation {
  /** 每个顶点的牙位标签，-1 = 牙龈 */
  labels: Int32Array;
  /** 分割使用的种子点（顶点索引 -> fdi），手动修改可增删 */
  seeds: Map<number, number>;
  /** 曲率场（每顶点），供前端着色 */
  curvature: Float32Array;
}

export interface StepLimits {
  /** 单步单牙最大平移 mm */
  maxTranslation: number;
  /** 单步单牙最大旋转 度 */
  maxRotationDeg: number;
  /** 方案允许的最大步数，超出则超限标记 */
  maxSteps: number;
}

export const DEFAULT_LIMITS: StepLimits = {
  maxTranslation: 0.25,
  maxRotationDeg: 2,
  maxSteps: 40,
};

/** 单颗牙在某一步的位姿（由切步引擎插值生成，存储省内存可只存 t/q） */
export interface StepToothState {
  fdi: number;
  t: Vec3;
  q: Quat;
  /** 该步相对上一步的平移量 mm */
  stepMove: number;
  /** 该步相对上一步的旋转量 度 */
  stepRotate: number;
  /** 平移/旋转是否超限 */
  overLimit: boolean;
}

export interface CollisionPair {
  fdiA: number;
  fdiB: number;
  /** 最大穿透深度 mm（正值=穿透，负值=间隙） */
  penetration: number;
  /** 穿透最深点（全局坐标），无穿透时为 null */
  point: Vec3 | null;
}

export interface StepCollision {
  step: number;
  pairs: CollisionPair[];
  /** 穿透报警阈值 mm */
  threshold: number;
  hasAlarm: boolean;
}

export interface StepPlan {
  limits: StepLimits;
  /** 总步数（不含初始态，初始态 = step 0） */
  stepCount: number;
  /** 每牙各自需要的步数（决定整体步数） */
  perToothSteps: Record<number, number>;
  /** steps[s] 为第 s+1 步所有牙的状态；step 0 用初始 pose */
  steps: StepToothState[][];
  /** 每步碰撞结果（计算后填充） */
  collisions: StepCollision[];
  /** 超限步骤号（1 基） */
  overLimitSteps: number[];
  /** 超限牙位汇总 */
  overLimitTeeth: number[];
  createdAt: number;
  /** 生成参数指纹，用于确定性校验 */
  fingerprint: string;
}

export interface OcclusionContact {
  upperFdi: number;
  lowerFdi: number;
  /** 穿透/接近量，正=穿透 mm */
  penetration: number;
  point: Vec3;
}

export interface OcclusionResult {
  /** 工况：ICP 正中咬合 / protrusive 前伸 / lateral 侧方 */
  mode: 'icp' | 'protrusive' | 'lateral-left' | 'lateral-right';
  contacts: OcclusionContact[];
  /** 下颌相对 ICP 的位移 mm */
  mandibleShift: Vec3;
}

export interface CaseRecord {
  id: string;
  patientName: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  upper: JawData;
  lower: JawData;
  ipr: IprEntry[];
  /** 去釉安全累计上限 mm（单邻接） */
  iprSafetyLimit: number;
  plan: StepPlan | null;
  occlusions: OcclusionResult[];
  /** 导入 STL 的原始网格（未分割），生成病例为空 */
  rawScan: { jaw: JawType; mesh: MeshData; segmentation: Segmentation | null } | null;
}

export interface JawData {
  jaw: JawType;
  teeth: ToothDef[];
  gingiva: GingivaMesh | null;
}

export interface ReportRow {
  fdi: number;
  name: string;
  totalTranslation: number;
  totalRotation: number;
  maxStepMove: number;
  maxStepRotate: number;
  riskSteps: number[];
}
