// 地图引擎封装：底图切换 / 3D 地球投影 / 3D 地形 / 标注语言与显隐 / 多航线渲染 / 机场 Pin / 视野适配
// v2 预留：真实航班追踪等在此增加数据源，业务层（航线数据、UI）不感知引擎实现。
//
// 2026-10-27 主项目地图整合：vector 槽位换成已验收 Flightline 底图。新增的运行时层
//（行星光照/地表、城市灯网、夜间路网）全部在 style.load 后挂载；主题切换会重建样式，
// 业务航线/Pin 按保存的参数重放，卫星逻辑（MapTiler/Esri、极区选片补偿、水面显隐）保留。

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
  buildStyle, labelLayerIds, labelTextColors, routeAnchorLayerId, nameExpr,
  activeMapTilerKey, setRuntimeMapTilerKey, bumpSatTileVersion, satelliteSourceSpec,
  GLOBE_SKY, FLAT_SKY, lightingAnchorLayerId, type BaseMode, type LabelLanguage,
} from './styleFactory';
import { ensureProtocol } from './oceanTint';
import { satelliteTileSize } from './satelliteLod';
import { mountSpaceScene, type SpaceScene } from './spaceScene';
import { PlanetLayer } from './flightline/planetLayer';
import { NightRoads } from './flightline/nightRoads';
import { sunVector } from './flightline/sun';
import { planetActiveFor, roadsEnabled, sunEpochMs } from './dayNight';
import {
  routeCorePaint, routeGlowPaint, routeLayerIds, routeLineLayers,
} from './routeStyle';
import planetFragment from './flightline/shaders/planet.frag?raw';
import planetMaterial from './flightline/shaders/material.glsl?raw';
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

