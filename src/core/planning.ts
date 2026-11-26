// 分步引擎：纯函数、确定性。同输入（初始/目标位姿 + 限值）两次结果位级一致。
import type {
  MeshData, Pose, Quat, ReportRow, StepLimits, StepPlan, StepToothState, ToothDef, Vec3,
} from './types';
import { DEFAULT_LIMITS } from './types';
import { hash32, q, v3 } from './math';
import { layoutOnArch } from './layout';

const DEG = Math.PI / 180;

/** 单颗牙需要的步数：平移/旋转分别向上取整后取大值，至少 1 步（即使不动） */
export function neededSteps(a: Pose, b: Pose, limits: StepLimits): number {
  const dist = v3.dist(a.t, b.t);
  const ang = q.angleDeg(a.q, b.q);
  const byT = dist <= 1e-9 ? 0 : Math.ceil(dist / limits.maxTranslation - 1e-9);
  const byR = ang <= 1e-9 ? 0 : Math.ceil(ang / limits.maxRotationDeg - 1e-9);
  return Math.max(1, byT, byR);
}

function poseAt(a: Pose, b: Pose, k: number, n: number): Pose {
  const t = n === 0 ? 0 : k / n;
  return { t: v3.lerp(a.t, b.t, t), q: q.slerp(a.q, b.q, t) };
}

/**
 * 自动切步。
 * 规则：
 *  1. 每颗牙按自身总位移求步数 n_i，整体步数 N=max(n_i)，所有牙同步分 N 段；
 *  2. 因此每颗牙每步位移 = 总量/n_i × (n_i/N)，天然不超限；
 *  3. N > limits.maxSteps 时，所有牙仍按 N 段切（保证限值不被突破），超限步骤打标记；
 *  4. 浮点插值固定 k/N 形式，集合迭代按 fdi 升序，保证两次结果完全一致。
 */
export function buildPlan(teeth: ToothDef[], limits: StepLimits = DEFAULT_LIMITS): StepPlan {
  const ordered = [...teeth].sort((a, b) => a.fdi - b.fdi);
  const perToothSteps: Record<number, number> = {};
  const fingerprints: string[] = [];
  let N = 1;
  for (const t of ordered) {
    const n = neededSteps(t.pose, t.targetPose, limits);
    perToothSteps[t.fdi] = n;
    N = Math.max(N, n);
    fingerprints.push(
      `${t.fdi}:${t.pose.t.map((x) => x.toFixed(6)).join(',')}:` +
      `${t.pose.q.map((x) => x.toFixed(6)).join(',')}->` +
      `${t.targetPose.t.map((x) => x.toFixed(6)).join(',')}:` +
      `${t.targetPose.q.map((x) => x.toFixed(6)).join(',')}`,
    );
  }
  const fingerprint = hash32(fingerprints.join('|') + `@${limits.maxTranslation}/${limits.maxRotationDeg}/${limits.maxSteps}`);

  const steps: StepToothState[][] = [];
  const overLimitSteps = new Set<number>();
  const overLimitTeeth = new Set<number>();

  for (let k = 1; k <= N; k++) {
    const row: StepToothState[] = [];
    const prevK = k - 1;
    for (const t of ordered) {
      const cur = poseAt(t.pose, t.targetPose, k, N);
      const prev = poseAt(t.pose, t.targetPose, prevK, N);
      const stepMove = v3.dist(prev.t, cur.t);
      const stepRotate = q.angleDeg(prev.q, cur.q);
      // 限值校验（带 1e-6 容差消除浮点噪声）
      const over = stepMove > limits.maxTranslation + 1e-6 || stepRotate > limits.maxRotationDeg + 1e-6;
      if (over) {
        overLimitSteps.add(k);
        overLimitTeeth.add(t.fdi);
      }
      if (k > limits.maxSteps) {
        overLimitSteps.add(k);
        overLimitTeeth.add(t.fdi);
      }
      row.push({
        fdi: t.fdi,
        t: cur.t,
        q: cur.q,
        stepMove,
        stepRotate,
        overLimit: over || k > limits.maxSteps,
      });
    }
    steps.push(row);
  }

  return {
    limits,
    stepCount: N,
    perToothSteps,
    steps,
    collisions: [],
    overLimitSteps: [...overLimitSteps].sort((a, b) => a - b),
    overLimitTeeth: [...overLimitTeeth].sort((a, b) => a - b),
    createdAt: 0, // 由调用方打时间戳，保持引擎纯函数
    fingerprint,
  };
}

