// 场景装配：把病例数据映射为渲染实例；切步只更新实例矩阵，不重建 VBO
import { Renderer, type Instance } from './renderer';
import { OrbitControls } from './orbitControls';
import { mat4, q, v3 } from './core/math';
import { posesAtStep } from './core/planning';
import { buildAlignerShell, buildAttachmentMesh } from './core/attachments';
import { buildIprMarks, iprColor, marksToPointCloud } from './core/ipr';
import type { CaseRecord, MeshData, Pose, ToothDef, Vec3 } from './core/types';
import { state } from './state';

const TOOTH_COLOR: [number, number, number] = [0.93, 0.9, 0.82];
const ROOT_COLOR: [number, number, number] = [0.78, 0.66, 0.55];
const GINGIVA_COLOR: [number, number, number] = [0.83, 0.46, 0.48];
const SELECT_COLOR: [number, number, number] = [0.35, 0.62, 0.95];
const ALARM_COLOR: [number, number, number] = [0.92, 0.25, 0.2];
const OVERLIMIT_COLOR: [number, number, number] = [0.95, 0.55, 0.15];

interface ToothSlot {
  tooth: ToothDef;
  crownId: number;
  rootId: number;
  attachmentIds: number[];
}

export class SceneManager {
  renderer: Renderer;
  controls: OrbitControls;
  private slots: ToothSlot[] = [];
  private gingivaIds: number[] = [];
  private shellId: number | null = null;
  private iprId: number | null = null;
  private raf = 0;
  private caseRef: CaseRecord | null = null;
  /** 每帧回调（页面可挂调试信息） */
  onFrame?: (step: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.controls = new OrbitControls(canvas, this.renderer.camera);
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.renderer.uploadInstances();
      this.renderer.render();
      this.onFrame?.(state.currentStep);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
  }

  /** 首次载入或病例结构变化时重建静态几何 */
  buildStatic(c: CaseRecord): void {
    this.caseRef = c;
    for (const s of this.slots) {
      this.renderer.removeMesh(s.crownId);
      this.renderer.removeMesh(s.rootId);
      for (const id of s.attachmentIds) this.renderer.removeMesh(id);
    }
    for (const id of this.gingivaIds) this.renderer.removeMesh(id);
    if (this.shellId !== null) { this.renderer.removeMesh(this.shellId); this.shellId = null; }
    if (this.iprId !== null) { this.renderer.removeMesh(this.iprId); this.iprId = null; }
    this.slots = [];
    this.gingivaIds = [];

    for (const jaw of [c.upper, c.lower]) {
      for (const tooth of jaw.teeth) {
        const crownId = this.renderer.addMesh(tooth.crown);
        const rootId = tooth.root ? this.renderer.addMesh(tooth.root) : -1;
        const attachmentIds = tooth.attachments.map((a) => this.renderer.addMesh(buildAttachmentMesh(tooth, a)));
        this.slots.push({ tooth, crownId, rootId, attachmentIds });
      }
      if (jaw.gingiva) this.gingivaIds.push(this.renderer.addMesh(jaw.gingiva.mesh));
    }
    this.renderer.frame([0, 0, 8], 125);
    this.refreshInstances();
  }

  /** 当前步位姿（含 IPR 间隙修正） */
  currentPoses(): Map<number, Pose> {
    const c = this.caseRef!;
    const all = [...c.upper.teeth, ...c.lower.teeth];
    if (!c.plan) {
      const m = new Map<number, Pose>();
      for (const t of all) m.set(t.fdi, { t: [...t.pose.t] as Vec3, q: [...t.pose.q] as QuatShim });
      return m;
    }
    return posesAtStep(all, c.plan, state.currentStep);
  }

  /** 每帧/状态变化时刷新实例矩阵与颜色（轻量，不上传几何） */
  refreshInstances(): void {
    const c = this.caseRef;
    if (!c) return;
    const poses = this.currentPoses();
    const plan = c.plan;
    const step = state.currentStep;

    // 本步碰撞报警牙位
    const alarmTeeth = new Set<number>();
    if (plan && plan.collisions[step - 1]) {
      for (const p of plan.collisions[step - 1].pairs) {
        if (p.penetration > state.collisionThreshold) {
          alarmTeeth.add(p.fdiA); alarmTeeth.add(p.fdiB);
        }
      }
    }
    const overLimitTeeth = new Set(plan?.steps[step - 1]?.filter((s) => s.overLimit).map((s) => s.fdi) ?? []);

    for (const slot of this.slots) {
      const pose = poses.get(slot.tooth.fdi)!;
      const r = this.renderer;
      r.clearInstances(slot.crownId);
      let base = TOOTH_COLOR;
      if (alarmTeeth.has(slot.tooth.fdi)) base = ALARM_COLOR;
      else if (overLimitTeeth.has(slot.tooth.fdi)) base = OVERLIMIT_COLOR;
      else if (state.selectedFdi === slot.tooth.fdi) base = SELECT_COLOR;
      const highlight = state.selectedFdi === slot.tooth.fdi ? 0.35 : 0;
      r.addInstance(slot.crownId, pose, [...base, highlight] as [number, number, number, number]);

      if (slot.rootId >= 0) {
        r.clearInstances(slot.rootId);
        if (state.showRoots) r.addInstance(slot.rootId, pose, [...ROOT_COLOR, 0] as [number, number, number, number]);
      }
      slot.attachmentIds.forEach((id, k) => {
        r.clearInstances(id);
        r.addInstance(id, pose, [0.4, 0.75, 0.95, 0] as [number, number, number, number]);
        void k;
      });
    }
    for (const id of this.gingivaIds) {
      this.renderer.clearInstances(id);
      if (state.showGingiva) {
        this.renderer.addInstance(id, { t: [0, 0, 0], q: q.identity() }, [...GINGIVA_COLOR, 0] as [number, number, number, number]);
      }
    }
    this.refreshShell(c, poses);
    this.refreshIpr(c, poses);
  }

