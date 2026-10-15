// 地图引擎封装：底图切换 / 3D 地球投影 / 标注语言与显隐 / 多航线渲染 / 机场 Pin / 视野适配
// v2 预留：3D 地形只需在此增加 setTerrain(dem)，业务层（航线数据、UI）不感知引擎实现。

// 本模块整体是异步 chunk（App 动态 import 本文件），maplibre CSS 跟着引擎走，
// 不占首屏 CSS（2026-10-16 性能预算）
import 'maplibre-gl/dist/maplibre-gl.css';

import {
  Map as MLMap,
  Marker,
  NavigationControl,
  AttributionControl,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import {
  buildStyle, labelLayerIds, labelTextColors, firstLabelLayerId, nameExpr,
  activeStadiaKey, setRuntimeStadiaKey, bumpStadiaTileVersion, stadiaSourceSpec,
  GLOBE_SKY, FLAT_SKY, type BaseMode, type LabelLanguage,
} from './styleFactory';
import { ensureProtocol } from './oceanTint';
import { mountSpaceScene, type SpaceScene } from './spaceScene';
import type { Airport } from '../data/search';
import type { SbfPlanMeta } from '../simbrief/simbrief';
import {
  greatCirclePoints, greatCircleMidpoint, haversineKm, initialBearing,
  destinationPoint, unwrapSequence, type Units,
} from '../geo/greatCircle';
import { estimateLegMinutes } from '../geo/flightTime';
import {
  buildPlanePath, easeInOutCubic, growDurationMs, planeAt, planeLoopSec,
  revealLineFeatures, GROW_STAGGER_MS, LABEL_FADE_MS, type PlanePath,
} from '../geo/routeAnim';

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
  /** SimBrief 计划元数据（飞行时间/巡航速度）：随真实航路导入，⇄ 反向等经停变动时清除 */
  ofp?: SbfPlanMeta;
}

// 航线标签文字颜色跟随航线色；描边恒为白晕（矢量/卫星一致），保证两种底图上都可读
const ROUTE_LABEL_HALO = '#FFFFFF';

// 视野适配统一留白（左侧给面板留位）
const FIT_PAD = { top: 110, bottom: 130, left: 460, right: 150 };

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 装饰小飞机（机头朝上=正北 0°，marker rotation 以此为基准随地图对齐）；
 *  配色走 --plane-color 随航线色，白描边保证卫星底图上可读 */
