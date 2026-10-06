// 底图样式：成品样式 + 运行时适配
// 样式本体是 design-assets 流水线的生成产物 styles/apple-landcover.json（126 层：
// Apple 配色 + NASA 全球绿毯两级金字塔 + DEM hillshade + 地表/土地利用色块），
// 不要在这里复刻或手改样式本体 —— 改观感回 design-assets 流水线（make_apple_starter /
// add_landcover / validate_style / run_tests）重生成，本文件只做接入主应用的适配：
//   1. 绿毯 image source 的相对路径 → Vite 资产 URL；
//   2. 逐层打 metadata.group（base / satellite / labels），供 MapController.setBase 翻可见性；
//   3. 插入 Esri 卫星影像层（satellite 组）；
//   4. 名字类标注层换成双语 name 表达式，并登记矢量模式配色（卫星切白字深晕后可恢复）。

import type { StyleSpecification } from 'maplibre-gl';
import appleLandcoverRaw from '../../design-assets/styles/apple-landcover.json?raw';
import globalLcUrl from '../../design-assets/demo/tiles/global-lc-merc.png?url';
import globalLcHdUrl from '../../design-assets/demo/tiles/global-lc-merc-hd.png?url';

export type LabelLanguage = 'latin' | 'zh';
export type BaseMode = 'vector' | 'satellite';

// OpenFreeMap 公共瓦片服务（免 key）；样式 CC0，瓦片数据 OSM/ODbL —— attribution 必须保留
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// 卫星影像：Stadia 纯影像（EU 端点，美西端点不通），瓦片走 gcimg:// 协议经 oceanTint 逐像素海洋调色。
// key 绝不入库（公开仓库合规）：读 .env.local 的 VITE_STADIA_KEY；取不到回退免 key 的 Esri World Imagery。
export const STADIA_KEY = ((import.meta.env.VITE_STADIA_KEY as string | undefined) ?? '').trim();
const STADIA_ATTRIBUTION =
  '© CNES, Distribution Airbus DS, © Airbus DS, © PlanetObserver (Contains Copernicus Data) | © Stadia Maps';

// 卫星模式的标注配色（白字 + 半透明深晕；白 halo 在影像上是突兀白边，深字又看不清）
const SAT_TEXT_COLOR = '#FFFFFF';
const SAT_TEXT_HALO = 'rgba(0,0,0,0.55)';

// 3D 地球的太空底色与大气辉光（sky-color 透明：深空与星星做在 .map-root 的 CSS 背景上，
// 大气辉光若有渲染则叠加在星空之上；fog 全透明，杜绝平面模式俯仰时出雾色）
export const GLOBE_SKY = {
  'sky-color': 'rgba(2,4,12,0)',
  'sky-horizon-blend': 0.6,
  'horizon-color': '#4a7ab5',
  'horizon-fog-blend': 0.5,
  'fog-color': 'rgba(0,0,0,0)',
  'fog-ground-blend': 0,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.8, 9, 0] as any,
};
export const FLAT_SKY = {
  'sky-color': 'rgba(0,0,0,0)',
  'horizon-color': 'rgba(0,0,0,0)',
  'fog-color': 'rgba(0,0,0,0)',
  'fog-ground-blend': 0,
  'atmosphere-blend': 0,
};

// icon-only / ref 徽章类 symbol：属于路网表面元素，随 base 组隐藏，不参与语言切换与配色
const BASE_GROUP_SYMBOLS = new Set([
  'road_one_way_arrow',
  'road_one_way_arrow_opposite',
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
]);

/** 地名取值表达式：zh 优先简体字段，latin 用英文名（OpenFreeMap 瓦片字段已实测支持） */
function nameExpr(lang: LabelLanguage): any {
  if (lang === 'zh') {
    return ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh'], ['get', 'name_en'], ['get', 'name']];
  }
  return ['coalesce', ['get', 'name_en'], ['get', 'name']];
}

