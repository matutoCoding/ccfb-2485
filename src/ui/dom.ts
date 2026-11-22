// 极简 DOM 构建辅助

type EventMap<T extends HTMLElement> = {
  [K in keyof HTMLElementEventMap as `on${Capitalize<K & string>}`]?: (ev: HTMLElementEventMap[K] & { target: T }) => void;
};

export type HProps<T extends HTMLElement = HTMLElement> = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  [key: string]: unknown;
} & Partial<EventMap<T>>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else Object.assign(el.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in el) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement) {
  el.replaceChildren();
}

export function mount(el: HTMLElement) {
  const root = document.getElementById('app')!;
  const main = root.querySelector('main.page') as HTMLElement;
  clear(main);
  main.append(el);
}

export function toast(msg: string, ms = 2200) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function field(label: string, input: HTMLElement) {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

export function numberInput(value: number, step = 1, onInput: (v: number) => void) {
  const input = h('input', { type: 'number', step: String(step), value: String(value) });
  input.addEventListener('input', () => onInput(Number(input.value)));
  return input;
}

export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void) {
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const readout = h('span', { class: 'range-readout' }, value.toFixed(step < 1 ? 2 : 0));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = step < 1 ? v.toFixed(2) : String(Math.round(v));
    onInput(v);
  });
  return { input, readout, wrap: h('div', { class: 'row', style: 'gap:8px' }, input, readout) };
}
