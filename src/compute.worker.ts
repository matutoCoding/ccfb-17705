// 计算 Worker：分割 / 切步 / 碰撞 / 咬合，保证主线程帧率不受影响
import { autoSegment } from './core/segmentation';
import { buildPlan } from './core/planning';
import { checkOcclusion, computePlanCollisions } from './core/collision';
import type { WorkerRequest, WorkerResponse } from './core/workerProtocol';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    let res: WorkerResponse;
    switch (req.kind) {
      case 'segment':
        res = { kind: 'segment', id: req.id, segmentation: autoSegment(req.mesh, req.jaw) };
        break;
      case 'plan':
        res = { kind: 'plan', id: req.id, plan: { ...buildPlan(req.teeth, req.limits), createdAt: Date.now() } };
        break;
      case 'collisions': {
        const collisions = computePlanCollisions(req.upper, req.lower, req.plan, req.threshold);
        res = { kind: 'collisions', id: req.id, collisions };
        break;
      }
      case 'occlusion': {
        const result = checkOcclusion(
          req.upper, req.lower,
          new Map(req.upperPoses), new Map(req.lowerPoses),
          req.mode, { contactDistance: req.contactDistance },
        );
        res = { kind: 'occlusion', id: req.id, result };
        break;
      }
    }
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ kind: 'error', id: req.id, message: (err as Error).message } as WorkerResponse);
  }
};
