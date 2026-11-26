// 页面 4：分步方案 —— 自动切步、碰撞计算、IPR、附件/牙套、逐步拖动审核
import { button, h, num, toast } from '../dom';
import { createViewport, setBusy } from '../viewport';
import { ComputeClient } from '../../workerClient';
import { navigate, persistCurrent, state, update } from '../../state';
import { missingCase, fmt } from './pageHelpers';
import { DEFAULT_LIMITS } from '../../core/types';
import type { IprEntry, StepPlan, ToothDef } from '../../core/types';
import { posesAtStep } from '../../core/planning';
import { iprAlarms, summarizeIpr } from '../../core/ipr';

const client = new ComputeClient();

export function renderStepsPage(root: HTMLElement): void {
  const c = state.current;
  if (!c) { root.replaceChildren(missingCase()); return; }

  const vp = createViewport(c);
  update({ currentStep: 0 });
  const side = h('div', { class: 'side-panel wide' });
  const dock = h('div', { class: 'step-dock' });

  const renderDock = (): void => {
    const plan = c.plan;
    if (!plan) { dock.replaceChildren(); return; }
    const range = h('input', {
      type: 'range', min: '0', max: String(plan.stepCount), value: String(state.currentStep),
    }) as HTMLInputElement;
    range.addEventListener('input', () => {
      update({ currentStep: Number(range.value) });
      label.textContent = `第 ${state.currentStep} / ${plan.stepCount} 步`;
      paintTicks();
      renderStepTable();
    });
    const label = h('div', { class: 'step-label', text: `第 ${state.currentStep} / ${plan.stepCount} 步` });
    const ticks = h('div', { class: 'step-ticks' });
    const paintTicks = (): void => {
      ticks.replaceChildren();
      for (let s = 1; s <= plan.stepCount; s++) {
        const alarm = plan.collisions[s - 1]?.hasAlarm;
        const over = plan.overLimitSteps.includes(s);
        ticks.append(h('i', {
          class: `${alarm ? 'alarm' : ''} ${over ? 'over' : ''} ${s === state.currentStep ? 'current' : ''}`,
          title: `第 ${s} 步${alarm ? ' · 碰撞报警' : ''}${over ? ' · 超限' : ''}`,
        }));
      }
    };
    const playBtn = button('▶ 自动播放', () => {
      let s = state.currentStep;
      const timer = setInterval(() => {
        s = s >= plan.stepCount ? 0 : s + 1;
        range.value = String(s);
        range.dispatchEvent(new Event('input'));
        if (s >= plan.stepCount) clearInterval(timer);
      }, 350);
    }, 'btn small');
    dock.replaceChildren(
      h('div', { class: 'top' }, playBtn, range, label),
      ticks,
    );
    paintTicks();
  };

  const stepTable = h('div');
  const renderStepTable = (): void => {
    const plan = c.plan;
    if (!plan) { stepTable.replaceChildren(); return; }
    const s = state.currentStep;
    const rows = s === 0 ? null : plan.steps[s - 1];
    stepTable.replaceChildren(
      h('div', { class: 'section-title', text: s === 0 ? '初始态（step 0）' : `第 ${s} 步每牙位移` }),
      h('div', { style: 'max-height:260px;overflow-y:auto' },
        h('table', {},
          h('tr', {}, h('th', { text: '牙位' }), h('th', { class: 'num', text: '平移 mm' }), h('th', { class: 'num', text: '旋转 °' }), h('th', { text: '状态' })),
          ...(rows ?? []).map((r) =>
            h('tr', {
              class: `clickable ${state.selectedFdi === r.fdi ? 'selected' : ''}`,
              onClick: () => { update({ selectedFdi: r.fdi }); vp.scene.refreshInstances(); renderStepTable(); },
            },
              h('td', { text: String(r.fdi) }),
              h('td', { class: 'num mono', text: num(r.stepMove, 3) }),
              h('td', { class: 'num mono', text: num(r.stepRotate, 3) }),
              h('td', {}, r.overLimit ? h('span', { class: 'tag danger', text: '超限' }) : h('span', { class: 'tag ok', text: '限值内' })),
            ),
          ),
        ),
      ),
    );
  };

  // ---- 方案生成 ----
  const limitT = h('input', { type: 'number', value: String(DEFAULT_LIMITS.maxTranslation), step: '0.05', min: '0.05' }) as HTMLInputElement;
  const limitR = h('input', { type: 'number', value: String(DEFAULT_LIMITS.maxRotationDeg), step: '0.5', min: '0.5' }) as HTMLInputElement;
  const maxSteps = h('input', { type: 'number', value: String(DEFAULT_LIMITS.maxSteps), step: '1', min: '1' }) as HTMLInputElement;
  const thresholdInput = h('input', { type: 'number', value: String(state.collisionThreshold), step: '0.05', min: '0.01' }) as HTMLInputElement;

  const summary = h('div');
  const renderSummary = (plan: StepPlan | null): void => {
    if (!plan) {
      summary.replaceChildren(h('div', { class: 'muted', text: '尚未生成方案' }));
      return;
    }
    const alarmSteps = plan.collisions.filter((x) => x.hasAlarm).map((x) => x.step);
    summary.replaceChildren(
      h('div', { class: 'section-title', text: '方案概况' }),
      h('table', {},
        h('tr', {}, h('td', { text: '总步数' }), h('td', { class: 'num', text: String(plan.stepCount) })),
        h('tr', {}, h('td', { text: '确定性指纹' }), h('td', { class: 'num mono', text: plan.fingerprint })),
        h('tr', {}, h('td', { text: '超限步骤' }), h('td', { class: 'num' }, plan.overLimitSteps.length
          ? h('span', { class: 'tag warn', text: plan.overLimitSteps.join(', ') }) : h('span', { class: 'tag ok', text: '无' }))),
        h('tr', {}, h('td', { text: '碰撞报警步' }), h('td', { class: 'num' }, alarmSteps.length
          ? h('span', { class: 'tag danger', text: alarmSteps.join(', ') }) : h('span', { class: 'tag ok', text: '无' }))),
      ),
    );
  };

  // ---- IPR 面板 ----
  const iprPanel = h('div');
  const renderIpr = (): void => {
    const { rows, alarms } = summarizeIpr(c.ipr, c.iprSafetyLimit);
    const alarmNode = alarms.length
      ? h('div', { class: 'danger-text', style: 'margin-top:6px', text: `⚠ 安全值报警：${alarms.map((a) => `${a.pair.replace('|', '–')} 累计 ${num(a.total)}mm`).join('；')}` })
      : undefined;
    const toothA = selectFdi(c, 11);
    const toothB = selectFdi(c, 12);
    const amount = h('input', { type: 'number', value: '0.25', step: '0.05', min: '0.05' }) as HTMLInputElement;
    const atStep = h('input', { type: 'number', value: '1', step: '1', min: '1' }) as HTMLInputElement;
    iprPanel.replaceChildren(
      h('div', { class: 'section-title', text: `邻面去釉（安全累计 ${c.iprSafetyLimit} mm）` }),
      h('label', { class: 'field', text: '牙 A' }, toothA),
      h('label', { class: 'field', text: '牙 B（邻接牙）' }, toothB),
      h('label', { class: 'field', text: '去釉量 mm' }, amount),
      h('label', { class: 'field', text: '执行步骤' }, atStep),
      button('添加 IPR', async () => {
        const a = Number(toothA.value), b = Number(toothB.value);
        if (a === b) { toast('请选择两颗不同的牙', 'error'); return; }
        const entry: IprEntry = {
          id: `ipr-${Date.now().toString(36)}`,
          jaw: c.upper.teeth.some((t) => t.fdi === a) ? 'upper' : 'lower',
          fdiA: Math.min(a, b), fdiB: Math.max(a, b),
          amount: Number(amount.value), atStep: Number(atStep.value),
        };
        c.ipr.push(entry);
        await persistCurrent();
        vp.scene.refreshInstances();
        renderIpr();
        toast('IPR 已添加，模型邻面将按色阶标记', 'ok');
      }, 'btn small primary'),
      h('div', { style: 'max-height:180px;overflow-y:auto;margin-top:8px' },
        h('table', {},
          h('tr', {}, h('th', { text: '邻接' }), h('th', { class: 'num', text: '累计 mm' }), h('th', { class: 'num', text: '步' }), h('th', { text: '' })),
          ...rows.map((r) =>
            h('tr', {},
              h('td', { text: `${r.fdiA}–${r.fdiB}` }),
              h('td', { class: 'num mono' }, h('span', { class: r.total > c.iprSafetyLimit ? 'tag danger' : 'tag ok', text: num(r.total) })),
              h('td', { class: 'num', text: r.steps.join(',') }),
              h('td', {}, button('删', async () => {
                c.ipr = c.ipr.filter((e) => !(Math.min(e.fdiA, e.fdiB) === r.fdiA && Math.max(e.fdiA, e.fdiB) === r.fdiB));
                await persistCurrent();
                vp.scene.refreshInstances();
                renderIpr();
              }, 'btn small')),
            ),
          ),
        ),
      ),
      ...(alarmNode ? [alarmNode] : []),
    );
  };

  // ---- 附件面板 ----
  const attPanel = h('div');
  const renderAttachments = (): void => {
    const fdiSel = selectFdi(c, 13);
    const kind = h('select', {},
      h('option', { value: 'rectangular', text: '矩形附件' }),
      h('option', { value: 'beveled', text: '斜面附件' }),
      h('option', { value: 'ellipsoid', text: '椭圆附件' }),
    ) as HTMLSelectElement;
    const face = h('select', {},
      h('option', { value: 'buccal', text: '颊面' }),
      h('option', { value: 'lingual', text: '舌面' }),
    ) as HTMLSelectElement;
    const w = h('input', { type: 'number', value: '3.5', step: '0.1' }) as HTMLInputElement;
    const hh = h('input', { type: 'number', value: '2.2', step: '0.1' }) as HTMLInputElement;
    const d = h('input', { type: 'number', value: '1.4', step: '0.1' }) as HTMLInputElement;
    const axial = h('input', { type: 'number', value: '0', step: '0.5' }) as HTMLInputElement;
    const all = [...c.upper.teeth, ...c.lower.teeth];
    attPanel.replaceChildren(
      h('div', { class: 'section-title', text: '附件' }),
      h('label', { class: 'field', text: '牙位' }, fdiSel),
      h('label', { class: 'field', text: '类型' }, kind),
      h('label', { class: 'field', text: '附着面' }, face),
      h('div', { style: 'display:flex;gap:8px' },
        h('label', { class: 'field', style: 'flex:1', text: '宽 mm' }, w),
        h('label', { class: 'field', style: 'flex:1', text: '高 mm' }, hh),
        h('label', { class: 'field', style: 'flex:1', text: '厚 mm' }, d),
      ),
      h('label', { class: 'field', text: '长轴偏移 mm（+龈向）' }, axial),
      button('放置附件', async () => {
        const tooth = all.find((t) => t.fdi === Number(fdiSel.value));
        if (!tooth) return;
        tooth.attachments.push({
          id: `att-${Date.now().toString(36)}`, fdi: tooth.fdi,
          kind: kind.value as ToothDef['attachments'][number]['kind'],
          face: face.value as 'buccal' | 'lingual',
          axialOffset: Number(axial.value),
          size: [Number(w.value), Number(hh.value), Number(d.value)],
        });
        await persistCurrent();
        vp.scene.buildStatic(c);
        renderAttachments();
        toast('附件已放置', 'ok');
      }, 'btn small primary'),
      h('div', { class: 'pill-list', style: 'margin-top:8px' },
        ...all.flatMap((t) => t.attachments.map((a) =>
          h('span', { class: 'tag info' }, `${a.fdi} ${a.kind}`,
            h('button', {
              class: 'btn small', style: 'margin-left:6px;padding:0 6px', text: '×',
              onClick: async () => {
                t.attachments = t.attachments.filter((x) => x.id !== a.id);
                await persistCurrent();
                vp.scene.buildStatic(c);
                renderAttachments();
              },
            }),
          ),
        )),
      ),
    );
  };

  // ---- 主操作：切步 + 碰撞 ----
  const generate = async (): Promise<void> => {
    setBusy('Worker 自动切步…');
    try {
      const limits = {
        maxTranslation: Number(limitT.value),
        maxRotationDeg: Number(limitR.value),
        maxSteps: Number(maxSteps.value),
      };
      const all = [...c.upper.teeth, ...c.lower.teeth];
      const { plan } = await client.runPlan(all, limits);
      c.plan = plan;
      update({ currentStep: 0 });
      setBusy(`正在计算 ${plan.stepCount} 步牙间碰撞…`);
      const { collisions } = await client.runCollisions(c.upper.teeth, c.lower.teeth, plan, state.collisionThreshold);
      c.plan.collisions = collisions;
      await persistCurrent();
      vp.scene.buildStatic(c);
      renderDock(); renderSummary(plan); renderStepTable();
      const alarms = collisions.filter((x) => x.hasAlarm).length;
      toast(`方案 ${plan.stepCount} 步生成完成${alarms ? `，${alarms} 步碰撞报警` : '，无碰撞报警'}`, alarms ? 'error' : 'ok');
    } catch (err) {
      toast('生成失败：' + (err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  thresholdInput.addEventListener('change', async () => {
    update({ collisionThreshold: Number(thresholdInput.value) });
    if (c.plan) {
      setBusy('按新阈值重算碰撞…');
      try {
        const { collisions } = await client.runCollisions(c.upper.teeth, c.lower.teeth, c.plan, state.collisionThreshold);
        c.plan.collisions = collisions;
        await persistCurrent();
        vp.scene.refreshInstances();
        renderDock(); renderSummary(c.plan);
      } finally { setBusy(null); }
    }
  });

  side.replaceChildren(
    h('div', { class: 'section-title', text: '切步限值' }),
    h('div', { style: 'display:flex;gap:8px' },
      h('label', { class: 'field', style: 'flex:1', text: '平移 mm/步' }, limitT),
      h('label', { class: 'field', style: 'flex:1', text: '旋转 °/步' }, limitR),
      h('label', { class: 'field', style: 'flex:1', text: '最大步数' }, maxSteps),
    ),
    h('label', { class: 'field', text: '碰撞穿透报警阈值 mm' }, thresholdInput),
    button('生成 / 重新切步', generate, 'btn primary'),
    summary,
    h('hr', { style: 'border-color:var(--border);border-style:solid;border-width:0 0 1px' }),
    iprPanel,
    attPanel,
    h('div', { class: 'section-title', text: '显示与导出' }),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', onChange: (e: Event) => update({ showShell: (e.target as HTMLInputElement).checked }),
    }), '牙套偏移壳体预览（0.5mm 间隙）'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: true, onChange: (e: Event) => update({ showIpr: (e.target as HTMLInputElement).checked }),
    }), '显示 IPR 邻面着色'),
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      button('去咬合检查', () => navigate('occlusion', c.id)),
      button('去审核报告', () => navigate('report', c.id)),
    ),
    stepTable,
  );

  root.replaceChildren(vp.wrap, side);
  vp.wrap.append(dock);
  renderDock();
  renderSummary(c.plan);
  renderStepTable();
  renderIpr();
  renderAttachments();
  void iprAlarms;
  void posesAtStep;
}

function selectFdi(c: NonNullable<typeof state.current>, preferred: number): HTMLSelectElement {
  const all = [...c.upper.teeth, ...c.lower.teeth].sort((a, b) => a.fdi - b.fdi);
  const sel = h('select', {}, ...all.map((t) =>
    h('option', { value: String(t.fdi), text: `${t.fdi} ${t.name}` }),
  )) as HTMLSelectElement;
  if (all.some((t) => t.fdi === preferred)) sel.value = String(preferred);
  return sel;
}
