// 页面 5：咬合检查 —— ICP/前伸/侧方工况，接触点颜色表示咬合松紧
import { button, h, num, toast } from '../dom';
import { createViewport, setBusy } from '../viewport';
import { ComputeClient } from '../../workerClient';
import { navigate, persistCurrent, state } from '../../state';
import { missingCase } from './pageHelpers';
import { posesAtStep } from '../../core/planning';
import { mat4, q } from '../../core/math';
import type { OcclusionResult, Pose } from '../../core/types';

const client = new ComputeClient();
const MODE_LABEL: Record<OcclusionResult['mode'], string> = {
  icp: '正中咬合 ICP',
  protrusive: '前伸运动（下颌 +3mm）',
  'lateral-left': '左侧方运动（+2.5mm）',
  'lateral-right': '右侧方运动（-2.5mm）',
};

export function renderOcclusionPage(root: HTMLElement): void {
  const c = state.current;
  if (!c) { root.replaceChildren(missingCase()); return; }

  const vp = createViewport(c);
  const resultBox = h('div');
  let pointCloudId = -1;

  const drawContactPoints = (res: OcclusionResult | null): void => {
    if (pointCloudId >= 0) { vp.scene.renderer.removeMesh(pointCloudId); pointCloudId = -1; }
    if (!res || res.contacts.length === 0) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const range = state.contactDistance;
    for (const ct of res.contacts) {
      positions.push(ct.point[0], ct.point[1], ct.point[2]);
      // penetration: 越接近 0（接触越紧）越红；负得越多（间隙大）越蓝
      const t = Math.max(0, Math.min(1, 1 + ct.penetration / range));
      colors.push(0.2 + 0.8 * t, 0.25 + 0.45 * (1 - Math.abs(0.5 - t) * 2), 0.95 - 0.75 * t);
      const id = positions.length / 3 - 1;
      indices.push(id, id, id);
    }
    const cloud = {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(colors),
      indices: Uint32Array.from(indices),
    };
    pointCloudId = vp.scene.renderer.addMesh(cloud, true);
    vp.scene.renderer.addInstance(pointCloudId, { t: [0, 0, 0], q: q.identity() }, [1, 1, 1, 0]);
  };

  const runMode = async (mode: OcclusionResult['mode']): Promise<void> => {
    setBusy(`计算 ${MODE_LABEL[mode]} 接触点…`);
    try {
      const all = [...c.upper.teeth, ...c.lower.teeth];
      const poses = c.plan ? posesAtStep(all, c.plan, state.currentStep) : new Map(all.map((t) => [t.fdi, t.pose]));
      const upperPoses: [number, Pose][] = c.upper.teeth.map((t) => [t.fdi, poses.get(t.fdi)!]);
      const lowerPoses: [number, Pose][] = c.lower.teeth.map((t) => [t.fdi, poses.get(t.fdi)!]);
      const { result } = await client.runOcclusion(
        c.upper.teeth, c.lower.teeth, upperPoses, lowerPoses, mode, state.contactDistance,
      );
      const old = c.occlusions.findIndex((x) => x.mode === mode);
      if (old >= 0) c.occlusions[old] = result; else c.occlusions.push(result);
      await persistCurrent();
      drawContactPoints(result);
      renderResult(result);
      toast(`${MODE_LABEL[mode]}：${result.contacts.length} 个接触对`, 'ok');
    } catch (err) {
      toast('咬合计算失败：' + (err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const renderResult = (res: OcclusionResult | null): void => {
    if (!res) {
      resultBox.replaceChildren(h('div', { class: 'muted', text: '选择工况开始计算' }));
      return;
    }
    resultBox.replaceChildren(
      h('div', { class: 'section-title', text: MODE_LABEL[res.mode] }),
      h('div', { class: 'muted', style: 'font-size:12px', text: `下颌位移 [${res.mandibleShift.map((x) => num(x)).join(', ')}] mm` }),
      h('div', { style: 'max-height:340px;overflow-y:auto;margin-top:6px' },
        h('table', {},
          h('tr', {}, h('th', { text: '上颌牙' }), h('th', { text: '下颌牙' }), h('th', { class: 'num', text: '间隙(-)/穿透(+) mm' }), h('th', { text: '咬合松紧' })),
          ...res.contacts.map((ct) => {
            const tight = ct.penetration > -0.1;
            const mid = ct.penetration <= -0.1 && ct.penetration > -0.5;
            return h('tr', {},
              h('td', { text: String(ct.upperFdi) }),
              h('td', { text: String(ct.lowerFdi) }),
              h('td', { class: 'num mono', text: num(ct.penetration, 3) }),
              h('td', {}, h('span', {
                class: `tag ${tight ? 'danger' : mid ? 'warn' : 'ok'}`,
                text: tight ? '紧' : mid ? '中' : '轻',
              })),
            );
          }),
        ),
      ),
    );
  };

  const contactInput = h('input', { type: 'number', value: String(state.contactDistance), step: '0.1', min: '0.2' }) as HTMLInputElement;
  contactInput.addEventListener('change', () => state.contactDistance = Number(contactInput.value));

  const panel = h('div', { class: 'side-panel' },
    h('div', { class: 'section-title', text: '咬合工况' }),
    h('div', { class: 'btn-row' },
      ...(Object.keys(MODE_LABEL) as OcclusionResult['mode'][][0][]).map((m) =>
        button(MODE_LABEL[m], () => runMode(m), 'btn small')),
    ),
    h('label', { class: 'field', style: 'margin-top:10px', text: '接触判定距离 mm' }, contactInput),
    h('div', { class: 'section-title', text: '接触点结果' }),
    resultBox,
    h('div', { class: 'section-title', text: '图例与操作' }),
    h('div', { class: 'legend' },
      h('span', {}, h('i', { style: 'background:#dd4a40' }), '咬合紧（接近接触/穿透）'),
      h('span', {}, h('i', { style: 'background:#e0932b' }), '中等'),
      h('span', {}, h('i', { style: 'background:#39b36e' }), '轻接触/间隙'),
    ),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      button('清除接触点', () => { drawContactPoints(null); renderResult(null); }),
      button('去审核报告', () => navigate('report', c.id)),
    ),
    h('div', { class: 'muted', style: 'font-size:12px;line-height:1.8;margin-top:8px', text: '工况以刚体平移近似下颌运动；若已生成方案，按当前步位姿计算，否则用初始位姿。' }),
  );

  root.replaceChildren(vp.wrap, panel);
  renderResult(c.occlusions[0] ?? null);
  drawContactPoints(c.occlusions[0] ?? null);
  void mat4;
}
