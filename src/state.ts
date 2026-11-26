// 全局状态：简单发布订阅，病例数据唯一来源；渲染层只读快照
import type { CaseRecord } from './core/types';
import { storage } from './storage';

export type PageId = 'cases' | 'import' | 'target' | 'steps' | 'occlusion' | 'report';

export interface AppState {
  page: PageId;
  caseId: string | null;
  cases: CaseRecord[];
  current: CaseRecord | null;
  /** 分步页当前步（0=初始态） */
  currentStep: number;
  /** 当前选中牙位 */
  selectedFdi: number | null;
  /** 碰撞报警阈值 mm */
  collisionThreshold: number;
  /** 咬合接触判定距离 mm */
  contactDistance: number;
  /** 显示开关 */
  showRoots: boolean;
  showGingiva: boolean;
  showShell: boolean;
  showIpr: boolean;
  busy: string | null;
}

type Listener = (s: AppState) => void;

const listeners = new Set<Listener>();

export const state: AppState = {
  page: 'cases',
  caseId: null,
  cases: [],
  current: null,
  currentStep: 0,
  selectedFdi: null,
  collisionThreshold: 0.15,
  contactDistance: 1.2,
  showRoots: false,
  showGingiva: true,
  showShell: false,
  showIpr: true,
  busy: null,
};

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn(state);
}

export function update(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  notify();
}

export async function refreshCaseList(): Promise<void> {
  state.cases = await storage.list();
  notify();
}

export async function openCase(id: string): Promise<void> {
  const c = await storage.get(id);
  if (!c) throw new Error('病例不存在: ' + id);
  state.caseId = id;
  state.current = c;
  state.currentStep = 0;
  state.selectedFdi = null;
  notify();
}

/** 修改当前病例后调用：更新内存并落库 */
export async function persistCurrent(): Promise<void> {
  if (!state.current) return;
  await storage.save(state.current);
  await refreshCaseList();
}

export function routeFor(page: PageId, caseId?: string | null): string {
  const id = caseId ?? state.caseId;
  return id && page !== 'cases' ? `#/${page}/${id}` : `#/${page}`;
}

export function navigate(page: PageId, caseId?: string | null): void {
  location.hash = routeFor(page, caseId);
}
