// 端到端冒烟测试：启动真实浏览器逐页检查渲染、WebGL 与页面内自检
// 运行：先 npm run dev，再 npx tsx scripts/e2e-smoke.ts

import puppeteer from 'puppeteer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SIM_URL ?? 'http://localhost:5173';
const PAGES = ['area', 'school', 'transducer', 'echo', 'voyage', 'settings'];

const browser = await puppeteer.launch({
  headless: true,
  userDataDir: join(tmpdir(), `sonar-sim-puppeteer-${process.pid}`),
  args: [
    '--use-gl=angle', '--use-angle=gl', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--no-first-run', '--disable-extensions',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', (err) => pageErrors.push(`[pageerror] ${err.message}`));

let failures = 0;
const ok = (cond: boolean, name: string, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// 1. 首页加载 + IndexedDB 种子数据
await page.goto(`${BASE}/#/echo`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#nav-items .nav-item');
const navCount = await page.$$eval('#nav-items .nav-item', (els) => els.length);
ok(navCount === 6, '六个导航页面均注册', `实际 ${navCount}`);
await new Promise((r) => setTimeout(r, 1500));

// 2. 逐页渲染（设置页为表单/自检页，无 canvas，单独校验）
const canvasPages = PAGES.filter((k) => k !== 'settings');
for (const key of canvasPages) {
  await page.goto(`${BASE}/#/${key}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  const canvases = await page.$$eval('canvas', (els) =>
    els.map((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height })));
  const rendered = canvases.filter((c) => c.w > 0 && c.h > 0).length;
  ok(rendered > 0, `页面 /${key} 有画布成功渲染`, `${rendered}/${canvases.length} 个 canvas`);
}
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
ok(!!(await page.$('#test-host')), '页面 /settings 自检面板渲染');

// 3. 回波页：瀑布图持续滚动产生 ping 列
await page.goto(`${BASE}/#/echo`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2500));
const clockText1 = await page.$eval('#sim-clock', (el) => el.textContent);
await new Promise((r) => setTimeout(r, 2000));
const clockText2 = await page.$eval('#sim-clock', (el) => el.textContent);
ok(clockText1 !== clockText2, '回波页仿真时钟在推进', `${clockText1} → ${clockText2}`);
const wfCanvas = await page.$('#page-root canvas');
ok(!!wfCanvas, '回波页瀑布图 canvas 存在');

// 4. 设置页：运行页面内自检，全部通过
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
const buttons = await page.$$eval('button', (els) => els.map((b) => b.textContent ?? ''));
ok(buttons.some((t) => t.includes('运行全部自检')), '自检按钮存在');
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('运行全部自检'));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 2500));
const summary = await page.$eval('#test-host', (el) => el.querySelector('div')?.textContent ?? '');
const m = summary.match(/(\d+)\/(\d+) 项通过/);
ok(!!m, '页面内自检输出结论', summary);
if (m) ok(m[1] === m[2], `页面内自检全部通过 (${m[1]}/${m[2]})`);
const failRows = await page.$$eval('#test-host .test-fail', (els) => els.length);
ok(failRows === 0, '页面内无失败项', `${failRows} 个失败`);

// 5. 换能器页：双频对比瀑布图
await page.goto(`${BASE}/#/transducer`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));
const tdCanvases = await page.$$eval('canvas', (els) => els.length);
ok(tdCanvases >= 3, '换能器页三维+双瀑布图均渲染', `${tdCanvases} 个 canvas`);

// 6. 控制台错误（忽略 WebGL 软件渲染的常见无害告警）
const realErrors = [...consoleErrors, ...pageErrors].filter((e) =>
  !/WebGL|GPU|swiftshader|GroupMarker|Deprecation/i.test(e));
ok(realErrors.length === 0, '无运行时控制台错误', realErrors.slice(0, 5).join(' | ') || '干净');

await browser.close();
console.log(`\n${failures === 0 ? '全部冒烟测试通过' : `${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
