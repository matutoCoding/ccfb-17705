// 极简 DOM 构造辅助，保持零依赖
export type El = HTMLElement;

type AttrValue = string | number | boolean | undefined | null | Function;
type Attrs = Record<string, AttrValue>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false | (Node | string | null | undefined | false)[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: El): void {
  el.replaceChildren();
}

export function mount(el: El, node: Node): void {
  el.replaceChildren(node);
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  return h('button', { class: cls, onClick, text: label });
}

export function num(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export function download(filename: string, buffer: ArrayBuffer, mime = 'application/octet-stream'): void {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const box = document.getElementById('toast-box') ?? (() => {
    const b = h('div', { id: 'toast-box', class: 'toast-box' });
    document.body.append(b);
    return b;
  })();
  const item = h('div', { class: `toast toast-${kind}`, text: msg });
  box.append(item);
  setTimeout(() => item.remove(), 3600);
}
