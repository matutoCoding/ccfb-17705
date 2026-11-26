// 页面 1：病例列表 —— 新建/生成测试病例/删除/打开
import { button, h, toast } from '../dom';
import { navigate, persistCurrent, refreshCaseList, state } from '../../state';
import { generateAlignedCase, generateCrowdedCase } from '../../core/caseGenerator';
import { storage } from '../../storage';
import type { CaseRecord } from '../../core/types';

export async function renderCasesPage(root: HTMLElement): Promise<void> {
  await refreshCaseList();
  const grid = h('div', { class: 'case-grid' });

  const draw = (): void => {
    grid.replaceChildren();
    if (state.cases.length === 0) {
      grid.append(h('div', { class: 'empty-state' },
        h('div', { style: 'font-size:15px;margin-bottom:10px', text: '还没有病例' }),
        h('div', { class: 'muted', text: '生成一副程序化的拥挤上下颌用于测试，或从模型导入页上传 STL' }),
      ));
    }
    for (const c of state.cases) {
      const toothCount = c.upper.teeth.length + c.lower.teeth.length;
      grid.append(h('div', {
        class: 'case-card',
        onClick: () => navigate('target', c.id),
      },
        h('h3', { text: c.patientName }),
        h('div', { class: 'meta' },
          h('div', { text: `编号：${c.id}` }),
          h('div', { text: `牙位：${toothCount} 颗 · IPR ${c.ipr.length} 条 · 更新 ${new Date(c.updatedAt).toLocaleString('zh-CN')}` }),
          h('div', {},
            c.plan
              ? h('span', { class: `tag ${c.plan.overLimitSteps.length ? 'warn' : 'ok'}`, text: `方案 ${c.plan.stepCount} 步` })
              : h('span', { class: 'tag info', text: '未排牙' }),
            ' ',
            c.plan?.collisions.some((x) => x.hasAlarm) ? h('span', { class: 'tag danger', text: '碰撞报警' }) : null,
          ),
        ),
        h('div', { class: 'btn-row', style: 'margin-top:12px' },
          button('打开', () => navigate('target', c.id), 'btn small primary'),
          button('删除', async () => {
            if (!confirm(`确认删除病例「${c.patientName}」？该操作不可恢复。`)) return;
            await storage.remove(c.id);
            toast('病例已删除', 'ok');
            draw();
          }, 'btn small danger'),
        ),
      ));
    }
  };
  draw();

  const nameInput = h('input', { placeholder: '患者姓名', value: `测试患者 ${state.cases.length + 1}` }) as HTMLInputElement;
  const panel = h('div', { class: 'side-panel wide' },
    h('div', { class: 'section-title', text: '新建病例' }),
    h('label', { class: 'field', text: '患者姓名' }, nameInput),
    h('div', { class: 'btn-row' },
      button('生成拥挤测试病例', async () => {
        const seed = (Date.now() ^ (state.cases.length * 2654435761)) >>> 0;
        const { record } = generateCrowdedCase(nameInput.value.trim() || '拥挤测试患者', seed);
        await storage.save(record);
        toast('拥挤病例已生成（尖牙错位/前牙扭转/弓长不足）', 'ok');
        await refreshCaseList();
        draw();
      }, 'btn primary'),
      button('生成理想排列对照', async () => {
        const seed = (Date.now() ^ 0x9e3779b9) >>> 0;
        const { record } = generateAlignedCase(nameInput.value.trim() || '理想排列对照', seed);
        await storage.save(record);
        toast('对照病例已生成', 'ok');
        await refreshCaseList();
        draw();
      }),
    ),
    h('div', { class: 'section-title', text: '说明' }),
    h('div', { class: 'muted', style: 'line-height:1.8;font-size:12px' },
      h('div', { text: '· 测试模型为程序化参数化牙冠+统计牙根+牙龈，同种子位级一致' }),
      h('div', { text: '· 也可在「模型导入」页上传上下颌 STL 并自动分割' }),
      h('div', { text: '· 所有数据保存在浏览器 IndexedDB，不上传服务器' }),
    ),
  );

  root.replaceChildren(grid, panel);
}
