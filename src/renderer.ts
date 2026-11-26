// WebGL2 渲染器：静态 VBO + 每实例模型矩阵/颜色，拖动步骤只更新实例缓冲，不重建几何
import type { MeshData, Pose, Vec3 } from './core/types';
import { mat4, v3 } from './core/math';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in mat4 aModel;   // 实例属性，占 location 2..5
layout(location=6) in vec4 aColor;  // rgb + 高亮混合系数
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColor;
void main() {
  vec4 world = aModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(aModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * world;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vColor;
uniform vec3 uEye;
uniform vec3 uLightDir;
out vec4 frag;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDir);
  float diff = max(dot(n, l), 0.0);
  float amb = 0.42;
  float rim = pow(1.0 - max(dot(n, normalize(uEye - vWorld)), 0.0), 2.5) * 0.18;
  vec3 base = vColor.rgb;
  vec3 lit = base * (amb + 0.62 * diff) + vec3(0.7, 0.85, 1.0) * rim;
  // a=1 正常着色；高亮混合系数在 vColor.a 中叠加黄色描边感
  lit = mix(lit, vec3(1.0, 0.82, 0.25), vColor.a * 0.55);
  frag = vec4(lit, 1.0);
}`;

const POINT_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in mat4 aModel;
layout(location=6) in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor;
void main() {
  // aNormal 通道在点云模式下复用为每顶点 RGB
  vec3 vertRgb = aNormal;
  vColor = vec4(mix(aColor.rgb, vertRgb, step(0.01, dot(vertRgb, vertRgb))), aColor.a);
  gl_Position = uViewProj * aModel * vec4(aPos, 1.0);
  gl_PointSize = 7.0;
}`;

