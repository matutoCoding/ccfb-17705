// 参数化牙冠（超二次曲面 + 牙类特征）与统计模型牙根
// 局部坐标：x=近远中，y=长轴(冠向+ / 根向-)，z=颊(+)舌(-)
import type { MeshData, ToothDef } from './types';
import { makeMesh, rng, v3 } from './math';

const sgnPow = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);

export interface CrownParams {
  /** 近远中宽 */
  width: number;
  /** 颊舌径 */
  depth: number;
  /** 冠高（咬合面到颈缘） */
  height: number;
  /** 纵向方正度（越小越方） */
  e1: number;
  /** 横向方正度 */
  e2: number;
  /** 牙类 */
  cls: ToothDef['toothClass'];
}

export const CROWN_PARAMS: Record<ToothDef['toothClass'], CrownParams> = {
  incisor:   { width: 8.2, depth: 6.4, height: 8.5, e1: 0.28, e2: 0.42, cls: 'incisor' },
  canine:    { width: 7.4, depth: 7.6, height: 9.5, e1: 0.34, e2: 0.46, cls: 'canine' },
  premolar:  { width: 6.9, depth: 8.4, height: 8.0, e1: 0.40, e2: 0.52, cls: 'premolar' },
  molar:     { width: 9.6, depth: 9.8, height: 7.6, e1: 0.42, e2: 0.55, cls: 'molar' },
};

/** 生成牙冠网格（局部坐标，中心在解剖中心，冠向 y+） */
export function generateCrown(p: CrownParams, seed: number): MeshData {
  const rand = rng(seed);
  const uSeg = 28, vSeg = 18;
  const positions: number[] = [];
  const indices: number[] = [];
  const a = p.width / 2, b = p.height / 2, c = p.depth / 2;

  // 后牙咬合面牙尖（2~4 个），前牙切缘轻微起伏
  const cuspCount = p.cls === 'molar' ? 4 : p.cls === 'premolar' ? 2 : 0;
  const cusps = Array.from({ length: cuspCount }, (_, k) => ({
    eta: k < 2 ? -0.55 : 0.55,
    omega: k % 2 === 0 ? 0.7 : Math.PI - 0.7,
    amp: 0.55 + rand() * 0.3,
  }));

  const ringIndex = (j: number, i: number): number => j * (uSeg + 1) + i;

  for (let j = 0; j <= vSeg; j++) {
    const eta = -Math.PI / 2 + (Math.PI * j) / vSeg; // -π/2(根端) .. π/2(咬合端)
    const ce = Math.cos(eta), se = Math.sin(eta);
    for (let i = 0; i <= uSeg; i++) {
      const omega = (2 * Math.PI * i) / uSeg;
      const co = Math.cos(omega), so = Math.sin(omega);
      let x = a * sgnPow(ce, p.e1) * sgnPow(co, p.e2);
      let y = b * sgnPow(se, p.e1);
      let z = c * sgnPow(ce, p.e1) * sgnPow(so, p.e2);

      // 牙尖隆起：只作用于咬合端
      const top = Math.max(0, se);
      for (const cu of cusps) {
        const dEta = eta - cu.eta, dOm = ((omega - cu.omega + Math.PI * 3) % (2 * Math.PI)) - Math.PI;
        const g = Math.exp(-(dEta * dEta) / 0.18 - (dOm * dOm) / 0.35);
        y += b * 0.16 * cu.amp * g * top;
      }
      if (p.cls === 'incisor' || p.cls === 'canine') {
        // 切缘/牙尖：咬合端沿颊舌向收窄成刃
        const edge = Math.pow(top, 3);
        z *= 1 - 0.55 * edge;
        if (p.cls === 'canine') {
          // 尖牙近中高、远中低的单尖
          y += b * 0.22 * edge * Math.max(0, co);
        }
      }
      // 颈缘轻微内收
      const neck = Math.pow(Math.max(0, -se), 2);
      x *= 1 - 0.12 * neck;
      z *= 1 - 0.12 * neck;
      // 确定性表面微扰，避免完美对称
      const noise = 1 + 0.012 * Math.sin(omega * 5 + seed) * Math.sin(eta * 4 + seed * 0.7);
      x *= noise; z *= noise;

      positions.push(x, y, z);
    }
  }
  for (let j = 0; j < vSeg; j++) {
    for (let i = 0; i < uSeg; i++) {
      const a0 = ringIndex(j, i), b0 = ringIndex(j, i + 1);
      const c0 = ringIndex(j + 1, i), d0 = ringIndex(j + 1, i + 1);
      indices.push(a0, c0, b0, b0, c0, d0);
    }
  }
  return makeMesh(Float32Array.from(positions), Uint32Array.from(indices));
}

interface RootSpec {
  length: number;
  /** 根分叉数：切牙/尖牙/前磨牙 1，磨牙 2~3 */
  branches: number;
  /** 根干占比 */
  trunkRatio: number;
  /** 根尖弯曲方向（局部 xz）与幅度 */
  bend: [number, number];
  rMx: number; // 根中 1/2 处近远中半径
  rMz: number; // 根中颊舌半径
}

