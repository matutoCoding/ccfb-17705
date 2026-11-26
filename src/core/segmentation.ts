// 口扫网格自动分割：曲率场 + 多种子分水岭区域生长（确定性）
// 思路：牙颈沟是高曲率凹陷，作为生长屏障；牙冠顶点放种子，区域在冠面内扩张。
import type { JawType, MeshData, Segmentation, Vec3 } from './types';
import { fdiFor } from './caseGenerator';
import { layoutOnArch } from './layout';
import { v3 } from './math';

/** 构建顶点邻接表（确定性：按索引排序） */
export function buildAdjacency(mesh: MeshData): Int32Array[] {
  const n = mesh.positions.length / 3;
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    for (let a = 0; a < 3; a++) {
      adj[tri[a]].add(tri[(a + 1) % 3]);
      adj[tri[a]].add(tri[(a + 2) % 3]);
    }
  }
  return adj.map((s) => Int32Array.from([...s].sort((x, y) => x - y)));
}

/**
 * 离散曲率：基于邻接三角形法线夹角的面积加权平均（正值≈凸起，负值≈凹陷）
 * 颈缘沟呈现连续负曲率带，是分割屏障。
 */
export function computeCurvature(mesh: MeshData, adj: Int32Array[]): Float32Array {
  const n = mesh.positions.length / 3;
  const curv = new Float32Array(n);
  const p = mesh.positions, nm = mesh.normals;
  for (let v = 0; v < n; v++) {
    let acc = 0, weight = 0;
    const va: Vec3 = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
    const na: Vec3 = [nm[v * 3], nm[v * 3 + 1], nm[v * 3 + 2]];
    for (let k = 0; k < adj[v].length; k++) {
      const u = adj[v][k];
      const nb: Vec3 = [nm[u * 3], nm[u * 3 + 1], nm[u * 3 + 2]];
      const vb: Vec3 = [p[u * 3], p[u * 3 + 1], p[u * 3 + 2]];
      const edge = v3.norm(v3.sub(vb, va));
      const dot = Math.max(-1, Math.min(1, v3.dot(na, nb)));
      // 法线夹角带符号：沿边方向投影到自身切平面判断凸凹
      const sign = v3.dot(v3.sub(nb, na), edge) >= 0 ? 1 : -1;
      acc += (Math.acos(dot) * 180) / Math.PI * sign;
      weight += 1;
    }
    curv[v] = weight > 0 ? acc / weight : 0;
  }
  return curv;
}

/** 自动种子：沿理想弓形（按平均冠宽的弧长布局）在网格表面找最近顶点，14 颗 */
export function autoSeeds(mesh: MeshData, jaw: JawType, archSpacing = 7.1): Map<number, number> {
  const seeds = new Map<number, number>();
  const p = mesh.positions;
  const n = p.length / 3;
  // 各牙类平均近远中冠宽，用于近似弧长定位
  const meanWidth = (absIdx: number): number =>
    absIdx <= 2 ? 8.2 : absIdx === 3 ? 7.4 : absIdx <= 5 ? 6.9 : 9.6;
  const widths = new Map<number, number>();
  for (let s = 1; s <= 7; s++) widths.set(s, meanWidth(s));
  const spec = { halfWidth: 44, depth: 29, spacing: archSpacing };
  const layout = layoutOnArch(spec, widths, 1.0, 0.35);
  for (let idx = -7; idx <= 7; idx++) {
    if (idx === 0) continue;
    const target = layout.get(idx)!;
    let bestV = -1, bestScore = Infinity;
    for (let v = 0; v < n; v++) {
      const dx = p[v * 3] - target.x;
      const dz = p[v * 3 + 2] - target.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestScore) { bestScore = d2; bestV = v; }
    }
    if (bestV >= 0) seeds.set(bestV, fdiFor(jaw, idx));
  }
  return seeds;
}

/**
 * 分水岭区域生长：
 * - 队列优先级 = 路径上最低曲率（越凸越优先），同优先级按顶点索引保证确定性
 * - 曲率低于 barrier 的凹陷带（颈沟）禁止跨越
 * - 多标签争夺时先到先得（确定性的平局规则）
 */
