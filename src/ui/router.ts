// hash 路由 + 应用外壳

import { h, clear } from './dom';
import { store } from '../data/store';
import { renderAreaPage } from './pages/area-page';
import { renderFishPage } from './pages/fish-page';
import { renderTransducerPage } from './pages/transducer-page';
import { renderEchoPage } from './pages/echo-page';
import { renderVoyagePage } from './pages/voyage-page';
import { renderSettingsPage } from './pages/settings-page';

export type RouteId = 'area' | 'fish' | 'transducer' | 'echo' | 'voyage' | 'settings';

const TABS: Array<[RouteId, string, string]> = [
  ['area', '海区场景', '#/area'],
  ['fish', '鱼群布放', '#/fish'],
  ['transducer', '换能器选型', '#/transducer'],
  ['echo', '回波显示', '#/echo'],
  ['voyage', '航次回放', '#/voyage'],
  ['settings', '设置', '#/settings'],
];

const RENDERERS: Record<RouteId, () => Promise<void> | void> = {
  area: renderAreaPage,
  fish: renderFishPage,
  transducer: renderTransducerPage,
  echo: renderEchoPage,
  voyage: renderVoyagePage,
  settings: renderSettingsPage,
};

export function currentRoute(): RouteId {
  const id = location.hash.replace('#/', '') as RouteId;
  return (TABS.some(([t]) => t === id) ? id : 'echo') as RouteId;
}

export function navigate(route: RouteId) {
  location.hash = `#/${route}`;
}

export async function router() {
  const route = currentRoute();
  const main = document.querySelector('main.page') as HTMLElement;
  clear(main);
  main.append(h('div', { class: 'muted' }, '加载中…'));
  await RENDERERS[route]();
  document.querySelectorAll('nav.tabs a').forEach((a) => {
    a.classList.toggle('active', (a as HTMLElement).dataset.route === route);
  });
}

export function renderShell(clockText: string) {
  const app = document.getElementById('app')!;
  clear(app);
  app.append(
    h(
      'header',
      { class: 'app-header' },
      h('h1', {}, h('span', { class: 'wave' }, '〜'), ' 探鱼器回波仿真系统'),
      h(
        'nav',
        { class: 'tabs' },
        ...TABS.map(([id, label, href]) =>
          h('a', { href, dataset: { route: id } }, label)
        )
      ),
      h('span', { class: 'clock-badge', id: 'global-clock' }, clockText)
    ),
    h('main', { class: 'page' })
  );
  window.addEventListener('hashchange', router);
}

export function setGlobalClock(text: string) {
  const el = document.getElementById('global-clock');
  if (el) el.textContent = text;
}

export { store };
