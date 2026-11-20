// 通用 UI 工具：DOM 构建、Toast、对话框、数字字段

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value') el.setAttribute('value', String(v));
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  let wrap = document.querySelector('.toast-wrap') as HTMLElement | null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.append(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind === 'info' ? '' : kind}`;
  t.textContent = msg;
  wrap.append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 320);
  }, 2600);
}

export function numField(
  label: string, value: number, step: number, onChange: (v: number) => void, min?: number, max?: number,
): HTMLLabelElement {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = String(step);
  inp.value = String(value);
  if (min !== undefined) inp.min = String(min);
  if (max !== undefined) inp.max = String(max);
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  const lab = document.createElement('label');
  lab.className = 'field';
  lab.append(span(label), inp);
  return lab;
}

export function slider(
  label: string, value: number, min: number, max: number, step: number,
  onChange: (v: number) => void, fmt: (v: number) => string = (v) => String(v),
): HTMLElement {
  const val = document.createElement('span');
  val.className = 'mono';
  val.textContent = fmt(value);
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(value);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    val.textContent = fmt(v);
    onChange(v);
  });
  const head = document.createElement('div');
  head.className = 'flex between center';
  head.append(span(label, 'dim small'), val);
  const wrap = document.createElement('div');
  wrap.append(head, inp);
  return wrap;
}

export function span(text: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = checked;
  inp.addEventListener('change', () => onChange(inp.checked));
  const lab = document.createElement('label');
  lab.className = 'flex gap8 center';
  lab.style.cursor = 'pointer';
  lab.append(inp, span(label));
  return lab;
}

export function select<T extends string>(
  label: string, value: T, options: { value: T; text: string }[], onChange: (v: T) => void,
): HTMLLabelElement {
  const sel = document.createElement('select');
  for (const o of options) {
    const op = document.createElement('option');
    op.value = o.value; op.textContent = o.text;
    if (o.value === value) op.selected = true;
    sel.append(op);
  }
  sel.addEventListener('change', () => onChange(sel.value as T));
  const lab = document.createElement('label');
  lab.className = 'field';
  lab.append(span(label), sel);
  return lab;
}

export function modal(title: string, body: HTMLElement, onOk: () => boolean | void): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  const head = document.createElement('h2');
  head.textContent = title;
  head.style.marginTop = '0';
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row mt16';
  btnRow.style.justifyContent = 'flex-end';
  const ok = document.createElement('button');
  ok.className = 'primary'; ok.textContent = '确定';
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  ok.addEventListener('click', () => {
    if (onOk() !== false) dlg.close();
  });
  cancel.addEventListener('click', () => dlg.close());
  btnRow.append(cancel, ok);
  dlg.append(head, body, btnRow);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
