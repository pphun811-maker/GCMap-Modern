// Flightline 夜间路网（已验收 Round 04/07/09 成果，主项目接线版）。
//
// 来源：候选 round-11 的 night-roads.js（逐字节算法未改）。差异只在部署适配：
//   - 道路几何地址改为主项目 /map-res/roads.geojson；
//   - 道路样式表改为构建期内联（不再 fetch /assets/road-glow-style.json）；
//   - 移除 demo 的 state 对象，开关由 MapController 显式调用 setEnabled/setLed。
//
// 保留的机制（验收依赖，勿简化）：
//   1. drawable —— 只有 worker 确认过的 appliedVersion 才算可画（GeoJSON source 的
//      版本化提交镜像，见下方 submitData / handleSourceData 契约）；
//   2. covering —— 请求盒必须完全覆盖当前视野（反经线拆两段），部分覆盖不接管；
//   3. current  —— 600 ms 取数宽限内不接管；静态视野靠定时器自恢复。
//   4. 中尺度 pass（z3.5–7）与近景 pass（z6–24）各自一套 atlas 接管标量。
//   5. 主题重建复用 LAST_APPLIED，但仍在 deferred fire 时复核视野与代次。
//
// 数据只含真实 highway/major_road/medium_road/minor_road；缺数据时 atlas 保持原样。

import roadGlowRaw from './roadGlowStyle.json?raw';
import { mapResourceUrl } from '../styleFactory';

const NIGHT_CLASSES = ['highway', 'major_road', 'medium_road', 'minor_road'];
const MID_CLASSES = ['highway', 'major_road'];
const LAYER_MINZOOM = 6;
const MID_LAYER_MINZOOM = 3.5;
const HANDOFF_ZOOM_START = 6.0;
const HANDOFF_ZOOM_END = 8.0;
const MID_HANDOFF_ZOOM_START = 3.5;
const MID_HANDOFF_ZOOM_FULL = 5.5;
const MID_HANDOFF_FADE_START = 5.9;
const MID_HANDOFF_FADE_END = 7.0;
const MID_HALO_RGBA = [255, 138, 52];
const MID_CORE_RGBA = [255, 185, 92];
const MID_HALO_ALPHA = 0.18;
const MID_CORE_ALPHA = 0.28;
const MID_WIDTHS: Record<string, { halo: any; core: any }> = {
  highway: {
    halo: ['interpolate', ['linear'], ['zoom'], 3.5, 1.1, 4, 1.35, 5, 1.7, 5.8, 2.1, 6.6, 2.4],
    core: ['interpolate', ['linear'], ['zoom'], 3.5, 0.45, 4, 0.55, 5, 0.7, 5.8, 0.85, 6.6, 0.95],
  },
  major_road: {
    halo: ['interpolate', ['linear'], ['zoom'], 3.5, 0.9, 4, 1.1, 5, 1.35, 5.8, 1.7, 6.6, 2.0],
    core: ['interpolate', ['linear'], ['zoom'], 3.5, 0.36, 4, 0.44, 5, 0.55, 5.8, 0.68, 6.6, 0.78],
  },
};
const FETCH_GRACE_MS = 600;
const EXPRESSION_INTERVAL_MS = 100;
const COVERAGE_ZOOM_SLACK = 2;
const MID_COVERAGE_ZOOM_SLACK = 3.0;
const SPILL_WIDTH = 2.2;
const SPILL_ALPHA = 0.25;
const REUSE_ZOOM_TOLERANCE = 0.25;
const REUSE_SUBMIT_MAX_MS = 1500;
const LED_WHITE = [255, 237.15, 204];
const LED_MIX = 0.6;

/** 最后一次成功应用的集合：跨实例保留，主题重建时可免网络重提交。 */
let LAST_APPLIED: {
  features: any[];
  metadata: any[];
  boxes: number[][];
  z: number;
  at: number;
  truncated: boolean;
} | null = null;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smootherstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const E = {
  get: (key: string) => ['get', key],
  add: (...terms: any[]) => ['+', ...terms],
  sub: (a: any, b: any) => ['-', a, b],
  mul: (...terms: any[]) => ['*', ...terms],
  div: (a: any, b: any) => ['/', a, b],
  min: (...terms: any[]) => ['min', ...terms],
  max: (...terms: any[]) => ['max', ...terms],
  floor: (a: any) => ['floor', a],
  sin: (a: any) => ['sin', a],
  cos: (a: any) => ['cos', a],
  asin: (a: any) => ['asin', a],
};
const clamp01 = (x: any) => E.min(1, E.max(0, x));
const ss = (a: any, b: any, x: any) => {
  // a/b 也可能是表达式（部分夜间时间表）；span 必须保持表达式。
  const t = clamp01(E.div(E.sub(x, a), E.sub(b, a)));
  return E.mul(E.mul(t, t), E.sub(3, E.mul(2, t)));
};
const fract = (x: any) => E.sub(x, E.floor(x));

