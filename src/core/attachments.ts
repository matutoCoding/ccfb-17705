// 附件（实体小凸起）与牙套偏移壳体生成
// 附件局部坐标与牙冠一致：x=近远中，y=长轴，z=颊(+)舌(-)
import type { Attachment, MeshData, Pose, ToothDef, Vec3 } from './types';
import { makeMesh, offsetMesh, q } from './math';

function maxAbsZ(m: MeshData): number {
  let r = 0;
  for (let i = 2; i < m.positions.length; i += 3) r = Math.max(r, Math.abs(m.positions[i]));
  return r;
}

function box(w: number, h: number, d: number): MeshData {
  const x = w / 2, y = h / 2;
  const corners: Vec3[] = [
    [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0],
    [-x, -y, d], [x, -y, d], [x, y, d], [-x, y, d],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return makeMesh(Float32Array.from(corners.flat()), Uint32Array.from(faces.flat()));
}

function beveledBox(w: number, h: number, d: number): MeshData {
  // 激活斜面：顶面比底面收窄 30%
  const x0 = w / 2, y0 = h / 2, x1 = w * 0.35, y1 = h * 0.35;
  const bottom: Vec3[] = [[-x0, -y0, 0], [x0, -y0, 0], [x0, y0, 0], [-x0, y0, 0]];
  const top: Vec3[] = [[-x1, -y1, d], [x1, -y1, d], [x1, y1, d], [-x1, y1, d]];
  const positions = [...bottom, ...top].flat();
  const indices: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    indices.push(i, j, 4 + j, i, 4 + j, 4 + i);
  }
  indices.push(4, 5, 6, 4, 6, 7);
  indices.push(0, 2, 1, 0, 3, 2);
  return makeMesh(Float32Array.from(positions), Uint32Array.from(indices));
}

function ellipsoid(w: number, h: number, d: number): MeshData {
  const uSeg = 18, vSeg = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  const ring = (j: number, i: number) => j * (uSeg + 1) + i;
  for (let j = 0; j <= vSeg; j++) {
    const eta = -Math.PI / 2 + (Math.PI * j) / vSeg;
    for (let i = 0; i <= uSeg; i++) {
      const omega = (2 * Math.PI * i) / uSeg;
      positions.push(
        (w / 2) * Math.cos(eta) * Math.cos(omega),
        (h / 2) * Math.cos(eta) * Math.sin(omega),
        d * (Math.sin(eta) * 0.5 + 0.5), // 底面落在 z=0
      );
    }
  }
  for (let j = 0; j < vSeg; j++) {
    for (let i = 0; i < uSeg; i++) {
      const a = ring(j, i), b = ring(j, i + 1), c = ring(j + 1, i), dd = ring(j + 1, i + 1);
      indices.push(a, c, b, b, c, dd);
    }
  }
  return makeMesh(Float32Array.from(positions), Uint32Array.from(indices));
}

/** 附件实体网格（牙冠局部坐标，已贴在颊/舌面上） */
export function buildAttachmentMesh(tooth: ToothDef, att: Attachment): MeshData {
  const [w, h, d] = att.size;
  const base = att.kind === 'ellipsoid' ? ellipsoid(w, h, d) : att.kind === 'beveled' ? beveledBox(w, h, d) : box(w, h, d);
  const faceSign = att.face === 'buccal' ? 1 : -1;
  const surfaceZ = faceSign * maxAbsZ(tooth.crown);
  const positions = new Float32Array(base.positions.length);
  for (let i = 0; i < base.positions.length; i += 3) {
    positions[i] = base.positions[i];
    positions[i + 1] = base.positions[i + 1] + att.axialOffset;
    // 舌面附件向 -z 方向生长
    positions[i + 2] = surfaceZ + (att.face === 'buccal' ? base.positions[i + 2] : -base.positions[i + 2]);
  }
  const normals = new Float32Array(base.normals.length);
  for (let i = 0; i < base.normals.length; i += 3) {
    normals[i] = base.normals[i];
    normals[i + 1] = base.normals[i + 1];
    normals[i + 2] = base.normals[i + 2] * faceSign;
  }
  return { positions, normals, indices: base.indices.slice() };
}

function transformLocal(m: MeshData, pose: Pose): MeshData {
  const n = m.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = q.rotateVec(pose.q, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
    positions[i * 3] = p[0] + pose.t[0];
    positions[i * 3 + 1] = p[1] + pose.t[1];
    positions[i * 3 + 2] = p[2] + pose.t[2];
    normals.set(q.rotateVec(pose.q, [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]]), i * 3);
  }
  return { positions, normals, indices: m.indices.slice() };
}

function mergeParts(parts: MeshData[]): MeshData {
  let vc = 0, ic = 0;
  for (const m of parts) { vc += m.positions.length / 3; ic += m.indices.length; }
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const indices = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const m of parts) {
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.positions.length / 3;
    io += m.indices.length;
  }
  return { positions, normals, indices };
}

/**
 * 单步牙套预览：该步所有牙冠（含附件）合并后沿法线整体偏移形成壳体。
 * offset 为牙套与牙面的间隙（mm），常用 0.25~0.75。
 */
export function buildAlignerShell(teeth: ToothDef[], poses: Map<number, Pose>, offset: number): MeshData {
  const parts: MeshData[] = [];
  for (const t of [...teeth].sort((a, b) => a.fdi - b.fdi)) {
    const pose = poses.get(t.fdi)!;
    parts.push(offsetMesh(transformLocal(t.crown, pose), offset));
    for (const att of t.attachments) {
      parts.push(transformLocal(buildAttachmentMesh(t, att), pose));
    }
  }
  return mergeParts(parts);
}
