// 航线外观：已验收 demo（round-11 候选 app.js）的细线 + 柔和 glow 结构，主项目真实航线共用。
//
// demo 原值：core 宽 1.3 / opacity .75；glow 宽 6 / opacity .09 / blur 3。
// 现有「粗细」倍率=1 时以这组值为基准，倍率直接线性缩放两层，保证 core/glow 始终成对。
// 颜色仍由每条航线自己决定（新建航线默认色板见下；已有用户自选/草稿颜色不重写）。
import type { LayerSpecification } from 'maplibre-gl';

/** 新航线默认配色：前两色取 demo 的浅黄绿/青，其余保留主项目原有可辨识色 */
export const ROUTE_COLORS = [
  '#d9e9b4', '#64b9bc',
  '#0B7BE8', '#E0433E', '#2E9E4F', '#F08C00',
  '#8250DF', '#0FA3B1', '#D6336C', '#9A7D0A',
];

/** demo 航线样式基准（宽度倍率=1） */
export const ROUTE_STYLE = {
  coreWidth: 1.3,
  coreOpacity: 0.75,
  glowWidth: 6,
  glowOpacity: 0.09,
  glowBlur: 3,
} as const;

export function routeCoreWidth(scale: number): number {
  return ROUTE_STYLE.coreWidth * scale;
}

export function routeGlowWidth(scale: number): number {
  return ROUTE_STYLE.glowWidth * scale;
}

export function routeCorePaint(color: string, scale: number): Record<string, any> {
  return {
    'line-color': color,
    'line-width': routeCoreWidth(scale),
    'line-opacity': ROUTE_STYLE.coreOpacity,
  };
}

export function routeGlowPaint(color: string, scale: number): Record<string, any> {
  return {
    'line-color': color,
    'line-width': routeGlowWidth(scale),
    'line-opacity': ROUTE_STYLE.glowOpacity,
    'line-blur': ROUTE_STYLE.glowBlur,
  };
}

/** 一条航线的完整 id 组：glow 在 core 之下，二者共用同一个 GeoJSON source（生长切片自动同步） */
export function routeLayerIds(routeId: string): {
  source: string;
  glow: string;
  core: string;
  label: string;
} {
  return {
    source: `route-lines-${routeId}`,
    glow: `route-glow-${routeId}`,
    core: `route-line-${routeId}`,
    label: `route-labels-${routeId}`,
  };
}

/** 生成 glow + core 两层（返回顺序即添加顺序：先 glow 后 core）；同源保证显隐/生长/删除同步 */
export function routeLineLayers(
  routeId: string,
  source: string,
  color: string,
  scale: number,
): [LayerSpecification, LayerSpecification] {
  const ids = routeLayerIds(routeId);
  const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  return [
    {
      id: ids.glow,
      type: 'line',
      source,
      layout,
      paint: routeGlowPaint(color, scale),
    },
    {
      id: ids.core,
      type: 'line',
      source,
      layout,
      paint: routeCorePaint(color, scale),
    },
  ];
}