// 抽取出的 halo 层用 line-blur，但 MapLibre 的 line-blur 会把 Chrome/ANGLE 的
// WebGL 错误计数顶到上限（实测单 pass 即可复现，blur=0 消失）。用更宽更淡的 spill
// pass 代替模糊：宽度/alpha 乘固定系数。
const scaleWidth = (expression: any, factor: number): any => {
  if (!Array.isArray(expression)) return expression;
  if (expression[0] === 'interpolate') {
    const out = expression.slice(0, 3);
    for (let i = 3; i < expression.length; i += 2) {
      out.push(expression[i], typeof expression[i + 1] === 'number' ? expression[i + 1] * factor : expression[i + 1]);
    }
    return out;
  }
  return expression.map((item) => scaleWidth(item, factor));
};
const scaleColorAlpha = (expression: any, factor: number): any => {
  if (!Array.isArray(expression)) return expression;
  if (expression[0] === 'rgba' && expression.length === 5) {
    return ['rgba', expression[1], expression[2], expression[3], Number((expression[4] * factor).toFixed(6))];
  }
  return expression.map((item) => scaleColorAlpha(item, factor));
};

// 每个 rgba stop 的通道向 LED 暖白移动 led*mix：两种开关状态都保持 data-driven 表达式
//（MapLibre 在 data-driven 与常量形式之间切换不能可靠重绘已建瓦片，改系数可以）。
const ledColorOf = (expression: any, mix: number): any => {
  const walk = (node: any): any => {
    if (!Array.isArray(node)) return node;
    if (node[0] === 'rgba' && node.length === 5
        && [1, 2, 3, 4].every((i) => typeof node[i] === 'number')) {
      const amount = ['*', ['coalesce', ['get', 'led'], 0], mix];
      return ['rgba',
        ['+', node[1], ['*', LED_WHITE[0] - node[1], amount]],
        ['+', node[2], ['*', LED_WHITE[1] - node[2], amount]],
        ['+', node[3], ['*', LED_WHITE[2] - node[3], amount]],
        node[4],
      ];
    }
    return node.map(walk);
  };
  return walk(expression);
};

export interface NightRoadsOptions {
  reuseOnAttach?: boolean;
  ledEnabled?: boolean;
  reuseSubmitDelayMs?: number;
}

export class NightRoads {
  private map: any;
  private onChange: (status: string) => void;
  private reuseOnAttach: boolean;
  private ledEnabled: boolean;
  private skipNextEnabledRefresh = false;
  private reuseTimer: ReturnType<typeof setTimeout> | null = null;
  private reuseFire: (() => void) | null = null;
  private idleSubscribed = false;
  private reuseSubmitDelayMs: number;
  private sourceId = 'night-roads';
  private layerIds: string[] = [];
  private layerSpecs = new Map<string, any>();
  private midLayerIds: string[] = [];
  private midLayerSpecs = new Map<string, any>();
  private styleSpec: any = null;
  private attached = false;
  private enabled = true;
  private dataVersion = 0;
  private appliedVersion = 0;
  private readyVersion = 0;
  private inflightVersion: number | null = null;
  private pendingVersion: number | null = null;
  private loaded = false;
  private features = 0;
  private truncated = false;
  private classes: Record<string, number> = {};
  private coverage: { boxes: number[][] } | null = null;
  private appliedZoom: number | null = null;
  private sun: [number, number, number] = [0, 0, 1];
  private sunLon = 0;
  private fetching = false;
  private graceExpired = false;
  private lastSuccess = 0;
  private lastError: string | null = null;
  private lastExpression = 0;
  private expressionTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private partialRetries = 0;
  private partialView: { boxes: number[][]; z: number } | null = null;
  private abort: AbortController | null = null;
  private sequence = 0;
  private timing: any = null;
  private timingLog: any[] = [];
  private eventMode = false;
  private removed = false;
  private lastMetadata: any[] | null = null;

  constructor(map: any, onChange: (status: string) => void, options: NightRoadsOptions = {}) {
    this.map = map;
    this.onChange = onChange || (() => {});
    this.reuseOnAttach = !!options.reuseOnAttach;
    this.ledEnabled = options.ledEnabled !== false;
    this.reuseSubmitDelayMs = options.reuseSubmitDelayMs ?? REUSE_SUBMIT_MAX_MS;
    this.handleSourceData = this.handleSourceData.bind(this);
  }