  private refreshShell(c: CaseRecord, poses: Map<number, Pose>): void {
    if (this.shellId !== null) {
      this.renderer.removeMesh(this.shellId);
      this.shellId = null;
    }
    if (!state.showShell) return;
    const shell = buildAlignerShell([...c.upper.teeth, ...c.lower.teeth], poses, 0.5);
    this.shellId = this.renderer.addMesh(shell);
    this.renderer.addInstance(this.shellId, { t: [0, 0, 0], q: q.identity() }, [0.65, 0.82, 0.95, 0] as [number, number, number, number]);
  }

  private refreshIpr(c: CaseRecord, poses: Map<number, Pose>): void {
    if (this.iprId !== null) {
      this.renderer.removeMesh(this.iprId);
      this.iprId = null;
    }
    if (!state.showIpr || c.ipr.length === 0) return;
    const all = [...c.upper.teeth, ...c.lower.teeth];
    const poseOf = (fdi: number): Pose => poses.get(fdi)!;
    const marks = c.ipr.filter((e) => e.atStep <= Math.max(1, state.currentStep)).flatMap((e) => buildIprMarks(e, all, poseOf));
    if (marks.length === 0) return;
    const cloud = marksToPointCloud(marks, all, poseOf);
    this.iprId = this.renderer.addMesh(cloud, true);
    // 点云颜色统一用安全色梯度中的最大值着色
    const maxAmount = Math.max(...c.ipr.map((e) => e.amount));
    const col = iprColor(maxAmount, c.iprSafetyLimit);
    this.renderer.addInstance(this.iprId, { t: [0, 0, 0], q: q.identity() }, [...col, 0] as [number, number, number, number]);
  }

  /** 目标排牙页：叠加显示目标位姿的半透明“幽灵牙” */
  buildGhostTargets(): number[] {
    const c = this.caseRef!;
    const ids: number[] = [];
    for (const slot of this.slots) {
      const id = this.renderer.addMesh(slot.tooth.crown);
      this.renderer.addInstance(id, slot.tooth.targetPose, [0.3, 0.85, 0.45, 0] as [number, number, number, number]);
      ids.push(id);
    }
    return ids;
  }

  getSlot(fdi: number): ToothSlot | undefined {
    return this.slots.find((s) => s.tooth.fdi === fdi);
  }
  getSlots(): ToothSlot[] { return this.slots; }
  get caseRecord(): CaseRecord | null { return this.caseRef; }

  /** 世界坐标 -> 最近牙（用于点击拾取与画笔） */
  pickAt(clientX: number, clientY: number): { fdi: number; point: Vec3 } | null {
    const { origin, dir } = this.renderer.screenRay(clientX, clientY);
    const poses = this.currentPoses();
    let best: { fdi: number; point: Vec3; d: number } | null = null;
    for (const slot of this.slots) {
      const pose = poses.get(slot.tooth.fdi)!;
      const m = mat4.fromPose(pose);
      const idx = slot.tooth.crown.indices;
      const pos = slot.tooth.crown.positions;
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [idx[t], idx[t + 1], idx[t + 2]].map((vi) =>
          mat4.transformPoint(m, [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]),
        ) as [Vec3, Vec3, Vec3];
        const hit = rayTriLocal(origin, dir, tri);
        if (hit !== null && (!best || hit < best.d)) {
          best = { fdi: slot.tooth.fdi, d: hit, point: v3.add(origin, v3.scale(dir, hit)) };
        }
      }
    }
    return best ? { fdi: best.fdi, point: best.point } : null;
  }
}

type QuatShim = import('./core/types').Quat;

function rayTriLocal(origin: Vec3, dir: Vec3, tri: [Vec3, Vec3, Vec3]): number | null {
  const [a, b, c] = tri;
  const edge1 = v3.sub(b, a);
  const edge2 = v3.sub(c, a);
  const h = v3.cross(dir, edge2);
  const det = v3.dot(edge1, h);
  if (Math.abs(det) < 1e-7) return null;
  const f = 1 / det;
  const s = v3.sub(origin, a);
  const u = f * v3.dot(s, h);
  if (u < 0 || u > 1) return null;
  const qv = v3.cross(s, edge1);
  const vv = f * v3.dot(dir, qv);
  if (vv < 0 || u + vv > 1) return null;
  const t = f * v3.dot(edge2, qv);
  return t > 1e-7 ? t : null;
}

export function meshPlaceholder(): MeshData | null { return null; }
