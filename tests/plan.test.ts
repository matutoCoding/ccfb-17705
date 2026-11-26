// 引擎测试：确定性（两次切步位级一致）、限值（0.25mm/2°）、碰撞与 IPR 校验
// 运行：npm test
import { generateCrowdedCase, generateAlignedCase } from '../src/core/caseGenerator';
import { autoArrangeTargets, buildPlan, posesAtStep, summarizeTeeth } from '../src/core/planning';
import { computePlanCollisions, detectJawCollisions, iprAlarms } from '../src/core/collision';
import { autoSegment } from '../src/core/segmentation';
import { DEFAULT_LIMITS } from '../src/core/types';
import type { StepPlan } from '../src/core/types';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function approxEqual(a: Float32Array | number[], b: Float32Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n[1] 程序化病例生成的确定性');
{
  const a = generateCrowdedCase('甲', 12345);
  const b = generateCrowdedCase('甲', 12345);
  const c = generateCrowdedCase('甲', 999);
  const va = a.record.upper.teeth[3].crown.positions;
  const vb = b.record.upper.teeth[3].crown.positions;
  const vc = c.record.upper.teeth[3].crown.positions;
  assert(approxEqual(va, vb), '同种子牙冠网格位级一致');
  assert(!approxEqual(va, vc), '不同种子产生不同网格');
  assert(a.record.upper.teeth.length === 14 && a.record.lower.teeth.length === 14, '每颌 14 颗牙（7-7）');
  assert(a.record.upper.teeth.every((t) => t.root !== null), '每颗牙都补建了统计牙根');
}

console.log('\n[2] 自动切步的确定性与限值');
{
  const { record } = generateCrowdedCase('乙', 777);
  record.upper.teeth = autoArrangeTargets(record.upper.teeth, 29, 22, 7.1);
  record.lower.teeth = autoArrangeTargets(record.lower.teeth, 26, 20, 6.85);
  const all = [...record.upper.teeth, ...record.lower.teeth];

  const p1 = buildPlan(all, DEFAULT_LIMITS);
  const p2 = buildPlan(all, DEFAULT_LIMITS);
  assert(p1.fingerprint === p2.fingerprint, `两次切步指纹相同（${p1.fingerprint}）`);
  assert(p1.stepCount === p2.stepCount, `两次步数相同（${p1.stepCount} 步）`);

  let bitwise = true;
  for (let s = 0; s < p1.steps.length; s++) {
    for (let i = 0; i < p1.steps[s].length; i++) {
      const a = p1.steps[s][i], b = p2.steps[s][i];
      if (a.fdi !== b.fdi || a.t.some((x, k) => x !== b.t[k]) || a.q.some((x, k) => x !== b.q[k])) bitwise = false;
    }
  }
  assert(bitwise, '两步方案所有位姿位级一致（浮点完全相同）');

  let maxT = 0, maxR = 0;
  for (const row of p1.steps) for (const s of row) {
    maxT = Math.max(maxT, s.stepMove);
    maxR = Math.max(maxR, s.stepRotate);
  }
  assert(maxT <= DEFAULT_LIMITS.maxTranslation + 1e-9, `单牙单步平移 ≤ 0.25mm（实测最大 ${maxT.toFixed(4)}）`);
  assert(maxR <= DEFAULT_LIMITS.maxRotationDeg + 1e-9, `单牙单步旋转 ≤ 2°（实测最大 ${maxR.toFixed(4)}）`);

  // 每颗牙的逐段单调：首步=初始，末步=目标
  const first = posesAtStep(all, p1, 0);
  const last = posesAtStep(all, p1, p1.stepCount);
  let endpoints = true;
  for (const t of all) {
    const f = first.get(t.fdi)!, l = last.get(t.fdi)!;
    if (f.t.some((x, k) => Math.abs(x - t.pose.t[k]) > 1e-9)) endpoints = false;
    if (l.t.some((x, k) => Math.abs(x - t.targetPose.t[k]) > 1e-9)) endpoints = false;
  }
  assert(endpoints, 'step0=初始位姿，末步=目标位姿');

  const rows = summarizeTeeth(all, p1);
  assert(rows.length === all.length, '报告覆盖全部 28 颗牙');
  assert(rows.every((r) => r.maxStepMove <= 0.25 + 1e-9), '报告中的单步最大平移全部合规');
}

console.log('\n[3] 步数超限标记（maxSteps 收紧时）');
{
  const { record } = generateCrowdedCase('丙', 555);
  record.upper.teeth = autoArrangeTargets(record.upper.teeth, 29, 22, 7.1);
  record.lower.teeth = autoArrangeTargets(record.lower.teeth, 26, 20, 6.85);
  const all = [...record.upper.teeth, ...record.lower.teeth];
  const tight = { ...DEFAULT_LIMITS, maxSteps: 3 };
  const p = buildPlan(all, tight);
  assert(p.stepCount > 3, `实际需要 ${p.stepCount} 步，超过收紧的 maxSteps=3`);
  assert(p.overLimitSteps.includes(p.stepCount), '超出 maxSteps 的步骤被标记');
  // 即使超限也不能突破物理限值
  const maxT = Math.max(...p.steps.flat().map((s) => s.stepMove));
  assert(maxT <= 0.25 + 1e-9, '超限方案依然保证 0.25mm 物理限值不被突破');
}

console.log('\n[4] 碰撞引擎：拥挤病例有报警，理想排列显著更少');
{
  const crowded = generateCrowdedCase('丁', 31337);
  const aligned = generateAlignedCase('戊', 31337);
  const threshold = 0.15;

  const cp = buildPlan([...crowded.record.upper.teeth, ...crowded.record.lower.teeth], DEFAULT_LIMITS);
  const crowdedCollisions = computePlanCollisions(crowded.record.upper.teeth, crowded.record.lower.teeth, cp, threshold);
  const crowdedAlarmPairs = crowdedCollisions.reduce((n, c) => n + c.pairs.filter((p) => p.penetration > threshold).length, 0);
  assert(crowdedAlarmPairs > 0, `拥挤病例检测到碰撞报警（${crowdedAlarmPairs} 个牙对）`);

  // 初始位姿直接检测，确定性：同输入两次结果一致
  const poses = new Map(crowded.record.upper.teeth.map((t) => [t.fdi, t.pose]));
  const r1 = detectJawCollisions(crowded.record.upper.teeth, poses, { threshold });
  const r2 = detectJawCollisions(crowded.record.upper.teeth, new Map(poses), { threshold });
  assert(JSON.stringify(r1) === JSON.stringify(r2), '碰撞结果两次完全一致');
  assert(r1.every((p) => Number.isFinite(p.penetration)), '穿透深度均为有限值');

  const ap = buildPlan([...aligned.record.upper.teeth, ...aligned.record.lower.teeth], DEFAULT_LIMITS);
  const alignedCollisions = computePlanCollisions(aligned.record.upper.teeth, aligned.record.lower.teeth, ap, threshold);
  const alignedAlarmPairs = alignedCollisions.reduce((n, c) => n + c.pairs.filter((p) => p.penetration > threshold).length, 0);
  assert(alignedAlarmPairs < crowdedAlarmPairs, `理想排列报警牙对更少（${alignedAlarmPairs} < ${crowdedAlarmPairs}）`);

  // 理想排列即便有残余小接触，最大穿透也应远小于拥挤病例
  const maxPen = (cols: typeof alignedCollisions): number =>
    Math.max(0, ...cols.flatMap((c) => c.pairs.map((p) => p.penetration)));
  const crowdedMax = maxPen(crowdedCollisions);
  const alignedMax = maxPen(alignedCollisions);
  assert(alignedMax < crowdedMax, `理想排列最大穿透更小（${alignedMax.toFixed(2)} < ${crowdedMax.toFixed(2)} mm）`);
  assert(alignedMax < 1.5, `理想排列无大穿透（最大 ${alignedMax.toFixed(2)} mm < 1.5mm）`);
}

console.log('\n[5] IPR 累计安全值报警');
{
  const entries = [
    { fdiA: 11, fdiB: 12, amount: 0.3 },
    { fdiA: 12, fdiB: 11, amount: 0.3 }, // 同一邻接对，累计 0.6 > 0.5
    { fdiA: 13, fdiB: 14, amount: 0.25 },
  ];
  const alarms = iprAlarms(entries, 0.5);
  assert(alarms.length === 1 && alarms[0].pair === '11|12', '累计去釉超 0.5mm 的邻接对被报警');
  assert(Math.abs(alarms[0].total - 0.6) < 1e-9, '累计量计算正确（0.6mm）');
}

console.log('\n[6] 自动分割流水线（内置拥挤口扫）');
{
  const gen = generateCrowdedCase('己', 20261127);
  const scan = gen.scans[0].upper;
  const seg = autoSegment(scan, 'upper');
  const labels = new Set(seg.labels);
  const toothLabels = [...labels].filter((x) => x > 0);
  assert(toothLabels.length >= 12, `分水岭分出 ${toothLabels.length} 个牙位标签（目标 14，允许少量粘连）`);
  assert(labels.has(-1), '存在牙龈标签');
  // 再次分割结果一致
  const seg2 = autoSegment(scan, 'upper');
  let same = seg2.labels.length === seg.labels.length;
  for (let i = 0; same && i < seg.labels.length; i++) if (seg2.labels[i] !== seg.labels[i]) same = false;
  assert(same, '分割结果两次完全一致（确定性堆 + 固定平局规则）');
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