  private handleSourceData(event: any): void {
    if (this.removed || !event || event.sourceId !== this.sourceId) return;
    // 普通瓦片完成事件也会走 sourcedata，但没有 sourceDataType；它们不确认任何版本。
    if (event.tile || event.coord) return;
    if (event.sourceDataType !== 'content') return;
    // 每个完成的 worker job 恰好一个无版本 content 事件，按提交顺序：最老的在飞 job 完成。
    if (this.inflightVersion === null) return;
    const confirmed = this.inflightVersion;
    this.inflightVersion = this.pendingVersion;
    this.pendingVersion = null;
    if (confirmed === 0) return; // addSource 初始空数据 job
    this.readyVersion = confirmed;
    if (this.timing && this.timing.version === confirmed) {
      this.mark('workerConfirm');
      if (typeof this.map.once === 'function') {
        this.map.once('idle', () => this.mark('idleAfterConfirm'));
      }
    }
    const was = this.loaded;
    this.updateLoaded();
    if (this.timing && this.timing.version === confirmed && this.loaded) this.mark('drawable');
    if (this.loaded !== was) {
      if (this.loaded) this.updateExpressions(true);
      this.notify();
    }
  }

  newTiming(kind: string, info: Record<string, any> = {}): void {
    this.timing = { kind, start: performance.now(), version: null, marks: {}, ...info };
    this.timingLog.push(this.timing);
    if (this.timingLog.length > 64) this.timingLog.shift();
  }
  mark(name: string): void {
    if (this.timing && this.timing.marks[name] === undefined) {
      this.timing.marks[name] = Math.round((performance.now() - this.timing.start) * 10) / 10;
    }
  }
  endTiming(end: string): void {
    if (!this.timing) return;
    this.mark(end);
    this.timing.durationMs = Math.round((performance.now() - this.timing.start) * 10) / 10;
    this.timing = null;
  }
  getTimings(): any {
    return { current: this.timing, log: this.timingLog };
  }

