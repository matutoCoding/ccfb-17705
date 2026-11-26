// 页面 2：模型导入 —— STL 上传、自动分割（Worker）、手动涂装修正、确认入病例
import { button, download, h, toast } from '../dom';
import { setBusy } from '../viewport';
import { ComputeClient } from '../../workerClient';
import { parseSTL, writeBinarySTL } from '../../core/stl';
import { extractToothMesh, paintLabel } from '../../core/segmentation';
import { generateCrowdedCase, fdiFor } from '../../core/caseGenerator';
import { mat4, q } from '../../core/math';
import { CROWN_PARAMS, generateRoot, rootSpecFor } from '../../core/toothGeometry';
import type { JawType, MeshData, Segmentation, ToothDef, LocalFrame, Pose, Vec3 } from '../../core/types';
import { navigate, persistCurrent, state } from '../../state';
import { Renderer } from '../../renderer';
import { OrbitControls } from '../../orbitControls';

const client = new ComputeClient();

export function renderImportPage(root: HTMLElement): void {
  const c = state.current;
  if (!c) {
    root.replaceChildren(h('div', { class: 'empty-state', style: 'margin:40px' },
      h('div', { text: '请先在病例列表打开或新建一个病例' }),
      button('去病例列表', () => navigate('cases'), 'btn primary'),
    ));
    return;
  }

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const hud = h('div', { class: 'hud' });
  const wrap = h('div', { class: 'canvas-wrap' }, canvas, hud);
  const renderer = new Renderer(canvas);
  renderer.frame([0, 0, 8], 130);
  const controls = new OrbitControls(canvas, renderer.camera);

  let segMesh: MeshData | null = null;
  let seg: Segmentation | null = null;
  let segJaw: JawType = 'upper';
  let paintFdi = -1;
  let paintRadius = 2.0;
  let baseId = -1;
  let cloudId = -1;
  const colors = labelColors();

  const raf = requestAnimationFrame(function loop() {
    renderer.uploadInstances();
    renderer.render();
    requestAnimationFrame(loop);
  });
  void raf;

  const updateHud = (): void => {
    const counts = new Map<number, number>();
    if (seg) for (const l of seg.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const teeth = [...counts.entries()].filter(([l]) => l > 0).sort((a, b) => a[0] - b[0]);
    hud.replaceChildren(
      h('b', { text: '分割状态' }),
      h('div', { text: segMesh ? `${segMesh.positions.length / 3} 顶点 / ${segMesh.indices.length / 3} 三角面` : '尚未载入网格' }),
      h('div', { text: seg ? `识别牙位 ${teeth.length} 颗，牙龈顶点 ${counts.get(-1) ?? 0}` : '未分割' }),
      h('div', { class: 'legend', style: 'margin-top:8px' },
        h('span', {}, h('i', { style: 'background:#dd6160' }), '牙龈'),
        h('span', {}, h('i', { style: 'background:#4f8cff' }), '牙冠（彩色点云）'),
      ),
    );
  };

  const showData = (): void => {
    if (!segMesh) return;
    if (baseId >= 0) renderer.removeMesh(baseId);
    if (cloudId >= 0) renderer.removeMesh(cloudId);
    baseId = renderer.addMesh(segMesh);
    renderer.addInstance(baseId, { t: [0, 0, 0], q: q.identity() }, [0.82, 0.82, 0.78, 0]);
    if (seg) {
      const cloud = labelCloud(segMesh, seg, colors);
      cloudId = renderer.addMesh(cloud, true);
      renderer.addInstance(cloudId, { t: [0, 0, 0], q: q.identity() }, [1, 1, 1, 0]);
    }
    updateHud();
  };

  controls.onLeftClick = (x, y) => {
    if (!segMesh || !seg || controls.isDrag) return;
    const ray = renderer.screenRay(x, y);
    const vi = closestVertex(segMesh, ray.origin, ray.dir);
    if (vi < 0) return;
    const p: Vec3 = [segMesh.positions[vi * 3], segMesh.positions[vi * 3 + 1], segMesh.positions[vi * 3 + 2]];
    const changed = paintLabel(seg, segMesh, p, paintRadius, paintFdi);
    if (changed > 0) { showData(); toast(`已修正 ${changed} 个顶点 → ${paintFdi < 0 ? '牙龈' : '牙位 ' + paintFdi}`, 'info'); }
  };

  // ---- 面板 ----
  const fileInput = h('input', { type: 'file', accept: '.stl' }) as HTMLInputElement;
  const jawSelect = h('select', {},
    h('option', { value: 'upper', text: '上颌' }),
    h('option', { value: 'lower', text: '下颌' }),
  ) as HTMLSelectElement;
  const paintSelect = h('select', {}) as HTMLSelectElement;
  const rebuildPaintOptions = (): void => {
    paintSelect.replaceChildren(h('option', { value: '-1', text: '牙龈（-1）' }));
    for (let i = -7; i <= 7; i++) {
      if (i === 0) continue;
      const fdi = fdiFor(jawSelect.value as JawType, i);
      paintSelect.append(h('option', { value: String(fdi), text: `牙位 ${fdi}` }));
    }
  };
  rebuildPaintOptions();
  const radiusInput = h('input', { type: 'number', value: String(paintRadius), step: '0.5', min: '0.5', max: '8' }) as HTMLInputElement;
  paintSelect.addEventListener('change', () => { paintFdi = Number(paintSelect.value); });
  radiusInput.addEventListener('change', () => { paintRadius = Number(radiusInput.value); });
  jawSelect.addEventListener('change', rebuildPaintOptions);

  const panel = h('div', { class: 'side-panel' },
    h('div', { class: 'section-title', text: '导入 STL 口扫' }),
    h('label', { class: 'field', text: '颌位' }, jawSelect),
    h('label', { class: 'field', text: 'STL 文件（二进制/ASCII）' }, fileInput),
    button('上传并自动分割', async () => {
      const file = fileInput.files?.[0];
      if (!file) { toast('请先选择 STL 文件', 'error'); return; }
      setBusy('解析 STL 并在 Worker 中自动分割…');
      try {
        const mesh = parseSTL(await file.arrayBuffer());
        const jaw = jawSelect.value as JawType;
        const { segmentation } = await client.runSegment(jaw, mesh);
        segMesh = mesh; seg = segmentation; segJaw = jaw;
        showData();
        toast(`分割完成：${segmentation.seeds.size} 个种子`, 'ok');
      } catch (err) {
        toast('导入失败：' + (err as Error).message, 'error');
      } finally { setBusy(null); }
    }, 'btn primary'),

    h('div', { class: 'section-title', text: '内置测试口扫' }),
    button('载入程序化拥挤口扫（上颌）', async () => {
      setBusy('生成测试口扫并自动分割…');
      try {
        const gen = generateCrowdedCase(c.patientName, 20261127);
        const mesh = gen.scans[0].upper;
        const { segmentation } = await client.runSegment('upper', mesh);
        segMesh = mesh; seg = segmentation; segJaw = 'upper';
        showData();
        toast('已载入，可在左侧涂刷修正', 'ok');
      } finally { setBusy(null); }
    }),
    button('导出当前网格为 STL', () => {
      if (!segMesh) { toast('没有可导出的网格', 'error'); return; }
      download(`${segJaw}-scan.stl`, writeBinarySTL(segMesh));
      toast('STL 已导出', 'ok');
    }),

    h('div', { class: 'section-title', text: '手动修正（点击模型涂刷）' }),
    h('label', { class: 'field', text: '涂刷为' }, paintSelect),
    h('label', { class: 'field', text: '笔刷半径 mm' }, radiusInput),
    h('div', { class: 'muted', style: 'font-size:12px;line-height:1.7', text: '点击模型把半径内顶点改涂为所选标签，分割错误的牙可在这里修正后再入病例。' }),

    h('div', { class: 'section-title', text: '确认' }),
    h('div', { class: 'btn-row' },
      button('确认分割并入病例', async () => {
        if (!seg || !segMesh) { toast('请先完成分割', 'error'); return; }
        setBusy('提取牙体并补建统计牙根…');
        try {
          commitSegmentation(c, segJaw, segMesh, seg);
          await persistCurrent();
          toast('分割结果已写入病例', 'ok');
          navigate('target', c.id);
        } catch (err) {
          toast('入病例失败：' + (err as Error).message, 'error');
        } finally { setBusy(null); }
      }, 'btn primary'),
      button('去目标排牙', () => navigate('target', c.id)),
    ),
  );

  root.replaceChildren(wrap, panel);
  updateHud();
  void mat4;
}

/** 牙位标签 -> 固定 RGB（与点云 normals 通道配合） */
function labelColors(): Map<number, [number, number, number]> {
  const map = new Map<number, [number, number, number]>();
  map.set(-1, [0.86, 0.38, 0.36]);
  const palette: [number, number, number][] = [
    [0.31, 0.55, 1], [0.25, 0.78, 0.55], [0.95, 0.75, 0.25], [0.85, 0.4, 0.85],
    [0.25, 0.8, 0.85], [0.95, 0.55, 0.3], [0.6, 0.8, 0.3], [0.7, 0.5, 0.95],
  ];
  for (let i = -7; i <= 7; i++) {
    if (i === 0) continue;
    map.set(i, palette[(Math.abs(i) - 1) % palette.length]);
  }
  return map;
}

/** 带每顶点颜色的点云（颜色写入 normals 通道，point 着色器读取） */
function labelCloud(mesh: MeshData, s: Segmentation, colors: Map<number, [number, number, number]>): MeshData {
  const positions: number[] = [];
  const vertColors: number[] = [];
  const indices: number[] = [];
  for (let v = 0; v < s.labels.length; v++) {
    if (s.labels[v] < 0) continue;
    positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    const col = colors.get(s.labels[v]) ?? [1, 1, 1];
    vertColors.push(...col);
    const id = positions.length / 3 - 1;
    indices.push(id, id, id);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(vertColors),
    indices: Uint32Array.from(indices),
  };
}

function closestVertex(mesh: MeshData, origin: Vec3, dir: Vec3): number {
  let best = -1; let bestD2 = Infinity;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const px = mesh.positions[v * 3], py = mesh.positions[v * 3 + 1], pz = mesh.positions[v * 3 + 2];
    const t = (px - origin[0]) * dir[0] + (py - origin[1]) * dir[1] + (pz - origin[2]) * dir[2];
    if (t < 0) continue;
    const cx = origin[0] + dir[0] * t, cy = origin[1] + dir[1] * t, cz = origin[2] + dir[2] * t;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = v; }
  }
  return best;
}

