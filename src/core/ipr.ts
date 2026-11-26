// 邻面去釉（IPR）：定位两颗邻牙的相对面、生成着色标记顶点、累计量校验
import type { IprEntry, MeshData, Pose, ToothDef, Vec3 } from './types';
import { q, v3 } from './math';
import { iprAlarms } from './collision';
export { iprAlarms };

export interface IprMark {
  fdi: number;
  /** 需要高亮的局部顶点索引 */
  vertices: number[];
}

/**
 * 找出牙冠上朝向另一颗邻牙的局部顶点（邻接面）。
 * 判据：顶点到邻牙中心方向 与 顶点外法线夹角 < 60°，且位于近/远中侧面区域。
 */
export function findInterproximalVerts(tooth: ToothDef, neighbor: ToothDef, poseOf: (fdi: number) => Pose): number[] {
  const self = poseOf(tooth.fdi);
  const other = poseOf(neighbor.fdi);
  const dir = v3.norm(v3.sub(other.t, self.t));
  const out: number[] = [];
  const m = tooth.crown;
  for (let i = 0; i < m.positions.length / 3; i++) {
    const worldP = v3.add(self.t, q.rotateVec(self.q, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]));
    if (v3.dist(worldP, other.t) > v3.dist(self.t, other.t) + 1.5) continue;
    const worldN = q.rotateVec(self.q, [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]]);
    if (v3.dot(worldN, dir) > 0.5) out.push(i);
  }
  return out;
}

/** 为一条 IPR 生成双侧标记（供渲染层按去釉量上颜色） */
export function buildIprMarks(
  entry: IprEntry,
  teeth: ToothDef[],
  poseOf: (fdi: number) => Pose,
): IprMark[] {
  const a = teeth.find((t) => t.fdi === entry.fdiA);
  const b = teeth.find((t) => t.fdi === entry.fdiB);
  if (!a || !b) return [];
  return [
    { fdi: a.fdi, vertices: findInterproximalVerts(a, b, poseOf) },
    { fdi: b.fdi, vertices: findInterproximalVerts(b, a, poseOf) },
  ];
}

/** 去釉量 -> 颜色（绿 0.1 -> 橙 0.3 -> 红 >=0.5），返回线性 RGB */
export function iprColor(amount: number, safetyLimit: number): [number, number, number] {
  const r = Math.min(1, amount / safetyLimit);
  if (r < 0.6) {
    const k = r / 0.6;
    return [0.25 + 0.75 * k, 0.75 - 0.25 * k, 0.25];
  }
  const k = (r - 0.6) / 0.4;
  return [1, 0.5 * (1 - k), 0.15 * (1 - k)];
}

/** 按邻接对汇总去釉量并做安全值报警 */
export function summarizeIpr(entries: IprEntry[], safetyLimit: number) {
  const totals = new Map<string, { fdiA: number; fdiB: number; total: number; steps: number[] }>();
  for (const e of [...entries].sort((a, b) => a.atStep - b.atStep)) {
    const key = e.fdiA < e.fdiB ? `${e.fdiA}|${e.fdiB}` : `${e.fdiB}|${e.fdiA}`;
    const row = totals.get(key) ?? { fdiA: Math.min(e.fdiA, e.fdiB), fdiB: Math.max(e.fdiA, e.fdiB), total: 0, steps: [] };
    row.total += e.amount;
    row.steps.push(e.atStep);
    totals.set(key, row);
  }
  const rows = [...totals.values()].sort((a, b) => a.fdiA - b.fdiA);
  return {
    rows,
    alarms: iprAlarms(entries, safetyLimit),
  };
}

/** 在去釉步把邻牙沿相对方向各退 amount/2，返回修正后的位姿（几何模拟片切间隙） */
export function applyIprSpacing(entries: IprEntry[], step: number, base: Map<number, Pose>): Map<number, Pose> {
  const out = new Map(base);
  const active = entries.filter((e) => e.atStep === step);
  for (const e of active) {
    const pa = out.get(e.fdiA)!;
    const pb = out.get(e.fdiB)!;
    const dir = v3.norm(v3.sub(pb.t, pa.t));
    const half = e.amount / 2;
    out.set(e.fdiA, { ...pa, t: v3.sub(pa.t, v3.scale(dir, half)) });
    out.set(e.fdiB, { ...pb, t: v3.add(pb.t, v3.scale(dir, half)) });
  }
  return out;
}

/** 标记网格构建：把每颗牙的 IPR 顶点合并成一个可绘制的点云 */
export function marksToPointCloud(marks: IprMark[], teeth: ToothDef[], poseOf: (fdi: number) => Pose): MeshData {
  const positions: number[] = [];
  for (const mark of marks) {
    const tooth = teeth.find((t) => t.fdi === mark.fdi);
    if (!tooth) continue;
    const pose = poseOf(mark.fdi);
    for (const vi of mark.vertices) {
      const wp = v3.add(pose.t, q.rotateVec(pose.q, [
        tooth.crown.positions[vi * 3], tooth.crown.positions[vi * 3 + 1], tooth.crown.positions[vi * 3 + 2],
      ]));
      positions.push(wp[0], wp[1], wp[2]);
    }
  }
  // 点云用退化三角（每个点 3 个重合索引），复用普通网格管线
  const indices: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) indices.push(i, i, i);
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length).fill(0),
    indices: Uint32Array.from(indices),
  };
}
