// 地名标注表达式 + 样式合法性回归测试（跑法见 HANDOFF §3）：
//   node scripts/test-style-labels.mjs
// 用 Vite SSR 加载真实 styleFactory / 行星层纯函数，再拿
// @maplibre/maplibre-gl-style-spec 校验整份样式与 text-field 表达式。
//
// 2026-10-27 主项目地图整合：底图换成 Flightline 已验收样式。
// 断言随之更新（层数 / 标注 id / 真实字段），但保留并扩展了行为检查：
// 语言表达式、标注组、卫星组、极区选片、亮暗主题。
// 不删除任何原有行为断言，也不放宽任何条件来“变绿”。
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
  const {
    buildStyle, nameExpr, labelLayerIds, routeAnchorLayerId, lightingAnchorLayerId, mapResourceUrl,
  } = await server.ssrLoadModule('/src/map/styleFactory.ts');
  const { satelliteTileSize } = await server.ssrLoadModule('/src/map/satelliteLod.ts');
  const { invertMat4, bakeLutR2, LUT_SIZE_R2 } = await server.ssrLoadModule('/src/map/flightline/planetLayer.ts');
  const { solarPosition, sunVector } = await server.ssrLoadModule('/src/map/flightline/sun.ts');
  const dn = await server.ssrLoadModule('/src/map/dayNight.ts');
  const routeStyle = await server.ssrLoadModule('/src/map/routeStyle.ts');
  const { STRINGS } = await server.ssrLoadModule('/src/i18n/strings.ts');

  // 相同屏幕球体大小，纬度拖向上/下限时相机 zoom 按 cos(lat) 降低。
  // 回归关键是大陆仍选择 z3，而不是全局掉到 z1。
  const cameraZoom = (lat) => 4.1 + Math.log2(Math.cos(lat * Math.PI / 180));
  const selectedZoom = (lat, size, globe = true) => Math.round(
    cameraZoom(lat) + Math.log2(512 / satelliteTileSize(size, lat, cameraZoom(lat), globe)),
  );
  check('极区精度：原始选片在极点退到 z1', selectedZoom(85.051129, 512, false) === 1);
  check('极区精度：60° 到南北纬度上限保持 z3',
    [60, 70, 80, 85.051129, -60, -70, -80, -85.051129].every((lat) => selectedZoom(lat, 512) === 3));
  check('极区精度：256px 卫星源也补偿', selectedZoom(85.051129, 256) === 4);
  check('极区精度：平面与中低纬保持原尺寸',
    satelliteTileSize(512, 85, 1, false) === 512 && satelliteTileSize(512, 45, 1, true) === 512);
  check('极区精度：近景不额外提升层级', satelliteTileSize(512, 85, 8, true) === 512);
  check('极区精度：补偿层级上限 z4',
    Math.abs(3.8 + Math.log2(512 / satelliteTileSize(512, 85, 3.8, true)) - 4) < 1e-10);

  // 资源前缀：MapLibre worker 要绝对地址；模板花括号必须保留
  const worldUrl = mapResourceUrl('tiles/world/{z}/{x}/{y}.pbf');
  check('资源前缀：绝对地址 + /map-res/', /^http:\/\/localhost\/map-res\/tiles\/world\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(worldUrl), worldUrl);
  check('资源前缀：glyphs 指向主项目字体接口',
    buildStyle('latin', 'vector', false).glyphs.includes('/map-res/fonts/{fontstack}/{range}.pbf'));

  const expectedLayers = 76; // 73 base + 1 影像 + 2 水面
  for (const [label, lang, base, globe, dark] of [
    ['latin/vector/dark', 'latin', 'vector', false, true],
    ['latin/satellite/dark', 'latin', 'satellite', false, true],
    ['zh/vector/dark', 'zh', 'vector', false, true],
    ['zh/globe/dark', 'zh', 'vector', true, true],
    ['zh/vector/light', 'zh', 'vector', false, false],
  ]) {
    const style = buildStyle(lang, base, globe, dark);
    const res = validateStyleMin(style);
    check(`${label} 样式合法`, res.length === 0, res.slice(0, 2).map((e) => e.message).join(' | '));
    check(`${label} 层数 ${expectedLayers}`, style.layers.length === expectedLayers, `${style.layers.length}`);
    const ids = labelLayerIds(style);
    check(`${label} 标注层 11`, ids.length === 11, `${ids.length}`);
    const country = style.layers.find((l) => l.id === 'places_country');
    check(
      `${label} 国名层文本 === nameExpr`,
      JSON.stringify(country.layout['text-field']) === JSON.stringify(nameExpr(lang)),
      JSON.stringify(country.layout['text-field']).slice(0, 70),
    );
    check(`${label} 所有标注层共用名字表达式`,
      ids.every((id) => {
        const l = style.layers.find((x) => x.id === id);
        return JSON.stringify(l.layout['text-field']) === JSON.stringify(nameExpr(lang));
      }));
    // 该表达式按 text-field 的真实属性类型再校验一次
    const prop = createPropertyExpression(nameExpr(lang), { type: 'string', 'property-type': 'data-driven', default: '' });
    check(`${label} text-field 表达式类型合法`, prop.result === 'success', prop.result === 'error' ? JSON.stringify(prop.value) : '');
    // 组划分：base 62 / labels 11 / satellite 3
    const groups = style.layers.reduce((m, l) => ((m[l.metadata?.group] = (m[l.metadata?.group] || 0) + 1), m), {});
    check(`${label} 组划分`, groups.base === 62 && groups.labels === 11
      && groups.satellite === 3, JSON.stringify(groups));
    // 默认隐藏层必须带标记（翻组时不能设回可见）
    check(`${label} 默认隐藏层标记`,
      ['occlusion-depth-cutoff', 'relief'].every((id) => {
        const l = style.layers.find((x) => x.id === id);
        return l.metadata?.hiddenByDefault === true && l.layout?.visibility === 'none';
      }));
    // 卫星影像/水面的初始可见性：vector 全隐，satellite 显示主影像与水面
    const sat = style.layers.find((l) => l.id === 'satellite');
    const water = style.layers.find((l) => l.id === 'water-ocean');
    const expectSat = base === 'satellite';
    check(`${label} 卫星层初始显隐`, (sat.layout.visibility === 'visible') === expectSat);
    check(`${label} 水面层随卫星组`, (water.layout.visibility === 'visible') === (base === 'satellite'));
    // 卫星水面必须引用独立的 OpenFreeMap 源（不能误用 Flightline world 源）
    check(`${label} 卫星水面源独立（固定瓦片模板，无 TileJSON 请求）`, style.sources.openmaptiles?.type === 'vector'
      && !style.sources.openmaptiles.url
      && style.sources.openmaptiles.tiles[0] === 'https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf'
      && style.sources.openmaptiles.maxzoom === 14
      && style.layers.find((l) => l.id === 'water-ocean').source === 'openmaptiles');
    // 航线插入锚点：必须在行星光照与 buildings-3d 之后（不能被整屏暗化压住）
    const anchor = routeAnchorLayerId(style);
    const index = (id) => style.layers.findIndex((l) => l.id === id);
    check(`${label} 航线锚点在光照/建筑之上`,
      anchor === 'address_label' && index(anchor) > index(lightingAnchorLayerId(style)) && index(anchor) > index('buildings-3d'),
      `${anchor}@${index(anchor)} > ${index(lightingAnchorLayerId(style))}/${index('buildings-3d')}`);
  }

  const evalName = (expr, props) =>
    createExpression(expr, { type: 'string' }).value.evaluate({ zoom: 4 }, { type: 'Feature', properties: props }, undefined, 0);

  // 真实 MVT 字段带冒号；本地名称不能覆盖所选语言，也不能在缺译名时混排。
  const turkey = { 'name:en': 'Turkey', name_en: 'T', name: 'Türkiye', 'name:zh-Hans': '土耳其' };
  const germany = { 'name:en': 'Germany', name: 'Deutschland', 'name:zh-Hans': '德国' };
  const noEn = { name: 'Deutschland' };
  const hant = { 'name:zh-Hant': '德國', name: 'Germany' };
  const nameless = { kind: 'river' };

  check('latin: 冒号英文名优先于截断旧字段和当地名称', evalName(nameExpr('latin'), turkey) === 'Turkey');
  check('latin: Deutschland → Germany（真实 name:en）', evalName(nameExpr('latin'), germany) === 'Germany');
  check('latin: 缺英文译名不回退 Deutschland', evalName(nameExpr('latin'), noEn) === '');
  check('latin: 无名字要素 → 空串（不产生 null）', evalName(nameExpr('latin'), nameless) === '');
  check('zh: Türkiye → 土耳其', evalName(nameExpr('zh'), turkey) === '土耳其');
  check('zh: 缺简体名 → 繁体名', evalName(nameExpr('zh'), hant) === '德國');
  check('zh: Deutschland → 德国', evalName(nameExpr('zh'), germany) === '德国');
  check('zh: 缺中文译名不回退当地语言或英文', evalName(nameExpr('zh'), { name: 'مصر', 'name:en': 'Egypt' }) === '');
  check('latin: 上海市 → Shanghai，屏蔽当地汉字', evalName(nameExpr('latin'), { name: '上海市', 'name:en': 'Shanghai' }) === 'Shanghai');
  check('latin: 空冒号字段允许旧英文别名，单字截断别名不显示',
    evalName(nameExpr('latin'), { 'name:en': '', name_en: 'Germany' }) === 'Germany'
    && evalName(nameExpr('latin'), { name_en: 'T', name: 'Türkiye' }) === '');
  check('zh: 空简体字段继续使用中文通用字段',
    evalName(nameExpr('zh'), { 'name:zh-Hans': '', 'name:zh': '东京', name: '東京' }) === '东京');

  // 行星层：矩阵求逆（替代 demo 的全局 glMatrix，必须与标准逆一致）
  {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const inv = new Float32Array(16);
    check('矩阵：单位阵求逆成功', invertMat4(inv, identity) && [...inv].every((v, i) => v === identity[i]));
    const m = new Float32Array([
      0.8, 0.1, 0.0, 0.0,
      -0.2, 0.9, 0.0, 0.0,
      0.0, 0.0, 1.2, 0.0,
      12, -7, 3, 1,
    ]);
    const mi = new Float32Array(16);
    check('矩阵：一般矩阵求逆成功', invertMat4(mi, m));
    // 乘积应接近单位阵（列主序）
    const p = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += m[k * 4 + r] * mi[c * 4 + k];
        p[c * 4 + r] = s;
      }
    }
    check('矩阵：M × M⁻¹ ≈ I', [...p].every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-5), [...p].map((v) => v.toFixed(3)).join(','));
    check('矩阵：奇异矩阵返回 false', invertMat4(new Float32Array(16), new Float32Array(16)) === false);
  }

  // 终止线 LUT：尺寸与预乘 alpha 方向
  {
    const lut = bakeLutR2();
    check('LUT：256 texel × RGBA', lut.length === LUT_SIZE_R2 * 4 && LUT_SIZE_R2 === 256);
    const alpha0 = lut[3];
    const alphaLast = lut[(LUT_SIZE_R2 - 1) * 4 + 3];
    check('LUT：夜侧 alpha 高于昼侧', alpha0 > alphaLast, `${alpha0} > ${alphaLast}`);
    check('LUT：预乘（夜侧 RGB ≤ alpha）',
      lut[0] <= lut[3] && lut[1] <= lut[3] && lut[2] <= lut[3], `${lut[0]},${lut[1]},${lut[2]} ≤ ${lut[3]}`);
  }

  // 太阳位置：真实 UTC 向量（单位长度、直射纬度在回归线内）
  {
    const { sun, timeDays } = sunVector(Date.UTC(2026, 5, 21, 12, 0, 0));
    const len = Math.hypot(sun[0], sun[1], sun[2]);
    check('太阳：向量单位长度', Math.abs(len - 1) < 1e-9, `${len}`);
    check('太阳：时角在 [0,1)', timeDays >= 0 && timeDays < 1, `${timeDays}`);
    const p = solarPosition(Date.UTC(2026, 5, 21, 12, 0, 0));
    check('太阳：夏至直射纬度 ≈ 23.4°', Math.abs(p.latDeg - 23.44) < 0.6, `${p.latDeg.toFixed(2)}`);
    const winter = solarPosition(Date.UTC(2026, 11, 21, 12, 0, 0));
    check('太阳：冬至直射南回归线', Math.abs(winter.latDeg + 23.44) < 0.6, `${winter.latDeg.toFixed(2)}`);
  }

  // 昼夜光照 + 手动 UTC：拖动手动值后，真实 60 s 时钟重算不得改写时刻
  {
    const base = Date.UTC(2026, 9, 27, 10, 0, 0);
    const manual = 13.5;
    const e1 = dn.sunEpochMs(base, manual);
    const e2 = dn.sunEpochMs(base + 60_000, manual);
    check('昼夜：手动时刻跨 60s 重算保持不变',
      e1 === e2 && new Date(e1).getUTCHours() === 13 && new Date(e1).getUTCMinutes() === 30);
    check('昼夜：未手动时跟随真实时刻', dn.sunEpochMs(base, null) === base);
    const nextDay = dn.sunEpochMs(Date.UTC(2026, 9, 27, 23, 50), 24);
    check('昼夜：24:00 归一为次日 00:00',
      new Date(nextDay).toISOString() === '2026-10-28T00:00:00.000Z', new Date(nextDay).toISOString());
    check('昼夜：拒绝 NaN/空串/越界',
      dn.normalizeUtcHours(NaN) === null && dn.normalizeUtcHours('') === null
      && dn.normalizeUtcHours(-0.1) === null && dn.normalizeUtcHours(24.1) === null);
    check('昼夜：合法字符串与 24 归一',
      dn.normalizeUtcHours('13.5') === 13.5 && dn.normalizeUtcHours(24) === 0);
    check('昼夜：HH:mm 显示（含 0.1h=6min）',
      dn.formatUtcHours(13.5) === '13:30' && dn.formatUtcHours(0.1) === '00:06' && dn.formatUtcHours(24) === '00:00');
    check('昼夜：直接输入时刻（HH:mm/HHmm/小数小时/24:00 归一）',
      dn.parseClockInput('14:30') === 14.5
      && dn.parseClockInput('1430') === 14.5
      && dn.parseClockInput('930') === 9.5
      && dn.parseClockInput('7') === 7
      && dn.parseClockInput('14.5') === 14.5
      && dn.parseClockInput('24:00') === 0
      && dn.parseClockInput(' 08:05 ') === 8 + 5 / 60);
    check('昼夜：非法输入返回 null（保持原值，不改太阳）',
      dn.parseClockInput('') === null && dn.parseClockInput('25:00') === null
      && dn.parseClockInput('12:60') === null && dn.parseClockInput('abc') === null
      && dn.parseClockInput('12345') === null);
    check('昼夜：时区后缀文本', dn.utcOffsetLabel(0) === 'UTC'
      && dn.utcOffsetLabel(8) === 'UTC+8' && dn.utcOffsetLabel(-5) === 'UTC-5');
    check('昼夜：时区换算（含跨日）与往返', (() => {
      const east = dn.toLocalHours(12, 8); // 12 UTC → 20:00 UTC+8
      const west = dn.toLocalHours(0, -5); // 0 UTC → 19:00 前一日 UTC-5
      return east === 20 && west === 19
        && dn.toUtcHours(east, 8) === 12
        && dn.toUtcHours(20, 8) === 12
        && dn.toUtcHours(19, -5) === 0;
    })());
    check('昼夜：时区偏移归一（越界/坏值回 UTC）',
      dn.normalizeUtcOffset(-12) === -12 && dn.normalizeUtcOffset(14) === 14
      && dn.normalizeUtcOffset('8') === 8 && dn.normalizeUtcOffset(8.4) === 8
      && dn.normalizeUtcOffset(15) === 0 && dn.normalizeUtcOffset(NaN) === 0);
    const off = dn.dayNightUniforms(false);
    const on = dn.dayNightUniforms(true);
    check('昼夜：关闭时 u_cycle/u_lights 归零，开启恢复',
      off.cycle === 0 && off.lights === 0 && on.cycle === 1 && on.lights === 1);
    check('昼夜：关闭只取消暗化/夜路，行星材质层仍激活',
      dn.planetActiveFor('vector') === true
      && dn.roadsEnabled(false, 'vector') === false
      && dn.roadsEnabled(true, 'vector') === true
      && dn.roadsEnabled(true, 'satellite') === false);
    check('昼夜：手动时刻的 timeDays 等于所选小时/24', (() => {
      const { timeDays } = sunVector(dn.sunEpochMs(base, manual));
      return Math.abs(timeDays - manual / 24) < 1e-9;
    })());
  }

  // 航线 demo 外观：glow + core 同源成对；宽度倍率同时缩放两层
  {
    const ids = routeStyle.routeLayerIds('rt-x');
    const [glow, core] = routeStyle.routeLineLayers('rt-x', ids.source, '#d9e9b4', 1);
    check('航线：glow 在 core 之前且共用 source',
      glow.id === ids.glow && core.id === ids.core && glow.source === ids.source && core.source === ids.source);
    check('航线：demo 基准 core 1.3/.75、glow 6/.09/blur3',
      core.paint['line-width'] === 1.3 && core.paint['line-opacity'] === 0.75
      && glow.paint['line-width'] === 6 && glow.paint['line-opacity'] === 0.09
      && glow.paint['line-blur'] === 3);
    const wide = routeStyle.routeGlowPaint('#64b9bc', 2);
    const wideCore = routeStyle.routeCorePaint('#64b9bc', 2);
    check('航线：粗细倍率同时缩放 glow/core',
      wide['line-width'] === 12 && wideCore['line-width'] === 2.6
      && wide['line-color'] === '#64b9bc' && wideCore['line-color'] === '#64b9bc');
    check('航线：新航线默认色前两色为 demo 浅黄绿/青',
      routeStyle.ROUTE_COLORS[0] === '#d9e9b4' && routeStyle.ROUTE_COLORS[1] === '#64b9bc');
    check('航线：中英色名与色板等长',
      STRINGS.zh.colorNames.length === routeStyle.ROUTE_COLORS.length
      && STRINGS.en.colorNames.length === routeStyle.ROUTE_COLORS.length);
  }
} finally {
  await server.close();
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
// 不用 process.exit：本机 Git Bash 下管道/重定向的 stdout 是异步的，exit 会丢缓冲
process.exitCode = failed ? 1 : 0;
