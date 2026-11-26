// 40 步临床量级用例：构造 ~6-8mm 的真实目标位移，验证步数与限值
import { generateCrowdedCase } from '../src/core/caseGenerator';
import { buildPlan } from '../src/core/planning';
import { q, v3 } from '../src/core/math';
import { DEFAULT_LIMITS } from '../src/core/types';

const { record } = generateCrowdedCase('临床量级', 8888);
let movedTeeth = 0;
for (const t of [...record.upper.teeth, ...record.lower.teeth]) {
  if (Math.abs(t.archIndex) > 4) {
    // 后牙不动
    t.targetPose = { t: [...t.pose.t], q: [...t.pose.q] };
    continue;
  }
  // 前牙区每颗给一个确定性的平移（沿颊向 5-7mm）+ 小角度扭转
  const shift = 5 + (Math.abs(t.archIndex) * 0.4);
  const buccal: [number, number, number] = t.jaw === 'upper' ? [0, 0, 1] : [0, 0, -1];
  t.targetPose = {
    t: v3.add(t.pose.t, v3.scale(buccal, shift)),
    q: q.mul(q.fromAxisAngle([0, 1, 0], (6 * Math.PI) / 180), t.pose.q),
  };
  movedTeeth++;
}

const plan = buildPlan([...record.upper.teeth, ...record.lower.teeth], DEFAULT_LIMITS);
let maxT = 0, maxR = 0;
for (const row of plan.steps) for (const s of row) {
  maxT = Math.max(maxT, s.stepMove);
  maxR = Math.max(maxR, s.stepRotate);
}
console.log(`移动牙数=${movedTeeth} 步数=${plan.stepCount} 最大单步平移=${maxT.toFixed(4)}mm 最大单步旋转=${maxR.toFixed(4)}°`);
if (plan.stepCount <= 40 && maxT <= 0.25 + 1e-9 && maxR <= 2 + 1e-9) {
  console.log('✓ 40 步内方案满足全部限值');
} else {
  console.error('✗ 超出 40 步或限值');
  process.exit(1);
}