  async attach(beforeId?: string): Promise<void> {
    if (this.attached) return;
    this.newTiming('attach');
    this.styleSpec = JSON.parse(roadGlowRaw);
    if (this.removed) return;
    this.mark('styleSpecLoaded');
    this.eventMode = typeof this.map.on === 'function';
    if (this.eventMode) this.map.on('sourcedata', this.handleSourceData);
    if (!this.map.getSource(this.sourceId)) {
      this.map.addSource(this.sourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // addSource 会同步启动初始 job（version 0），避免它的 content 事件被误认成真实数据。
      this.inflightVersion = 0;
    }
    const byId = new Map<string, any>(this.styleSpec.layers.map((item: any) => [item.layer.id, item.layer]));
    // 中尺度 pass 先加，近景 pass 后加（6.0–6.6 交叉淡入时近景在上）。
    for (const cls of MID_CLASSES) {
      const halo = byId.get(`local-road-glow-${cls}-halo`);
      const core = byId.get(`local-road-glow-${cls}-core`);
      const widths = MID_WIDTHS[cls];
      if (!halo || !core || !widths) continue;
      const passes = [
        { pass: 'spill', baseColor: ['rgba', ...MID_HALO_RGBA, MID_HALO_ALPHA * SPILL_ALPHA], width: scaleWidth(widths.halo, SPILL_WIDTH) },
        { pass: 'halo', baseColor: ['rgba', ...MID_HALO_RGBA, MID_HALO_ALPHA], width: widths.halo },
        { pass: 'core', baseColor: ['rgba', ...MID_CORE_RGBA, MID_CORE_ALPHA], width: widths.core },
      ] as any[];
      for (const spec of passes) {
        spec.colorOn = ledColorOf(spec.baseColor, LED_MIX);
        spec.colorOff = ledColorOf(spec.baseColor, 0);
        const id = `night-road-mid-${cls}-${spec.pass}`;
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        this.map.addLayer({
          id,
          type: 'line',
          source: this.sourceId,
          filter: ['==', ['get', 'k'], cls],
          minzoom: MID_LAYER_MINZOOM,
          maxzoom: 7.0,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': this.ledEnabled ? spec.colorOn : spec.colorOff,
            'line-width': spec.width,
            'line-blur': 0,
            'line-opacity': 0,
          },
        }, beforeId);
        this.midLayerIds.push(id);
        this.midLayerSpecs.set(id, spec);
      }
    }
    for (const cls of NIGHT_CLASSES) {
      const halo = byId.get(`local-road-glow-${cls}-halo`);
      const core = byId.get(`local-road-glow-${cls}-core`);
      if (!halo || !core) continue;
      const passes = [
        { pass: 'spill', baseColor: scaleColorAlpha(halo.paint['line-color'], SPILL_ALPHA), width: scaleWidth(halo.paint['line-width'], SPILL_WIDTH) },
        { pass: 'halo', baseColor: halo.paint['line-color'], width: halo.paint['line-width'] },
        { pass: 'core', baseColor: core.paint['line-color'], width: core.paint['line-width'] },
      ] as any[];
      for (const spec of passes) {
        spec.colorOn = ledColorOf(spec.baseColor, LED_MIX);
        spec.colorOff = ledColorOf(spec.baseColor, 0);
        const id = `night-road-glow-${cls}-${spec.pass}`;
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        this.map.addLayer({
          id,
          type: 'line',
          source: this.sourceId,
          filter: ['==', ['get', 'k'], cls],
          minzoom: LAYER_MINZOOM,
          maxzoom: 24,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': this.ledEnabled ? spec.colorOn : spec.colorOff,
            'line-width': spec.width,
            'line-blur': 0,
            'line-opacity': 0,
          },
        }, beforeId);
        this.layerIds.push(id);
        this.layerSpecs.set(id, spec);
      }
    }
    this.mark('layersAdded');
    this.attached = true;
    const cached = LAST_APPLIED;
    let reused = false;
    this.endTiming('attachLayers');
    if (this.reuseOnAttach && this.reuseIsCurrent(cached)) {
      const attachSequence = this.sequence;
      const fire = () => {
        if (this.reuseTimer) { clearTimeout(this.reuseTimer); this.reuseTimer = null; }
        if (this.idleSubscribed && typeof this.map.off === 'function') {
          this.map.off('idle', fire);
          this.idleSubscribed = false;
        }
        if (this.removed || this.attached !== true || this.appliedVersion !== 0) return;
        if (!this.enabled || this.sequence !== attachSequence) return;
        if (!this.reuseIsCurrent(cached)) {
          this.scheduleRefresh(0);
          return;
        }
        this.newTiming('reuse');
        this.mark('cacheHit');
        this.applyData(cached!.features, cached!.metadata, cached!.boxes, cached!.z);
      };
      this.reuseFire = fire;
      if (this.reuseSubmitDelayMs === 0) {
        fire();
      } else {
        if (typeof this.map.once === 'function') { this.map.once('idle', fire); this.idleSubscribed = true; }
        this.reuseTimer = setTimeout(fire, this.reuseSubmitDelayMs);
      }
      reused = true;
      this.skipNextEnabledRefresh = true;
    }
    this.updateExpressions(true);
    if (!reused) this.scheduleRefresh(0);
  }

  setLed(enabled: boolean): void {
    const next = !!enabled;
    if (next === this.ledEnabled) return;
    this.ledEnabled = next;
    if (!this.attached) return;
    for (const id of [...this.layerIds, ...this.midLayerIds]) {
      const spec = this.layerSpecs.get(id) || this.midLayerSpecs.get(id);
      if (spec && this.map.getLayer(id)) {
        this.map.setPaintProperty(id, 'line-color', next ? spec.colorOn : spec.colorOff);
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
    this.applyVisibility();
    if (this.enabled) {
      this.updateExpressions(true);
      if (this.skipNextEnabledRefresh) {
        this.skipNextEnabledRefresh = false;
      } else {
        this.scheduleRefresh(0);
      }
    } else {
      if (this.abort) { this.abort.abort(); this.abort = null; }
      ++this.sequence;
      this.fetching = false;
      this.graceExpired = false;
      this.skipNextEnabledRefresh = false;
      this.disarmGraceTimer();
    }
    this.notify();
  }

  applyVisibility(): void {
    if (!this.attached) return;
    const visible = this.enabled ? 'visible' : 'none';
    for (const id of [...this.layerIds, ...this.midLayerIds]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible);
    }
  }

  notify(): void {
    if (!this.removed) this.onChange(this.status());
  }

  updateSun(sun: [number, number, number], _timeDays: number): void {
    this.sun = sun;
    this.sunLon = Math.atan2(sun[0], sun[2]) * 180 / Math.PI;
    if (!this.enabled || !this.attached) return;
    const now = performance.now();
    if (now - this.lastExpression >= EXPRESSION_INTERVAL_MS) {
      this.updateExpressions();
    } else if (!this.expressionTimer) {
      this.expressionTimer = setTimeout(() => {
        this.expressionTimer = null;
        this.updateExpressions();
      }, EXPRESSION_INTERVAL_MS - (now - this.lastExpression) + 5);
    }
  }

  private solarAlphaState(): { planetDark: any; viewDark: any; alphaFor: (dark: any) => any } {
    const sx = this.sun[0], sy = this.sun[1], sz = this.sun[2];
    const sinE = E.add(
      E.mul(E.sin(E.get('br')), sy),
      E.mul(E.cos(E.get('br')), E.add(
        E.mul(E.sin(E.get('lr')), sx),
        E.mul(E.cos(E.get('lr')), sz),
      )),
    );
    const planetDark = E.sub(1, ss(-0.21, -0.02, sinE));
    const elev = E.mul(E.asin(E.min(1, E.max(-1, sinE))), 180 / Math.PI);
    const viewDark = E.sub(1, ss(-6, 3, elev));
    const hour = E.add(12, E.mul(
      fract(E.add(E.div(E.sub(E.get('ln'), this.sunLon), 360), 1)),
      24,
    ));
    const nightFactor = E.mul(
      ss(E.get('oa'), E.add(E.get('oa'), 0.1), hour),
      E.sub(1, ss(E.get('on'), E.add(E.get('on'), 0.1), hour)),
    );
    const alphaFor = (dark: any) => E.min(1, E.max(0, E.mul(
      E.mul(E.get('lit'), E.sub(1, E.mul(E.get('off'), nightFactor))),
      E.mul(E.get('gain'), E.mul(E.sub(1, E.mul(0.25, nightFactor)), dark)),
    )));
    return { planetDark, viewDark, alphaFor };
  }

  private opacityExpression(): any {
    const { planetDark, viewDark, alphaFor } = this.solarAlphaState();
    return ['interpolate', ['linear'], ['zoom'], 6, alphaFor(planetDark), 8, alphaFor(viewDark), 24, alphaFor(viewDark)];
  }

  private midOpacityExpression(): any {
    const { planetDark, alphaFor } = this.solarAlphaState();
    const a = alphaFor(planetDark);
    return ['interpolate', ['linear'], ['zoom'],
      3.5, E.mul(a, 0),
      4.1, E.mul(a, 0.55),
      4.8, E.mul(a, 0.85),
      5.6, E.mul(a, 1),
      6.2, E.mul(a, 1),
      6.6, E.mul(a, 0.55),
      7.0, E.mul(a, 0),
    ];
  }

  updateExpressions(force = false): void {
    if (!this.attached || !this.enabled) return;
    const now = performance.now();
    if (!force && now - this.lastExpression < EXPRESSION_INTERVAL_MS) return;
    this.lastExpression = now;
    if (!this.loaded || this.features === 0) return;
    const expression = this.opacityExpression();
    for (const id of this.layerIds) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-opacity', expression);
    }
    const midExpression = this.midOpacityExpression();
    for (const id of this.midLayerIds) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-opacity', midExpression);
    }
  }

  scheduleRefresh(delay = 180): void {
    if (!this.attached || !this.enabled) return;
    clearTimeout(this.refreshTimer!);
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null; }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private requestBoxes(boxes: number[][]): number[][] {
    return boxes.map(([w, s, e, n]) => {
      const margin = Math.max(0.02, (e - w) * 0.03);
      return [w - margin, Math.max(-85, s - margin), e + margin, Math.min(85, n + margin)];
    });
  }

  private schedulePartialRetry(requested: number[][], z: number): void {
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null; }
    if (this.partialRetries >= 5) return;
    this.partialView = { boxes: requested.map((box) => box.slice()), z };
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      if (this.removed || !this.attached || !this.enabled || this.fetching) return;
      if (!this.partialView) return;
      const current = this.requestBoxes(this.viewBoxes());
      const sameView = this.map.getZoom() === this.partialView.z
        && JSON.stringify(current) === JSON.stringify(this.partialView.boxes);
      if (!sameView) { this.partialView = null; return; }
      this.partialRetries++;
      void this.refresh();
    }, 4000);
  }

  private viewBoxes(): number[][] {
    const bounds = this.map.getBounds();
    let west = bounds.getWest(), east = bounds.getEast();
    const south = Math.max(-85, bounds.getSouth());
    const north = Math.min(85, bounds.getNorth());
    west = ((west + 180) % 360 + 360) % 360 - 180;
    east = ((east + 180) % 360 + 360) % 360 - 180;
    if (north - south >= 170) return [];
    if (east <= west) return [[west, south, 180, north], [-180, south, east, north]];
    if (east - west > 180) return [[west, south, 0, north], [0, south, east, north]];
    return [[west, south, east, north]];
  }

  private reuseIsCurrent(cached: typeof LAST_APPLIED): boolean {
    if (!cached || cached.truncated) return false;
    if (Math.abs(this.map.getZoom() - cached.z) > REUSE_ZOOM_TOLERANCE) return false;
    return this.boxesCoverView(cached.boxes);
  }

  coversView(z: number, slack = COVERAGE_ZOOM_SLACK): boolean {
    const cov = this.coverage;
    if (!cov || this.appliedZoom === null) return false;
    if (Math.abs(z - this.appliedZoom) > slack) return false;
    return this.boxesCoverView(cov.boxes);
  }

  coverageFraction(): number {
    const cov = this.coverage;
    if (!cov || !Array.isArray(cov.boxes) || !cov.boxes.length) return 0;
    const b = this.map.getBounds();
    let west = b.getWest(), east = b.getEast();
    west = ((west + 180) % 360 + 360) % 360 - 180;
    east = ((east + 180) % 360 + 360) % 360 - 180;
    const south = Math.max(-85, b.getSouth());
    const north = Math.min(85, b.getNorth());
    if (!(north > south)) return 0;
    let spans: number[][];
    if (east <= west) spans = [[west, 180], [-180, east]];
    else if (east - west > 180) spans = [[-180, 180]];
    else spans = [[west, east]];
    let total = 0, covered = 0;
    for (const [a, z] of spans) {
      total += (z - a) * (north - south);
      for (const [w, s, e, n] of cov.boxes) {
        const lon = Math.max(0, Math.min(z, e) - Math.max(a, w));
        const lat = Math.max(0, Math.min(north, n) - Math.max(south, s));
        covered += lon * lat;
      }
    }
    return total > 0 ? clamp(covered / total, 0, 1) : 0;
  }

  private boxesCoverView(boxes: number[][] | null | undefined): boolean {
    if (!Array.isArray(boxes) || !boxes.length) return false;
    const b = this.map.getBounds();
    let west = b.getWest(), east = b.getEast();
    const south = b.getSouth(), north = b.getNorth();
    west = ((west + 180) % 360 + 360) % 360 - 180;
    east = ((east + 180) % 360 + 360) % 360 - 180;
    let spans: number[][];
    if (east <= west) spans = [[west, 180], [-180, east]];
    else if (east - west > 180) spans = [[-180, 180]];
    else spans = [[west, east]];
    const EPS = 1e-7;
    const usable = boxes
      .filter(([, s, , n]) => s <= south + EPS && n >= north - EPS)
      .sort((p, q) => p[0] - q[0]);
    for (const [a, b2] of spans) {
      let cursor = a;
      for (const [w, , e] of usable) {
        if (e <= cursor + EPS) continue;
        if (w > cursor + EPS) return false;
        cursor = Math.max(cursor, Math.min(e, b2));
        if (cursor >= b2 - EPS) break;
      }
      if (cursor < b2 - EPS) return false;
    }
    return true;
  }

  private sourceReady(): boolean | null {
    if (typeof this.map.isSourceLoaded !== 'function' || !this.map.getSource) return null;
    try {
      if (!this.map.getSource(this.sourceId)) return null;
      return this.map.isSourceLoaded(this.sourceId) === true;
    } catch {
      return null;
    }
  }

  private isDrawable(): boolean {
    if (this.appliedVersion === 0 || this.features <= 0) return false;
    if (this.eventMode) {
      return this.readyVersion === this.appliedVersion
        && this.inflightVersion === null
        && this.pendingVersion === null;
    }
    const live = this.sourceReady();
    if (live === false) return false;
    if (live === true) return true;
    return this.readyVersion === this.appliedVersion;
  }

  private updateLoaded(): void {
    this.loaded = this.isDrawable();
  }

  async refresh(): Promise<void> {
    if (!this.attached || !this.enabled || this.removed) return;
    this.skipNextEnabledRefresh = false;
    const z = this.map.getZoom();
    if (z < MID_LAYER_MINZOOM - 0.05) {
      this.clearData();
      return;
    }
    const boxes = this.viewBoxes();
    if (!boxes.length) {
      if (typeof this.map.isMoving === 'function' && this.map.isMoving()) {
        this.fetching = false;
        this.disarmGraceTimer();
        this.notify();
        return;
      }
      this.clearData();
      return;
    }
    if (this.abort) this.abort.abort();
    this.abort = new AbortController();
    const sequence = ++this.sequence;
    const requested = this.requestBoxes(boxes);
    this.newTiming('fetch', { zoom: z, boxes: requested.length });
    this.fetching = true;
    this.armGraceTimer();
    this.notify();
    try {
      const gzBytes = [0];
      const serverTimings: any[] = [];
      const endpoint = mapResourceUrl('roads.geojson');
      const responses = await Promise.all(requested.map(async ([w, s, e, n]) => {
        const url = `${endpoint}?z=${z.toFixed(2)}&w=${w.toFixed(4)}&s=${s.toFixed(4)}&e=${e.toFixed(4)}&n=${n.toFixed(4)}`;
        const response = await fetch(url, { signal: this.abort!.signal });
        if (!response.ok) throw Error('roads ' + response.status);
        try {
          const headers = response.headers;
          if (headers && typeof headers.get === 'function') {
            gzBytes[0] += Number(headers.get('content-length')) || 0;
            const header = headers.get('x-roads-timing');
            if (header) serverTimings.push(JSON.parse(header));
          }
        } catch { /* header 读取只是测量，失败不影响好数据 */ }
        return response.json();
      }));
      this.mark('fetched');
      if (this.removed || sequence !== this.sequence) return;
      if (this.timing) {
        this.timing.gzBytes = gzBytes[0];
        this.timing.serverHttp = serverTimings;
      }
      const metadata = responses.map((data: any) => data.metadata || {});
      const failedTiles = metadata.reduce((n: number, m: any) => n + (m.failedTiles || 0), 0);
      if (failedTiles > 0) {
        this.fetching = false;
        this.graceExpired = false;
        this.disarmGraceTimer();
        this.lastError = `夜路部分瓦片失败（${failedTiles}）`;
        if (this.timing) this.timing.error = this.lastError;
        this.endTiming('fetchPartial');
        this.schedulePartialRetry(requested, z);
        this.notify();
        return;
      }
      this.partialRetries = 0;
      this.partialView = null;
      const features = responses.flatMap((data: any) => data.features || []);
      this.applyData(features, metadata, requested, z);
    } catch (error: any) {
      if (this.removed || error.name === 'AbortError' || sequence !== this.sequence) return;
      this.fetching = false;
      this.graceExpired = false;
      this.disarmGraceTimer();
      this.lastError = String(error.message || error);
      if (this.timing) this.timing.error = this.lastError;
      this.endTiming('fetchError');
      this.notify();
    }
  }

  private applyData(features: any[], metadata: any[], boxes: number[][], z: number): void {
    this.features = features.length;
    this.truncated = metadata.some((m) => m.truncated);
    this.classes = {};
    for (const meta of metadata) {
      for (const [kind, count] of Object.entries(meta.classes || {})) {
        this.classes[kind] = (this.classes[kind] || 0) + (count as number);
      }
    }
    this.lastMetadata = metadata;
    this.lastSuccess = performance.now();
    this.lastError = null;
    this.graceExpired = false;
    this.disarmGraceTimer();
    this.fetching = false;
    this.appliedVersion = this.submitData({ type: 'FeatureCollection', features });
    this.coverage = this.features > 0 ? { boxes: boxes.map((box) => box.slice()) } : null;
    this.appliedZoom = z;
    if (this.features > 0 && !this.truncated) {
      LAST_APPLIED = { features, metadata, boxes: boxes.map((box) => box.slice()), z, at: performance.now(), truncated: false };
    }
    if (this.timing) {
      this.timing.version = this.appliedVersion;
      this.timing.features = this.features;
      this.timing.server = metadata.map((m) => ({
        elapsedMs: m.elapsedMs, timing: m.timing || null, tiles: m.tiles,
        features: m.features, vertices: m.vertices, truncated: m.truncated,
      }));
      this.mark('submit');
    }
    this.updateLoaded();
    this.updateExpressions(true);
    this.notify();
  }

  private clearData(): void {
    if (this.abort) { this.abort.abort(); this.abort = null; }
    ++this.sequence;
    this.fetching = false;
    this.graceExpired = false;
    this.disarmGraceTimer();
    this.lastError = null;
    this.partialRetries = 0;
    this.partialView = null;
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null; }
    if (this.appliedVersion !== 0 || this.features !== 0) {
      this.features = 0;
      this.truncated = false;
      this.classes = {};
      this.lastMetadata = null;
      this.appliedVersion = this.submitData({ type: 'FeatureCollection', features: [] });
      this.coverage = null;
      this.appliedZoom = null;
      this.updateLoaded();
    }
    this.notify();
  }

  private submitData(data: any): number {
    const version = ++this.dataVersion;
    const source = this.map.getSource(this.sourceId);
    if (source) {
      if (this.inflightVersion === null) this.inflightVersion = version;
      else this.pendingVersion = version;
      source.setData(data);
    }
    return version;
  }

  private armGraceTimer(): void {
    this.disarmGraceTimer();
    this.graceExpired = false;
    const wait = Math.max(0, FETCH_GRACE_MS - (performance.now() - this.lastSuccess)) + 5;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.removed || !this.fetching) return;
      this.graceExpired = true;
      this.notify();
    }, wait);
  }

  private disarmGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  handoff(): number {
    if (!this.enabled || this.removed) return 0;
    if (!this.isDrawable() || this.truncated) return 0;
    const z = this.map.getZoom();
    if (z < HANDOFF_ZOOM_START) return 0;
    if (!this.coversView(z)) return 0;
    if (this.fetching && (this.graceExpired || performance.now() - this.lastSuccess > FETCH_GRACE_MS)) return 0;
    const value = smootherstep(HANDOFF_ZOOM_START, HANDOFF_ZOOM_END, z);
    if (value > 0 && this.timing && this.timing.version === this.appliedVersion
        && this.timing.marks.takeover === undefined) {
      this.mark('takeover');
      this.endTiming('takeover');
    }
    return value;
  }

  midHandoff(): number {
    if (!this.enabled || this.removed) return 0;
    if (!this.isDrawable() || this.truncated) return 0;
    const z = this.map.getZoom();
    if (z < MID_LAYER_MINZOOM) return 0;
    if (this.appliedZoom === null || Math.abs(z - this.appliedZoom) > MID_COVERAGE_ZOOM_SLACK) return 0;
    if (this.fetching && (this.graceExpired || performance.now() - this.lastSuccess > FETCH_GRACE_MS)) return 0;
    const base = smootherstep(MID_HANDOFF_ZOOM_START, MID_HANDOFF_ZOOM_FULL, z)
      * (1 - smootherstep(MID_HANDOFF_FADE_START, MID_HANDOFF_FADE_END, z));
    return base * this.coverageFraction();
  }

  diagnostics(): any {
    const z = typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;
    const metadata = this.lastMetadata || [];
    return {
      attached: this.attached,
      enabled: this.enabled,
      zoom: z,
      appliedZoom: this.appliedZoom,
      dataZooms: [...new Set(metadata.map((m) => m.dataZoom).filter((v) => v !== undefined))],
      viewBands: [...new Set(metadata.map((m) => m.viewBand).filter(Boolean))],
      serverTiles: metadata.reduce((n, m) => n + (m.tiles || 0), 0),
      serverFeatures: metadata.reduce((n, m) => n + (m.features || 0), 0),
      serverVertices: metadata.reduce((n, m) => n + (m.vertices || 0), 0),
      failedTiles: metadata.reduce((n, m) => n + (m.failedTiles || 0), 0),
      features: this.features,
      classes: this.classes,
      truncated: this.truncated,
      loaded: this.loaded,
      fetchPending: this.fetching,
      graceExpired: this.graceExpired,
      lastError: this.lastError,
      partialRetries: this.partialRetries,
      coverageBoxes: this.coverage ? this.coverage.boxes.length : 0,
      coverageFraction: +this.coverageFraction().toFixed(4),
      handoff: this.handoff(),
      midHandoff: this.midHandoff(),
      nearLayers: this.layerIds.length,
      midLayers: this.midLayerIds.length,
    };
  }

  status(): string {
    if (this.removed) return '夜间路网：已释放';
    if (!this.attached) return '夜间路网：准备中';
    if (!this.enabled) return '夜间路网：已关闭';
    if (this.fetching && this.graceExpired) return '夜间路网：等待数据超时（atlas 保持）';
    if (this.lastError && !this.loaded) return '夜间路网：不可用（atlas 保持）';
    if (this.fetching) return this.loaded ? '夜间路网：更新中…' : '夜间路网：载入中';
    if (this.lastError) return `夜间路网：更新失败，沿用已载入路段（${this.features} 段）`;
    if (!this.loaded) return this.features > 0 ? `夜间路网：${this.features} 段数据确认中…` : '夜间路网：当前视野无可用路段';
    const classes = Object.entries(this.classes).map(([k, v]) => `${k} ${v}`).join(' · ');
    const zooms = [...new Set((this.lastMetadata || []).map((m) => m.dataZoom).filter((v) => v !== undefined))];
    const data = zooms.length ? ` · 数据 z${zooms.join('/')}` : '';
    return `夜间路网：${this.features} 段${this.truncated ? '（已截断）' : ''}${classes ? ' · ' + classes : ''}${data}`;
  }

  dispose(): void {
    this.removed = true;
    this.endTiming('disposed');
    this.disarmGraceTimer();
    clearTimeout(this.refreshTimer!);
    clearTimeout(this.expressionTimer!);
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null; }
    if (this.reuseTimer) { clearTimeout(this.reuseTimer); this.reuseTimer = null; }
    if (this.reuseFire && this.idleSubscribed && typeof this.map.off === 'function') {
      this.map.off('idle', this.reuseFire);
    }
    this.reuseFire = null;
    this.idleSubscribed = false;
    if (this.abort) { this.abort.abort(); this.abort = null; }
    this.fetching = false;
    if (this.eventMode && typeof this.map.off === 'function') {
      this.map.off('sourcedata', this.handleSourceData);
    }
    for (const id of [...this.layerIds, ...this.midLayerIds]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    this.layerIds = [];
    this.layerSpecs.clear();
    this.midLayerIds = [];
    this.midLayerSpecs.clear();
    if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
    this.attached = false;
  }
}
