// 地名标注表达式 + 样式合法性回归测试（跑法见 HANDOFF §4「地名标注表达式」条目）：
//   env -u NODE_OPTIONS node scripts/test-style-labels.mjs
// 用 Vite SSR 加载真实 styleFactory（?raw/?url 由 Vite 原生处理），
// 再拿 @maplibre/maplibre-gl-style-spec 校验整份样式与 text-field 表达式。
// 仅本地保留（.git/info/exclude），不入公开仓库。
import { createServer } from 'vite';
import { createExpression, createPropertyExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed++;
};

try {
  const { buildStyle, nameExpr, labelLayerIds } = await server.ssrLoadModule('/src/map/styleFactory.ts');

  for (const [label, lang, base, globe] of [
    ['latin/vector', 'latin', 'vector', false],
    ['latin/satellite', 'latin', 'satellite', false],
    ['zh/vector', 'zh', 'vector', false],
    ['zh/globe', 'zh', 'vector', true],
  ]) {
    const style = buildStyle(lang, base, globe);
    const res = validateStyleMin(style);
    check(`${label} 样式合法`, res.length === 0, res.slice(0, 2).map((e) => e.message).join(' | '));
    check(`${label} 层数 127`, style.layers.length === 127, `${style.layers.length}`);
    const ids = labelLayerIds(style);
    check(`${label} 标注层 20`, ids.length === 20, `${ids.length}`);
    const country = style.layers.find((l) => l.id === 'label_country_1');
    check(
      `${label} 国名层文本 === nameExpr`,
      JSON.stringify(country.layout['text-field']) === JSON.stringify(nameExpr(lang)),
      JSON.stringify(country.layout['text-field']).slice(0, 70),
    );
    // 该表达式按 text-field 的真实属性类型再校验一次
    const prop = createPropertyExpression(nameExpr(lang), { type: 'string', 'property-type': 'data-driven', default: '' });
    check(`${label} text-field 表达式类型合法`, prop.result === 'success', prop.result === 'error' ? JSON.stringify(prop.value) : '');
  }

  const evalName = (expr, props) =>
    createExpression(expr, { type: 'string' }).value.evaluate({ zoom: 4 }, { type: 'Feature', properties: props }, undefined, 0);

  const turkey = { name_en: 'T', 'name:latin': 'Türkiye', name: 'Türkiye', 'name:zh-Hans': '土耳其' };
  const germany = { name_en: 'Germany', 'name:latin': 'Deutschland', name: 'Deutschland' };
  const noEn = { 'name:latin': 'Deutschland', name: 'Deutschland' };
  const nameless = { class: 'river' };

  check('latin: Türkiye → Türkiye（上游 name_en 被截断为 T）', evalName(nameExpr('latin'), turkey) === 'Türkiye');
  check('latin: Germany → Germany', evalName(nameExpr('latin'), germany) === 'Germany');
  check('latin: 缺 name_en → name:latin', evalName(nameExpr('latin'), noEn) === 'Deutschland');
  check('latin: 无名字要素 → 空串（不产生 null）', evalName(nameExpr('latin'), nameless) === '');
  check('zh: Türkiye → 土耳其', evalName(nameExpr('zh'), turkey) === '土耳其');
  check('zh: 缺中文名 → 英文名', evalName(nameExpr('zh'), germany) === 'Germany');
} finally {
  await server.close();
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
// 不用 process.exit：本机 Git Bash 下管道/重定向的 stdout 是异步的，exit 会丢缓冲
process.exitCode = failed ? 1 : 0;