function commitSegmentation(c: NonNullable<typeof state.current>, jaw: JawType, mesh: MeshData, s: Segmentation): void {
  const fdIs = [...new Set(s.labels)].filter((x) => x > 0).sort((a, b) => a - b);
  const teeth: ToothDef[] = [];
  for (const fdi of fdIs) {
    const { mesh: crown, center } = extractToothMesh(mesh, s.labels, fdi);
    const archIndex = fdiToArchIndex(fdi);
    const cls: ToothDef['toothClass'] =
      Math.abs(archIndex) <= 2 ? 'incisor' : Math.abs(archIndex) === 3 ? 'canine' : Math.abs(archIndex) <= 5 ? 'premolar' : 'molar';
    const params = CROWN_PARAMS[cls];
    const root = generateRoot(rootSpecFor(cls, fdi, fdi * 101 + 7), -params.height / 2 - 0.4, params.width, fdi * 53 + 11);
    const rootDir: Vec3 = jaw === 'upper' ? [0, -1, 0] : [0, 1, 0];
    const frame: LocalFrame = { origin: center, axes: [[1, 0, 0], [0, 0, 1], rootDir] };
    const pose: Pose = { t: center, q: q.identity() };
    teeth.push({
      fdi, jaw, archIndex, name: `牙位 ${fdi}`, toothClass: cls,
      pose, targetPose: { t: [...center] as Vec3, q: q.identity() },
      localFrame: frame, crown, root, boundsRadius: params.height, attachments: [],
    });
  }
  c[jaw] = { jaw, teeth, gingiva: c[jaw].gingiva };
  c.rawScan = { jaw, mesh, segmentation: s };
}

function fdiToArchIndex(fdi: number): number {
  const quadrant = Math.floor(fdi / 10);
  const i = fdi % 10;
  return quadrant === 1 || quadrant === 4 ? -i : i;
}
