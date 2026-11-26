// 页面 6：审核报告 —— 每牙总移动、风险步骤、IPR 清单、碰撞汇总，支持浏览器打印
import { button, h, num, toast } from '../dom';
import { navigate, state } from '../../state';
import { missingCase } from './pageHelpers';
import { summarizeTeeth } from '../../core/planning';
import { summarizeIpr } from '../../core/ipr';

export function renderReportPage(root: HTMLElement): void {
  const c = state.current;
  if (!c) { root.replaceChildren(missingCase()); return; }
  const plan = c.plan;

  const body = h('div', { class: 'scroll', style: 'flex:1;padding:24px;overflow-y:auto' });

  if (!plan) {
    body.replaceChildren(h('div', { class: 'empty-state', style: 'margin:40px' },
      h('div', { style: 'font-size:15px;margin-bottom:10px', text: '该病例还没有分步方案' }),
      button('去分步方案页生成', () => navigate('steps', c.id), 'btn primary'),
    ));
    root.replaceChildren(body);
    return;
  }

  const rows = summarizeTeeth([...c.upper.teeth, ...c.lower.teeth], plan);
  const iprSummary = summarizeIpr(c.ipr, c.iprSafetyLimit);
  const collisionRows = plan.collisions.filter((x) => x.hasAlarm);
  const totalAlarms = collisionRows.length;
  const now = new Date().toLocaleString('zh-CN');

  const report = h('div', { class: 'report-printable', style: 'max-width:980px;margin:0 auto' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid var(--border);padding-bottom:12px' },
      h('div', {},
        h('h2', { style: 'margin:0 0 6px', text: '隐形矫治分步审核报告' }),
        h('div', { class: 'muted', text: `患者：${c.patientName} · 病例编号：${c.id}` }),
      ),
      h('div', { class: 'muted', style: 'font-size:12px;text-align:right' },
        h('div', { text: `生成时间：${now}` }),
        h('div', { text: `方案指纹：${plan.fingerprint}` }),
      ),
    ),

    h('div', { class: 'section-title', text: '一、方案概要' }),
    h('table', {},
      h('tr', {},
        h('td', { text: '总步数' }), h('td', { class: 'num', text: String(plan.stepCount) }),
        h('td', { text: '每步限值' }), h('td', { class: 'num', text: `${plan.limits.maxTranslation} mm / ${plan.limits.maxRotationDeg}°` }),
      ),
      h('tr', {},
        h('td', { text: '超限步骤数' }), h('td', { class: 'num' }, plan.overLimitSteps.length ? h('span', { class: 'tag warn', text: String(plan.overLimitSteps.length) }) : h('span', { class: 'tag ok', text: '0' })),
        h('td', { text: '碰撞报警步数' }), h('td', { class: 'num' }, totalAlarms ? h('span', { class: 'tag danger', text: String(totalAlarms) }) : h('span', { class: 'tag ok', text: '0' })),
      ),
      h('tr', {},
        h('td', { text: 'IPR 邻接对' }), h('td', { class: 'num', text: String(iprSummary.rows.length) }),
        h('td', { text: 'IPR 安全值' }), h('td', { class: 'num', text: `${c.iprSafetyLimit} mm/邻接` }),
      ),
    ),

    h('div', { class: 'section-title', text: '二、每颗牙总移动与风险步骤' }),
    h('table', {},
      h('tr', {},
        h('th', { text: '牙位' }), h('th', { text: '名称' }),
        h('th', { class: 'num', text: '总平移 mm' }), h('th', { class: 'num', text: '总旋转 °' }),
        h('th', { class: 'num', text: '单步最大平移' }), h('th', { class: 'num', text: '单步最大旋转' }),
        h('th', { text: '风险步骤' }),
      ),
      ...rows.map((r) =>
        h('tr', {},
          h('td', { text: String(r.fdi) }),
          h('td', { text: r.name }),
          h('td', { class: 'num mono', text: num(r.totalTranslation) }),
          h('td', { class: 'num mono', text: num(r.totalRotation) }),
          h('td', { class: 'num mono', text: num(r.maxStepMove, 3) }),
          h('td', { class: 'num mono', text: num(r.maxStepRotate, 3) }),
          h('td', {}, r.riskSteps.length
            ? h('span', { class: r.riskSteps.some((s) => plan.collisions[s - 1]?.hasAlarm) ? 'tag danger' : 'tag warn', text: r.riskSteps.join(', ') })
            : h('span', { class: 'tag ok', text: '无' })),
        ),
      ),
    ),

    h('div', { class: 'section-title', text: '三、邻面去釉清单' }),
    iprSummary.rows.length === 0
      ? h('div', { class: 'muted', text: '无 IPR 计划' })
      : h('table', {},
        h('tr', {}, h('th', { text: '邻接对' }), h('th', { class: 'num', text: '累计去釉 mm' }), h('th', { text: '执行步骤' }), h('th', { text: '安全值判定' })),
        ...iprSummary.rows.map((r) =>
          h('tr', {},
            h('td', { text: `${r.fdiA} – ${r.fdiB}` }),
            h('td', { class: 'num mono', text: num(r.total) }),
            h('td', { text: r.steps.join(', ') }),
            h('td', {}, r.total > c.iprSafetyLimit
              ? h('span', { class: 'tag danger', text: `超安全值 ${num(r.total - c.iprSafetyLimit)} mm` })
              : h('span', { class: 'tag ok', text: '安全' })),
          ),
        ),
      ),

    h('div', { class: 'section-title', text: '四、碰撞报警明细' }),
    collisionRows.length === 0
      ? h('div', {}, h('span', { class: 'tag ok', text: '所有步骤穿透深度均低于报警阈值，无碰撞风险' }))
      : h('table', {},
        h('tr', {}, h('th', { text: '步骤' }), h('th', { text: '牙对' }), h('th', { class: 'num', text: '最大穿透 mm' }), h('th', { class: 'num', text: `阈值 ${state.collisionThreshold}` })),
        ...collisionRows.flatMap((cr) =>
          cr.pairs.filter((p) => p.penetration > cr.threshold).map((p) =>
            h('tr', {},
              h('td', { text: String(cr.step) }),
              h('td', { text: `${p.fdiA} – ${p.fdiB}` }),
              h('td', { class: 'num mono danger-text', text: num(p.penetration, 3) }),
              h('td', { class: 'num', text: '超限' }),
            ),
          ),
        ),
      ),

    h('div', { class: 'section-title', text: '五、咬合接触汇总' }),
    c.occlusions.length === 0
      ? h('div', { class: 'muted', text: '未进行咬合检查' })
      : c.occlusions.map((oc) =>
        h('div', { style: 'margin-bottom:8px' },
          h('span', { class: 'tag info', text: modeName(oc.mode) }),
          h('span', { style: 'margin-left:8px', text: `接触对 ${oc.contacts.length} 个，最紧接触 ${oc.contacts.reduce((m, x) => Math.max(m, x.penetration), -99).toFixed(2)} mm` }),
        ),
      ),

    h('hr', { style: 'margin:24px 0;border:0;border-top:1px solid var(--border)' }),
    h('div', { class: 'muted', style: 'font-size:12px;line-height:1.8', text: '审核结论：本报告由浏览器端确定性引擎生成，同目标排牙与限值下重复切步结果一致（指纹相同）。红色碰撞项与橙色超限项需医生结合临床复核。' }),
  );

  const toolbar = h('div', { class: 'no-print', style: 'padding:14px 24px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center' },
    button('打印 / 另存 PDF', () => window.print(), 'btn primary'),
    button('返回分步方案', () => navigate('steps', c.id)),
    h('span', { class: 'muted', style: 'font-size:12px', text: '打印样式已隐藏操作区，仅输出报告正文' }),
  );

  body.replaceChildren(report);
  root.replaceChildren(h('div', { style: 'flex:1;display:flex;flex-direction:column;min-width:0' }, toolbar, body));
  toast(`报告已生成：${rows.length} 颗牙，${totalAlarms} 步碰撞报警`, totalAlarms ? 'error' : 'ok');
}

function modeName(mode: string): string {
  return {
    icp: '正中咬合', protrusive: '前伸', 'lateral-left': '左侧方', 'lateral-right': '右侧方',
  }[mode] ?? mode;
}
