// Worker 消息协议：所有重计算任务的请求/响应类型，ArrayBuffer 走 transfer
import type {
  JawType, MeshData, OcclusionResult, Pose, Segmentation, StepCollision, StepLimits, StepPlan, ToothDef,
} from './types';

export type WorkerRequest =
  | { kind: 'segment'; id: number; jaw: JawType; mesh: MeshData }
  | { kind: 'plan'; id: number; teeth: ToothDef[]; limits: StepLimits }
  | { kind: 'collisions'; id: number; upper: ToothDef[]; lower: ToothDef[]; plan: StepPlan; threshold: number }
  | { kind: 'occlusion'; id: number; upper: ToothDef[]; lower: ToothDef[]; upperPoses: [number, Pose][]; lowerPoses: [number, Pose][]; mode: OcclusionResult['mode']; contactDistance: number };

export type WorkerResponse =
  | { kind: 'segment'; id: number; segmentation: Segmentation }
  | { kind: 'plan'; id: number; plan: StepPlan }
  | { kind: 'collisions'; id: number; collisions: StepCollision[] }
  | { kind: 'occlusion'; id: number; result: OcclusionResult }
  | { kind: 'error'; id: number; message: string };

/** 收集消息里所有可转移的 ArrayBuffer（TypedArray 底层缓冲） */
export function extractTransferable(data: unknown): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (v instanceof ArrayBuffer) {
      if (!seen.has(v)) { seen.add(v); out.push(v); }
      return;
    }
    if (ArrayBuffer.isView(v)) {
      const buf = v.buffer as ArrayBuffer;
      if (!seen.has(buf)) { seen.add(buf); out.push(buf); }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v instanceof Map) { for (const x of v.values()) walk(x); return; }
    for (const key of Object.keys(v as Record<string, unknown>)) {
      walk((v as Record<string, unknown>)[key]);
    }
  };
  walk(data);
  return out;
}
