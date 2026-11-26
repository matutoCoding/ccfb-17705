// IndexedDB 病例存储：结构化克隆原生支持 TypedArray，Map 需手动转数组
import type { CaseRecord, MeshData, Segmentation } from './core/types';

const DB_NAME = 'aligner-review-db';
const DB_VERSION = 1;
const STORE = 'cases';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      }),
  );
}

// ---- Map <-> 数组（Segmentation.seeds） ----
function encodeSeg(seg: Segmentation | null | undefined): unknown {
  if (!seg) return null;
  return {
    labels: seg.labels,
    curvature: seg.curvature,
    seeds: [...seg.seeds.entries()],
  };
}

function decodeSeg(raw: unknown): Segmentation | null {
  if (!raw) return null;
  const r = raw as { labels: Int32Array; curvature: Float32Array; seeds: [number, number][] };
  return { labels: r.labels, curvature: r.curvature, seeds: new Map(r.seeds) };
}

/** 存库前深拷贝并编码（不改动内存中的活动对象） */
function encodeCase(c: CaseRecord): CaseRecord {
  const clone = structuredClone(c);
  if (clone.rawScan?.segmentation) {
    const seg = encodeSeg(clone.rawScan.segmentation) as Segmentation;
    clone.rawScan = { ...clone.rawScan, segmentation: seg };
  }
  return clone;
}

function decodeCase(raw: unknown): CaseRecord {
  const c = raw as CaseRecord;
  if (c.rawScan?.segmentation) {
    c.rawScan = { ...c.rawScan, segmentation: decodeSeg(c.rawScan.segmentation) };
  }
  return c;
}

export const storage = {
  async list(): Promise<CaseRecord[]> {
    const rows = await tx('readonly', (s) => s.getAll() as IDBRequest<CaseRecord[]>);
    return rows.map(decodeCase).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async get(id: string): Promise<CaseRecord | undefined> {
    const raw = await tx('readonly', (s) => s.get(id) as IDBRequest<CaseRecord | undefined>);
    return raw ? decodeCase(raw) : undefined;
  },
  async save(c: CaseRecord): Promise<void> {
    c.updatedAt = Date.now();
    await tx('readwrite', (s) => s.put(encodeCase(c)) as IDBRequest<IDBValidKey>);
  },
  async remove(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  },
};

/** 网格 -> 可转移的纯缓冲（导出场景使用） */
export function meshBuffers(m: MeshData): { positions: ArrayBuffer; normals: ArrayBuffer; indices: ArrayBuffer } {
  return {
    positions: m.positions.buffer as ArrayBuffer,
    normals: m.normals.buffer as ArrayBuffer,
    indices: m.indices.buffer as ArrayBuffer,
  };
}
