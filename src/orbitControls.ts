// 轨道相机控制：左键旋转、右键平移、滚轮缩放；带拖动状态回调供 UI 区分拾取
import type { CameraState } from './renderer';
import { v3 } from './core/math';

export class OrbitControls {
  private el: HTMLElement;
  camera: CameraState;
  private dragging: 'rotate' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;
  onInteract?: () => void;
  /** 左键按下是否很快被释放（用于区分点击拾取与旋转） */
  onLeftClick?: (x: number, y: number) => void;
  private downX = 0;
  private downY = 0;
  private moved = false;

  constructor(el: HTMLElement, camera: CameraState) {
    this.el = el;
    this.camera = camera;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', this.handleDown);
    window.addEventListener('pointermove', this.handleMove);
    window.addEventListener('pointerup', this.handleUp);
    el.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.handleDown);
    window.removeEventListener('pointermove', this.handleMove);
    window.removeEventListener('pointerup', this.handleUp);
    this.el.removeEventListener('wheel', this.handleWheel);
  }

  private handleDown = (e: PointerEvent): void => {
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.downX = e.clientX; this.downY = e.clientY;
    this.moved = false;
    this.dragging = e.button === 2 ? 'pan' : 'rotate';
  };

  private handleMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 4) this.moved = true;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (this.dragging === 'rotate') {
      this.camera.yaw -= dx * 0.008;
      this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + dy * 0.008));
    } else {
      const scale = this.camera.distance * 0.0016;
      const right = v3.norm([Math.cos(this.camera.yaw), 0, -Math.sin(this.camera.yaw)]);
      const up: [number, number, number] = [0, 1, 0];
      this.camera.target = v3.add(
        this.camera.target,
        v3.add(v3.scale(right, -dx * scale), v3.scale(up, dy * scale)),
      );
    }
    this.onInteract?.();
  };

  private handleUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const wasClick = !this.moved && e.button === 0;
    this.dragging = null;
    if (wasClick) this.onLeftClick?.(e.clientX, e.clientY);
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.camera.distance = Math.max(20, Math.min(400, this.camera.distance * (1 + Math.sign(e.deltaY) * 0.09)));
    this.onInteract?.();
  };

  get isDrag(): boolean { return this.dragging !== null; }
}
