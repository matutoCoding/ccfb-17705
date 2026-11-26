// 确定性数学库：vec3 / quat / mat4，所有运算无隐式顺序依赖
import type { MeshData, Pose, Quat, Vec3 } from './types';

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3): number => v3.len(v3.sub(a, b)),
  norm(a: Vec3): Vec3 {
    const l = v3.len(a);
    return l < 1e-12 ? [0, 0, 0] : v3.scale(a, 1 / l);
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  neg: (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]],
  copy: (a: Vec3): Vec3 => [a[0], a[1], a[2]],
  zero: (): Vec3 => [0, 0, 0],
};

export const q = {
  identity(): Quat {
    return [0, 0, 0, 1];
  },
  /** 轴角（轴必须归一化，角度弧度） */
  fromAxisAngle(axis: Vec3, rad: number): Quat {
    const h = rad * 0.5;
    const s = Math.sin(h);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
  },
  mul(a: Quat, b: Quat): Quat {
    // a * b，先 b 后 a
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  conj(a: Quat): Quat {
    return [-a[0], -a[1], -a[2], a[3]];
  },
  norm(a: Quat): Quat {
    const l = Math.hypot(a[0], a[1], a[2], a[3]);
    if (l < 1e-12) return q.identity();
    return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
  },
  rotateVec(a: Quat, v: Vec3): Vec3 {
    // q * v * q^-1 的展开形式
    const [x, y, z, w] = a;
    const ux = x, uy = y, uz = z;
    const uv = v3.cross([ux, uy, uz], v);
    const uuv = v3.cross([ux, uy, uz], uv);
    return [
      v[0] + 2 * (w * uv[0] + uuv[0]),
      v[1] + 2 * (w * uv[1] + uuv[1]),
      v[2] + 2 * (w * uv[2] + uuv[2]),
    ];
  },
  /** 两个单位四元数夹角（度），结果 ∈ [0,180] */
  angleDeg(a: Quat, b: Quat): number {
    const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
    return (2 * Math.acos(d) * 180) / Math.PI;
  },
  /** 球面线性插值，t∈[0,1]，走最短弧 */
  slerp(a: Quat, b: Quat, t: number): Quat {
    let [x, y, z, w] = b;
    let cos = a[0] * x + a[1] * y + a[2] * z + a[3] * w;
    if (cos < 0) {
      cos = -cos;
      x = -x; y = -y; z = -z; w = -w;
    }
    if (cos > 0.9995) {
      // 极小角度用归一化线性插值，数值更稳
      return q.norm([
        a[0] + t * (x - a[0]),
        a[1] + t * (y - a[1]),
        a[2] + t * (z - a[2]),
        a[3] + t * (w - a[3]),
      ]);
    }
    const theta0 = Math.acos(cos);
    const sinTheta = Math.sin(theta0);
    const theta = theta0 * t;
    const s0 = Math.cos(theta) - (cos * Math.sin(theta)) / sinTheta;
    const s1 = Math.sin(theta) / sinTheta;
    return [
      s0 * a[0] + s1 * x,
      s0 * a[1] + s1 * y,
      s0 * a[2] + s1 * z,
      s0 * a[3] + s1 * w,
    ];
  },
  /** 由两组正交基构造：from 坐标系旋转到 to 坐标系（列基向量） */
  fromBasis(from: [Vec3, Vec3, Vec3], to: [Vec3, Vec3, Vec3]): Quat {
    // 旋转矩阵 R = To * From^T（两组都是正交基）
    const m: number[] = [];
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        m[row * 4 + col] =
          to[0][row] * from[0][col] + to[1][row] * from[1][col] + to[2][row] * from[2][col];
      }
      m[3 * 4 + col] = 0;
    }
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    return mat4.getQuat(m as unknown as Float32Array);
  },
};

