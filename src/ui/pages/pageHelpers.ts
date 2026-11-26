// 页面公共辅助
import { button, h } from '../dom';
import { navigate, state } from '../../state';

export type ViewportHandleShim = never;

export function missingCase(): HTMLElement {
  return h('div', { class: 'empty-state', style: 'margin:40px' },
    h('div', { text: '请先在病例列表打开一个病例' }),
    button('去病例列表', () => navigate('cases'), 'btn primary'),
  );
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

export function allTeeth(): import('../../core/types').ToothDef[] {
  const c = state.current;
  return c ? [...c.upper.teeth, ...c.lower.teeth] : [];
}