// 近景瓦片失败的有界自动重试（世界/建筑源；与已验收候选一致）
const NEAR_SOURCES = ['world', 'buildings'];

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
  // 机场 Pin 点击回调（App 渲染信息卡；null = 未注册）
  private pinClickCb: ((a: Airport, x: number, y: number) => void) | null = null;
  // 3D 地形当前是否开启
  private terrainActive = false;
  // 当前底图模式：vector / satellite
  private baseMode: BaseMode;
  // 当前 UI 主题（地图样式 dark/light 与 CSS 同步）
  private themeDark: boolean;
  private lang: LabelLanguage;
  private labelsVisible = true;
  private space: SpaceScene | null = null;
  // 昼夜光照（demo cycle）与手动 UTC 时刻：统一状态，真实时钟只在其上重算太阳
  private cycleOn = true;
  private manualUtc: number | null = null;
  /** 最近一次太阳计算（DEV 诊断/复验用；不含航班业务时间） */
  private lastSun: { sun: [number, number, number]; timeDays: number; epoch: number } | null = null;
  // Flightline 运行时层
  private planet: PlanetLayer | null = null;
  private nightRoads: NightRoads | null = null;
  // 样式重建后重放业务航线用的最后参数
  private lastEntries: RouteEntry[] = [];
  private lastUnits: Units = 'km';
  private lastFmt: (km: number, u: Units) => string = () => '';
  // 主题重建期间禁止生长动画重放（样式切换不是几何变化）
  private noGrowth = false;
  // 近景瓦片失败重试预算
  private nearRetryTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};
  private nearRetryRounds: Record<string, number> = {};
  private sunTimer: ReturnType<typeof setInterval> | null = null;
  // 观感动画共用一个 rAF ticker（生长/标签淡入/小飞机巡航），无动画时自停省电；
  // id 形如 `grow:<routeId>` / `labelfade:<routeId>` / `plane:<routeId>`
  private anims = new Map<string, { tick: (now: number, dtMs: number) => boolean; cleanup: () => void }>();
  private tickerRaf: number | null = null;
  private lastTickNow = 0;
  // 本次 syncRoutes 内已启动的生长动画数（多条航线错峰）
  private growCount = 0;
  // 装饰小飞机总开关（默认关闭，右上菜单控制；URL plane=1）
  private planesEnabled = false;

  constructor(container: HTMLElement, lang: LabelLanguage, base: BaseMode, globe = false, dark = true) {
    // 卫星瓦片自定义协议必须在样式构建前注册，否则首批 gsat:// 瓦片会请求未注册协议；
    // getter 是动态的：用户运行时填入/更换 key 后无需重注册
    ensureProtocol(() => activeMapTilerKey());
    if (import.meta.env.DEV && container.clientHeight < 200) {
      // 布局塌陷守卫：.map-root 若被 maplibre 自带 CSS 翻盘（.maplibregl-map{position:relative}）
      // 会塌成 0 高，地图只剩 300px 默认条、页面"白屏"——DOM 探针全绿，只有像素能发现
      console.error(
        `[MapController] 地图容器高度塌陷 clientHeight=${container.clientHeight}px：` +
        '检查 .app-root .map-root 定位规则是否仍压过 .maplibregl-map',
      );
    }
    this.lang = lang;
    this.baseMode = base;
    this.themeDark = dark;
    this.map = new MLMap({
      container,
      style: buildStyle(lang, base, globe, dark),
      center: [110, 33],
      zoom: 3,
      attributionControl: false,
      hash: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, // 供截图/导出与自动化测试读帧
    });
    // 底图资源署名来自样式 sources；不再叠加旧 NASA 绿毯署名
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    // 比例尺已按用户要求移除（左下角只留品牌水印）
    if (import.meta.env.DEV) {
      (window as any).__map = this.map;
      (window as any).__mapErrors = [];
      // 昼夜/手动 UTC 复验句柄：只读快照，不暴露写入口
      (window as any).__dayNight = () => ({
        cycleOn: this.cycleOn,
        manualUtc: this.manualUtc,
        base: this.baseMode,
        lastSun: this.lastSun,
      });
    }
    // 每次样式建立（首屏、深浅主题重建）后挂载 Flightline 运行时层并重放业务航线
    this.map.on('style.load', () => this.attachRuntimeLayers());
    // 在下一次选片前同步，保留现有 source/缓存及互斥图层切换。
    // metadata 覆盖 TileJSON 的 tileSize 后也要重放（含首次加载/换 key）。
    this.map.on('move', () => {
      this.updateSatelliteLod();
      this.updateRoadHandovers();
      this.cullMarkers();
    });
    this.map.on('sourcedata', (e: any) => {
      if (e.sourceDataType === 'metadata') this.updateSatelliteLod();
      if (NEAR_SOURCES.includes(e.sourceId) && e.isSourceLoaded) {
        this.nearRetryRounds[e.sourceId] = 0;
        const timer = this.nearRetryTimers[e.sourceId];
        if (timer) { clearTimeout(timer); this.nearRetryTimers[e.sourceId] = null; }
      }
    });
    this.map.on('error', (e: any) => {
      if (e && e.tile) { this.scheduleNearRetry(e.sourceId); return; }
      if (import.meta.env.DEV) {
        (window as any).__mapErrors.push(String(e?.error?.message ?? e));
      }
    });
    // moveend/zoomend 时相机与投影变换已落定，重新裁剪一次 Pin（jumpTo 的同步 move
    // 事件里 transform 仍是旧相机，单靠 move 会把远端点误判为在屏内）。
    this.map.on('moveend', () => { this.nightRoads?.scheduleRefresh(); this.cullMarkers(); });
    this.map.on('zoomend', () => { this.nightRoads?.scheduleRefresh(); this.cullMarkers(); });
    this.map.on('projectiontransition', () => this.cullMarkers());
    // render 兜底：jumpTo 的同步 move/moveend 里 transform 可能仍是旧相机，
    // 投影过渡完成后的第一帧 render 才是最终位置（200ms 节流）。
    this.map.on('render', () => this.cullMarkers());
    this.map.on('remove', () => {
      if (this.sunTimer) { clearInterval(this.sunTimer); this.sunTimer = null; }
    });
    // 3D 太空场景（星空 + 大气辉光）：仅 globe 模式挂载；vector 模式下大气由
    // Flightline 行星层负责，这里只画星空（避免两套大气叠加）。
    this.syncSpaceScene();
    // 真实 UTC 太阳时钟：初始值 + 每 60 s 重算；业务时间不参与
    this.applySun();
    this.sunTimer = setInterval(() => this.applySun(), 60_000);
  }

  // ------------------------------------------------------------------
  // Flightline 运行时层生命周期
  // ------------------------------------------------------------------
  /** style.load：挂载行星光照/夜路，按当前状态重放业务航线、底图组、地形与语言。 */
  private attachRuntimeLayers(): void {
    const style = this.map.getStyle() as any;
    if (!style?.layers) return;
    const anchor = lightingAnchorLayerId(style as StyleSpecification);
    // 行星光照/地表层
    if (this.planet) {
      try { this.map.removeLayer(this.planet.id); } catch { /* 样式重建后已不存在 */ }
      this.planet = null;
    }
    const planet = new PlanetLayer({
      fragment: planetFragment,
      material: planetMaterial,
      onError: (e) => console.warn('[MapController] planet layer unavailable:', e),
    });
    try {
      this.map.addLayer(planet as any, anchor);
      this.planet = planet;
      if (import.meta.env.DEV) (window as any).__planet = planet;
    } catch (e) {
      console.warn('[MapController] addLayer planet failed', e);
    }
    // 夜间路网（真实干道几何；卫星模式下关闭）
    if (this.nightRoads) { this.nightRoads.dispose(); this.nightRoads = null; }
    const roads = new NightRoads(this.map as any, () => this.updateRoadHandovers(), { reuseOnAttach: true });
    this.nightRoads = roads;
    if (import.meta.env.DEV) {
      (window as any).__nightRoads = roads;
      (window as any).__nightDiagnostics = () => roads.diagnostics();
    }
    roads.attach(anchor).then(() => {
      if (this.nightRoads !== roads) return;
      roads.setEnabled(roadsEnabled(this.cycleOn, this.baseMode));
      roads.setLed(true);
      this.applySun();
    }).catch((e) => console.warn('[MapController] night roads unavailable:', String(e?.message ?? e)));
    this.planet?.setActive(planetActiveFor(this.baseMode));
    this.planet?.setCycle(this.cycleOn);
    // 旧样式的航线层已随 setStyle 消失；清掉登记，等下方 rebuildRoutes 重建
    this.routeLabelLayers.clear();
    // 底图组 / 标注配色 / 卫星与水面互斥
    this.applyBaseState();
    // 地形在 setStyle 后会被清空，按当前开关重放
    if (this.terrainActive) this.setTerrain(true);
    this.applySun();
    // 业务航线：样式重建后 source/layer 全没了，按最后参数重放（不重播生长动画）
    this.rebuildRoutes();
  }

  /** 样式重建前释放运行时层的计时器/监听（图层随 setStyle 一起消失）。 */
  private disposeRuntimeLayers(): void {
    this.nightRoads?.dispose();
    this.nightRoads = null;
    this.planet = null;
  }

  /** 样式重建后按保存的航线参数重画（Pin/小飞机重建，不重播生长动画）。 */
  private rebuildRoutes(): void {
    for (const [id, rec] of [...this.routes]) {
      this.cancelAnim(`grow:${id}`);
      this.cancelAnim(`labelfade:${id}`);
      this.cancelAnim(`plane:${id}`);
      for (const m of rec.markers) m.remove();
      this.removePlane(rec);
    }
    this.routes.clear();
    this.routeLabelLayers.clear();
    this.noGrowth = true;
    try {
      this.syncRoutes(this.lastEntries, this.lastUnits, this.lastFmt);
    } finally {
      this.noGrowth = false;
    }
  }

  private syncSpaceScene(): void {
    const globe = this.map.getProjection()?.type === 'globe';
    if (this.space && !globe) {
      this.space.destroy();
      this.space = null;
    }
    if (globe && !this.space) {
      // 太空背景 = demo 的确定性细星点；大气辉光由行星层 halo/haze 负责，不叠第二圈光晕
      this.space = mountSpaceScene(this.map);
    }
  }

  /** 昼夜光照开关（demo cycle 语义）：关掉暗化/城市夜光/夜路，但行星层仍激活以保留地表材质与大气 */
  setDayNight(on: boolean): void {
    const next = !!on;
    if (this.cycleOn === next) return;
    this.cycleOn = next;
    this.planet?.setCycle(next);
    if (this.nightRoads) {
      this.nightRoads.setEnabled(roadsEnabled(next, this.baseMode));
    }
    this.updateRoadHandovers();
    this.map.triggerRepaint();
  }

  /** 手动 UTC 时刻（小时 0–24）；null = 跟随真实时间。真实时钟不会覆盖手动值 */
  setManualUtc(hours: number | null): void {
    if (hours === this.manualUtc) return;
    this.manualUtc = hours;
    this.applySun();
  }

  private applySun(): void {
    const epoch = sunEpochMs(Date.now(), this.manualUtc);
    const { sun, timeDays } = sunVector(epoch);
    this.lastSun = { sun, timeDays, epoch };
    this.planet?.setSun(sun, timeDays);
    this.planet?.setCycle(this.cycleOn);
    this.nightRoads?.updateSun(sun, timeDays);
    this.updateRoadHandovers();
  }

  private updateRoadHandovers(): void {
    this.planet?.setHandovers(this.nightRoads?.handoff() ?? 0, this.nightRoads?.midHandoff() ?? 0);
  }

  /** 视口裁剪：globe 近景下 MapLibre Marker 的 smartWrap 会把远在另一半球的城市
   *  （如上海近景里的 LHR/JFK）换到屏幕内，Pin 会出现在错误位置。MapLibre 的
   *  world-copy 语义在 mercator 下是需要的（跨反经线时同一机场可能在 ±360° 的
   *  另一份世界副本里），所以按三份投影判断：任一份落在视口内才显示。
   *  只改 visibility，不动航线显隐使用的 display。 */
  private isOnScreen(lngLat: [number, number]): boolean {
    const host = this.map.getContainer();
    const w = host.clientWidth;
    const h = host.clientHeight;
    const M = 100;
    const inside = (p: { x: number; y: number }) =>
      Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -M && p.x <= w + M && p.y >= -M && p.y <= h + M;
    const [lng, lat] = lngLat;
    if (inside(this.map.project([lng, lat]))) return true;
    return inside(this.map.project([lng - 360, lat])) || inside(this.map.project([lng + 360, lat]));
  }

  private lastCullAt = 0;
  private cullMarkers(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastCullAt < 200) return;
    this.lastCullAt = now;
    for (const rec of this.routes.values()) {
      for (const m of rec.markers) {
        const el = m.getElement();
        const lng = Number(el.dataset.lng);
        const lat = Number(el.dataset.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const vis = this.isOnScreen([lng, lat]);
        const next = vis ? '' : 'hidden';
        if (el.style.visibility !== next) el.style.visibility = next;
      }
    }
  }

  /** 近景瓦片 5xx：只对静止视野做有界 refreshTiles 重试（6 次，6 s 间隔），
   *  已载入的源成功后会清空预算。与已验收候选一致。 */
  private scheduleNearRetry(sourceId?: string): void {
    if (!sourceId || !NEAR_SOURCES.includes(sourceId)) return;
    if (this.nearRetryTimers[sourceId] || (this.nearRetryRounds[sourceId] || 0) >= 6) return;
    this.nearRetryTimers[sourceId] = setTimeout(() => {
      this.nearRetryTimers[sourceId] = null;
      this.nearRetryRounds[sourceId] = (this.nearRetryRounds[sourceId] || 0) + 1;
      try {
        if (this.map.getSource(sourceId)) (this.map as any).refreshTiles(sourceId);
      } catch { /* 源可能已随样式重建消失 */ }
    }, 6000);
  }

  onReady(cb: () => void): void {
    const run = () => { try { cb(); } catch (e) { console.error('[MapController] onReady failed', e); } };
    if (this.map.isStyleLoaded()) run();
    else this.map.once('load', run);
  }

  /** 把当前状态（底图组 / 标注配色 / 卫星与水面互斥 / 行星与夜路开关）应用到地图。 */
  private applyBaseState(): void {
    const layers = (this.map.getStyle() as any)?.layers as any[] | undefined;
    if (!layers) return;
    const targetGroup = this.baseMode === 'satellite' ? 'satellite' : 'base';
    for (const l of layers) {
      const g = l.metadata?.group as string | undefined;
      if (!g || g === 'labels') continue;
      // 候选样式里默认隐藏的层（深度裁剪 / 晕染）翻组时不得被设回可见
      if (l.metadata?.hiddenByDefault) {
        this.map.setLayoutProperty(l.id, 'visibility', 'none');
        continue;
      }
      const visible = g === targetGroup;
      this.map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
    }
    // 标注：语言显隐 + 底图模式配色
    const sat = this.baseMode === 'satellite';
    const defaults = labelTextColors();
    const style = this.map.getStyle() as StyleSpecification;
    for (const id of labelLayerIds(style)) {
      try {
        this.map.setLayoutProperty(id, 'visibility', this.labelsVisible ? 'visible' : 'none');
        this.map.setPaintProperty(id, 'text-color', sat ? '#FFFFFF' : (defaults[id]?.color ?? '#000000'));
        this.map.setPaintProperty(id, 'text-halo-color', sat ? 'rgba(0,0,0,0.55)' : (defaults[id]?.halo ?? '#FFFFFF'));
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }
    for (const id of this.routeLabelLayers) {
      if (!this.map.getLayer(id)) continue; // 样式重建瞬间旧航线层已不存在，等 rebuildRoutes 重建
      try {
        this.map.setPaintProperty(id, 'text-halo-color', ROUTE_LABEL_HALO);
      } catch {
        /* 同上 */
      }
    }
    this.applyWaterVisibility();
    this.planet?.setActive(planetActiveFor(this.baseMode));
    this.planet?.setCycle(this.cycleOn);
    this.nightRoads?.setEnabled(roadsEnabled(this.cycleOn, this.baseMode));
    this.updateRoadHandovers();
  }

  /** 矢量 / 卫星底图切换（按 metadata.group 翻 visibility，航线层不受影响） */
  setBase(mode: BaseMode): void {
    this.baseMode = mode;
    this.applyBaseState();
    this.syncSpaceScene();
    this.map.triggerRepaint();
  }

  /** 深浅主题：重建地图样式（Flightline dark/light）；业务航线由 style.load 重放。
   *  CSS 主题仍由 App 的 html.dark 类负责，这里只同步地图。 */
  setTheme(dark: boolean): void {
    if (dark === this.themeDark) return;
    this.themeDark = dark;
    this.disposeRuntimeLayers();
    const globe = this.map.getProjection()?.type === 'globe';
    this.map.setStyle(buildStyle(this.lang, this.baseMode, globe, dark), { diff: false });
  }

  /** 用户在菜单填入自己的 MapTiler key（UI 侧已通过抓瓦片预验证）：写 localStorage + 热更新
   *  gsat 协议取值，并整源重建卫星 source（tileSize/maxzoom 无法原地改）。
   *  换 key 时瓦片 URL 带 ?v=<n> 版本号穿透 maplibre 瓦片缓存；卫星层可见性保持不变。 */
  applySatelliteKey(key: string): void {
    setRuntimeMapTilerKey(key);
    bumpSatTileVersion();
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
    // 插回原位：background 之后、矢量水面层（water-ocean）之前——影像在下、水面铺色在上
    const beforeId = style.layers.find((l: any) => l.id !== 'background' && l.id !== 'satellite')?.id;
    this.map.addSource('satellite-imagery', satelliteSourceSpec());
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
    this.applyWaterVisibility();
  }

  /** 3D 地球投影：globe=低缩放渲染为球体（放大后 maplibre 自动回落 mercator），mercator=常规平面。
   *  sky 随投影切换：球体=深空+大气，平面=全透明（杜绝俯仰时出雾色） */
  setGlobe(on: boolean): void {
    try {
      this.map.setProjection({ type: on ? 'globe' : 'mercator' });
      this.map.setSky(on ? (GLOBE_SKY as any) : (FLAT_SKY as any));
      this.updateSatelliteLod();
    } catch (e) {
      console.warn('[MapController] setProjection failed', e);
    }
    this.syncSpaceScene();
    this.nightRoads?.scheduleRefresh(400);
    this.updateRoadHandovers();
    this.map.triggerRepaint();
  }

  private updateSatelliteLod(): void {
    const globe = this.map.getProjection()?.type === 'globe';
    for (const id of ['satellite-imagery']) {
      const source = this.map.getSource(id);
      if (source?.type !== 'raster') continue;
      // serialize 保留源配置值，避免在连续拖拽时重复累乘补偿。
      const spec = source.serialize();
      if (spec.type !== 'raster') continue;
      source.tileSize = satelliteTileSize(
        spec.tileSize ?? 512, this.map.getCenter().lat, this.map.getZoom(), globe,
      );
    }
  }

  /** 3D 地形起伏：复用样式里的 terrain-dem 源（游戏地形档案，terrarium）。
   *  exaggeration 1.2 与整体观感匹配；关闭传 null 恢复平面。
   *  样式未就绪时调用会抛错，由调用方保证时序（App 在 onReady 重放 / ready 后的 effect 里调用）。 */
  setTerrain(on: boolean): void {
    try {
      this.map.setTerrain(on ? { source: 'terrain-dem', exaggeration: 1.2 } : null);
      this.terrainActive = on;
    } catch (e) {
      console.warn('[MapController] setTerrain failed', e);
    }
  }

  private applyWaterVisibility(): void {
    const vis = this.baseMode === 'satellite'
      ? 'visible'
      : 'none';
    for (const id of ['water-ocean', 'water-other']) {
      try {
        this.map.setLayoutProperty(id, 'visibility', vis);
      } catch {
        /* 图层可能尚未就绪，忽略 */
      }
    }
  }

  /** 视角回正：正北朝向 + 俯仰归零（中心与缩放不变） */
  resetView(): void {
    this.map.easeTo({ bearing: 0, pitch: 0, duration: 650 });
  }

  /** 注册机场 Pin 点击回调（屏幕坐标相对地图容器，信息卡由业务层渲染）。传 null 注销 */
  onPinClick(cb: ((a: Airport, x: number, y: number) => void) | null): void {
    this.pinClickCb = cb;
  }

  /** 切换地图标注语言（逐层替换 text-field 表达式） */
  setLabelsLanguage(lang: LabelLanguage): void {
    this.lang = lang;
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
    this.labelsVisible = visible;
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
    this.lastEntries = entries;
    this.lastUnits = units;
    this.lastFmt = fmt;
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

  /** 默认粗细：demo 验收值（core 1.3 / glow 6，width 倍率线性缩放） */
  private renderRoute(e: RouteEntry, units: Units, fmt: (km: number, u: Units) => string): LegInfo[] {
    const ids = routeLayerIds(e.id);
    const srcLine = ids.source;
    const srcLabel = ids.label;
    const glowLayer = ids.glow;
    const lineLayer = ids.core;
    const labelLayer = ids.label;
    let rec = this.routes.get(e.id);
    // 几何变化（新增 / 编辑经停 / 导入真实航路）→ 重放生长动画；纯样式与单位调整不重放
    const codesSig = e.airports.map((a) => a.iata || a.icao).join('-');
    const geoSig = `${codesSig}:${e.waypoints?.length ?? 0}`;
    const willGrow = (rec ? rec.geoSig !== geoSig : true) && e.visible && !prefersReducedMotion() && !this.noGrowth;
    if (!rec) {
      const beforeId = routeAnchorLayerId(this.map.getStyle() as StyleSpecification);
      this.map.addSource(srcLine, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addSource(srcLabel, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      // glow + core 共用同一 source：生长切片、显隐、删除、颜色/粗细天然同步
      const [glowSpec, coreSpec] = routeLineLayers(e.id, srcLine, e.color, e.width);
      this.map.addLayer(glowSpec as any, beforeId);
      this.map.addLayer(coreSpec as any, beforeId);
      this.map.addLayer(
        {
          id: labelLayer, type: 'symbol', source: srcLabel,
          layout: {
            'text-field': ['get', 'label'],
            // 游戏字体只有 Regular/Medium/Italic；Medium 是可用字重里最接近原 Bold 的一档
            'text-font': ['Noto Sans Medium'],
            'text-size': 11,
            'text-line-height': 1.25,
            'text-justify': 'center',
            // 航线标签是主动生成的核心 UI，不允许被底图标注碰撞挤掉（底图标注密，洲际视野下会落败）
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
      // 颜色 / 粗细可能变了：幂等覆盖，代价可忽略（core 与 glow 必须成对更新）
      try {
        for (const [key, value] of Object.entries(routeGlowPaint(e.color, e.width))) {
          this.map.setPaintProperty(glowLayer, key, value as any);
        }
        for (const [key, value] of Object.entries(routeCorePaint(e.color, e.width))) {
          this.map.setPaintProperty(lineLayer, key, value as any);
        }
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

    // 机场 Pin（demo 外观：小圆点 + 细描边 + 机场代码）：仅在机场序列变化时重建，颜色与显隐每次同步
    const sig = e.airports.map((a) => a.iata || a.icao).join('-');
    if (sig !== rec.codesSig) {
      for (const m of rec.markers) m.remove();
      rec.markers = [];
      e.airports.forEach((a) => {
        const code = a.iata || a.icao;
        const el = document.createElement('div');
        el.className = 'ap-pin';
        el.style.cursor = 'pointer';
        // demo 的 airports/airport-labels 等效外观：6px 圆点 + 1.5px 深描边 + 代码小字。
        // 不保留旧光晕/城市副标题/序号徽章；透明热区保证 6px 视觉点仍可轻松点击。
        el.innerHTML = `
          <div class="ap-pin-hit"></div>
          <div class="ap-pin-dot"></div>
          <div class="ap-pin-label">${code}</div>`;
        el.dataset.lng = String(a.lon);
        el.dataset.lat = String(a.lat);
        // 点击 Pin → 业务层信息卡（屏幕坐标相对地图容器；el 为 0×0 定位锚，rect 即点位）
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!this.pinClickCb) return;
          const r = el.getBoundingClientRect();
          const host = this.map.getContainer().getBoundingClientRect();
          this.pinClickCb(a, r.left - host.left, r.top - host.top);
        });
        // globe 模式下球体背面的 Pin 会被 maplibre 套 opacityWhenCovered（默认 0.2 → 半透明幽灵
        // 标志透出球面），置 0 让背面完全隐藏；mercator 下 isLocationOccluded 恒 false，无副作用
        const marker = new Marker({ element: el, anchor: 'center', opacityWhenCovered: 0 })
          .setLngLat([a.lon, a.lat])
          .addTo(this.map);
        rec!.markers.push(marker);
      });
      rec.codesSig = sig;
      this.cullMarkers();
    } else if (rec.plane) {
      rec.plane.el.style.setProperty('--plane-color', e.color);
    }

    const vis = e.visible ? 'visible' : 'none';
    try {
      this.map.setLayoutProperty(glowLayer, 'visibility', vis);
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
        // rAF 时间戳可能略早于动画 start（同一帧里刚建立的动画），下限夹 0 避免
        // 向 MapLibre 写入负 opacity（会被校验器记为样式错误）。
        const k = Math.min(1, Math.max(0, (now - start) / LABEL_FADE_MS));
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
      // 与 Pin 同款视口裁剪：globe 近景时 avoid smartWrap 把远端点换进屏幕
      rec.plane.el.style.visibility = this.isOnScreen(p.lngLat) ? '' : 'hidden';
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
    const ids = routeLayerIds(id);
    for (const m of rec.markers) m.remove();
    this.removePlane(rec);
    try { this.map.removeLayer(ids.glow); } catch { /* 可能尚未添加 */ }
    try { this.map.removeLayer(ids.core); } catch { /* 同上 */ }
    try { this.map.removeLayer(ids.label); } catch { /* 同上 */ }
    try { this.map.removeSource(ids.source); } catch { /* 同上 */ }
    try { this.map.removeSource(ids.label); } catch { /* 同上 */ }
    this.routeLabelLayers.delete(ids.label);
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

  /** 视野适配多条（可见）航线的并线并集 */
  fitRoutes(entries: RouteEntry[]): void {
    this.fitRoute(entries.flatMap((e) => e.airports));
  }
}
