// 页面 3：目标排牙 —— 拾取拖牙/旋转、沿牙弓自动排、平移与转矩分量分开显示
import { button, h, toast } from '../dom';
import { createViewport, setBusy } from '../viewport';
import { navigate, persistCurrent, state, update } from '../../state';
import { missingCase, fmt } from './pageHelpers';
import { applyTargetDelta, autoArrangeTargets, targetComponents } from '../../core/planning';
import { rayPlane } from '../../picking';
import { v3 } from '../../core/math';
import type { ToothDef, Vec3 } from '../../core/types';

export function renderTargetPage(root: HTMLElement): void {
  const c = state.current;
  if (!c) { root.replaceChildren(missingCase()); return; }

  const vp = createViewport(c);
  const detail = h('div');
  const findTooth = (fdi: number): ToothDef =>
    [...c.upper.teeth, ...c.lower.teeth].find((t) => t.fdi === fdi)!;

  const save = async (): Promise<void> => {
    c.plan = null; // 目标变化后旧方案失效
    await persistCurrent();
    vp.scene.refreshInstances();
    refreshDetail();
  };

  const applyDelta = (tooth: ToothDef, d: Vec3, axis: Vec3, deg: number): void => {
    Object.assign(tooth, applyTargetDelta(tooth, d, axis, deg));
    void save();
  };

  const refreshDetail = (): void => {
    const fdi = state.selectedFdi;
    const tooth = fdi ? findTooth(fdi) : undefined;
    if (!tooth) {
      detail.replaceChildren(h('div', { class: 'muted', text: '点击模型选择一颗牙，查看平移与转矩分量并微调' }));
      return;
    }
    const comp = targetComponents(tooth);
    const transButtons: [string, Vec3][] = [
      ['近中 0.25', [-0.25, 0, 0]], ['远中 0.25', [0.25, 0, 0]],
      ['龈向 0.25', [0, -0.25, 0]], ['合向 0.25', [0, 0.25, 0]],
      ['舌向 0.25', [0, 0, -0.25]], ['颊向 0.25', [0, 0, 0.25]],
    ];
    const rotButtons: [string, Vec3, number][] = [
      ['长轴 +2°', [0, 1, 0], 2], ['长轴 -2°', [0, 1, 0], -2],
      ['转矩 +2°', [1, 0, 0], 2], ['转矩 -2°', [1, 0, 0], -2],
      ['倾斜 +2°', [0, 0, 1], 2], ['倾斜 -2°', [0, 0, 1], -2],
    ];
    detail.replaceChildren(
      h('div', { class: 'section-title', text: `${tooth.fdi} · ${tooth.name}` }),
      h('table', {},
        h('tr', {}, h('th', { text: '平移分量 mm' }), h('th', { class: 'num', text: 'x 近远中' }), h('th', { class: 'num', text: 'y 垂直' }), h('th', { class: 'num', text: 'z 颊舌' })),
        h('tr', {}, h('td', { text: '初始→目标' }), ...comp.translation.map((x) => h('td', { class: 'num mono', text: fmt(x) }))),
      ),
      h('div', { style: 'margin:8px 0' },
        h('span', { class: 'tag info', text: `总平移 ${fmt(comp.translationMag)} mm` }), ' ',
        h('span', { class: 'tag info', text: `总旋转 ${fmt(comp.rotationDeg)}°` }),
      ),
      h('div', { class: 'muted', style: 'font-size:12px;margin:6px 0 4px', text: '平移微调' }),
      h('div', { class: 'btn-row' }, ...transButtons.map(([label, d]) =>
        button(label, () => applyDelta(tooth, d, [0, 0, 0], 0), 'btn small'))),
      h('div', { class: 'muted', style: 'font-size:12px;margin:10px 0 4px', text: '转矩/旋转微调' }),
      h('div', { class: 'btn-row' }, ...rotButtons.map(([label, axis, deg]) =>
        button(label, () => applyDelta(tooth, [0, 0, 0], axis, deg), 'btn small'))),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        button('复位该牙', async () => {
          tooth.targetPose = { t: [...tooth.pose.t] as Vec3, q: [...tooth.pose.q] };
          await save();
        }),
      ),
    );
  };

  // 拾取与拖动
  vp.scene.controls.onLeftClick = (x, y) => {
    const hit = vp.scene.pickAt(x, y);
    update({ selectedFdi: hit ? hit.fdi : null });
    vp.scene.refreshInstances();
    refreshDetail();
  };

  let dragging = false;
  let planePoint: Vec3 = [0, 0, 0];
  let planeNormal: Vec3 = [0, 1, 0];
  let dragTooth: ToothDef | null = null;
  const canvas = vp.wrap.querySelector('canvas')!;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.selectedFdi) return;
    const hit = vp.scene.pickAt(e.clientX, e.clientY);
    if (!hit || hit.fdi !== state.selectedFdi) return;
    dragging = true;
    dragTooth = findTooth(hit.fdi);
    planeNormal = v3.norm(v3.sub(vp.scene.renderer.eye, hit.point));
    planePoint = [...dragTooth.targetPose.t] as Vec3;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !dragTooth) return;
    const ray = vp.scene.renderer.screenRay(e.clientX, e.clientY);
    const p = rayPlane(ray.origin, ray.dir, planePoint, planeNormal);
    if (!p) return;
    dragTooth.targetPose.t = [p[0], p[1], p[2]];
    vp.scene.refreshInstances();
  });
  canvas.addEventListener('pointerup', async () => {
    if (!dragging) return;
    dragging = false; dragTooth = null;
    await save();
  });

  const panel = h('div', { class: 'side-panel' },
    h('div', { class: 'section-title', text: '排牙工具' }),
    h('div', { class: 'btn-row' },
      button('沿牙弓自动排齐', async () => {
        setBusy('沿理想牙弓重排目标位姿…');
        try {
          c.upper.teeth = autoArrangeTargets(c.upper.teeth, 44, 29, 7.1);
          c.lower.teeth = autoArrangeTargets(c.lower.teeth, 41, 27, 6.85);
          c.plan = null;
          await persistCurrent();
          vp.scene.buildStatic(c);
          refreshDetail();
          toast('已按弓形重排，可继续逐牙微调', 'ok');
        } finally { setBusy(null); }
      }, 'btn primary'),
      button('全部复位', async () => {
        for (const t of [...c.upper.teeth, ...c.lower.teeth]) {
          t.targetPose = { t: [...t.pose.t] as Vec3, q: [...t.pose.q] };
        }
        c.plan = null;
        await persistCurrent();
        vp.scene.buildStatic(c);
        refreshDetail();
        toast('目标位已全部复位', 'ok');
      }),
    ),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox',
      onChange: (e: Event) => update({ showRoots: (e.target as HTMLInputElement).checked }),
    }), '显示统计牙根'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox',
      onChange: (e: Event) => update({ showGingiva: (e.target as HTMLInputElement).checked }),
    }), '显示牙龈'),
    h('div', { class: 'section-title', text: '选中牙详情' }),
    detail,
    h('div', { class: 'section-title', text: '下一步' }),
    button('生成分步方案 →', () => navigate('steps', c.id), 'btn primary'),
    h('div', { class: 'muted', style: 'font-size:12px;line-height:1.8;margin-top:8px', text: '左键空白处旋转视角；选中牙后按住拖动可在视平面内平移；右侧按钮做精确平移/转矩微调，平移量与旋转角分开显示。' }),
  );

  root.replaceChildren(vp.wrap, panel);
  refreshDetail();
}
