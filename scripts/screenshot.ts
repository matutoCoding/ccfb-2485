// 截图脚本：把六个页面存到 scripts/shots/，便于人工核对视觉效果
// 运行：SIM_URL=http://localhost:5174 npx tsx scripts/screenshot.ts

import puppeteer from 'puppeteer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.SIM_URL ?? 'http://localhost:5173';
const outDir = join(process.cwd(), 'scripts', 'shots');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  userDataDir: join(tmpdir(), `sonar-shots-${process.pid}`),
  args: ['--use-gl=angle', '--use-angle=gl', '--enable-unsafe-swiftshader', '--no-sandbox', '--no-first-run'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1050 });

const targets: [string, number][] = [
  ['echo', 12000],
  ['area', 1200],
  ['school', 1200],
  ['transducer', 2500],
  ['voyage', 2500],
  ['settings', 1500],
];

for (const [key, wait] of targets) {
  await page.goto(`${BASE}/#/${key}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, wait));
  if (key === 'settings') {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('运行全部自检'))?.click();
    });
    await new Promise((r) => setTimeout(r, 2500));
  }
  const buf = await page.screenshot();
  const file = join(outDir, `${key}.png`);
  writeFileSync(file, buf);
  console.log('saved', file);
}
await browser.close();
console.log('done');
