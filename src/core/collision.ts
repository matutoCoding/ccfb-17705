// 碰撞/咬合引擎：空间哈希加速的顶点-三角面穿透检测，遍历顺序固定 => 结果确定
import type {
  CollisionPair, JawType, MeshData, OcclusionContact, OcclusionResult, Pose, StepCollision, StepPlan, ToothDef, Vec3,
} from './types';
import { q, v3 } from './math';
import { posesAtStep } from './planning';

interface HashGrid {
  cell: number;
  map: Map<number, number[]>; // cellKey -> 条目索引
}

const cellKey = (ix: number, iy: number, iz: number): number => {
  // 限定范围的三整数打包，避免字符串键的不确定性开销
  const OX = 256, OY = 256, OZ = 256;
  return ((ix + OX) * 512 + (iy + OY)) * 512 + (iz + OZ);
};

function buildVertexGrid(verts: Float32Array, cell: number): HashGrid {
  const map = new Map<number, number[]>();
  const n = verts.length / 3;
  for (let i = 0; i < n; i++) {
    const key = cellKey(Math.floor(verts[i * 3] / cell), Math.floor(verts[i * 3 + 1] / cell), Math.floor(verts[i * 3 + 2] / cell));
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(i);
  }
  return { cell, map };
}

function nearestVertex(grid: HashGrid, verts: Float32Array, p: Vec3, maxDist: number): { dist: number; point: Vec3; index: number } | null {
  const r = Math.ceil(maxDist / grid.cell);
  const cx = Math.floor(p[0] / grid.cell);
  const cy = Math.floor(p[1] / grid.cell);
  const cz = Math.floor(p[2] / grid.cell);
  let best = maxDist;
  let bestPoint: Vec3 | null = null;
  let bestIndex = -1;
  for (let ix = cx - r; ix <= cx + r; ix++) {
    for (let iy = cy - r; iy <= cy + r; iy++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const bucket = grid.map.get(cellKey(ix, iy, iz));
        if (!bucket) continue;
        for (const vi of bucket) {
          const dx = verts[vi * 3] - p[0];
          const dy = verts[vi * 3 + 1] - p[1];
          const dz = verts[vi * 3 + 2] - p[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < best) {
            best = d;
            bestIndex = vi;
            bestPoint = [verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]];
          }
        }
      }
    }
  }
  return bestPoint ? { dist: best, point: bestPoint, index: bestIndex } : null;
}


/** 把一颗牙的局部网格摆到世界坐标（仅位置，碰撞用） */
function poseMesh(mesh: MeshData, pose: Pose): Float32Array {
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = q.rotateVec(pose.q, [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]);
    out[i * 3] = r[0] + pose.t[0];
    out[i * 3 + 1] = r[1] + pose.t[1];
    out[i * 3 + 2] = r[2] + pose.t[2];
  }
  return out;
}

export interface CollisionOptions {
  /** 穿透报警阈值 mm */
  threshold: number;
  /** 空间哈希格子尺寸 mm */
  cellSize?: number;
  /** 粗筛最大距离 mm（包围球间距小于该值才细检） */
  broadPhaseDistance?: number;
}

/** 局部空间三角面几何（不随步变化，可缓存复用） */
interface LocalTriMesh {
  indices: Uint32Array;
  triNormal: Float32Array;  // 局部法线
  triRadius: Float32Array;  // 局部包围球半径（旋转不变）
  crownRadius: number;
}

const localMeshCache = new WeakMap<ToothDef, LocalTriMesh>();

