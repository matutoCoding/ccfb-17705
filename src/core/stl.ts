// STL 读写：二进制 STL 与 ASCII STL，导入后面积加权重算法线
import type { MeshData } from './types';
import { recomputeNormals } from './math';

export function parseSTL(buffer: ArrayBuffer): MeshData {
  const head = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  const ascii = isAsciiSTL(head);
  if (ascii) return parseAscii(new TextDecoder().decode(buffer));
  return parseBinary(buffer);
}

function isAsciiSTL(head: Uint8Array): boolean {
  const s = String.fromCharCode(...head).trimStart().toLowerCase();
  return s.startsWith('solid') && !looksBinary(head);
}

function looksBinary(head: Uint8Array): boolean {
  // 二进制 STL 头部 80 字节通常含 NUL 或非打印字节
  return head.some((b) => b === 0 || (b < 9 && b !== 0));
}

function parseBinary(buffer: ArrayBuffer): MeshData {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buffer.byteLength < expected - 4) {
    throw new Error(`STL 长度不匹配：声明 ${triCount} 个三角面，文件过短`);
  }
  // 二进制 STL 不共享顶点，按坐标量化合并以获得邻接关系（量化 1e-5 mm）
  const positions: number[] = [];
  const indices: number[] = [];
  const cache = new Map<string, number>();
  let offset = 84;
  const quant = 1e5;
  const intern = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * quant)},${Math.round(y * quant)},${Math.round(z * quant)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const idx = positions.length / 3;
    positions.push(x, y, z);
    cache.set(key, idx);
    return idx;
  };
  for (let t = 0; t < triCount; t++) {
    // 跳过 12 字节面法线
    offset += 12;
    const a = intern(dv.getFloat32(offset, true), dv.getFloat32(offset + 4, true), dv.getFloat32(offset + 8, true));
    const b = intern(dv.getFloat32(offset + 12, true), dv.getFloat32(offset + 16, true), dv.getFloat32(offset + 20, true));
    const c = intern(dv.getFloat32(offset + 24, true), dv.getFloat32(offset + 28, true), dv.getFloat32(offset + 32, true));
    indices.push(a, b, c);
    offset += 36 + 2; // 3 顶点 + 属性字节
  }
  const mesh: MeshData = {
    positions: Float32Array.from(positions),
    normals: new Float32Array(0),
    indices: Uint32Array.from(indices),
  };
  mesh.normals = recomputeNormals(mesh);
  return mesh;
}

function parseAscii(text: string): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const cache = new Map<string, number>();
  const quant = 1e5;
  const verts: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/);
    if (!m) continue;
    verts.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  const intern = (v: number[]): number => {
    const key = `${Math.round(v[0] * quant)},${Math.round(v[1] * quant)},${Math.round(v[2] * quant)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const idx = positions.length / 3;
    positions.push(v[0], v[1], v[2]);
    cache.set(key, idx);
    return idx;
  };
  for (let i = 0; i + 2 < verts.length; i += 3) {
    indices.push(intern(verts[i]), intern(verts[i + 1]), intern(verts[i + 2]));
  }
  const mesh: MeshData = {
    positions: Float32Array.from(positions),
    normals: new Float32Array(0),
    indices: Uint32Array.from(indices),
  };
  mesh.normals = recomputeNormals(mesh);
  return mesh;
}

/** 导出二进制 STL（演示“导回技工所格式”用） */
export function writeBinarySTL(mesh: MeshData): ArrayBuffer {
  const triCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3], ib = mesh.indices[t * 3 + 1], ic = mesh.indices[t * 3 + 2];
    // 面法线
    const n = faceNormal(mesh, ia, ib, ic);
    dv.setFloat32(offset, n[0], true); dv.setFloat32(offset + 4, n[1], true); dv.setFloat32(offset + 8, n[2], true);
    offset += 12;
    for (const vi of [ia, ib, ic]) {
      dv.setFloat32(offset, mesh.positions[vi * 3], true);
      dv.setFloat32(offset + 4, mesh.positions[vi * 3 + 1], true);
      dv.setFloat32(offset + 8, mesh.positions[vi * 3 + 2], true);
      offset += 12;
    }
    dv.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

function faceNormal(mesh: MeshData, a: number, b: number, c: number): [number, number, number] {
  const p = mesh.positions;
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
