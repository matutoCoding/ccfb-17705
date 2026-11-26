// 应用入口：hash 路由 + 侧边导航
import './styles.css';
import { h, mount } from './ui/dom';
import { disposeCurrentViewports } from './ui/viewport';
import { navigate, openCase, refreshCaseList, state, subscribe, update, type PageId } from './state';
import { renderCasesPage } from './ui/pages/cases';
import { renderImportPage } from './ui/pages/importPage';
import { renderTargetPage } from './ui/pages/target';
import { renderStepsPage } from './ui/pages/steps';
import { renderOcclusionPage } from './ui/pages/occlusion';
import { renderReportPage } from './ui/pages/report';

const NAV: { id: PageId; label: string; icon: string; needCase: boolean }[] = [
  { id: 'cases', label: '病例列表', icon: '1', needCase: false },
  { id: 'import', label: '模型导入', icon: '2', needCase: true },
  { id: 'target', label: '目标排牙', icon: '3', needCase: true },
  { id: 'steps', label: '分步方案', icon: '4', needCase: true },
  { id: 'occlusion', label: '咬合检查', icon: '5', needCase: true },
  { id: 'report', label: '审核报告', icon: '6', needCase: true },
];

const TITLES: Record<PageId, string> = {
  cases: '病例列表',
  import: '模型导入与分割',
  target: '目标排牙',
  steps: '分步方案与碰撞审核',
  occlusion: '咬合检查',
  report: '审核报告',
};

function parseHash(): { page: PageId; caseId: string | null } {
  const m = location.hash.match(/^#\/(\w+)(?:\/(.+))?/);
  const page = (m?.[1] as PageId) ?? 'cases';
  return { page: NAV.some((n) => n.id === page) ? page : 'cases', caseId: m?.[2] ?? null };
}

async function render(): Promise<void> {
  const { page, caseId } = parseHash();
  if (caseId && state.caseId !== caseId) {
    try {
      await openCase(caseId);
    } catch {
      location.hash = '#/cases';
      return;
    }
  }
  update({ page });

  const navItems = NAV.map((n) =>
    h('a', {
      class: `nav-item ${state.page === n.id ? 'active' : ''}`,
      href: n.needCase && state.caseId ? `#/${n.id}/${state.caseId}` : `#/${n.id}`,
      onClick: (e: Event) => {
        if (n.needCase && !state.caseId) { e.preventDefault(); }
      },
    },
      h('span', { class: 'idx', text: n.icon }),
      h('span', { text: n.label }),
    ),
  );

  const sidebar = h('div', { class: 'sidebar' },
    h('div', { class: 'brand' }, '隐形矫治排牙审核', h('small', { text: 'Aligner Review · WebGL2' })),
    ...navItems,
    h('div', { class: 'case-chip' },
      h('b', { text: state.current ? state.current.patientName : '未打开病例' }),
      h('div', { text: state.current ? `编号 ${state.current.id}` : '从病例列表选择或新建' }),
    ),
  );

  const topbar = h('div', { class: 'topbar' },
    h('h2', { text: TITLES[page] }),
    h('div', { class: 'spacer' }),
    page !== 'cases' && state.current
      ? h('span', { class: 'tag info', text: `碰撞阈值 ${state.collisionThreshold} mm · 限值 ${state.current.plan?.limits.maxTranslation ?? 0.25} mm / ${state.current.plan?.limits.maxRotationDeg ?? 2}°` })
      : null,
  );

  const content = h('div', { class: 'content' });
  // 路由切换前销毁上一页的 WebGL 视口与订阅，避免遮罩/GL 上下文残留
  disposeCurrentViewports();
  const root = h('div', { class: 'main' }, topbar, content);
  mount(document.getElementById('app')!, h('div', { style: 'display:flex;height:100vh;width:100%' }, sidebar, root));

  const renderers: Record<PageId, () => Promise<void> | void> = {
    cases: () => renderCasesPage(content),
    import: () => renderImportPage(content),
    target: () => renderTargetPage(content),
    steps: () => renderStepsPage(content),
    occlusion: () => renderOcclusionPage(content),
    report: () => renderReportPage(content),
  };
  await renderers[page]();
}

window.addEventListener('hashchange', render);
subscribe(() => { /* 状态变化由各页面自行订阅；路由切换走 hashchange */ });

void navigate;
refreshCaseList().then(render);