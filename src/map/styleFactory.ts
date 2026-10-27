// 底图样式：Flightline 已验收地图（round-11 冻结输入）+ 运行时适配。
//
// 2026-10-27 主项目整合：原先 design-assets 的 Apple/OpenFreeMap 矢量样式退出运行时，
// vector 槽位改由已验收的 Flightline 底图承担（用户授权“直接把原先的矢量图替代了”）。
// 样式本体是候选 styles/dark.json / light.json 的原样副本（SHA 见 REVIEW-REQUEST），
// 本文件只做接入主项目所需的适配，不重调已过的配色：
//   1. 样式内所有资源（瓦片 / glyphs / 道路 / 行星纹理）改走主项目自己的 /map-res/ 前缀；
//   2. 逐层打 metadata.group（base / satellite / labels），供 MapController.setBase 翻可见性；
//   3. 名字类标注层换成按真实字段（name:en / name:zh-Hans / name）构造的双语表达式；
//   4. 插入卫星影像层 + 矢量水面层（卫星组；OpenFreeMap 的 water 多边形仅服务卫星水面）；
//   5. 记录默认隐藏层（occlusion-depth-cutoff / relief），翻组时不得把它们设回可见。
//
// 卫星影像保留 MapTiler/Esri、极区选片补偿与水面显隐。

import type { StyleSpecification } from 'maplibre-gl';
import darkRaw from './flightline/styles/dark.json?raw';
import lightRaw from './flightline/styles/light.json?raw';
import { STATIC_MAP, staticResourceUrl } from './flightline/resourceMode';

export type LabelLanguage = 'latin' | 'zh';
export type BaseMode = 'vector' | 'satellite';

// 地图资源前缀：dev / preview 由 server/mapResources.mjs 同源托管；支持 Vite base 子路径。
// MapLibre 的 worker 构造 Request 时没有 document base URL，所以这里必须给出绝对地址。
const PAGE_HREF = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';