export function rootSpecFor(cls: ToothDef['toothClass'], fdi: number, seed: number): RootSpec {
  const rand = rng(seed + 777);
  const base: Record<ToothDef['toothClass'], Omit<RootSpec, 'bend'>> = {
    incisor: { length: 11.5, branches: 1, trunkRatio: 0.55, rMx: 1.5, rMz: 1.7 },
    canine: { length: 14.5, branches: 1, trunkRatio: 0.6, rMx: 2.0, rMz: 2.3 },
    premolar: { length: 12.0, branches: fdi % 10 === 4 ? 2 : 1, trunkRatio: 0.45, rMx: 1.8, rMz: 2.4 },
    molar: { length: 11.0, branches: 3, trunkRatio: 0.35, rMx: 2.6, rMz: 2.8 },
  };
  const b = base[cls];
  return {
    ...b,
    length: b.length * (0.92 + rand() * 0.16),
    bend: [(rand() - 0.5) * 2.2, (rand() - 0.5) * 1.4],
  };
}

/** 统计模型牙根：根干圆锥 + 分叉根尖，冠根衔接处 y ≈ -height/2 */
export function generateRoot(spec: RootSpec, neckY: number, crownWidth: number, seed: number): MeshData {
  const rand = rng(seed + 31337);
  const uSeg = 20, hSeg = 22;
  const positions: number[] = [];
  const indices: number[] = [];
  const neckRx = crownWidth * 0.26;
  const neckRz = crownWidth * 0.3;
  const tipY = neckY - spec.length;

  // 分叉根的水平偏移方向（颊舌/近远中均布）
  const branchDirs: [number, number][] =
    spec.branches === 1
      ? [[0, 0]]
      : spec.branches === 2
        ? [[0, 0.9], [0, -0.9]]
        : [[0.85, 0.5], [-0.85, 0.5], [0, -0.85]];
  const spread = crownWidth * 0.22;

  const ringIndex = (j: number, i: number) => j * (uSeg + 1) + i;

  for (let j = 0; j <= hSeg; j++) {
    const t = j / hSeg; // 0=颈缘 1=根尖
    // 半径曲线：颈缘略膨 -> 根干收窄 -> 根尖渐变细
    const taper = Math.pow(1 - t, 0.75);
    const bulge = 1 + 0.18 * Math.sin(Math.PI * Math.min(1, t * 1.4));
    const rx = neckRx * taper * bulge;
    const rz = neckRz * taper * bulge;
    const y = neckY - spec.length * t;
    for (let i = 0; i <= uSeg; i++) {
      const omega = (2 * Math.PI * i) / uSeg;
      const co = Math.cos(omega), so = Math.sin(omega);
      let x = rx * co;
      let z = rz * so;
      // 分叉：过根干后各分支向不同方向偏移并分别收尖
      if (t > spec.trunkRatio) {
        const k = (t - spec.trunkRatio) / (1 - spec.trunkRatio);
        // 用角度选择最近分支，形成融合的分叉外形
        let bx = 0, bz = 0;
        if (spec.branches > 1) {
          let best = -Infinity;
          for (const [dx, dz] of branchDirs) {
            const d = dx * co + dz * so;
            if (d > best) { best = d; bx = dx; bz = dz; }
          }
        }
        const ease = k * k * (3 - 2 * k);
        x += bx * spread * ease;
        z += bz * spread * ease;
        x *= 1 - 0.55 * k;
        z *= 1 - 0.55 * k;
      }
      // 根尖整体弯曲 + 个体微扰
      x += spec.bend[0] * t * t;
      z += spec.bend[1] * t * t;
      const noise = 1 + 0.02 * (rand() - 0.5);
      x *= noise; z *= noise;
      positions.push(x, y, z);
    }
  }
  for (let j = 0; j < hSeg; j++) {
    for (let i = 0; i < uSeg; i++) {
      const a0 = ringIndex(j, i), b0 = ringIndex(j, i + 1);
      const c0 = ringIndex(j + 1, i), d0 = ringIndex(j + 1, i + 1);
      indices.push(a0, c0, b0, b0, c0, d0);
    }
  }
  // 根尖封口
  const tipCenter = positions.length / 3;
  positions.push(spec.bend[0], tipY, spec.bend[1]);
  const last = hSeg * (uSeg + 1);
  for (let i = 0; i < uSeg; i++) indices.push(tipCenter, last + i, last + i + 1);
  return makeMesh(Float32Array.from(positions), Uint32Array.from(indices));
}

/** 由局部冠网格顶点估计包围球半径（含牙根预留长度） */
export function boundsRadiusWithRoot(crown: MeshData, rootLength: number): number {
  let r = 0;
  for (let i = 0; i < crown.positions.length; i += 3) {
    r = Math.max(r, v3.len([crown.positions[i], crown.positions[i + 1], crown.positions[i + 2]]));
  }
  return Math.max(r, rootLength * 0.9);
}
