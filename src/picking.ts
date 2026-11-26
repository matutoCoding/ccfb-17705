// 射线拾取：Möller–Trumbore 与每颗牙的世界空间三角形求交，取最近命中
import type { MeshData, Pose, Vec3 } from './core/types';
import { mat4, v3 } from './core/math';

export interface PickHit {
  fdi: number;
  point: Vec3;
  distance: number;
}

function rayTri(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const eps = 1e-7;
  const edge1 = v3.sub(b, a);
  const edge2 = v3.sub(c, a);
  const h = v3.cross(dir, edge2);
  const det = v3.dot(edge1, h);
  if (Math.abs(det) < eps) return null;
  const f = 1 / det;
  const s = v3.sub(origin, a);
  const u = f * v3.dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = v3.cross(s, edge1);
  const v = f * v3.dot(dir, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * v3.dot(edge2, q);
  return t > eps ? t : null;
}

/** 在一组牙（局部网格 + 当前位姿）中拾取最近牙位 */
export function pickTooth(
  origin: Vec3,
  dir: Vec3,
  teeth: { fdi: number; crown: MeshData; pose: Pose }[],
): PickHit | null {
  let best: PickHit | null = null;
  for (const tooth of teeth) {
    const m = mat4.fromPose(tooth.pose);
    const idx = tooth.crown.indices;
    const pos = tooth.crown.positions;
    for (let t = 0; t < idx.length; t += 3) {
      const tri = [idx[t], idx[t + 1], idx[t + 2]].map((vi) =>
        mat4.transformPoint(m, [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]),
      ) as [Vec3, Vec3, Vec3];
      const hit = rayTri(origin, dir, tri[0], tri[1], tri[2]);
      if (hit !== null && (!best || hit < best.distance)) {
        best = {
          fdi: tooth.fdi,
          distance: hit,
          point: v3.add(origin, v3.scale(dir, hit)),
        };
      }
    }
  }
  return best;
}

/** 射线与平面交点（拖牙时把运动约束在过牙中心的平面上） */
export function rayPlane(origin: Vec3, dir: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const denom = v3.dot(dir, planeNormal);
  if (Math.abs(denom) < 1e-7) return null;
  const t = v3.dot(v3.sub(planePoint, origin), planeNormal) / denom;
  return t >= 0 ? v3.add(origin, v3.scale(dir, t)) : null;
}
