// 程序化测试病例：一副拥挤的上下颌，确定性（同 seed 完全一致）
import type {
  CaseRecord, JawData, JawType, LocalFrame, MeshData, Pose, Quat, ToothDef, Vec3,
} from './types';
import { DEFAULT_ARCH, archFrame, archPoint, sampleArch, type ArchSpec } from './arch';
import { layoutOnArch } from './layout';
import { boundsRadiusWithRoot, CROWN_PARAMS, generateCrown, generateRoot, rootSpecFor } from './toothGeometry';
import { makeMesh, mat4, q, rng, v3 } from './math';

const FDI_NAME: Record<number, string> = {
  11: '上颌右中切牙', 12: '上颌右侧切牙', 13: '上颌右尖牙', 14: '上颌右第一前磨牙', 15: '上颌右第二前磨牙', 16: '上颌右第一磨牙', 17: '上颌右第二磨牙',
  21: '上颌左中切牙', 22: '上颌左侧切牙', 23: '上颌左尖牙', 24: '上颌左第一前磨牙', 25: '上颌左第二前磨牙', 26: '上颌左第一磨牙', 27: '上颌左第二磨牙',
  41: '下颌右中切牙', 42: '下颌右侧切牙', 43: '下颌右尖牙', 44: '下颌右第一前磨牙', 45: '下颌右第二前磨牙', 46: '下颌右第一磨牙', 47: '下颌右第二磨牙',
  31: '下颌左中切牙', 32: '下颌左侧切牙', 33: '下颌左尖牙', 34: '下颌左第一前磨牙', 35: '下颌左第二前磨牙', 36: '下颌左第一磨牙', 37: '下颌左第二磨牙',
};

export function fdiFor(jaw: JawType, archIndex: number): number {
  const i = Math.abs(archIndex);
  if (jaw === 'upper') return archIndex < 0 ? 10 + i : 20 + i;
  return archIndex < 0 ? 40 + i : 30 + i;
}

function toothClassFor(i: number): ToothDef['toothClass'] {
  const a = Math.abs(i);
  if (a <= 2) return 'incisor';
  if (a === 3) return 'canine';
  if (a <= 5) return 'premolar';
  return 'molar';
}

