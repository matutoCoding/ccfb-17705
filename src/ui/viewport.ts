// 共享视口：canvas + SceneManager + 忙碌遮罩，页面卸载时销毁 GL 资源
import { h } from './dom';
import { SceneManager } from '../sceneManager';
import { state, subscribe, update, type AppState } from '../state';
import type { CaseRecord } from '../core/types';

export interface ViewportHandle {
  wrap: HTMLElement;
  scene: SceneManager;
  /** 状态变化回调（返回 false 可跳过默认实例刷新） */
  onState?: (s: AppState) => boolean | void;
  dispose(): void;
}

export function createViewport(c: CaseRecord): ViewportHandle {
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const busy = h('div', { class: 'busy-mask', hidden: true },
    h('div', {}, h('div', { class: 'spinner' }), h('div', { id: 'busy-text', text: '计算中…' })),
  );
  const wrap = h('div', { class: 'canvas-wrap' }, canvas, busy);
  const scene = new SceneManager(canvas);
  scene.buildStatic(c);

  const unsub = subscribe((s) => {
    if (s.current?.id !== c.id) return;
    busy.hidden = !s.busy;
    busy.querySelector('#busy-text')!.textContent = s.busy ?? '计算中…';
    const skip = handle.onState ? handle.onState(s) === false : false;
    if (!skip) scene.refreshInstances();
  });

  const handle: ViewportHandle = {
    wrap,
    scene,
    dispose() {
      unsub();
      scene.dispose();
      activeViewports.delete(handle);
    },
  };
  return registerViewport(handle);
}

export function setBusy(text: string | null): void {
  update({ busy: text });
}

/** 当前存活的视口号柄，路由切换时统一销毁，避免 GL 上下文与遮罩残留 */
const activeViewports = new Set<ViewportHandle>();

export function registerViewport(h: ViewportHandle): ViewportHandle {
  activeViewports.add(h);
  return h;
}

export function disposeCurrentViewports(): void {
  for (const h of activeViewports) h.dispose();
  activeViewports.clear();
  update({ busy: null });
}
