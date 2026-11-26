// 牙弓曲线：抛物线弓形，坐标约定 x=患者左向(+)，y=垂直(上+)，z=前牙方向(+)
import type { Vec3 } from './types';
import { v3 } from './math';

export interface ArchSpec {
  /** 半宽：最后一颗磨牙处的 |x| */
  halfWidth: number;
  /** 弓形深度：前牙区相对磨牙区的 z 突出 */
  depth: number;
  /** 相邻牙位序号之间的弦长间隔 mm */
  spacing: number;
}

export const DEFAULT_ARCH: ArchSpec = { halfWidth: 44, depth: 29, spacing: 7.1 };

/** 牙位序号 i（±1..±7）-> 理想弓上的 xz 坐标 */
export function archPoint(spec: ArchSpec, i: number): { x: number; z: number } {
  const x = spec.spacing * i;
  const ratio = Math.min(1, Math.abs(x) / spec.halfWidth);
  const z = spec.depth * (1 - ratio * ratio);
  return { x, z };
}

/** 弓形在序号 i 处的单位切向量（沿 x 增大方向）与颊向单位向量（朝外） */
export function archFrame(spec: ArchSpec, i: number): { tangent: Vec3; outward: Vec3 } {
  const x = spec.spacing * i;
  const dzDx = (-2 * spec.depth * x) / (spec.halfWidth * spec.halfWidth);
  const tangent = v3.norm([1, 0, dzDx]);
  // 右旋坐标下外侧（唇颊向）= tangent 绕 -y 转 90°
  const outward = v3.norm([-tangent[2], 0, tangent[0]]);
  return { tangent, outward };
}

/** 沿弓形密集采样，供牙龈与自动排牙使用 */
export function sampleArch(spec: ArchSpec, iMin: number, iMax: number, samples: number): { p: Vec3; outward: Vec3 }[] {
  const out: { p: Vec3; outward: Vec3 }[] = [];
  for (let k = 0; k < samples; k++) {
    const i = iMin + ((iMax - iMin) * k) / (samples - 1);
    const { x, z } = archPoint(spec, i);
    const { outward } = archFrame(spec, i);
    out.push({ p: [x, 0, z], outward });
  }
  return out;
}

/** 弓形弧长（从序号 0 到 i），用于按累计冠宽定位牙位 */
export function archArcLength(spec: ArchSpec, i: number): number {
  const steps = Math.max(8, Math.ceil(Math.abs(i) * 6));
  let len = 0;
  let prev = archPoint(spec, 0);
  for (let k = 1; k <= steps; k++) {
    const cur = archPoint(spec, (i * k) / steps);
    len += Math.hypot(cur.x - prev.x, cur.z - prev.z);
    prev = cur;
  }
  return len;
}

/** 给定弧长 s，反求弓形上的序号 i（二分法），再返回该点坐标 */
export function archPointAtArcLength(spec: ArchSpec, s: number): { x: number; z: number; i: number } {
  const total = archArcLength(spec, 7);
  const target = Math.min(total, Math.abs(s));
  let lo = 0, hi = 7;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (archArcLength(spec, mid) < target) lo = mid; else hi = mid;
  }
  const i = (lo + hi) / 2;
  const { x, z } = archPoint(spec, i);
  return { x, z, i };
}