/** 列主序 4x4，与 WebGL 一致 */
export const mat4 = {
  identity(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  fromPose(p: Pose): Float32Array {
    const [x, y, z, w] = p.q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const m = new Float32Array(16);
    m[0] = 1 - (yy + zz); m[1] = xy + wz;       m[2] = xz - wy;       m[3] = 0;
    m[4] = xy - wz;       m[5] = 1 - (xx + zz); m[6] = yz + wx;       m[7] = 0;
    m[8] = xz + wy;       m[9] = yz - wx;       m[10] = 1 - (xx + yy); m[11] = 0;
    m[12] = p.t[0]; m[13] = p.t[1]; m[14] = p.t[2]; m[15] = 1;
    return m;
  },
  mul(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },
  perspective(fovyRad: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) * nf; m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  },
  lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
    const z = v3.norm(v3.sub(eye, center));
    const x = v3.norm(v3.cross(up, z));
    const y = v3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    m[15] = 1;
    return m;
  },
  getQuat(m: ArrayLike<number>): Quat {
    const t = m[0] + m[5] + m[10];
    let out: Quat;
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      out = [(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, 0.25 * s];
    } else if (m[0] > m[5] && m[0] > m[10]) {
      const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
      out = [0.25 * s, (m[4] + m[1]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s];
    } else if (m[5] > m[10]) {
      const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
      out = [(m[4] + m[1]) / s, 0.25 * s, (m[9] + m[6]) / s, (m[8] - m[2]) / s];
    } else {
      const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
      out = [(m[8] + m[2]) / s, (m[9] + m[6]) / s, 0.25 * s, (m[1] - m[4]) / s];
    }
    return q.norm(out);
  },
  transformPoint(m: Float32Array, p: Vec3): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const inv = 1 / w;
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) * inv,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) * inv,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) * inv,
    ];
  },
};

export function meshVertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

/** 重新计算平滑法线（面积加权），确定性：按索引顺序累加 */
export function recomputeNormals(m: MeshData): Float32Array {
  const n = meshVertexCount(m);
  const normals = new Float32Array(n * 3);
  const { positions: p, indices: idx } = m;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vi of [idx[i], idx[i + 1], idx[i + 2]]) {
      normals[vi * 3] += nx;
      normals[vi * 3 + 1] += ny;
      normals[vi * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (l > 1e-12) {
      normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
    }
  }
  return normals;
}

export function makeMesh(positions: Float32Array, indices: Uint32Array): MeshData {
  const m: MeshData = { positions, normals: new Float32Array(0), indices };
  m.normals = recomputeNormals(m);
  return m;
}

/** 网格整体变换（返回新网格） */
export function transformMesh(m: MeshData, pose: Pose): MeshData {
  const n = meshVertexCount(m);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const rot = q.rotateVec(pose.q, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
    positions[i * 3] = rot[0] + pose.t[0];
    positions[i * 3 + 1] = rot[1] + pose.t[1];
    positions[i * 3 + 2] = rot[2] + pose.t[2];
  }
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const rn = q.rotateVec(pose.q, [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]]);
    normals.set(rn, i * 3);
  }
  return { positions, normals, indices: m.indices };
}

/** 合并多个网格（保留顶点偏移映射），返回合并网格与各子网格的顶点/索引偏移 */
export function mergeMeshes(parts: MeshData[]): { mesh: MeshData; vertexOffsets: number[]; indexOffsets: number[] } {
  let vc = 0, tc = 0;
  const vertexOffsets: number[] = [];
  const indexOffsets: number[] = [];
  for (const m of parts) {
    vertexOffsets.push(vc);
    indexOffsets.push(tc);
    vc += meshVertexCount(m);
    tc += m.indices.length;
  }
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const indices = new Uint32Array(tc);
  let vo = 0, io = 0;
  for (const m of parts) {
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += meshVertexCount(m);
    io += m.indices.length;
  }
  return { mesh: { positions, normals, indices }, vertexOffsets, indexOffsets };
}

/** 沿法线膨胀（壳体/牙套预览用），offset mm */
export function offsetMesh(m: MeshData, offset: number): MeshData {
  const n = meshVertexCount(m);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = m.positions[i * 3] + m.normals[i * 3] * offset;
    positions[i * 3 + 1] = m.positions[i * 3 + 1] + m.normals[i * 3 + 1] * offset;
    positions[i * 3 + 2] = m.positions[i * 3 + 2] + m.normals[i * 3 + 2] * offset;
  }
  return { positions, normals: m.normals.slice(), indices: m.indices.slice() };
}

/** 轴对齐包围盒 */
export function boundingBox(m: MeshData): { min: Vec3; max: Vec3; center: Vec3; radius: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m.positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const center = v3.scale(v3.add(min, max), 0.5);
  let radius = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    radius = Math.max(radius, v3.dist([m.positions[i], m.positions[i + 1], m.positions[i + 2]], center));
  }
  return { min, max, center, radius };
}

/** 确定性 PRNG（mulberry32），同种子序列完全一致 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32 位字符串哈希（指纹用，FNV-1a） */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
