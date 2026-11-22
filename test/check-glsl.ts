// GLSL shader 静态配平检查(构建期守护,防止着色器括号笔误)
import { readFileSync } from 'node:fs';

const files = ['src/render/waterfall.ts', 'src/render/view3d.ts', 'src/render/gl-util.ts'];
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /`#version[\s\S]*?`/g;
  const glsl = [...src.matchAll(re)].map((m) => m[0]);
  for (const g of glsl) {
    const braces = [...g].reduce((a, c) => a + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
    const parens = [...g].reduce((a, c) => a + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
    const hasVersion = g.includes('#version 300 es');
    if (braces !== 0 || parens !== 0 || !hasVersion) {
      bad++;
      console.log(`UNBALANCED ${f} braces=${braces} parens=${parens} version=${hasVersion}`);
    }
  }
  console.log(`${f}: ${glsl.length} 个 shader, ${bad ? '存在错误' : '配平正常'}`);
}
process.exit(bad ? 1 : 0);
