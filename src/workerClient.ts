// Worker RPC 封装：请求序号 + Promise，结构化克隆自动携带 TypedArray
import ComputeWorker from './compute.worker?worker';
import type { WorkerRequest, WorkerResponse } from './core/workerProtocol';

/** 联合类型上的分布式 Omit（普通 Omit 对 union 不逐成员生效） */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<WorkerRequest, 'id'>;

export class ComputeClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new ComputeWorker();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.kind === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message));
      this.pending.clear();
    };
  }

  private call(req: RequestBody): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  runSegment(jaw: import('./core/types').JawType, mesh: import('./core/types').MeshData) {
    return this.call({ kind: 'segment', jaw, mesh }) as Promise<{ kind: 'segment'; id: number; segmentation: import('./core/types').Segmentation }>;
  }
  runPlan(teeth: import('./core/types').ToothDef[], limits: import('./core/types').StepLimits) {
    return this.call({ kind: 'plan', teeth, limits }) as Promise<{ kind: 'plan'; id: number; plan: import('./core/types').StepPlan }>;
  }
  runCollisions(upper: import('./core/types').ToothDef[], lower: import('./core/types').ToothDef[], plan: import('./core/types').StepPlan, threshold: number) {
    return this.call({ kind: 'collisions', upper, lower, plan, threshold }) as Promise<{ kind: 'collisions'; id: number; collisions: import('./core/types').StepCollision[] }>;
  }
  runOcclusion(
    upper: import('./core/types').ToothDef[], lower: import('./core/types').ToothDef[],
    upperPoses: [number, import('./core/types').Pose][], lowerPoses: [number, import('./core/types').Pose][],
    mode: import('./core/types').OcclusionResult['mode'], contactDistance: number,
  ) {
    return this.call({ kind: 'occlusion', upper, lower, upperPoses, lowerPoses, mode, contactDistance }) as Promise<{ kind: 'occlusion'; id: number; result: import('./core/types').OcclusionResult }>;
  }
}