function getLocalMesh(t: ToothDef): LocalTriMesh {
  const hit = localMeshCache.get(t);
  if (hit) return hit;
  const indices = t.crown.indices;
  const triCount = indices.length / 3;
  const triNormal = new Float32Array(triCount * 3);
  const triRadius = new Float32Array(triCount);
  const v = t.crown.positions;
  let crownRadius = 0;
  for (let tri = 0; tri < triCount; tri++) {
    const a = indices[tri * 3] * 3, b = indices[tri * 3 + 1] * 3, c = indices[tri * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const vx = v[c] - v[a], vy = v[c + 1] - v[a + 1], vz = v[c + 2] - v[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    triNormal.set([nx / nl, ny / nl, nz / nl], tri * 3);
    const cx = (v[a] + v[b] + v[c]) / 3, cy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3, cz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
    triRadius[tri] = Math.max(
      Math.hypot(v[a] - cx, v[a + 1] - cy, v[a + 2] - cz),
      Math.hypot(v[b] - cx, v[b + 1] - cy, v[b + 2] - cz),
      Math.hypot(v[c] - cx, v[c + 1] - cy, v[c + 2] - cz),
    );
  }
  for (let k = 0; k < v.length; k += 3) crownRadius = Math.max(crownRadius, Math.hypot(v[k], v[k + 1], v[k + 2]));
  const mesh: LocalTriMesh = { indices, triNormal, triRadius, crownRadius };
  localMeshCache.set(t, mesh);
  return mesh;
}

/** 每步世界空间面网格：复用局部法线/半径，仅质心与哈希随位姿重建 */
interface WorldSurface {
  verts: Float32Array;
  local: LocalTriMesh;
  triCenter: Float32Array; // 世界质心
  triNormal: Float32Array; // 世界法线（局部法线旋转后）
  pose: Pose;
  grid: HashGrid;
}

function buildWorldSurface(t: ToothDef, pose: Pose, cell: number): WorldSurface {
  const local = getLocalMesh(t);
  const verts = poseMesh(t.crown, pose);
  const triCount = local.indices.length / 3;
  const triCenter = new Float32Array(triCount * 3);
  const triNormal = new Float32Array(triCount * 3);
  const map = new Map<number, number[]>();
  for (let tri = 0; tri < triCount; tri++) {
    const ia = local.indices[tri * 3] * 3, ib = local.indices[tri * 3 + 1] * 3, ic = local.indices[tri * 3 + 2] * 3;
    const cx = (verts[ia] + verts[ib] + verts[ic]) / 3;
    const cy = (verts[ia + 1] + verts[ib + 1] + verts[ic + 1]) / 3;
    const cz = (verts[ia + 2] + verts[ib + 2] + verts[ic + 2]) / 3;
    triCenter.set([cx, cy, cz], tri * 3);
    const ln: Vec3 = [local.triNormal[tri * 3], local.triNormal[tri * 3 + 1], local.triNormal[tri * 3 + 2]];
    triNormal.set(q.rotateVec(pose.q, ln), tri * 3);
    const key = cellKey(Math.floor(cx / cell), Math.floor(cy / cell), Math.floor(cz / cell));
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(tri);
  }
  return { verts, local, triCenter, triNormal, pose, grid: { cell, map } };
}

/**
 * 单颌牙间碰撞（双向顶点-三角面最近距离，确定性）：
 * 粗筛用冠包围球 + 弓上邻接关系（仅检查同颌 |archIndex| 差 ≤ 2 的牙对）；
 * 细检对每个顶点求点到面的精确最近距离，三角面连通性/法线/包围球走局部缓存。
 * 穿透判据：点到最近面的有符号距离为负（位于面内侧），取双向最大穿透；
 * 无内点时报告最近间隙（负值），不再用顶点法线，避免凸面假阳性。
 */
export function detectJawCollisions(
  teeth: ToothDef[],
  poses: Map<number, Pose>,
  opts: CollisionOptions,
): CollisionPair[] {
  const cell = opts.cellSize ?? 0.75;
  // 邻牙接触只关心局部表面，搜索半径取阈值与小间隙的上限，避免扫整颗牙
  const searchDist = Math.max(opts.threshold * 4, 1.5);
  const ordered = [...teeth].sort((a, b) => a.fdi - b.fdi);
  // 惰性构建：只有通过粗筛、真正需要细检的牙才构建世界面网格
  const worldSurfaces = new Map<number, WorldSurface>();
  const surfaceOf = (t: ToothDef): WorldSurface => {
    let ws = worldSurfaces.get(t.fdi);
    if (!ws) {
      ws = buildWorldSurface(t, poses.get(t.fdi)!, cell);
      worldSurfaces.set(t.fdi, ws);
    }
    return ws;
  };
  const pairs: CollisionPair[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const A = ordered[i], B = ordered[j];
      if (A.jaw !== B.jaw) continue;
      if (Math.abs(A.archIndex - B.archIndex) > 2) continue;
      // 跨中线仅允许中切牙对（-1 与 +1，即 11-21 / 41-31），其余跳过
      const crossMidline = Math.sign(A.archIndex) !== Math.sign(B.archIndex);
      if (crossMidline && !(A.archIndex + B.archIndex === 0 && Math.abs(A.archIndex) === 1)) continue;
      const pa = poses.get(A.fdi)!, pb = poses.get(B.fdi)!;
      // 用冠半径粗筛：中心距超过两冠半径 + 容差则不可能接触，直接跳过（不构建网格）
      const centerDist = v3.dist(pa.t, pb.t);
      const rA = getLocalMesh(A).crownRadius, rB = getLocalMesh(B).crownRadius;
      if (centerDist > rA + rB + searchDist) continue;

      const surfA = surfaceOf(A);
      const surfB = surfaceOf(B);
      let deepestPen = 0;      // 真正内点的最大深度（正值）
      let penPoint: Vec3 | null = null;
      let minGap = Infinity;   // 最近间隙（无穿透时使用）

      const probe = (source: WorldSurface, target: WorldSurface): boolean => {
        const sv = source.verts;
        for (let vi = 0; vi < sv.length / 3; vi++) {
          const p: Vec3 = [sv[vi * 3], sv[vi * 3 + 1], sv[vi * 3 + 2]];
          const hit = nearestWorldSurface(target, p, searchDist);
          if (!hit) continue;
          if (hit.dist < minGap) minGap = hit.dist;
          if (hit.signed < 0 && hit.dist > deepestPen) {
            deepestPen = hit.dist;
            penPoint = p;
          }
        }
        return deepestPen > opts.threshold; // 已确认报警，可提前结束该牙对
      };
      const alarmA = probe(surfB, surfA);
      if (!alarmA) probe(surfA, surfB);

      const penetration = deepestPen > 0 ? deepestPen : -minGap;
      pairs.push({
        fdiA: A.fdi, fdiB: B.fdi,
        penetration: Number.isFinite(penetration) ? penetration : -searchDist,
        point: deepestPen > 0 ? penPoint : null,
      });
    }
  }
  // 确定性输出：按牙位排序
  return pairs.sort((a, b) => a.fdiA - b.fdiA || a.fdiB - b.fdiB);
}

/** 世界空间点到面最近距离（法线/半径走局部缓存，质心用世界坐标） */
function nearestWorldSurface(ws: WorldSurface, p: Vec3, maxDist: number): { dist: number; point: Vec3; signed: number } | null {
  const cell = ws.grid.cell;
  const r = Math.max(1, Math.ceil(maxDist / cell));
  const cx = Math.floor(p[0] / cell);
  const cy = Math.floor(p[1] / cell);
  const cz = Math.floor(p[2] / cell);
  let bestAbs = maxDist;
  let best: { dist: number; point: Vec3; signed: number } | null = null;
  const { verts, local, triCenter, triNormal, grid } = ws;
  const px = p[0], py = p[1], pz = p[2];
  for (let ix = cx - r; ix <= cx + r; ix++) {
    for (let iy = cy - r; iy <= cy + r; iy++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const bucket = grid.map.get(cellKey(ix, iy, iz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const tri = bucket[bi];
          const tcx = triCenter[tri * 3], tcy = triCenter[tri * 3 + 1], tcz = triCenter[tri * 3 + 2];
          const reach = local.triRadius[tri] + bestAbs;
          const dx = px - tcx, dy = py - tcy, dz = pz - tcz;
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
          const ia = local.indices[tri * 3] * 3, ib = local.indices[tri * 3 + 1] * 3, ic = local.indices[tri * 3 + 2] * 3;
          const sd = pointTriSignedDist(
            px, py, pz,
            verts[ia], verts[ia + 1], verts[ia + 2],
            verts[ib], verts[ib + 1], verts[ib + 2],
            verts[ic], verts[ic + 1], verts[ic + 2],
            triNormal[tri * 3], triNormal[tri * 3 + 1], triNormal[tri * 3 + 2],
          );
          if (Math.abs(sd) < bestAbs) {
            bestAbs = Math.abs(sd);
            best = { dist: Math.abs(sd), point: p, signed: sd };
          }
        }
      }
    }
  }
  return best;
}

/**
 * 无分配标量版点到三角形有符号距离（Ericson 最近点 + 面法线判内外）。
 * 法线由调用方按世界空间给出。
 */
function pointTriSignedDist(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ccx: number, ccy: number, ccz: number,
  nx: number, ny: number, nz: number,
): number {
  // 最近点用重心区域判定，最后统一算距离，避免任何数组分配
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = ccx - ax, acy = ccy - ay, acz = ccz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const vv = d1 / (d1 - d3);
        qx = ax + abx * vv; qy = ay + aby * vv; qz = az + abz * vv;
      } else {
        const cpx = px - ccx, cpy = py - ccy, cpz = pz - ccz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = ccx; qy = ccy; qz = ccz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const ww = d2 / (d2 - d6);
            qx = ax + acx * ww; qy = ay + acy * ww; qz = az + acz * ww;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (ccx - bx) * w; qy = by + (ccy - by) * w; qz = bz + (ccz - bz) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const ex = px - qx, ey = py - qy, ez = pz - qz;
  const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
  return ex * nx + ey * ny + ez * nz < 0 ? -dist : dist;
}

/** 对整套分步方案逐行算碰撞，填充 plan.collisions */
export function computePlanCollisions(
  upper: ToothDef[],
  lower: ToothDef[],
  plan: StepPlan,
  threshold: number,
): StepCollision[] {
  const out: StepCollision[] = [];
  const all = [...upper, ...lower];
  for (let step = 1; step <= plan.stepCount; step++) {
    const poses = posesAtStep(all, plan, step);
    const pairs = [
      ...detectJawCollisions(upper, poses, { threshold }),
      ...detectJawCollisions(lower, poses, { threshold }),
    ];
    const hasAlarm = pairs.some((p) => p.penetration > threshold);
    out.push({ step, pairs, threshold, hasAlarm });
  }
  plan.collisions = out;
  return out;
}

/**
 * 咬合检查：上下颌对位后检测接触点。
 * mode 控制下颌刚体位移（前伸/侧方），接触判定用上下冠顶点的最近距离与法线对冲。
 */
export function checkOcclusion(
  upper: ToothDef[],
  lower: ToothDef[],
  upperPoses: Map<number, Pose>,
  lowerPoses: Map<number, Pose>,
  mode: OcclusionResult['mode'],
  opts: { contactDistance: number; cellSize?: number } = { contactDistance: 1.2 },
): OcclusionResult {
  const shiftMap: Record<OcclusionResult['mode'], Vec3> = {
    icp: [0, 0, 0],
    protrusive: [0, 0, 3],
    'lateral-left': [2.5, 0, 0],
    'lateral-right': [-2.5, 0, 0],
  };
  const mandibleShift = shiftMap[mode];
  const shiftedLower = new Map<number, Pose>();
  for (const [fdi, pose] of lowerPoses) {
    shiftedLower.set(fdi, { t: v3.add(pose.t, mandibleShift), q: pose.q });
  }
  // 上颌顶点入网格
  const parts: { fdi: number; verts: Float32Array }[] = [];
  let total = 0;
  for (const t of upper) {
    const verts = poseMesh(t.crown, upperPoses.get(t.fdi)!);
    parts.push({ fdi: t.fdi, verts });
    total += verts.length;
  }
  const merged = new Float32Array(total);
  const owner = new Int32Array(total / 3);
  let off = 0;
  for (const part of parts) {
    merged.set(part.verts, off * 3);
    for (let i = 0; i < part.verts.length / 3; i++) owner[off + i] = part.fdi;
    off += part.verts.length / 3;
  }
  const grid = buildVertexGrid(merged, opts.cellSize ?? 0.5);
  const contacts: OcclusionContact[] = [];
  for (const t of lower.sort((a, b) => a.fdi - b.fdi)) {
    const pose = shiftedLower.get(t.fdi)!;
    const verts = poseMesh(t.crown, pose);
    for (let vi = 0; vi < verts.length / 3; vi++) {
      const p: Vec3 = [verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]];
      // 只检查朝上的顶点（咬合面）
      const nWorld = q.rotateVec(pose.q, [
        t.crown.normals[vi * 3], t.crown.normals[vi * 3 + 1], t.crown.normals[vi * 3 + 2],
      ]);
      if (nWorld[1] < 0.35) continue;
      const hit = nearestVertex(grid, merged, p, opts.contactDistance);
      if (!hit) continue;
      const upperFdi = owner[hit.index];
      const penetration = -hit.dist; // 距离越小咬得越紧，负值表示还有间隙
      contacts.push({ upperFdi, lowerFdi: t.fdi, penetration, point: p });
    }
  }
  // 每对上下牙只保留咬得最紧的接触点，确定性排序
  const best = new Map<string, OcclusionContact>();
  for (const c of contacts) {
    const key = `${c.upperFdi}-${c.lowerFdi}`;
    const prev = best.get(key);
    if (!prev || c.penetration > prev.penetration) best.set(key, c);
  }
  return {
    mode,
    contacts: [...best.values()].sort((a, b) => a.upperFdi - b.upperFdi || a.lowerFdi - b.lowerFdi),
    mandibleShift,
  };
}

/** IPR 安全校验：累计去釉超限时返回报警条目 */
export function iprAlarms(
  entries: { fdiA: number; fdiB: number; amount: number }[],
  safetyLimit: number,
): { pair: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    const key = e.fdiA < e.fdiB ? `${e.fdiA}|${e.fdiB}` : `${e.fdiB}|${e.fdiA}`;
    totals.set(key, (totals.get(key) ?? 0) + e.amount);
  }
  return [...totals.entries()]
    .filter(([, total]) => total > safetyLimit + 1e-9)
    .map(([pair, total]) => ({ pair, total }))
    .sort((a, b) => a.pair.localeCompare(b.pair));
}

export type { JawType };