/** 牙龈：沿弓形的 U 形软组织垫，顶点落在牙颈部之下并包住牙弓 */
function generateGingiva(jaw: JawType, spec: ArchSpec, teeth: ToothDef[]): MeshData {
  const samples = sampleArch(spec, -7.4, 7.4, 44);
  const cross = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  // 上下颌牙颈缘平均高度
  const neckY = teeth.reduce((s, t) => s + t.pose.t[1], 0) / teeth.length + (jaw === 'upper' ? -5.2 : 5.2);
  const padThickness = 5.5; // 向根尖方向的厚度
  const halfWidth = 8.2;    // 颊舌向半宽

  for (let k = 0; k < samples.length; k++) {
    const { p, outward } = samples[k];
    // 末端封口处向内收
    const endFactor = Math.min(1, Math.min(k, samples.length - 1 - k) / 3);
    for (let j = 0; j <= cross; j++) {
      const phi = (2 * Math.PI * j) / cross;
      const lateral = Math.cos(phi) * halfWidth * endFactor;
      const vertical = Math.sin(phi) * padThickness * 0.5;
      const x = p[0] + outward[0] * lateral;
      const z = p[2] + outward[2] * lateral;
      // 上缘（近牙侧）起伏贴合牙间乳头
      const ripple = 0.9 * Math.cos((k / (samples.length - 1)) * Math.PI * 14);
      const topY = neckY + (jaw === 'upper' ? 0.6 + ripple : -0.6 - ripple);
      const y = topY + (jaw === 'upper' ? -vertical : vertical);
      positions.push(x, y, z);
    }
  }
  const row = cross + 1;
  for (let k = 0; k < samples.length - 1; k++) {
    for (let j = 0; j < cross; j++) {
      const a = k * row + j, b = a + 1, c = (k + 1) * row + j, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  // 两端封口
  for (const endK of [0, samples.length - 1]) {
    const base = endK * row;
    const center = positions.length / 3;
    const s = samples[endK];
    positions.push(s.p[0], neckY, s.p[2]);
    for (let j = 0; j < cross; j++) indices.push(center, base + j, base + j + 1);
  }
  return makeMesh(Float32Array.from(positions), Uint32Array.from(indices));
}

interface JawBuild {
  data: JawData;
  /** 合并后的整颌“口扫”网格（冠+龈） */
  scan: MeshData;
  /** 每颗牙在 scan 中的顶点区间（供自动分割校验/种子） */
  toothVertexRanges: { fdi: number; vStart: number; vCount: number }[];
}

function buildJaw(jaw: JawType, seed: number, crowded: boolean): JawBuild {
  const rand = rng(seed + (jaw === 'upper' ? 101 : 202));
  const sizeRand = rng(seed + (jaw === 'upper' ? 4041 : 5051));
  const spec: ArchSpec = jaw === 'upper'
    ? { ...DEFAULT_ARCH }
    : { halfWidth: DEFAULT_ARCH.halfWidth - 3, depth: DEFAULT_ARCH.depth - 2, spacing: DEFAULT_ARCH.spacing - 0.25 };

  // 第一遍：先确定每颗牙的个体冠宽（独立 RNG，保证布局前拿到全部宽度）
  const widths = new Map<number, number>();
  const sizeParams = new Map<number, { w: number; d: number; h: number }>();
  for (let idx = -7; idx <= 7; idx++) {
    if (idx === 0) continue;
    const p0 = CROWN_PARAMS[toothClassFor(idx)];
    const w = p0.width * (0.94 + sizeRand() * 0.12);
    const d = p0.depth * (0.94 + sizeRand() * 0.12);
    const h = p0.height * (0.95 + sizeRand() * 0.1);
    widths.set(Math.abs(idx), w);
    sizeParams.set(idx, { w, d, h });
  }
  // 拥挤：弓长压缩到 72% 且无邻间隙（邻牙被迫重叠）；理想排列 100% + 邻间隙
  const layout = crowded ? layoutOnArch(spec, widths, 0.72, 0) : layoutOnArch(spec, widths, 1.0, 0.35);

  const teeth: ToothDef[] = [];
  const crownMeshes: MeshData[] = [];
  const toothVertexRanges: { fdi: number; vStart: number; vCount: number }[] = [];
  let vCursor = 0;

  for (let idx = -7; idx <= 7; idx++) {
    if (idx === 0) continue;
    const fdi = fdiFor(jaw, idx);
    const cls = toothClassFor(idx);
    const params = CROWN_PARAMS[cls];
    const { w, d, h } = sizeParams.get(idx)!;
    const crown = generateCrown({ ...params, width: w, depth: d, height: h }, seed + fdi * 13);
    const rootSpec = rootSpecFor(cls, fdi, seed + fdi * 17);
    const root = generateRoot(rootSpec, -h / 2 - 0.4, w, seed + fdi * 29);

    const lp = layout.get(idx)!;
    const tangent = lp.tangent;
    const outward = lp.outward;
    // 牙冠中心高度：后牙略低形成 Spee 曲线
    const curveY = (jaw === 'upper' ? -1 : 1) * 1.2 * Math.pow(Math.abs(idx) / 7, 2);
    // 上下颌基高：牙冠半高约 4mm，预留约 1mm 覆合间隙，使咬合面间距 ~2mm
    const baseY = (jaw === 'upper' ? 5 : -5) + curveY;

    let pos: Vec3 = [lp.x, baseY, lp.z];
    let rotEuler = { twist: 0, tip: 0, torque: 0 };
    if (crowded) {
      // 拥挤：尖牙唇向低位、切牙扭转错位、整体弓长不足
      const severity = Math.abs(idx) <= 3 ? 1.4 : 0.8;
      pos = v3.add(pos, [
        (rand() - 0.5) * 1.6 * severity,
        (rand() - 0.5) * 1.2 * severity + (Math.abs(idx) === 3 ? (jaw === 'upper' ? 1.6 : -1.6) : 0),
        (rand() - 0.5) * 2.2 * severity,
      ]);
      rotEuler = {
        twist: ((rand() - 0.5) * 22 + (Math.abs(idx) <= 2 ? (rand() - 0.5) * 18 : 0)) * Math.PI / 180,
        tip: (rand() - 0.5) * 14 * Math.PI / 180,
        torque: (rand() - 0.5) * 12 * Math.PI / 180,
      };
    }
    // 局部坐标系：x 近远中（沿弓切向，远中为 x+），z 颊向，y 根向
    const mesial = v3.neg(tangent);
    const distal = tangent;
    const buccal = jaw === 'upper' ? outward : v3.neg(outward);
    const rootDir: Vec3 = jaw === 'upper' ? [0, -1, 0] : [0, 1, 0];
    const frame: LocalFrame = { origin: pos, axes: [distal, buccal, rootDir] };
    // 初始旋转：由局部基到全局基（含拥挤扰动，绕局部各轴）
    let qLocal = q.identity();
    qLocal = q.mul(q.fromAxisAngle(rootDir, rotEuler.twist), qLocal); // 绕长轴扭转
    qLocal = q.mul(q.fromAxisAngle(distal, rotEuler.torque), qLocal);  // 冠唇舌向转矩
    qLocal = q.mul(q.fromAxisAngle(buccal, rotEuler.tip), qLocal);     // 近远中倾斜
    const qFrame = q.fromBasis([v3.norm(mesial) as Vec3, v3.norm(buccal) as Vec3, rootDir], [
      [1, 0, 0], [0, 0, 1], [0, 1, 0],
    ]);
    const pose: Pose = { t: pos, q: q.norm(q.mul(qFrame, qLocal)) };

    const def: ToothDef = {
      fdi, jaw, archIndex: idx, name: FDI_NAME[fdi], toothClass: cls,
      pose, targetPose: { t: [...pos] as Vec3, q: [...pose.q] as Quat },
      localFrame: frame, crown, root,
      boundsRadius: boundsRadiusWithRoot(crown, rootSpec.length),
      attachments: [],
    };
    teeth.push(def);
    crownMeshes.push(crown);
    toothVertexRanges.push({ fdi, vStart: vCursor, vCount: crown.positions.length / 3 });
    vCursor += crown.positions.length / 3;
  }

  const gingivaMesh = generateGingiva(jaw, spec, teeth);
  // 口扫 = 所有牙冠（摆到全局位姿）+ 牙龈
  const posedCrowns = teeth.map((t) => {
    const m = makeMesh(t.crown.positions.slice(), t.crown.indices.slice());
    const world: MeshData = {
      positions: new Float32Array(m.positions.length),
      normals: new Float32Array(m.normals.length),
      indices: m.indices,
    };
    const M = mat4.fromPose(t.pose);
    for (let i = 0; i < m.positions.length; i += 3) {
      const wp = mat4.transformPoint(M, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
      world.positions.set(wp, i);
    }
    for (let i = 0; i < m.normals.length; i += 3) {
      const wn = q.rotateVec(t.pose.q, [m.normals[i], m.normals[i + 1], m.normals[i + 2]]);
      world.normals.set(wn, i);
    }
    return world;
  });
  const all = [...posedCrowns, gingivaMesh];
  let acc = 0;
  const scanParts: MeshData[] = [];
  for (const m of all) {
    scanParts.push(m);
    acc += m.positions.length / 3;
  }
  const scan = mergeList(scanParts);

  return {
    data: { jaw, teeth, gingiva: { jaw, mesh: gingivaMesh } },
    scan,
    toothVertexRanges,
  };
}

function mergeList(parts: MeshData[]): MeshData {
  let vc = 0, ic = 0;
  for (const m of parts) { vc += m.positions.length / 3; ic += m.indices.length; }
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const indices = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const m of parts) {
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.positions.length / 3;
    io += m.indices.length;
  }
  return { positions, normals, indices };
}

export interface GeneratedCase {
  record: CaseRecord;
  /** 上下颌合并口扫（供“模型导入”页演示导入/分割） */
  scans: { upper: MeshData; lower: MeshData; ranges: { fdi: number; vStart: number; vCount: number }[] }[];
}

export function generateCrowdedCase(patientName: string, seed = 20261127): GeneratedCase {
  const upper = buildJaw('upper', seed, true);
  const lower = buildJaw('lower', seed, true);
  const now = Date.now();
  const record: CaseRecord = {
    id: `case-${seed.toString(16)}`,
    patientName,
    note: '程序化生成的拥挤病例：尖牙唇向错位、前牙扭转、弓长不足',
    createdAt: now, updatedAt: now,
    upper: upper.data, lower: lower.data,
    ipr: [], iprSafetyLimit: 0.5,
    plan: null, occlusions: [], rawScan: null,
  };
  return {
    record,
    scans: [
      { upper: upper.scan, lower: lower.scan, ranges: upper.toothVertexRanges },
      { upper: lower.scan, lower: lower.scan, ranges: lower.toothVertexRanges },
    ],
  };
}

/** 生成对齐良好的对照病例（用于验证碰撞/咬合在理想排列下基本无报警） */
export function generateAlignedCase(patientName: string, seed = 424242): GeneratedCase {
  const upper = buildJaw('upper', seed, false);
  const lower = buildJaw('lower', seed, false);
  const now = Date.now();
  const record: CaseRecord = {
    id: `case-${seed.toString(16)}-a`,
    patientName, note: '程序化生成的理想排列对照病例',
    createdAt: now, updatedAt: now,
    upper: upper.data, lower: lower.data,
    ipr: [], iprSafetyLimit: 0.5,
    plan: null, occlusions: [], rawScan: null,
  };
  return {
    record,
    scans: [
      { upper: upper.scan, lower: lower.scan, ranges: upper.toothVertexRanges },
      { upper: lower.scan, lower: lower.scan, ranges: lower.toothVertexRanges },
    ],
  };
}