export function watershedSegment(
  mesh: MeshData,
  adj: Int32Array[],
  curvature: Float32Array,
  seeds: Map<number, number>,
  barrier = -14,
): Int32Array {
  const n = mesh.positions.length / 3;
  const labels = new Int32Array(n).fill(-1);
  // 简单二叉堆，元素 [vertex, minCurvature]，按 minCurvature 降序、vertex 升序
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (cmp(heap[i], heap[parent]) < 0) {
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      } else break;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < heap.length && cmp(heap[l], heap[smallest]) < 0) smallest = l;
        if (r < heap.length && cmp(heap[r], heap[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  };
  const cmp = (a: [number, number], b: [number, number]): number =>
    b[1] - a[1] || a[0] - b[0];

  for (const [v, fdi] of seeds) {
    labels[v] = fdi;
    push([v, curvature[v]]);
  }
  while (heap.length > 0) {
    const [v, pathCurv] = pop();
    const label = labels[v];
    for (let k = 0; k < adj[v].length; k++) {
      const u = adj[v][k];
      if (labels[u] !== -1) continue;
      if (curvature[u] < barrier) continue; // 颈沟屏障
      labels[u] = label;
      push([u, Math.min(pathCurv, curvature[u])]);
    }
  }
  return labels;
}

/** 完整自动分割流水线 */
export function autoSegment(mesh: MeshData, jaw: JawType): Segmentation {
  const adj = buildAdjacency(mesh);
  const curvature = computeCurvature(mesh, adj);
  const seeds = autoSeeds(mesh, jaw);
  const labels = watershedSegment(mesh, adj, curvature, seeds);
  return { labels, seeds, curvature };
}

/** 手动修正：把以 center 为中心半径 radius(mm) 内的顶点改涂为 fdi（-1=牙龈） */
export function paintLabel(seg: Segmentation, mesh: MeshData, center: Vec3, radius: number, fdi: number): number {
  const r2 = radius * radius;
  const p = mesh.positions;
  let changed = 0;
  for (let v = 0; v < p.length / 3; v++) {
    const dx = p[v * 3] - center[0], dy = p[v * 3 + 1] - center[1], dz = p[v * 3 + 2] - center[2];
    if (dx * dx + dy * dy + dz * dz <= r2 && seg.labels[v] !== fdi) {
      seg.labels[v] = fdi;
      changed++;
    }
  }
  return changed;
}

/** 按标签提取单牙网格（返回局部坐标 + 全局中心） */
export function extractToothMesh(mesh: MeshData, labels: Int32Array, fdi: number): { mesh: MeshData; center: Vec3 } {
  const usedVerts = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let v = 0; v < labels.length; v++) {
    if (labels[v] !== fdi) continue;
    usedVerts.set(v, positions.length / 3);
    positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    cx += mesh.positions[v * 3]; cy += mesh.positions[v * 3 + 1]; cz += mesh.positions[v * 3 + 2];
    cnt++;
  }
  const center: Vec3 = cnt ? [cx / cnt, cy / cnt, cz / cnt] : [0, 0, 0];
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = usedVerts.get(idx[t]), b = usedVerts.get(idx[t + 1]), c = usedVerts.get(idx[t + 2]);
    if (a !== undefined && b !== undefined && c !== undefined) indices.push(a, b, c);
  }
  // 中心化到局部坐标
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= center[0]; positions[i + 1] -= center[1]; positions[i + 2] -= center[2];
  }
  const out: MeshData = {
    positions: Float32Array.from(positions),
    normals: new Float32Array(0),
    indices: Uint32Array.from(indices),
  };
  out.normals = recomputeFromScratch(out);
  return { mesh: out, center };
}

function recomputeFromScratch(m: MeshData): Float32Array {
  const n = m.positions.length / 3;
  const normals = new Float32Array(n * 3);
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ux = m.positions[b] - m.positions[a], uy = m.positions[b + 1] - m.positions[a + 1], uz = m.positions[b + 2] - m.positions[a + 2];
    const vx = m.positions[c] - m.positions[a], vy = m.positions[c + 1] - m.positions[a + 1], vz = m.positions[c + 2] - m.positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const vi of [m.indices[t], m.indices[t + 1], m.indices[t + 2]]) {
      normals[vi * 3] += nx; normals[vi * 3 + 1] += ny; normals[vi * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (l > 1e-12) { normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l; }
  }
  return normals;
}
