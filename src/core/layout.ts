// 按牙冠近远中宽度沿牙弓弧长定位：保证邻接但不重叠
import type { Vec3 } from './types';
import { archFrame, archPointAtArcLength, type ArchSpec } from './arch';

export interface ArchPosition {
  x: number;
  z: number;
  tangent: Vec3;
  outward: Vec3;
  /** 反求出的弓形序号（浮点） */
  archIndexFloat: number;
}

/**
 * 输入每颗牙的 |archIndex|（1..7）与冠宽，返回各 archIndex（带正负号）的弓上位置。
 * 中线处为 0 弧长，第 s 颗牙中心弧长 = 前 s-1 颗邻接边界累加 + 自身半宽。
 * compressFactor<1 时整体压缩弓长（制造拥挤），1.0 为理想邻接排列；
 * gap 为每个邻接面预留的额外间隙（mm），补偿弓形弦长<弧长与网格外鼓。
 */
export function layoutOnArch(
  spec: ArchSpec,
  widthsByAbsIndex: Map<number, number>,
  compressFactor = 1,
  gap = 0.8,
): Map<number, ArchPosition> {
  const boundary = new Map<number, number>(); // |idx| -> 中心弧长
  let acc = 0;
  for (let s = 1; s <= 7; s++) {
    const w = widthsByAbsIndex.get(s) ?? 7;
    // 中切牙（s=1）中线侧额外留间隙，避免 11-21 接触
    const midlineExtra = s === 1 ? gap * 0.5 : 0;
    boundary.set(s, acc + w / 2 + midlineExtra);
    acc += w + gap;
  }
  const out = new Map<number, ArchPosition>();
  for (const sign of [-1, 1]) {
    for (let s = 1; s <= 7; s++) {
      const arc = boundary.get(s)! * compressFactor;
      const { x, z, i } = archPointAtArcLength(spec, arc);
      const signedI = sign * i;
      const f = archFrame(spec, signedI);
      out.set(sign * s, {
        x: sign * x,
        z,
        tangent: f.tangent,
        outward: f.outward,
        archIndexFloat: signedI,
      });
    }
  }
  return out;
}
