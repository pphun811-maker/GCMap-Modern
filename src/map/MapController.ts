// 地图引擎封装：底图切换 / 标注语言与显隐 / 多航线渲染 / 机场 Pin / 视野适配
// v2 预留：globe 投影与 3D 地形只需在此增加 setProjection({type:'globe'}) 与 setTerrain(dem)，
// 业务层（航线数据、UI）不感知引擎实现。

import {
  Map as MLMap,
  Marker,
  NavigationControl,
  AttributionControl,
  ScaleControl,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import { buildStyle, labelLayerIds, labelTextColors, firstLabelLayerId, STADIA_KEY, type BaseMode, type LabelLanguage } from './styleFactory';
import { ensureProtocol } from './oceanTint';
import type { Airport } from '../data/search';
import {
  greatCirclePoints, greatCircleMidpoint, haversineKm, initialBearing,
  destinationPoint, unwrapSequence, type Units,
} from '../geo/greatCircle';

export interface LegInfo {
  from: Airport;
  to: Airport;
  km: number;
  bearing: number;
}

/** 真实航路的航点（SimBrief OFP 的 navlog fix，含起降机场） */
export interface RouteWaypoint {
  ident: string;
  lat: number;
  lon: number;
}

/** 一条航线：id 全会话稳定（React key + 地图图层命名），width 为默认粗细的倍率。
 *  waypoints 存在时按航点序列画真实航路折线（airports 只用于 Pin 与 URL），否则画大圆弧 */
export interface RouteEntry {
  id: string;
  airports: Airport[];
  visible: boolean;
  color: string;
  width: number;
  waypoints?: RouteWaypoint[];
  /** 导入该真实航路所用 SimBrief 用户名（URL sbf 参数的来源） */
  simbriefUser?: string;
}

// 航线标签文字颜色跟随航线色；描边随底图模式（矢量=白晕，卫星=深晕），保证两种底图上都可读
const ROUTE_LABEL_HALO = {
  vector: '#FFFFFF',
  satellite: 'rgba(0,0,0,0.55)',
} as const;

// 视野适配统一留白（左侧给面板留位）
const FIT_PAD = { top: 110, bottom: 130, left: 460, right: 150 };

interface RouteRecord {
  markers: Marker[];
  codesSig: string;
}

export class MapController {
  map: MLMap;
  private routes = new Map<string, RouteRecord>();
  private routeLabelLayers = new Set<string>();
  private currentBase: BaseMode;

  constructor(container: HTMLElement, lang: LabelLanguage, base: BaseMode) {
    // 卫星瓦片自定义协议必须在样式构建前注册，否则首批 gcimg:// 瓦片会请求未注册协议
    ensureProtocol(() => STADIA_KEY);
    this.currentBase = base;
    this.map = new MLMap({
      container,
      style: buildStyle(lang, base),
      center: [110, 33],
      zoom: 3,
      attributionControl: false,
      hash: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, // 供截图/导出与自动化测试读帧
    });
    // NASA 地表覆盖绿毯数据署名：image source 不支持 attribution 字段（Style Spec），挂控件上
    this.map.addControl(
      new AttributionControl({ compact: true, customAttribution: 'Land cover © NASA EOSDIS GIBS' }),
      'bottom-right',
    );
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    if (import.meta.env.DEV) {
      (window as any).__map = this.map;
      (window as any).__mapErrors = [];
      this.map.on('error', (e: any) => {
        (window as any).__mapErrors.push(String(e?.error?.message ?? e));
      });
    }
  }

  onReady(cb: () => void): void {
    const run = () => { try { cb(); } catch (e) { console.error('[MapController] onReady failed', e); } };
    if (this.map.isStyleLoaded()) run();
    else this.map.once('load', run);
  }

  /** 矢量 / 卫星底图切换（按 metadata.group 翻 visibility，航线层不受影响） */
  setBase(mode: BaseMode): void {
    const layers = (this.map.getStyle() as any)?.layers as any[] | undefined;
    if (!layers) return;
    // 注意：样式里的组名是 base/satellite，对外模式值是 vector/satellite
    const targetGroup = mode === 'satellite' ? 'satellite' : 'base';
    this.currentBase = mode;
    for (const l of layers) {
      const g = l.metadata?.group as string | undefined;
      if (!g || g === 'labels') continue;
      const visible = g === targetGroup;
      this.map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
    }
    // 标注配色随底图模式切换：矢量=成品样式原色（含各自 halo）；卫星=白字 + 半透明深晕
    const sat = mode === 'satellite';
    const defaults = labelTextColors();
    const style = this.map.getStyle() as StyleSpecification;
    for (const id of labelLayerIds(style)) {
      try {
        this.map.setPaintProperty(id, 'text-color', sat ? '#FFFFFF' : (defaults[id]?.color ?? '#000000'));
        this.map.setPaintProperty(id, 'text-halo-color', sat ? 'rgba(0,0,0,0.55)' : (defaults[id]?.halo ?? '#FFFFFF'));
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }
    for (const id of this.routeLabelLayers) {
      try {
        this.map.setPaintProperty(id, 'text-halo-color', ROUTE_LABEL_HALO[mode]);
      } catch {
        /* 同上 */
      }
    }
  }

  /** 切换地图标注语言（逐层替换 text-field 表达式） */
  setLabelsLanguage(lang: LabelLanguage): void {
    const style = this.map.getStyle() as StyleSpecification | undefined;
    if (!style?.layers) return; // 样式未加载完成：初始语言已在构造时内置，后续切换在 ready 后调用
    const expr = lang === 'zh'
      ? ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh'], ['get', 'name_en'], ['get', 'name']]
      : ['coalesce', ['get', 'name_en'], ['get', 'name']];
    for (const id of labelLayerIds(style)) {
      try {
        this.map.setLayoutProperty(id, 'text-field', expr as any);
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }
  }

  /** 地名标注整体显隐（两种底图模式下共用的全部名字标注层） */
  setLabelsVisible(visible: boolean): void {
    const style = this.map.getStyle() as StyleSpecification | undefined;
    if (!style?.layers) return;
    for (const id of labelLayerIds(style)) {
      try {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }
  }

  /** 全量同步多条航线：增删各自图层与 Pin、更新数据与样式、应用显隐。返回每条航线的分段信息 */
  syncRoutes(entries: RouteEntry[], units: Units, fmt: (km: number, u: Units) => string): Record<string, LegInfo[]> {
    const kept = new Set(entries.map((e) => e.id));
    for (const id of [...this.routes.keys()]) {
      if (!kept.has(id)) this.disposeRoute(id);
    }
    const legsMap: Record<string, LegInfo[]> = {};
    for (const e of entries) legsMap[e.id] = this.renderRoute(e, units, fmt);
    return legsMap;
  }

  /** 默认粗细曲线沿既有验收值 z2=2 / z6=3.2 / z10=4.5，width 为倍率 */
  private lineWidthExpr(w: number) {
    return ['interpolate', ['linear'], ['zoom'], 2, 2 * w, 6, 3.2 * w, 10, 4.5 * w];
  }

  private renderRoute(e: RouteEntry, units: Units, fmt: (km: number, u: Units) => string): LegInfo[] {
    const srcLine = `route-lines-${e.id}`;
    const srcLabel = `route-labels-${e.id}`;
    const lineLayer = `route-line-${e.id}`;
    const labelLayer = `route-labels-${e.id}`;
    let rec = this.routes.get(e.id);
    if (!rec) {
      const beforeId = firstLabelLayerId(this.map.getStyle() as StyleSpecification);
      this.map.addSource(srcLine, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addSource(srcLabel, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer(
        {
          id: lineLayer, type: 'line', source: srcLine,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': e.color,
            'line-width': this.lineWidthExpr(e.width) as any,
          },
        },
        beforeId,
      );
      this.map.addLayer(
        {
          id: labelLayer, type: 'symbol', source: srcLabel,
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 11,
            'text-line-height': 1.25,
            'text-justify': 'center',
            // 航线标签是主动生成的核心 UI，不允许被底图标注碰撞挤掉（成品样式标注密，洲际视野下会落败）
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': e.color,
            'text-halo-color': ROUTE_LABEL_HALO[this.currentBase],
            'text-halo-width': 1.8,
            'text-halo-blur': 0.4,
          },
        },
        beforeId,
      );
      rec = { markers: [], codesSig: '' };
      this.routes.set(e.id, rec);
      this.routeLabelLayers.add(labelLayer);
    } else {
      // 颜色 / 粗细可能变了：幂等覆盖，代价可忽略
      try {
        this.map.setPaintProperty(lineLayer, 'line-color', e.color);
        this.map.setPaintProperty(lineLayer, 'line-width', this.lineWidthExpr(e.width) as any);
        this.map.setPaintProperty(labelLayer, 'text-color', e.color);
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }

    const legs: LegInfo[] = [];
    const lineFeatures: any[] = [];
    const labelFeatures: any[] = [];

    if (e.waypoints && e.waypoints.length >= 2) {
      this.renderWaypointRoute(e, legs, lineFeatures, labelFeatures, units, fmt);
    } else {
      const unwrapped = unwrapSequence(e.airports.map((a) => ({ lon: a.lon, lat: a.lat })));

      for (let i = 0; i < e.airports.length - 1; i++) {
        const from = e.airports[i];
        const to = e.airports[i + 1];
        const km = haversineKm(unwrapped[i], unwrapped[i + 1]);
        const bearing = initialBearing(unwrapped[i], unwrapped[i + 1]);
        legs.push({ from, to, km, bearing });

        const coords = greatCirclePoints(unwrapped[i], unwrapped[i + 1], 128);
        lineFeatures.push({
          type: 'Feature',
          properties: { leg: i },
          geometry: { type: 'LineString', coordinates: coords },
        });
        const mid = greatCircleMidpoint(unwrapped[i], unwrapped[i + 1]);
        // 标签沿行进方向右侧垂直挪离航线（距离=段长的 6%），任何朝向/缩放下都不压线
        const labelPos = destinationPoint(mid, (bearing + 90) % 360, km * 0.06);
        labelFeatures.push({
          type: 'Feature',
          properties: { label: `${from.iata || from.icao} → ${to.iata || to.icao}\n${fmt(km, units)}` },
          geometry: { type: 'Point', coordinates: [labelPos.lon, labelPos.lat] },
        });
      }
    }

    (this.map.getSource(srcLine) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: lineFeatures,
    });
    (this.map.getSource(srcLabel) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: labelFeatures,
    });

    // 机场 Pin（Apple 蓝点样式，颜色跟随航线色）：仅在机场序列变化时重建，颜色与显隐每次同步
    const sig = e.airports.map((a) => a.iata || a.icao).join('-');
    if (sig !== rec.codesSig) {
      for (const m of rec.markers) m.remove();
      rec.markers = [];
      e.airports.forEach((a, idx) => {
        const code = a.iata || a.icao;
        const el = document.createElement('div');
        el.className = 'ap-pin';
        el.innerHTML = `
          <div class="ap-pin-glow"></div>
          <div class="ap-pin-dot"></div>
          <div class="ap-pin-label"><b>${code}</b><span>${a.city || a.name}</span></div>
          ${e.airports.length > 2 ? `<div class="ap-pin-index">${idx + 1}</div>` : ''}`;
        el.style.setProperty('--pin-color', e.color);
        const marker = new Marker({ element: el, anchor: 'center' })
          .setLngLat([a.lon, a.lat])
          .addTo(this.map);
        rec!.markers.push(marker);
      });
      rec.codesSig = sig;
    } else {
      for (const m of rec.markers) m.getElement().style.setProperty('--pin-color', e.color);
    }

    const vis = e.visible ? 'visible' : 'none';
    try {
      this.map.setLayoutProperty(lineLayer, 'visibility', vis);
      this.map.setLayoutProperty(labelLayer, 'visibility', vis);
    } catch {
      /* 图层可能尚未就绪，忽略 */
    }
    for (const m of rec.markers) m.getElement().style.display = e.visible ? '' : 'none';

    return legs;
  }

  /** 真实航路折线：整条一条 LineString，标签放在沿线 50% 处按局部航向右侧挪离（同大圆分支的 6% 规则） */
  private renderWaypointRoute(
    e: RouteEntry,
    legs: LegInfo[],
    lineFeatures: any[],
    labelFeatures: any[],
    units: Units,
    fmt: (km: number, u: Units) => string,
  ): void {
    const wpts = unwrapSequence(e.waypoints!.map((w) => ({ lon: w.lon, lat: w.lat })));

    let totalKm = 0;
    const cum: number[] = [0];
    for (let i = 1; i < wpts.length; i++) {
      totalKm += haversineKm(wpts[i - 1], wpts[i]);
      cum.push(totalKm);
    }

    lineFeatures.push({
      type: 'Feature',
      properties: { leg: 0 },
      geometry: { type: 'LineString', coordinates: wpts.map((p) => [p.lon, p.lat]) },
    });

    const from = e.airports[0];
    const to = e.airports[e.airports.length - 1];
    const bearing = initialBearing(wpts[0], wpts[wpts.length - 1]);
    legs.push({ from, to, km: totalKm, bearing });

    // 沿线 50% 处：先定位所在段，再在段内按剩余距离插值
    const half = totalKm / 2;
    let seg = 0;
    while (seg < cum.length - 2 && cum[seg + 1] < half) seg++;
    const segBearing = initialBearing(wpts[seg], wpts[seg + 1]);
    const onLine = destinationPoint(wpts[seg], segBearing, half - cum[seg]);
    const labelPos = destinationPoint(onLine, (segBearing + 90) % 360, Math.max(totalKm * 0.06, 40));
    labelFeatures.push({
      type: 'Feature',
      properties: { label: `${from.iata || from.icao} → ${to.iata || to.icao}\n${fmt(totalKm, units)}` },
      geometry: { type: 'Point', coordinates: [labelPos.lon, labelPos.lat] },
    });
  }

  private disposeRoute(id: string): void {
    const rec = this.routes.get(id);
    if (!rec) return;
    for (const m of rec.markers) m.remove();
    try { this.map.removeLayer(`route-line-${id}`); } catch { /* 可能尚未添加 */ }
    try { this.map.removeLayer(`route-labels-${id}`); } catch { /* 同上 */ }
    try { this.map.removeSource(`route-lines-${id}`); } catch { /* 同上 */ }
    try { this.map.removeSource(`route-labels-${id}`); } catch { /* 同上 */ }
    this.routeLabelLayers.delete(`route-labels-${id}`);
    this.routes.delete(id);
  }

  /** 视野适配一个点集（单条航线的机场序列，或多条航线的并集） */
  fitRoute(airports: Airport[]): void {
    if (airports.length === 0) return;
    if (airports.length === 1) {
      this.map.flyTo({ center: [airports[0].lon, airports[0].lat], zoom: 9 });
      return;
    }
    const pts = unwrapSequence(airports.map((a) => ({ lon: a.lon, lat: a.lat })));
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const p of pts) {
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    }
    this.map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: FIT_PAD, duration: 900, maxZoom: 10.5, linear: false },
    );
  }

  /** 视野适配多条（可见）航线的并集 */
  fitRoutes(entries: RouteEntry[]): void {
    this.fitRoute(entries.flatMap((e) => e.airports));
  }
}
