// 应用入口：侧边导航 + hash 路由

import './styles.css';
import { store } from './core/store';
import { h, span } from './ui/dom';
import { renderAreaPage } from './pages/area';
import { renderSchoolPage } from './pages/school';
import { renderTransducerPage } from './pages/transducer';
import { renderEchoPage } from './pages/echo';
import { renderVoyagePage } from './pages/voyage';
import { renderSettingsPage } from './pages/settings';

const PAGES = [
  { key: 'area', ico: '🗺️', name: '海区场景', render: renderAreaPage },
  { key: 'school', ico: '🐟', name: '鱼群布放', render: renderSchoolPage },
  { key: 'transducer', ico: '📡', name: '换能器选型', render: renderTransducerPage },
  { key: 'echo', ico: '🌊', name: '回波显示', render: renderEchoPage },
  { key: 'voyage', ico: '🧭', name: '航次回放', render: renderVoyagePage },
  { key: 'settings', ico: '⚙️', name: '设置 / 自检', render: renderSettingsPage },
] as const;

type PageKey = (typeof PAGES)[number]['key'];

function currentKey(): PageKey {
  const k = (location.hash.replace('#/', '') || 'echo') as PageKey;
  return PAGES.some((p) => p.key === k) ? k : 'echo';
}

function renderNav(active: PageKey): void {
  const nav = document.getElementById('nav-items')!;
  nav.replaceChildren();
  for (const p of PAGES) {
    const item = h('div', {
      class: `nav-item ${p.key === active ? 'active' : ''}`,
      onclick: () => { location.hash = `#/${p.key}`; },
    }, h('span', { class: 'ico' }, p.ico), span(p.name));
    nav.append(item);
  }
  const footer = document.getElementById('nav-footer')!;
  if (store.data) {
    footer.replaceChildren();
    footer.append(
      h('div', { class: 'stat' }, span('海区'), span(store.area?.name ?? '—', 'mono')),
      h('div', { class: 'stat' }, span('数据存储'), span('IndexedDB')),
    );
  }
}

async function route(): Promise<void> {
  if (!store.data) return;
  const key = currentKey();
  renderNav(key);
  const root = document.getElementById('page-root')!;
  root.replaceChildren();
  const page = PAGES.find((p) => p.key === key)!;
  const dispose = await page.render(root);
  // 路由切换时释放旧页面资源
  window.addEventListener('hashchange', function onLeave() {
    dispose?.();
    window.removeEventListener('hashchange', onLeave);
  }, { once: true });
}

window.addEventListener('hashchange', route);

store.init().then(() => {
  if (!location.hash) location.hash = '#/echo';
  route();
  store.sub(() => {
    renderNav(currentKey());
  });
}).catch((e) => {
  document.getElementById('page-root')!.textContent = '初始化失败：' + (e as Error).message;
  console.error(e);
});