/** text-field 是否取自 name 类字段（ref 徽章 / 纯图标层不算） */
function isNameLabel(textField: unknown): boolean {
  return textField != null && JSON.stringify(textField).includes('"name');
}

// 各标注层矢量模式配色（卫星切白后恢复用；每次 buildStyle 重建）
const LABEL_PAINT_DEFAULTS: Record<string, { color: string; halo: string }> = {};

export function buildStyle(lang: LabelLanguage = 'latin', base: BaseMode = 'vector', globe = false): StyleSpecification {
  const style = JSON.parse(appleLandcoverRaw) as any;
  for (const k of Object.keys(LABEL_PAINT_DEFAULTS)) delete LABEL_PAINT_DEFAULTS[k];

  // 3D 地球（?globe=1 直开时内置，避免首帧"先平后球"跳变；运行时切换走 MapController.setGlobe）
  if (globe) {
    style.projection = { type: 'globe' };
    style.sky = { ...GLOBE_SKY };
  }

  // 绿毯整图改走 Vite 资产 URL（JSON 里的 ../demo/tiles 相对路径在应用里不存在）
  style.sources['global-landcover-img'].url = globalLcUrl;
  style.sources['global-landcover-hd-img'].url = globalLcHdUrl;
  // 成品样式靠 demo 页 AttributionControl 署名，应用侧署名挂在 source 上
  style.sources.openmaptiles.attribution = '© OpenStreetMap contributors · OpenFreeMap';

  const name = nameExpr(lang);
  for (const layer of style.layers) {
    const isLabel =
      layer.type === 'symbol' && !BASE_GROUP_SYMBOLS.has(layer.id) && isNameLabel(layer.layout?.['text-field']);
    layer.metadata = { ...(layer.metadata ?? {}), group: isLabel ? 'labels' : 'base' };
    if (!isLabel) continue;
    layer.layout = layer.layout ?? {};
    layer.paint = layer.paint ?? {};
    layer.layout['text-field'] = name;
    LABEL_PAINT_DEFAULTS[layer.id] = {
      color: layer.paint['text-color'] ?? '#000000',
      halo: layer.paint['text-halo-color'] ?? '#000000',
    };
    if (base === 'satellite') {
      layer.paint['text-color'] = SAT_TEXT_COLOR;
      layer.paint['text-halo-color'] = SAT_TEXT_HALO;
    }
  }

  // 卫星影像：插在 background 之后（与 base 组互斥，?base=satellite 直开时内置可见避免闪白）
  style.layers.splice(1, 0, {
    id: 'satellite',
    type: 'raster',
    source: 'satellite-imagery',
    metadata: { group: 'satellite' },
    layout: { visibility: base === 'satellite' ? 'visible' : 'none' },
    paint: { 'raster-opacity': 1 },
  });
  style.sources['satellite-imagery'] = STADIA_KEY
    ? {
        type: 'raster',
        tiles: ['gcimg://{z}/{x}/{y}'],
        tileSize: 512,
        maxzoom: 18,
        attribution: STADIA_ATTRIBUTION,
      }
    : {
        type: 'raster',
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      };

  return style as unknown as StyleSpecification;
}

/** 标注层 id 列表（语言切换 / 配色切换都作用在这组；ref 徽章等 base 组 symbol 不在内） */
export function labelLayerIds(style: StyleSpecification): string[] {
  return style.layers
    .filter((l: any) => l.metadata?.group === 'labels' && l.type === 'symbol')
    .map((l) => l.id);
}

/** 各标注层矢量模式配色（卫星模式切白后恢复用；首次 buildStyle 时填充） */
export function labelTextColors(): Record<string, { color: string; halo: string }> {
  return LABEL_PAINT_DEFAULTS;
}

/** 航线层插入位置：第一个标注层之前（航线压路网、让标注） */
export function firstLabelLayerId(style: StyleSpecification): string | undefined {
  return style.layers.find((l: any) => l.metadata?.group === 'labels')?.id;
}