/** 取某一步所有牙的位姿（step=0 返回初始位姿） */
export function posesAtStep(teeth: ToothDef[], plan: StepPlan, step: number): Map<number, Pose> {
  const out = new Map<number, Pose>();
  const k = Math.max(0, Math.min(plan.stepCount, step));
  for (const t of teeth) {
    if (k === 0) {
      out.set(t.fdi, { t: [...t.pose.t] as Vec3, q: [...t.pose.q] as Quat });
    } else {
      const s = plan.steps[k - 1].find((r) => r.fdi === t.fdi)!;
      out.set(s.fdi, { t: [...s.t] as Vec3, q: [...s.q] as Quat });
    }
  }
  return out;
}

/** 切步后对每颗牙的汇总（审核报告用） */
export function summarizeTeeth(teeth: ToothDef[], plan: StepPlan): ReportRow[] {
  return [...teeth]
    .sort((a, b) => a.fdi - b.fdi)
    .map((t) => {
      const totalTranslation = v3.dist(t.pose.t, t.targetPose.t);
      const totalRotation = q.angleDeg(t.pose.q, t.targetPose.q);
      let maxStepMove = 0, maxStepRotate = 0;
      const riskSteps: number[] = [];
      for (let k = 1; k <= plan.stepCount; k++) {
        const s = plan.steps[k - 1].find((r) => r.fdi === t.fdi)!;
        maxStepMove = Math.max(maxStepMove, s.stepMove);
        maxStepRotate = Math.max(maxStepRotate, s.stepRotate);
        if (s.overLimit) riskSteps.push(k);
      }
      const collisionRisks = new Set<number>();
      for (const c of plan.collisions) {
        if (c.hasAlarm && c.pairs.some((p) => p.fdiA === t.fdi || p.fdiB === t.fdi)) collisionRisks.add(c.step);
      }
      return {
        fdi: t.fdi, name: t.name,
        totalTranslation, totalRotation,
        maxStepMove, maxStepRotate,
        riskSteps: [...new Set([...riskSteps, ...collisionRisks])].sort((a, b) => a - b),
      };
    });
}

/**
 * 沿牙弓曲线自动排牙：按每颗牙实际冠宽做弧长布局（邻接不重叠），
 * 目标位姿吸附到理想弓，高度保持现状。
 */
export function autoArrangeTargets(teeth: ToothDef[], halfWidth: number, depth: number, spacing: number): ToothDef[] {
  const widths = new Map<number, number>();
  for (const t of teeth) {
    const w = maxAbsX(t.crown) * 2;
    widths.set(Math.abs(t.archIndex), w);
  }
  const layout = layoutOnArch({ halfWidth, depth, spacing }, widths, 1.0, 0.35);
  return teeth.map((t) => {
    const lp = layout.get(t.archIndex)!;
    const buccal = t.jaw === 'upper' ? lp.outward : v3.neg(lp.outward);
    const rootDir: Vec3 = t.jaw === 'upper' ? [0, -1, 0] : [0, 1, 0];
    const target: Pose = {
      t: [lp.x, t.targetPose.t[1], lp.z],
      q: q.fromBasis(
        [v3.neg(lp.tangent), buccal, rootDir],
        [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
      ),
    };
    return { ...t, targetPose: target };
  });
}

function maxAbsX(m: import('./types').MeshData): number {
  let r = 0;
  for (let i = 0; i < m.positions.length; i += 3) r = Math.max(r, Math.abs(m.positions[i]));
  return r;
}

/** 把单颗牙的手动平移/旋转累加到目标位姿（平移与转矩分量分开返回供 UI 显示） */
export function applyTargetDelta(
  tooth: ToothDef,
  deltaTranslation: Vec3,
  deltaRotationAxis: Vec3,
  deltaRotationDeg: number,
): ToothDef {
  const dq = q.fromAxisAngle(v3.norm(deltaRotationAxis), deltaRotationDeg * DEG);
  return {
    ...tooth,
    targetPose: {
      t: v3.add(tooth.targetPose.t, deltaTranslation),
      q: q.norm(q.mul(dq, tooth.targetPose.q)),
    },
  };
}

/** 平移分量与转矩（旋转）分量，供“分开显示” */
export function targetComponents(tooth: ToothDef): { translation: Vec3; translationMag: number; rotationDeg: number } {
  const translation = v3.sub(tooth.targetPose.t, tooth.pose.t);
  return {
    translation,
    translationMag: v3.len(translation),
    rotationDeg: q.angleDeg(tooth.pose.q, tooth.targetPose.q),
  };
}

export function maxMeshExtent(meshes: MeshData[]): number {
  let m = 0;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      m = Math.max(m, Math.abs(mesh.positions[i]), Math.abs(mesh.positions[i + 1]), Math.abs(mesh.positions[i + 2]));
    }
  }
  return m;
}