const POINT_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  frag = vec4(vColor.rgb, 0.95);
}`;

export interface Instance {
  matrix: Float32Array;
  color: [number, number, number, number];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader 编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

interface MeshObject {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  nbo: WebGLBuffer;
  ibo: WebGLBuffer;
  matrixBuffer: WebGLBuffer;
  colorBuffer: WebGLBuffer;
  indexCount: number;
  instances: Instance[];
  pointMode: boolean;
  dirty: boolean;
  matrixCache: Float32Array;
  colorCache: Float32Array;
}

export interface CameraState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private pointProg: WebGLProgram;
  private objects: MeshObject[] = [];
  private uViewProj: WebGLUniformLocation;
  private uEye: WebGLUniformLocation;
  private uLight: WebGLUniformLocation;
  private pViewProj: WebGLUniformLocation;
  camera: CameraState = { target: [0, 0, 10], distance: 130, yaw: 0.35, pitch: 0.42 };
  private vpCache: Float32Array | null = null;
  private eyeCache: Vec3 = [0, 0, 0];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    this.pointProg = program(gl, POINT_VERT, POINT_FRAG);
    this.uViewProj = gl.getUniformLocation(this.prog, 'uViewProj')!;
    this.uEye = gl.getUniformLocation(this.prog, 'uEye')!;
    this.uLight = gl.getUniformLocation(this.prog, 'uLightDir')!;
    this.pViewProj = gl.getUniformLocation(this.pointProg, 'uViewProj')!;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.07, 0.08, 0.1, 1);
  }

  /** 上传一块静态网格，返回对象 id；实例后续可热更新 */
  addMesh(mesh: MeshData, pointMode = false): number {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    // 每实例矩阵（4 个 vec4）
    const matrixBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, matrixBuffer);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(2 + k, 1);
    }
    // 每实例颜色
    const colorBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(6, 1);

    gl.bindVertexArray(null);
    const obj: MeshObject = {
      vao, vbo, nbo, ibo, matrixBuffer, colorBuffer,
      indexCount: mesh.indices.length, instances: [], pointMode,
      dirty: true, matrixCache: new Float32Array(16), colorCache: new Float32Array(4),
    };
    this.objects.push(obj);
    return this.objects.length - 1;
  }

  removeMesh(id: number): void {
    const gl = this.gl;
    const o = this.objects[id];
    if (!o) return;
    gl.deleteVertexArray(o.vao);
    gl.deleteBuffer(o.vbo); gl.deleteBuffer(o.nbo); gl.deleteBuffer(o.ibo);
    gl.deleteBuffer(o.matrixBuffer); gl.deleteBuffer(o.colorBuffer);
    this.objects[id] = null as unknown as MeshObject;
  }

  clearInstances(id: number): void {
    const o = this.objects[id];
    o.instances.length = 0;
    o.dirty = true;
  }

  addInstance(id: number, pose: Pose, color: [number, number, number, number]): void {
    const o = this.objects[id];
    o.instances.push({ matrix: mat4.fromPose(pose), color });
    o.dirty = true;
  }

  addInstanceMatrix(id: number, matrix: Float32Array, color: [number, number, number, number]): void {
    const o = this.objects[id];
    o.instances.push({ matrix, color });
    o.dirty = true;
  }

  /** 热更新实例数据：仅对脏对象重分配并上传，无变化的网格零 GL 开销 */
  uploadInstances(): void {
    const gl = this.gl;
    for (const o of this.objects) {
      if (!o || !o.dirty) continue;
      const n = o.instances.length;
      const need = Math.max(1, n);
      if (o.matrixCache.length !== need * 16) {
        o.matrixCache = new Float32Array(need * 16);
        o.colorCache = new Float32Array(need * 4);
      }
      o.matrixCache.fill(0);
      o.colorCache.fill(0);
      for (let i = 0; i < n; i++) {
        o.matrixCache.set(o.instances[i].matrix, i * 16);
        o.colorCache.set(o.instances[i].color, i * 4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, o.matrixBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, o.matrixCache, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, o.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, o.colorCache, gl.DYNAMIC_DRAW);
      o.dirty = false;
    }
  }

  private viewProj(aspect: number): { vp: Float32Array; eye: Vec3 } {
    const c = this.camera;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const eye: Vec3 = [
      c.target[0] + c.distance * cp * Math.sin(c.yaw),
      c.target[1] + c.distance * sp,
      c.target[2] + c.distance * cp * Math.cos(c.yaw),
    ];
    const proj = mat4.perspective((40 * Math.PI) / 180, aspect, 1, 1000);
    const view = mat4.lookAt(eye, c.target, [0, 1, 0]);
    return { vp: mat4.mul(proj, view), eye };
  }

  render(): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { vp, eye } = this.viewProj(canvas.width / canvas.height);
    this.vpCache = vp; this.eyeCache = eye;

    for (const o of this.objects) {
      if (!o || o.instances.length === 0) continue;
      const prog = o.pointMode ? this.pointProg : this.prog;
      gl.useProgram(prog);
      gl.bindVertexArray(o.vao);
      if (o.pointMode) {
        gl.uniformMatrix4fv(this.pViewProj, false, vp);
        gl.drawArraysInstanced(gl.POINTS, 0, o.indexCount, o.instances.length);
      } else {
        gl.uniformMatrix4fv(this.uViewProj, false, vp);
        gl.uniform3fv(this.uEye, eye);
        gl.uniform3f(this.uLight, 0.35, 0.8, 0.45);
        gl.drawElementsInstanced(gl.TRIANGLES, o.indexCount, gl.UNSIGNED_INT, 0, o.instances.length);
      }
    }
    gl.bindVertexArray(null);
  }

  /** 屏幕射线 -> 世界方向（拾取/画笔用），返回射线起点与单位方向 */
  screenRay(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const vp = this.vpCache ?? this.viewProj(canvas.width / canvas.height).vp;
    // 逆变换（4x4 求逆，场景小，直接解析实现）
    const inv = invert4(vp);
    const near = transform4(inv, [nx, ny, -1, 1]);
    const far = transform4(inv, [nx, ny, 1, 1]);
    const o: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
    const f: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
    return { origin: o, dir: v3.norm(v3.sub(f, o)) };
  }

  get eye(): Vec3 { return this.eyeCache; }

  frame(target: Vec3, distance: number): void {
    this.camera.target = target;
    this.camera.distance = distance;
  }
}

function transform4(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

function invert4(m: Float32Array): Float32Array {
  const inv = new Float32Array(16);
  const a: number[] = Array.from(m);
  const ind = new Int32Array(16);
  // 通用高斯消元求逆
  const aug = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) aug[i * 4 + j] = a[j * 4 + i];
  }
  const dst = new Float32Array(16);
  invertMatrix4(aug, dst, ind);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) inv[j * 4 + i] = dst[i * 4 + j];
  }
  return inv;
}

function invertMatrix4(src: Float32Array, dst: Float32Array, ind: Int32Array): void {
  for (let i = 0; i < 4; i++) ind[i] = i;
  const a = src;
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 4 + col]) > Math.abs(a[pivot * 4 + col])) pivot = r;
    if (pivot !== col) {
      for (let c = 0; c < 4; c++) {
        const tmp = a[pivot * 4 + c]; a[pivot * 4 + c] = a[col * 4 + c]; a[col * 4 + c] = tmp;
        const ti = ind[pivot]; ind[pivot] = ind[col]; ind[col] = ti;
      }
    }
    const diag = a[col * 4 + col] || 1e-12;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = a[r * 4 + col] / diag;
      for (let c = 0; c < 4; c++) a[r * 4 + c] -= factor * a[col * 4 + c];
    }
  }
  // 单位矩阵逆变换
  const id = new Float32Array(16);
  id[0] = id[5] = id[10] = id[15] = 1;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (k === ind[j] ? id[i * 4 + k] : 0) / (a[k * 4 + k] || 1e-12);
      dst[i * 4 + j] = s;
    }
  }
}