const PLANE_SVG = `
<svg viewBox="0 0 24 24" aria-hidden>
  <path d="M12 1.6 13.2 8.6 21.6 13.4 21.6 15.3 13.3 12.8 12.9 18.1 15.7 20.3 15.7 21.9 12 20.7 8.3 21.9 8.3 20.3 11.1 18.1 10.7 12.8 2.4 15.3 2.4 13.4 10.8 8.6 Z"
    fill="var(--plane-color, #0c79fe)" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;

interface RouteRecord {
  markers: Marker[];
  codesSig: string;
  /** 几何签名（机场序列 + 航点数）：变化 = 线数据重建 + 生长动画重放 + 小飞机换轨 */
  geoSig: string;
  /** 生长动画进行中（期间小飞机不起飞，重同步会先收场） */
  growing: boolean;
  /** 当前颜色与显隐（小飞机总开关补飞时要用，避免为此重走一次 renderRoute） */
  color: string;
  visible: boolean;
  plane: { marker: Marker; el: HTMLElement } | null;
  planePath: PlanePath | null;
  /** 巡航循环时长（秒，∝ 估算飞行时间）与进度 t∈[0,1)、帧间缓存的当前段索引 */
  planeLoopSec: number;
  planeT: number;
  planeSeg: number;
}

export class MapController {
  map: MLMap;
  private routes = new Map<string, RouteRecord>();
  private routeLabelLayers = new Set<string>();
  private space: SpaceScene | null = null;
  // 观感动画共用一个 rAF ticker（生长/标签淡入/小飞机巡航），无动画时自停省电；
  // id 形如 `grow:<routeId>` / `labelfade:<routeId>` / `plane:<routeId>`
  private anims = new Map<string, { tick: (now: number, dtMs: number) => boolean; cleanup: () => void }>();
  private tickerRaf: number | null = null;
  private lastTickNow = 0;
  // 本次 syncRoutes 内已启动的生长动画数（多条航线错峰）
  private growCount = 0;
  // 装饰小飞机总开关（默认关闭，右上菜单控制；URL plane=1）
  private planesEnabled = false;

  constructor(container: HTMLElement, lang: LabelLanguage, base: BaseMode, globe = false) {
    // 卫星瓦片自定义协议必须在样式构建前注册，否则首批 gcimg:// 瓦片会请求未注册协议；
    // getter 是动态的：用户运行时填入/更换 key 后无需重注册
    ensureProtocol(() => activeStadiaKey());
    if (import.meta.env.DEV && container.clientHeight < 200) {
      // 布局塌陷守卫：.map-root 若被 maplibre 自带 CSS 翻盘（.maplibregl-map{position:relative}）
      // 会塌成 0 高，地图只剩 300px 默认条、页面"白屏"——DOM 探针全绿，只有像素能发现
      console.error(
        `[MapController] 地图容器高度塌陷 clientHeight=${container.clientHeight}px：` +
        '检查 .app-root .map-root 定位规则是否仍压过 .maplibregl-map',
      );
    }
    this.map = new MLMap({
      container,
      style: buildStyle(lang, base, globe),
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
    // 比例尺已按用户要求移除（左下角只留品牌水印）
    if (import.meta.env.DEV) {
      (window as any).__map = this.map;
      (window as any).__mapErrors = [];
      this.map.on('error', (e: any) => {
        (window as any).__mapErrors.push(String(e?.error?.message ?? e));
      });
    }
    // 3D 太空场景（星空 + 大气辉光）：仅 globe 模式挂载，切回平面时整体卸载
    if (globe) this.space = mountSpaceScene(this.map);
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
        this.map.setPaintProperty(id, 'text-halo-color', ROUTE_LABEL_HALO);
      } catch {
        /* 同上 */
      }
    }
  }

  /** 用户在菜单填入自己的 Stadia key（UI 侧已通过抓瓦片预验证）：写 localStorage + 热更新
   *  gcimg 协议取值，并整源重建卫星 source（tileSize/maxzoom 无法原地改）。
   *  换 key 时瓦片 URL 带 ?v=<n> 版本号穿透 maplibre 瓦片缓存；卫星层可见性保持不变。 */
  applySatelliteKey(key: string): void {
    setRuntimeStadiaKey(key);
    bumpStadiaTileVersion();
    if (this.map.isStyleLoaded()) this.swapSatelliteSource();
    else this.map.once('load', () => this.swapSatelliteSource());
  }

  private swapSatelliteSource(): void {
    const style = this.map.getStyle() as any;
    if (!style?.layers) return;
    const prev = style.layers.find((l: any) => l.id === 'satellite');
    const vis = prev?.layout?.visibility === 'visible';
    try { this.map.removeLayer('satellite'); } catch { /* 尚未存在 */ }
    try { this.map.removeSource('satellite-imagery'); } catch { /* 尚未存在 */ }
    // 插回原位：background 之后、第一个非 background 层之前（与 buildStyle 的 splice(1,0) 一致）
    const beforeId = style.layers.find((l: any) => l.id !== 'background' && l.id !== 'satellite')?.id;
    this.map.addSource('satellite-imagery', stadiaSourceSpec());
    this.map.addLayer(
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite-imagery',
        metadata: { group: 'satellite' },
        layout: { visibility: vis ? 'visible' : 'none' },
        paint: { 'raster-opacity': 1 },
      },
      beforeId,
    );
  }

  /** 3D 地球投影：globe=低缩放渲染为球体（放大后 maplibre 自动回落 mercator），mercator=常规平面。
   *  sky 随投影切换：球体=深空+大气，平面=全透明（杜绝俯仰时出雾色） */
  setGlobe(on: boolean): void {
    try {
      this.map.setProjection({ type: on ? 'globe' : 'mercator' });
      this.map.setSky(on ? (GLOBE_SKY as any) : (FLAT_SKY as any));
    } catch (e) {
      console.warn('[MapController] setProjection failed', e);
    }
    if (on && !this.space) this.space = mountSpaceScene(this.map);
    else if (!on && this.space) {
      this.space.destroy();
      this.space = null;
    }
  }

  /** 视角回正：正北朝向 + 俯仰归零（中心与缩放不变） */
  resetView(): void {
    this.map.easeTo({ bearing: 0, pitch: 0, duration: 650 });
  }

  /** 切换地图标注语言（逐层替换 text-field 表达式） */
  setLabelsLanguage(lang: LabelLanguage): void {
    const style = this.map.getStyle() as StyleSpecification | undefined;
    if (!style?.layers) return; // 样式未加载完成：初始语言已在构造时内置，后续切换在 ready 后调用
    const expr = nameExpr(lang); // 与 buildStyle 共用同一表达式（含 name_en 截断守卫）
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
    this.growCount = 0;
    for (const e of entries) legsMap[e.id] = this.renderRoute(e, units, fmt);
    return legsMap;
  }

  /** 注册/替换一个动画并确保 ticker 在跑；同 id 旧动画先 cleanup */
  private animate(id: string, tick: (now: number, dtMs: number) => boolean, cleanup: () => void = () => {}): void {
    const prev = this.anims.get(id);
    if (prev) {
      this.anims.delete(id);
      try { prev.cleanup(); } catch { /* 清理失败不拖垮 ticker */ }
    }
    this.anims.set(id, { tick, cleanup });
    if (this.tickerRaf != null) return;
    this.lastTickNow = performance.now();
    const loop = (now: number) => {
      this.tickerRaf = null;
      const dtMs = Math.min(64, now - this.lastTickNow); // 掉帧/休眠回来时钳 dt，防止小飞机瞬移
      this.lastTickNow = now;
      for (const [key, a] of [...this.anims]) {
        let alive = false;
        try { alive = a.tick(now, dtMs); } catch { alive = false; }
        if (!alive) {
          this.anims.delete(key);
          try { a.cleanup(); } catch { /* 同上 */ }
        }
      }
      if (this.anims.size) this.tickerRaf = requestAnimationFrame(loop);
    };
    this.tickerRaf = requestAnimationFrame(loop);
  }

  private cancelAnim(id: string): void {
    const a = this.anims.get(id);
    if (!a) return;
    this.anims.delete(id);
    try { a.cleanup(); } catch { /* 同上 */ }
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
    // 几何变化（新增 / 编辑经停 / 导入真实航路）→ 重放生长动画；纯样式与单位调整不重放
    const codesSig = e.airports.map((a) => a.iata || a.icao).join('-');
    const geoSig = `${codesSig}:${e.waypoints?.length ?? 0}`;
    const willGrow = (rec ? rec.geoSig !== geoSig : true) && e.visible && !prefersReducedMotion();
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
            'text-halo-color': ROUTE_LABEL_HALO,
            // 描边细化过一轮：1.8 + 0.4 模糊在 11px 字上显得很厚（2026-10-08 用户要求打薄）
            'text-halo-width': 1.1,
            'text-halo-blur': 0.25,
            // 生长动画期间标签先隐，完成后淡入（routeAnim.LABEL_FADE_MS）
            'text-opacity': willGrow ? 0 : 1,
          },
        },
        beforeId,
      );
      rec = { markers: [], codesSig: '', geoSig, growing: false, color: e.color, visible: e.visible, plane: null, planePath: null, planeLoopSec: 10, planeT: 0, planeSeg: 0 };
      this.routes.set(e.id, rec);
      this.routeLabelLayers.add(labelLayer);
    } else {
      // 生长期内被重新同步（改色/改粗细/换单位/显隐）：旧生长与淡入立即收场，
      // 避免旧动画的切片覆盖本次新数据；几何已变时小飞机一并作废待重生
      this.cancelAnim(`grow:${e.id}`);
      this.cancelAnim(`labelfade:${e.id}`);
      if (willGrow) this.removePlane(rec);
      // 颜色 / 粗细可能变了：幂等覆盖，代价可忽略
      try {
        this.map.setPaintProperty(lineLayer, 'line-color', e.color);
        this.map.setPaintProperty(lineLayer, 'line-width', this.lineWidthExpr(e.width) as any);
        this.map.setPaintProperty(labelLayer, 'text-color', e.color);
        this.map.setPaintProperty(labelLayer, 'text-opacity', 1);
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

    // 巡航路径与循环时长：估算飞行时间（各段距离分档）映射到 5–24s 视觉循环
    rec.planePath = buildPlanePath(lineFeatures.map((f) => f.geometry.coordinates as [number, number][]));
    rec.planeLoopSec = planeLoopSec(legs.reduce((s, l) => s + estimateLegMinutes(l.km), 0));

    (this.map.getSource(srcLabel) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: labelFeatures,
    });
    if (willGrow) {
      // 生长动画接管线数据（首帧切片覆盖，避免全量闪一帧）
      this.startGrowth(e.id, rec, srcLine, labelLayer, lineFeatures, e.color);
    } else {
      (this.map.getSource(srcLine) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: lineFeatures,
      });
    }

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
        // globe 模式下球体背面的 Pin 会被 maplibre 套 opacityWhenCovered（默认 0.2 → 半透明幽灵
        // 标志透出球面），置 0 让背面完全隐藏；mercator 下 isLocationOccluded 恒 false，无副作用
        const marker = new Marker({ element: el, anchor: 'center', opacityWhenCovered: 0 })
          .setLngLat([a.lon, a.lat])
          .addTo(this.map);
        rec!.markers.push(marker);
      });
      rec.codesSig = sig;
    } else {
      for (const m of rec.markers) m.getElement().style.setProperty('--pin-color', e.color);
      if (rec.plane) rec.plane.el.style.setProperty('--plane-color', e.color);
    }

    const vis = e.visible ? 'visible' : 'none';
    try {
      this.map.setLayoutProperty(lineLayer, 'visibility', vis);
      this.map.setLayoutProperty(labelLayer, 'visibility', vis);
    } catch {
      /* 图层可能尚未就绪，忽略 */
    }
    for (const m of rec.markers) m.getElement().style.display = e.visible ? '' : 'none';
    if (rec.plane) rec.plane.el.style.display = e.visible ? '' : 'none';
    rec.color = e.color;
    rec.visible = e.visible;
    // 会话中途开启"减弱动态效果"：现役小飞机立即回收，也不再补飞
    if (prefersReducedMotion() && rec.plane) this.removePlane(rec);
    // 小飞机兜底起飞：总开关开启时，非生长状态的可见航线保证有一架在飞
    //（生长完成后由 startGrowth 起飞；取消生长 / 开关切换 / 显隐切换走这里）
    if (this.planesEnabled && !rec.growing && e.visible && !prefersReducedMotion() && rec.planePath && !rec.plane) {
      this.spawnPlane(e.id, rec, e.color);
    }

    return legs;
  }

  /** 航线生长动画：逐帧切片线数据（多段逐段连续生长），完成后淡入标签并放飞小飞机 */
  private startGrowth(routeId: string, rec: RouteRecord, srcLine: string, labelLayer: string, lineFeatures: any[], color: string): void {
    rec.growing = true;
    const src = this.map.getSource(srcLine) as GeoJSONSource;
    const setFeatures = (features: any[]) => src.setData({ type: 'FeatureCollection', features });
    const totalPts = lineFeatures.reduce((s, f) => s + f.geometry.coordinates.length, 0);
    // 首帧先只露起点切片，避免刚设的全量数据闪一帧
    setFeatures(revealLineFeatures(lineFeatures, 1));
    const duration = growDurationMs(lineFeatures.length);
    const start = performance.now() + this.growCount++ * GROW_STAGGER_MS;
    this.animate(`grow:${routeId}`, (now) => {
      if (now < start) return true; // 多条航线同时新增时的错峰等待
      const t = Math.min(1, (now - start) / duration);
      setFeatures(revealLineFeatures(lineFeatures, 1 + Math.round(easeInOutCubic(t) * (totalPts - 1))));
      if (t < 1) return true;
      rec.growing = false;
      this.fadeLabelsIn(routeId, labelLayer);
      this.spawnPlane(routeId, rec, color);
      return false;
    });
  }

  /** 标签淡入（生长完成后调用）；cleanup 兜底确保最终可见 */
  private fadeLabelsIn(routeId: string, labelLayer: string): void {
    const start = performance.now();
    this.animate(
      `labelfade:${routeId}`,
      (now) => {
        const k = Math.min(1, (now - start) / LABEL_FADE_MS);
        try { this.map.setPaintProperty(labelLayer, 'text-opacity', k); } catch { return false; }
        return k < 1;
      },
      () => {
        try { this.map.setPaintProperty(labelLayer, 'text-opacity', 1); } catch { /* 图层已移除 */ }
      },
    );
  }

  /** 装饰小飞机总开关（右上菜单；URL plane=1）。关闭=全线撤机；开启=可见航线立即补飞 */
  setPlanesEnabled(on: boolean): void {
    if (this.planesEnabled === on) return;
    this.planesEnabled = on;
    for (const [id, rec] of this.routes) {
      if (!on) {
        this.cancelAnim(`plane:${id}`);
        this.removePlane(rec);
        continue;
      }
      if (rec.visible && !rec.growing && rec.planePath && !rec.plane && !prefersReducedMotion()) {
        this.spawnPlane(id, rec, rec.color);
      }
    }
  }

  /** 装饰小飞机起飞：沿 planePath 循环巡航，循环时长 ∝ 估算飞行时间。纯观感，与真实航迹无关 */
  private spawnPlane(routeId: string, rec: RouteRecord, color: string): void {
    if (!this.planesEnabled || prefersReducedMotion()) return; // 总开关关闭时不起飞
    const path = rec.planePath;
    if (!path || path.coords.length < 2 || path.totalKm <= 0) return;
    this.removePlane(rec);
    const el = document.createElement('div');
    el.className = 'route-plane';
    el.style.setProperty('--plane-color', color);
    el.innerHTML = PLANE_SVG;
    const marker = new Marker({
      element: el,
      anchor: 'center',
      rotationAlignment: 'map',
      pitchAlignment: 'map',
      // globe 模式球体背面整体隐藏，与 Pin 同款防幽灵
      opacityWhenCovered: 0,
    });
    const p0 = planeAt(path, 0);
    marker.setLngLat(p0.lngLat).setRotation(p0.bearing).addTo(this.map);
    rec.plane = { marker, el };
    rec.planeT = 0;
    rec.planeSeg = 0;
    this.animate(`plane:${routeId}`, (_now, dtMs) => {
      if (!rec.plane) return false; // marker 已被外部移除，巡航动画自行退场
      rec.planeT += dtMs / (rec.planeLoopSec * 1000);
      if (rec.planeT >= 1) { rec.planeT %= 1; rec.planeSeg = 0; } // 飞完一轮从头再来
      const p = planeAt(path, rec.planeT, rec.planeSeg);
      rec.planeSeg = p.seg;
      rec.plane.marker.setLngLat(p.lngLat);
      rec.plane.marker.setRotation(p.bearing);
      return true;
    });
  }

  private removePlane(rec: RouteRecord): void {
    if (!rec.plane) return;
    try { rec.plane.marker.remove(); } catch { /* 已移除 */ }
    rec.plane = null; // 巡航动画 tick 的空守卫会自行退场
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
    this.cancelAnim(`grow:${id}`);
    this.cancelAnim(`labelfade:${id}`);
    this.cancelAnim(`plane:${id}`);
    const rec = this.routes.get(id);
    if (!rec) return;
    for (const m of rec.markers) m.remove();
    this.removePlane(rec);
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