export function mapResourceUrl(pathname: string): string {
  if (STATIC_MAP) return staticResourceUrl(pathname.replace(/^\/+/, ''));
  const base = import.meta.env.BASE_URL || '/';
  const url = new URL(`${base}map-res/${pathname.replace(/^\/+/, '')}`, PAGE_HREF).href;
  return url.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

// ---------------------------------------------------------------------------
// 卫星影像（并行工作，语义未改）
// ---------------------------------------------------------------------------
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// 卫星影像：MapTiler satellite-v2（2026-10-26 换源——Stadia 把影像挪出免费套餐，403 "Upgrade
// for Access"），瓦片走 gsat:// 协议经 oceanTint 做陆地色彩管线；海面由本文件注入的矢量水面
// 层负责（逐像素判海会在深色森林上出"水坑"，已废）。
// key 绝不入库（公开仓库合规），两级来源：
//   ① 构建期内置：本地构建读 .env.local 的 VITE_MAPTILER_KEY（桌面版同源）；
//   ② 运行时用户填入：公开构建（CI/Release 无 key）在菜单里填自己的 key，
//      只存浏览器 localStorage（不进 URL、不进仓库），gsat 协议处理器动态读取。
// 两者都没有时回退免 key 的 Esri World Imagery。
export const BAKED_MAPTILER_KEY = ((import.meta.env.VITE_MAPTILER_KEY as string | undefined) ?? '').trim();
export const MAPTILER_KEY_STORAGE = 'gcmap.maptilerkey';

let runtimeKey = '';
if (typeof localStorage !== 'undefined') {
  try { runtimeKey = localStorage.getItem(MAPTILER_KEY_STORAGE) ?? ''; } catch { /* 隐私模式等：当无 key */ }
}

/** 当前生效的 MapTiler key：构建期内置优先，其次用户运行时填入的（gsat 协议处理器每次取瓦片时动态调用） */
export function activeMapTilerKey(): string {
  return BAKED_MAPTILER_KEY || runtimeKey;
}

/** 公开构建（无内置 key）才提供"填入自己的 key"入口；
 *  本地/桌面带 key 版本不显示该 UI。 */
export const KEY_EDITABLE = !BAKED_MAPTILER_KEY;

/** 用户运行时填入 key：写 localStorage 持久化 + 热更新 gsat 协议取值 */
export function setRuntimeMapTilerKey(key: string): void {
  runtimeKey = key;
  try {
    if (key) localStorage.setItem(MAPTILER_KEY_STORAGE, key);
    else localStorage.removeItem(MAPTILER_KEY_STORAGE);
  } catch { /* 隐私模式：本会话仍生效，刷新后丢失 */ }
}

export function hasRuntimeMapTilerKey(): boolean {
  return !!runtimeKey;
}

/** 验证 key 可用性。两级判据：
 *  ① 形状校验：MapTiler key 是 8-64 位 URL 安全串，明显垃圾本地立即拒绝（不做 UUID 式强校验——
 *     MapTiler key 长度/字符集不统一，实测存在 20 位混合大小写）；
 *  ② 抓一张卫星瓦片探测连通性（401/403 归为无效）。
 *  ⚠ 客户端无法证明 key 的套餐/额度状态，只能挡"手滑输错/粘错"和探测断网。 */
export type MapTilerKeyCheck = 'ok' | 'invalid' | 'network';

const MAPTILER_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export async function validateMapTilerKey(key: string): Promise<MapTilerKeyCheck> {
  if (!MAPTILER_KEY_RE.test(key)) return 'invalid';
  try {
    const resp = await fetch(
      `https://api.maptiler.com/tiles/satellite-v2/1/1/0.jpg?key=${encodeURIComponent(key)}`,
    );
    return resp.ok ? 'ok' : 'invalid';
  } catch {
    return 'network';
  }
}

const MAPTILER_ATTRIBUTION = '© MapTiler © OpenStreetMap contributors';

// 矢量水面层配色（卫星模式铺在影像上；藏蓝 = 旧 gcimg 调色的定稿目标色）
// 不透明度 0.64（2026-10-26 用户定稿）：半透明让真实卫星水面纹理透出，同时保留藏蓝氛围；
// 水面边界来自 OSM 数据，调多低都不会误染陆地。
const WATER_OCEAN_COLOR = '#233466';
const WATER_OTHER_COLOR = '#29407a';
const WATER_OPACITY = 0.64;

// 所有底图和主题统一使用白字黑边，避免深色地名在地表材质上失去对比度。
const PLACE_TEXT_COLOR = '#FFFFFF';
const PLACE_TEXT_HALO = '#000000';

// 3D 地球的 sky：与 demo `setup()` 完全一致——全透明、atmosphere-blend 0。
// demo 的太空/大气只由 PlanetLayer 的 halo/haze 绘制；MapLibre 自带 sky/atmosphere
// 若保留，会在地球边缘（尤其左上角）叠出一大片外扩辉光，与 demo 不一致。
export const GLOBE_SKY = {
  'sky-color': 'rgba(0,0,0,0)',
  'horizon-color': 'rgba(0,0,0,0)',
  'fog-color': 'rgba(0,0,0,0)',
  'fog-ground-blend': 0,
  'atmosphere-blend': 0,
};
export const FLAT_SKY = {
  'sky-color': 'rgba(0,0,0,0)',
  'horizon-color': 'rgba(0,0,0,0)',
  'fog-color': 'rgba(0,0,0,0)',
  'fog-ground-blend': 0,
  'atmosphere-blend': 0,
};

/** 空字段也视为缺失，继续查找同一语言的其它字段。
 *  先转字符串，避免字段不存在时对 null 求 length。 */
function translatedName(field: string, fallback: any, minLength = 1): any {
  const value = ['to-string', ['get', field]];
  return ['case', ['>=', ['length', value], minLength], value, fallback];
}

/** Protomaps 的语言字段用冒号：name:en / name:zh-Hans，而 name 是当地语言。
 *  只使用所选语言的译名；缺译名时留空，避免回退 name 后重新混入各国语言。
 *  兼容旧 name_en，但拒绝历史上被截断为单字符的值。 */
export function nameExpr(lang: LabelLanguage): any {
  const fields = lang === 'zh'
    ? ['name:zh-Hans', 'name:zh', 'name:zh-Hant', 'name_zh']
    : ['name:en', 'name_en'];
  return fields.reduceRight<any>((fallback, field) =>
    translatedName(field, fallback, field === 'name_en' ? 2 : 1), '');
}

/** text-field 是否取自 name 类字段（路网箭头 / 纯图标层不算） */
function isNameLabel(textField: unknown): boolean {
  return textField != null && JSON.stringify(textField).includes('"name');
}

// 各标注层矢量模式配色（卫星切白后恢复用；每次 buildStyle 重建）
const LABEL_PAINT_DEFAULTS: Record<string, { color: string; halo: string }> = {};

// gsat 瓦片 URL 版本号：换 key 时自增。key 不体现在 URL 里，不带版本号的话 maplibre
// 会命中瓦片缓存继续用旧 key 抓回的图；协议 URL 容忍 ?v=<n> 后缀（oceanTint 正则兼容）
let satTileVer = 0;
export function bumpSatTileVersion(): void {
  satTileVer++;
}

/** MapTiler 卫星源规格（gsat:// 协议 + 陆地色彩管线）；buildStyle 初始构建与换 key 重建共用 */
export function maptilerSourceSpec(): any {
  return {
    type: 'raster',
    tiles: [`gsat://{z}/{x}/{y}${satTileVer ? `?v=${satTileVer}` : ''}`],
    tileSize: 512,
    maxzoom: 18,
    attribution: MAPTILER_ATTRIBUTION,
  };
}

export function satelliteSourceSpec(): any {
  if (activeMapTilerKey()) return maptilerSourceSpec();
  return {
    type: 'raster',
    tiles: [ESRI_IMAGERY],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  };
}

/** 所有样式资源统一改走主项目资源前缀（绝对地址，worker 可用） */
function rewriteResourceUrls(style: any): void {
  style.glyphs = mapResourceUrl('fonts/{fontstack}/{range}.pbf');
  const sourceUrls: Record<string, string> = {
    world: mapResourceUrl('tiles/world/{z}/{x}/{y}.pbf'),
    bathymetry: mapResourceUrl('tiles/bathymetry/{z}/{x}/{y}.pbf'),
    buildings: mapResourceUrl('tiles/buildings/{z}/{x}/{y}.pbf'),
    dem: mapResourceUrl('tiles/terrain/{z}/{x}/{y}.png'),
  };
  for (const [id, url] of Object.entries(sourceUrls)) {
    const source = style.sources[id];
    if (source && Array.isArray(source.tiles)) source.tiles = [url];
  }
}

export function buildStyle(
  lang: LabelLanguage = 'latin',
  base: BaseMode = 'vector',
  globe = false,
  dark = true,
): StyleSpecification {
  const style = JSON.parse(dark ? darkRaw : lightRaw) as any;
  for (const k of Object.keys(LABEL_PAINT_DEFAULTS)) delete LABEL_PAINT_DEFAULTS[k];
  rewriteResourceUrls(style);

  if (globe) {
    style.projection = { type: 'globe' };
    style.sky = { ...GLOBE_SKY };
  }

  // 默认隐藏层（候选样式的深度裁剪/晕染默认 visibility:none）：翻组时不得设回可见。
  const hiddenByDefault = new Set<string>();
  for (const layer of style.layers) {
    if (layer.layout?.visibility === 'none') hiddenByDefault.add(layer.id);
  }

  const name = nameExpr(lang);
  for (const layer of style.layers) {
    const isLabel =
      layer.type === 'symbol' && isNameLabel(layer.layout?.['text-field']);
    layer.metadata = {
      ...(layer.metadata ?? {}),
      group: isLabel ? 'labels' : 'base',
      ...(hiddenByDefault.has(layer.id) ? { hiddenByDefault: true } : {}),
    };
    if (!isLabel) {
      // ?base=satellite 直开时先把 base 组收起来：等 onReady 再收会露出矢量底图。
      if (base === 'satellite') {
        layer.layout = { ...(layer.layout ?? {}), visibility: 'none' };
      }
      continue;
    }
    layer.layout = layer.layout ?? {};
    layer.paint = layer.paint ?? {};
    layer.layout['text-field'] = name;
    layer.paint['text-color'] = PLACE_TEXT_COLOR;
    layer.paint['text-halo-color'] = PLACE_TEXT_HALO;
    layer.paint['text-halo-width'] = 1;
    layer.paint['text-halo-blur'] = 0;
    LABEL_PAINT_DEFAULTS[layer.id] = {
      color: PLACE_TEXT_COLOR,
      halo: PLACE_TEXT_HALO,
    };
  }

  // 卫星影像：插在 background 之后（与 base 组互斥，?base=satellite 直开时内置可见避免闪白）。
  const satVisible = base === 'satellite';
  style.layers.splice(1, 0, {
    id: 'satellite',
    type: 'raster',
    source: 'satellite-imagery',
    metadata: { group: 'satellite' },
    layout: { visibility: satVisible ? 'visible' : 'none' },
    paint: { 'raster-opacity': 1 },
  });
  // 矢量水面层紧跟影像之后：海洋/湖河水域用成品多边形铺色，不逐像素判海
  //（判据会把深色森林误判成海——2026-10-26 换源 MapTiler 后在泰加林/雨林实测实锤）。
  // 与 satellite 同组，setBase 翻组时一起显隐。
  // Flightline 底图自身的水面来自 world 矢量源；这里的 OpenFreeMap water 源只服务卫星模式，
  // 不能改用 world 源（字段/覆盖不同会把卫星水面弄丢）。
  const waterVisible = satVisible;
  style.layers.splice(2, 0, {
    id: 'water-ocean',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'water',
    metadata: { group: 'satellite' },
    layout: { visibility: waterVisible ? 'visible' : 'none' },
    filter: ['==', ['get', 'class'], 'ocean'],
    paint: { 'fill-color': WATER_OCEAN_COLOR, 'fill-opacity': WATER_OPACITY },
  }, {
    id: 'water-other',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'water',
    metadata: { group: 'satellite' },
    layout: { visibility: waterVisible ? 'visible' : 'none' },
    filter: ['!=', ['get', 'class'], 'ocean'],
    paint: { 'fill-color': WATER_OTHER_COLOR, 'fill-opacity': WATER_OPACITY },
  });
  style.sources['satellite-imagery'] = satelliteSourceSpec();
  // 卫星水面所需的 OpenFreeMap 矢量源（免 key；只被 water-ocean/water-other 引用）。
  // 用固定快照的 tiles 模板而不是 url：TileJSON 会在每次样式加载时被请求（vector 模式
  // 也会请求，网络失败就污染地图错误通道），且线上快照会漂移。水面层隐藏时 MapLibre
  // 不会请求瓦片，因此 vector 模式完全不外联；卫星模式的 z14 以上由 MapLibre overzoom。
  style.sources.openmaptiles = {
    type: 'vector',
    tiles: ['https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: 14,
    attribution: '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap',
  };

  return style as unknown as StyleSpecification;
}

/** 标注层 id 列表（语言切换 / 配色切换都作用在这组；路网箭头等 base 组 symbol 不在内） */
export function labelLayerIds(style: StyleSpecification): string[] {
  return style.layers
    .filter((l: any) => l.metadata?.group === 'labels' && l.type === 'symbol')
    .map((l) => l.id);
}

/** 各标注层矢量模式配色（卫星模式切白后恢复用；首次 buildStyle 时填充） */
export function labelTextColors(): Record<string, { color: string; halo: string }> {
  return LABEL_PAINT_DEFAULTS;
}

/** 光照/地面特效层的插入锚点：最早的近景符号层（roads_oneway），让行星光照与夜路
 *  压在道路/建筑之下、标注之上（与已验收候选的 near 语义一致）。 */
export function lightingAnchorLayerId(style: StyleSpecification): string | undefined {
  const ids = style.layers.map((l: any) => l.id);
  for (const candidate of ['roads_oneway', 'buildings-3d']) {
    if (ids.includes(candidate)) return candidate;
  }
  return style.layers.find((l: any) => l.type === 'symbol')?.id;
}

/** 航线层插入锚点：光照层与 buildings-3d 之后的第一批标注层之前。
 *  旧实现用"第一个标注层"，在新样式里会落到行星光照层之下（整屏暗化会压住航线），
 *  因此改为按层序取：max(光照锚点, buildings-3d) 之后的第一个 labels 层。 */
export function routeAnchorLayerId(style: StyleSpecification): string | undefined {
  const layers = style.layers as any[];
  const ids = layers.map((l) => l.id);
  const anchors = ['roads_oneway', 'buildings-3d'].map((id) => ids.indexOf(id)).filter((i) => i >= 0);
  const floor = anchors.length ? Math.max(...anchors) : -1;
  for (let i = floor + 1; i < layers.length; i++) {
    if (layers[i].metadata?.group === 'labels') return layers[i].id;
  }
  return undefined;
}

/** 兼容旧调用：第一个 labels 层（不含光照/建筑层级判断）。 */
export function firstLabelLayerId(style: StyleSpecification): string | undefined {
  return style.layers.find((l: any) => l.metadata?.group === 'labels')?.id;
}
