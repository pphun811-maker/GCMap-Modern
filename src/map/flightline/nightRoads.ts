// Flightline 夜间路网（已验收 Round 04/07/09/12 成果，主项目接线版）。
//
// 来源：候选 round-12 的 night-roads.js（算法未改）。差异只在部署适配：
//   - 道路几何地址改为主项目 /map-res/roads.geojson（静态模式由 fetchMapResource 接管）；
//   - 道路样式表改为构建期内联（roadGlowStyle.json / roadGlowR2Style.json）；
//   - 移除 demo 的 state 对象，开关由 MapController 显式调用 setEnabled/setLed；
//   - 不移植 demo 专用的 loopback 备用连接池（127.0.0.1 ↔ localhost）：主项目的资源
//     层有自己的连接/并发策略，R12 的 fallback 只改数据 zoom，不改请求源。
//
// 保留的机制（验收依赖，勿简化）：
//   1. drawable —— 只有 worker 确认过的 appliedVersion 才算可画（GeoJSON source 的
//      版本化提交镜像，见下方 submitData / handleSourceData 契约）；
//   2. covering —— 请求盒必须完全覆盖当前视野（反经线拆两段），部分覆盖不接管；
//   3. current  —— 600 ms 取数宽限内不接管；静态视野靠定时器自恢复；
//   4. 两套 atlas 接管标量 —— 近景 handoff()（6..8 交出）与中尺度 midHandoff()
//      （R12 起只作旧验收脚本的诊断值；着色器改读 atlasCoverage() 的覆盖比例）。
//      两者共用 drawable/covering/current 闸门，数值各自独立；
//   5. 主题重建复用 LAST_APPLIED，但仍在 deferred fire 时复核视野与代次。
//
// Round 12 增量（全部叠加在以上契约上）：
//   P1-1 lit 基础路网（night-road-lit-*）：恢复 night_road() 的 kind<0 分支 ——
//       DLL 基础路宽/底色（#334155 / #3b4250），alpha = lit*(1-off*nightFactor)*dark，
//       无 gain、无 part-night 0.75 项、无 LED 混合；highway z3.5、major_road z6、
//       minor_road z11。
//   P1-2 glow 按原作的 z8 边界拆组：local 组（night-road-glow-*）maxzoom 8，r2 组
//       （r2-road-glow-*）minzoom 8，再叠 25 个 r2-road-glow-lit-* band（前端 O1 顺序）。
//       Round 09 自造的 6 层 mid glow 与 2.2× spill 删除；midHandoff() 仅作诊断保留。
//   P1-3 halo 直接使用 DLL 的 line-blur（Round 03 的 WebGL 错误计数在 MapLibre 5.24
//       复测为零，见 round-12/reports/P1-IMPLEMENTATION.md）；blur 就是原作语义，
//       不再用加宽加淡的 spill 近似。
//   P1-4 atlas 调光改为覆盖比例驱动：atlasCoverage() 返回 0..1 的覆盖比例，原作的
//       smoothstep(3.5, 5.5) 留在 shader 里，这里不能再乘一遍（会平方）。
//   P2 近景渐进 fallback：z≥8 先请求 min(7, floor(z)) 的低精度集，与 800 ms 竞速；
//       真实 z8 请求随后替换。fallback 走同一条 submitData/worker/coverage 管线
//       （所以地图不空、atlas 可调光），但不写 LAST_APPLIED（主题重建必须重新取真实集），
//       晚到也只能在真实请求仍在飞时应用，不能覆盖更新的数据或已 dispose/关闭的图层；
//       fallback 期间 fetchStale() 不释放交接（preview 本身就是当前数据）。
//       atlas 在 fallback 期间额外乘 0.65 的 FALLBACK_ATLAS_GAIN 由 shader 完成，
//       本文件只暴露 appliedFallback / diagnostics().fallback 给上层。
//   P3 截断守卫：已有 non-truncated 好数据时，截断响应不覆盖（保留 fallback/last-good，
//       truncated 保持 false）；没有好数据才应用截断集且 handoff 为 0。请求侧的
//       nearTileBudget / nearTzLowered 属于 roads 服务端模块，本文件只消费响应 metadata。
//
// 数据只含真实 highway/major_road/medium_road/minor_road；缺数据时 atlas 保持原样。

import roadGlowRaw from './roadGlowStyle.json?raw';
import roadGlowR2Raw from './roadGlowR2Style.json?raw';
import { mapResourceUrl } from '../styleFactory';
import { fetchMapResource } from './resourceMode';

const NIGHT_CLASSES = ['highway', 'major_road', 'medium_road', 'minor_road'];
// R12 P1-1: 原作的低 zoom “lit roads” pass。night_road() 对 kind < 0 返回 vec2(lit, 0):
// 没有 gain、没有 LED 混合、没有 glow 颜色；几何是 DLL 的基础路网宽度/底色
//（local #334155 / r2 #3b4250），所以中尺度看到的是暗色亮路而不是只有城市光 atlas。
const LIT_CLASSES: { cls: string; minzoom: number }[] = [
  { cls: 'highway', minzoom: 3.5 },
  { cls: 'major_road', minzoom: 6 },
  // 计划里的可选项：官方 z8-10 瓦片没有 minor_road，这一层实际从 z12 才有几何
  //（而且已经接近亚像素）。
  { cls: 'minor_road', minzoom: 11 },
];
const LIT_COLOR_LOCAL = '#334155';
const LIT_COLOR_R2 = '#3b4250';
// 采样宽度的可读性下限（原作的 z4 highway 是 0.157 px，1x 屏幕上不可见）。
// 想要严格的游戏宽度就设为 0。
const LIT_MIN_WIDTH = 0.5;
// DLL 基础路宽 stops（dll-all-road-style-layers.json）。按整数 zoom 采样，让 MapLibre
// 相邻 stop 的 exponential 复现游戏的*整段*归一化曲线；逐字照抄 stops 会在 z4 得到
// 0.286 而不是 0.157。
const LIT_WIDTH_STOPS: Record<string, number[][]> = {
  highway: [[3, 0], [6, 1.1], [12, 1.6], [16, 15.393399119235868], [22, 985.1775436310955]],
  major_road: [[6, 0], [12, 1.6], [16, 11.841076245566052], [22, 757.8288797162273]],
  minor_road: [[11, 0], [12.5, 0.5], [16, 8.288753371896236], [22, 530.4802158013591]],
};
function gameExponentialStops(stops: number[][], base = 2): number[] {
  const out: number[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    const denom = Math.pow(base, z1 - z0) - 1;
    for (let z = z0; z < z1; z += 1) {
      out.push(z, v0 + (v1 - v0) * (Math.pow(base, z - z0) - 1) / denom);
    }
  }
  const [zl, vl] = stops[stops.length - 1];
  out.push(zl, vl);
  return out;
}
const LIT_WIDTHS: Record<string, any> = Object.fromEntries(
  Object.entries(LIT_WIDTH_STOPS).map(([cls, stops]): [string, any] => {
    const sampled = gameExponentialStops(stops);
    if (cls === 'highway' || cls === 'major_road') {
      for (let i = 1; i < sampled.length; i += 2) sampled[i] = Math.max(LIT_MIN_WIDTH, sampled[i]);
    }
    return [cls, ['interpolate', ['exponential', 2], ['zoom'], ...sampled]];
  }),
);
const LAYER_MINZOOM = 6;
// z8 是原作的 local -> r2 边界（游戏前端把每个 local-road-glow-* 的 maxzoom
// 都夹到 r2 组的 minzoom 8）。
const LOCAL_MAX_ZOOM = 8;
const R2_MIN_ZOOM = 8;
// 夜间路网开始取数/绘制的最低 view zoom；atlas 交接 ramp 也从这里开始
//（shader 里的 smoothstep(3.5, 5.5)）。
const ATLAS_MIN_ZOOM = 3.5;
const HANDOFF_ZOOM_START = 6.0;
const HANDOFF_ZOOM_END = 8.0;
// 仅留给 midHandoff() 的旧诊断 ramp（旧审计断言 3.5..5.5 上升、5.9..7.0 淡出）。
// 着色器不再消费它。
const MID_HANDOFF_ZOOM_START = 3.5;
const MID_HANDOFF_ZOOM_FULL = 5.5;
const MID_HANDOFF_FADE_START = 5.9;
const MID_HANDOFF_FADE_END = 7.0;
// R12 P1-2: 原作的 r2-road-glow-lit-* 组，按前端 O1 渲染顺序
//（minor -> major -> link -> highway，然后同序的 bridges；kerb/core 按类交错；
//  rail 在两组之间）。
const R2_LIT_W1 = ['roads_minor', 'roads_major', 'roads_link', 'roads_highway'];
const R2_LIT_T1 = R2_LIT_W1.map((v) => v.replace('roads_', 'roads_bridges_'));
const R2_LIT_ORDER: [string, string][] = [
  ...[...R2_LIT_W1, ...R2_LIT_T1].map((v): [string, string] => ['spill', v]),
  ...R2_LIT_W1.flatMap((v): [string, string][] => [['kerb', v], ['core', v]]),
  ['rail', 'roads_rail'],
  ...R2_LIT_T1.flatMap((v): [string, string][] => [['kerb', v], ['core', v]]),
];
// r2 lit band 的 line-opacity：'glow' 用恢复出的 glow alpha
//（lit * gain * part-night * dark），'lit' 用无 gain 的 lit alpha。
// 计划默认 'glow'；保留一行开关做 A/B。类型写成 string 才能保住这个 A/B 分支
//（字面量 'glow' 会让 `=== 'lit'` 被 TS 判为无重叠）。
const LIT_BANDS_ALPHA: string = 'glow';
const FETCH_GRACE_MS = 600;
const EXPRESSION_INTERVAL_MS = 100;
// R12 P2: 近景渐进低精度 fallback。fallback 数据 zoom = min(7, floor(view zoom))；
// 只有确实低于 view zoom 时才用，而且最多把真实请求推迟 FALLBACK_RACE_MS。
const FALLBACK_VIEW_MIN_ZOOM = 8;
const FALLBACK_DATA_MAX_ZOOM = 7;
const FALLBACK_RACE_MS = 800;
const COVERAGE_ZOOM_SLACK = 2;
const MID_COVERAGE_ZOOM_SLACK = 3.0;
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

// R12 P1-3: halo 层直接使用 DLL 的 line-blur。Round 03 记录的“MapLibre 的 line-blur
// 把 Chrome/ANGLE 的 WebGL 错误计数顶到上限”已在 MapLibre 5.24 复测（round-12/
// reports/P1-IMPLEMENTATION.md）：z8.5 4,862 帧、z12 3,066 帧，DLL blur 表达式下
// gl.getError() 为 0、无 map/JS 错误、无 console 警告、无 context loss。
// MapLibre 的 blur2 = (blur + 1/DPR) * gamma 与恢复出的 tile_alpha 同一条 ramp，
// 所以 line-blur 就是原作的语义，不是近似；2.2× 宽度的 spill 纯属近似，已删除。

// DLL 的 filter 用 `kind` / `kind_detail`；候选烘焙到 feature 上的属性是 `k`。
// DLL 的 filter（以及它们的 all / has / !has 祖先）是 MapLibre 的 legacy filter
// 语法，属性名必须是裸字符串 —— 不能写成表达式形式 ["get", name]
//（混用会让 MapLibre 以 “string expected, array found” 拒绝整层）。
// 其余（is_link / is_bridge / is_tunnel / kind_detail 存在性测试）逐字保留，
// 在 roads 服务端透传这些字段前，这些变体保持空层而不是编造。
const translateRoadFilter = (node: any): any => {
  if (!Array.isArray(node)) return node;
  if ((node[0] === '==' || node[0] === '!=') && (node[1] === 'kind' || node[1] === 'kind_detail')) {
    return [node[0], node[1] === 'kind' ? 'k' : 'kind_detail', node[2]];
  }
  return node.map(translateRoadFilter);
};

// MapLibre 会把 zoom 表达式在其第一个 stop 以下夹住。DLL 的 spill blur 从 z16 才
// 开始；逐字照抄时 z8..15.99 会夹到 21.55 px，把 spill 变成几乎不可见的细线而不是
// 预期中的无模糊宽带。在第一个 stop 前补一段显式 0。
const normalizeBlur = (expression: any, minzoom: number): any => {
  if (!Array.isArray(expression) || expression[0] !== 'interpolate') return expression;
  const firstZoom = expression[3];
  if (!(firstZoom > minzoom)) return expression;
  const out = ['interpolate', expression[1], expression[2], minzoom, 0, firstZoom - 0.1, 0];
  for (let i = 3; i < expression.length; i++) out.push(expression[i]);
  return out;
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
  /** R12 P2：近景低精度 fallback。默认开启；状态机审计可传 false 回到单请求契约。 */
  progressiveFallback?: boolean;
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
  private progressiveFallback: boolean;
  private sourceId = 'night-roads';
  // local glow（night-road-glow-*）—— 沿用 Round 03/04 的 id。
  private layerIds: string[] = [];
  private layerSpecs = new Map<string, any>();
  // R12 P1-2: r2 glow 组（z8+）与 25 个 r2 lit band。
  private r2LayerIds: string[] = [];
  private r2LayerSpecs = new Map<string, any>();
  private litBandLayerIds: string[] = [];
  private litBandLayerSpecs = new Map<string, any>();
  // R12 P1-1: lit 基础路网 pass（无 gain/LED），与 glow pass 分开，
  // 已验收的 glow id 与它们的 opacity 表达式保持不变。
  private litLayerIds: string[] = [];
  private litLayerSpecs = new Map<string, any>();
  // Round 09 的 mid pass 已在 Round 12 P1-2 删除（原作没有中尺度 glow；lit pass 与
  // local glow 取代它）。数组保留为空，旧审计/诊断读 midLayerIds 不会炸；
  // diagnostics 里 midLayers = 0。
  private midLayerIds: string[] = [];
  private midLayerSpecs = new Map<string, any>();
  private styleSpec: any = null;
  private r2StyleSpec: any = null;
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
  // R12 P2: 上层（MapController/shaders 接线、诊断）直接读这两个字段，
  // 所以保持 public。appliedFallback 表示“source 当前可画的数据是低精度 fallback”，
  // 而不是“最后一次提交的是 fallback”；updateLoaded() 在真实 worker 确认时翻回 false。
  // 候选里的 fallbackVersion 只写不读（strict noUnusedLocals 会拒绝），这里省略。
  appliedFallback = false;
  fallbackZoom: number | null = null;
  private realVersion: number | null = null;
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
    // 默认开启；pre-P2 的状态机审计传 false 以保持它们写的单请求契约。
    this.progressiveFallback = options.progressiveFallback !== false;
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

  // R12 P1-1: 最底层的组。先加，保证所有 glow pass 在 lit 基础路网之上。
  // kind<0 语义：颜色是 DLL 基础路色（无 LED 暖白），alpha 是
  // lit * (1 - off*nightFactor) * dark，没有 gain 项、没有 line-blur。
  private addLitLayers(beforeId?: string): void {
    for (const { cls, minzoom } of LIT_CLASSES) {
      const id = `night-road-lit-${cls}`;
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      this.map.addLayer({
        id,
        type: 'line',
        source: this.sourceId,
        filter: ['==', ['get', 'k'], cls],
        minzoom,
        maxzoom: 24,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          // 相机 step：z8 边界从 local 色切到 r2 色（plan 1.3）。
          'line-color': ['step', ['zoom'], LIT_COLOR_LOCAL, 8, LIT_COLOR_R2],
          'line-width': LIT_WIDTHS[cls],
          'line-blur': 0,
          // 数据可画后由 litOpacityExpression() 替换。
          'line-opacity': 0,
        },
      }, beforeId);
      this.litLayerIds.push(id);
      this.litLayerSpecs.set(id, { family: 'lit' });
    }
  }

  // 一组 glow（每类 halo + core）。两组都逐字使用 DLL paint：halo 保留提取出的
  // line-blur（恢复出的 tile_alpha ramp），core 保持 blur 0。local 组沿用已验收的
  // night-road-glow-* id 并止于 z8 边界；r2 组是 DLL 自己的 halo/core 对，minzoom 8。
  private addGlowGroup(options: {
    idPrefix: string;
    assetPrefix: string;
    byId: Map<string, any>;
    minzoom: number;
    maxzoom: number;
    beforeId?: string;
    ids: string[];
    specs: Map<string, any>;
  }): void {
    const { idPrefix, assetPrefix, byId, minzoom, maxzoom, beforeId, ids, specs } = options;
    for (const cls of NIGHT_CLASSES) {
      const halo = byId.get(`${assetPrefix}-${cls}-halo`);
      const core = byId.get(`${assetPrefix}-${cls}-core`);
      if (!halo || !core) continue;
      const passes = [
        {
          pass: 'halo',
          baseColor: halo.paint['line-color'],
          width: halo.paint['line-width'],
          blur: halo.paint['line-blur'] ?? 0,
        },
        {
          pass: 'core',
          baseColor: core.paint['line-color'],
          width: core.paint['line-width'],
          blur: core.paint['line-blur'] ?? 0,
        },
      ] as any[];
      for (const spec of passes) {
        spec.colorOn = ledColorOf(spec.baseColor, LED_MIX);
        spec.colorOff = ledColorOf(spec.baseColor, 0);
        const id = `${idPrefix}-${cls}-${spec.pass}`;
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        this.map.addLayer({
          id,
          type: 'line',
          source: this.sourceId,
          filter: ['==', ['get', 'k'], cls],
          minzoom,
          maxzoom,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': this.ledEnabled ? spec.colorOn : spec.colorOff,
            'line-width': spec.width,
            // R12 P1-3: DLL 的 blur，不再是加宽 spill 近似。
            'line-blur': spec.blur,
            // 数据到达后每帧由太阳/地方时表达式替换。
            'line-opacity': 0,
          },
        }, beforeId);
        ids.push(id);
        specs.set(id, spec);
      }
    }
  }

  // 25 个 r2-road-glow-lit-{spill,kerb,core,rail}-* 层，minzoom / filter / width /
  // blur / colour 按 DLL 原样。filter 从 `kind` 翻译到候选的 `k`；
  // is_link / is_bridge / is_tunnel / rail 存在性测试保持字段门控 —— 在 roads
  // 服务端透传这些字段（Round 12 Stage 6）前，link/bridge/rail 变体保持空层。
  private addR2LitBands(byId: Map<string, any>, beforeId?: string): void {
    if (!byId.size) return;
    for (const [pass, variant] of R2_LIT_ORDER) {
      const id = `r2-road-glow-lit-${pass}-${variant}`;
      const layer = byId.get(id);
      if (!layer) continue;
      const minzoom = layer.minzoom ?? R2_MIN_ZOOM;
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      this.map.addLayer({
        id,
        type: 'line',
        source: this.sourceId,
        filter: translateRoadFilter(layer.filter),
        minzoom,
        maxzoom: 24,
        layout: layer.layout || { 'line-cap': 'round' },
        paint: {
          'line-color': layer.paint['line-color'],
          'line-width': layer.paint['line-width'],
          'line-blur': normalizeBlur(layer.paint['line-blur'], minzoom) ?? 0,
          // 数据可画后由 updateExpressions() 替换。
          'line-opacity': 0,
        },
      }, beforeId);
      this.litBandLayerIds.push(id);
      this.litBandLayerSpecs.set(id, { family: 'litBand' });
    }
  }

  async attach(beforeId?: string): Promise<void> {
    if (this.attached) return;
    this.newTiming('attach');
    this.styleSpec = JSON.parse(roadGlowRaw);
    // r2 资产是独立的 DLL 记录。构建期内联后不再有“文件缺失”的运行时错误，
    // 但 parse 仍然是外部数据边界：坏 JSON 不能把整个夜间路网拖垮 ——
    // 没有它只是 z8+ 两组缺席，local 组和 lit pass 仍然会挂上。
    try {
      this.r2StyleSpec = JSON.parse(roadGlowR2Raw);
    } catch (error) {
      console.warn('road-glow r2 style:', String((error as any)?.message || error));
      this.r2StyleSpec = { layers: [] };
    }
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
    const r2ById = new Map<string, any>((this.r2StyleSpec?.layers || []).map((item: any) => [item.layer.id, item.layer]));
    // R12 P1-1: lit 基础路网最先加（最底层）。
    this.addLitLayers(beforeId);
    // R12 P1-2: 原作 local glow（z6..8）、r2 glow（z8+）、最后 r2 lit band。
    // addLayer(id, near) 把每个新层插到 `near` 下方，所以这个调用顺序就是
    // 从底到顶的渲染顺序。
    this.addGlowGroup({
      idPrefix: 'night-road-glow',
      assetPrefix: 'local-road-glow',
      byId,
      minzoom: LAYER_MINZOOM,
      maxzoom: LOCAL_MAX_ZOOM,
      beforeId,
      ids: this.layerIds,
      specs: this.layerSpecs,
    });
    this.addGlowGroup({
      idPrefix: 'r2-road-glow',
      assetPrefix: 'r2-road-glow',
      byId: r2ById,
      minzoom: R2_MIN_ZOOM,
      maxzoom: 24,
      beforeId,
      ids: this.r2LayerIds,
      specs: this.r2LayerSpecs,
    });
    this.addR2LitBands(r2ById, beforeId);
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

  // 每个 glow pass 在 LED 混合与 0 混合（数值上就是 R3 的钠灯色）之间切换。
  // 两种形式都是 data-driven，paint 更新会重绘已建瓦片；纯颜色变化 ——
  // opacity、gain 和交接都不动。lit 基础路网和 r2 lit band 保留 DLL 颜色
  //（它们没有 LED 分支）。
  setLed(enabled: boolean): void {
    const next = !!enabled;
    if (next === this.ledEnabled) return;
    this.ledEnabled = next;
    if (!this.attached) return;
    for (const id of [...this.layerIds, ...this.r2LayerIds]) {
      const spec = this.layerSpecs.get(id) || this.r2LayerSpecs.get(id);
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
    for (const id of [...this.layerIds, ...this.r2LayerIds, ...this.litLayerIds, ...this.litBandLayerIds]) {
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

  private solarTerms(): { planetDark: any; viewDark: any; nightFactor: any } {
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
    return { planetDark, viewDark, nightFactor };
  }

  private solarAlphaState(): { planetDark: any; viewDark: any; alphaFor: (dark: any) => any } {
    const terms = this.solarTerms();
    const { nightFactor } = terms;
    const alphaFor = (dark: any) => E.min(1, E.max(0, E.mul(
      E.mul(E.get('lit'), E.sub(1, E.mul(E.get('off'), nightFactor))),
      E.mul(E.get('gain'), E.mul(E.sub(1, E.mul(0.25, nightFactor)), dark)),
    )));
    return { ...terms, alphaFor };
  }

  private opacityExpression(): any {
    const { planetDark, viewDark, alphaFor } = this.solarAlphaState();
    return ['interpolate', ['linear'], ['zoom'], 6, alphaFor(planetDark), 8, alphaFor(viewDark), 24, alphaFor(viewDark)];
  }

  // R12 P1-1: night_road() kind<0 返回 vec2(lit, 0)，即只有
  // lit * (1 - off*nightFactor)；没有 gain、没有 part-night 0.75 项、没有 LED。
  // `dark` 是 web 的日光护栏：lit pass 画在底图自己的道路上，所以白天必须淡出
  //（这是对原作 tile pass 的有意偏离 —— 原作会整条替换底图道路）。
  private litAlphaFor(dark: any): any {
    const { nightFactor } = this.solarTerms();
    return clamp01(E.mul(
      E.mul(E.get('lit'), E.sub(1, E.mul(E.get('off'), nightFactor))),
      dark,
    ));
  }

  private litOpacityExpression(): any {
    const { planetDark, viewDark } = this.solarTerms();
    // 顶层 6..8 interpolate 是原作的 mix(planet_dark, view_dark,
    // smoothstep(6, 8, zoom))；z6 以下 MapLibre 会夹到 planetDark。
    return ['interpolate', ['linear'], ['zoom'],
      6, this.litAlphaFor(planetDark),
      8, this.litAlphaFor(viewDark),
      24, this.litAlphaFor(viewDark),
    ];
  }

  // r2 lit band 使用同一套恢复出的 solar/LED/part-night alpha。它们在 DLL 里是
  // style layer，确切的 night_road 模式没有字节级证明（plan 3.6），所以默认复用
  // glow alpha；LIT_BANDS_ALPHA 可以把整组切到无 gain 的 lit alpha 做 A/B。
  private litBandOpacityExpression(litExpression: any, glowExpression: any): any {
    return LIT_BANDS_ALPHA === 'lit' ? litExpression : glowExpression;
  }

  updateExpressions(force = false): void {
    if (!this.attached || !this.enabled) return;
    const now = performance.now();
    if (!force && now - this.lastExpression < EXPRESSION_INTERVAL_MS) return;
    this.lastExpression = now;
    if (!this.loaded || this.features === 0) return;
    const expression = this.opacityExpression();
    for (const id of [...this.layerIds, ...this.r2LayerIds]) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-opacity', expression);
    }
    // P1-1 lit pass：自己的表达式（无 gain / LED / part-night 项）。
    const litExpression = this.litOpacityExpression();
    for (const id of this.litLayerIds) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-opacity', litExpression);
    }
    const bandExpression = this.litBandOpacityExpression(litExpression, expression);
    for (const id of this.litBandLayerIds) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-opacity', bandExpression);
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
    // R12 P2: 真实集只有在 worker job 完成后才算可见集。在它确认之前保持
    // fallback 标记（以及 atlas 衰减），否则 fallback 还画在屏幕上时 atlas 就提前变亮。
    // 这个翻转让它恰好发生在真实版本的确认点，且在 sourcedata 通知上层之前。
    if (this.appliedFallback && this.realVersion !== null && this.readyVersion === this.realVersion) {
      this.appliedFallback = false;
      this.fallbackZoom = null;
    }
    this.loaded = this.isDrawable();
  }

  // 一次 HTTP 周期：所有请求盒在同一个 view zoom。header 读取只用于测量
  //（缺失/异常 header 绝不能让好数据变成失败周期）。真实请求与 R12 P2 fallback 共用。
  private async fetchCycle(z: number, requested: number[][], signal: AbortSignal): Promise<any> {
    const gzBytes = [0];
    const serverTimings: any[] = [];
    const endpoint = mapResourceUrl('roads.geojson');
    const responses = await Promise.all(requested.map(async ([w, s, e, n]) => {
      const url = `${endpoint}?z=${z.toFixed(2)}&w=${w.toFixed(4)}&s=${s.toFixed(4)}&e=${e.toFixed(4)}&n=${n.toFixed(4)}`;
      const response = await fetchMapResource(url, signal);
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
    const metadata = responses.map((data: any) => data.metadata || {});
    return {
      features: responses.flatMap((data: any) => data.features || []),
      metadata,
      failedTiles: metadata.reduce((n: number, m: any) => n + (m.failedTiles || 0), 0),
      gzBytes: gzBytes[0],
      serverTimings,
    };
  }

  async refresh(): Promise<void> {
    if (!this.attached || !this.enabled || this.removed) return;
    this.skipNextEnabledRefresh = false;
    const z = this.map.getZoom();
    if (z < ATLAS_MIN_ZOOM - 0.05) {
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
    const signal = this.abort.signal;
    const sequence = ++this.sequence;
    const requested = this.requestBoxes(boxes);
    this.newTiming('fetch', { zoom: z, boxes: requested.length });
    const timing = this.timing;
    this.fetching = true;
    this.armGraceTimer();
    this.notify();

    // R12 P2: 先低精度。近景请求本地 z0-7 档，若本周期仍有效就应用，再由下面
    // 的真实请求替换。`realApplied`/`realSettled` 与晚到的 fallback 续体共享，
    // 保证它永远不会覆盖更新的数据。
    let realApplied = false;
    let realSettled = false;
    const fallbackZ = this.progressiveFallback && z >= FALLBACK_VIEW_MIN_ZOOM
      ? Math.min(FALLBACK_DATA_MAX_ZOOM, Math.floor(z))
      : null;
    if (fallbackZ !== null && fallbackZ < z) {
      if (timing) timing.fallbackZoom = fallbackZ;
      const fallback = this.fetchCycle(fallbackZ, requested, signal)
        .then((result) => {
          // 仅测量：客户端观测到的 fallback 延迟与服务端分段耗时
          //（fallback 不是 timing 记录的真实版本，所以这里不关闭周期）。
          if (this.timing === timing) {
            timing.fallbackFetchMs = Math.round((performance.now() - timing.start) * 10) / 10;
            timing.fallbackServer = result.serverTimings;
            timing.fallbackGzBytes = result.gzBytes;
          }
          return { ok: true, result };
        })
        .catch((error) => ({ ok: false, error }));
      // 与计时器竞速：fallback 慢时真实请求也必须发出。fallback 一落定就清掉
      // 计时器，避免多余的 timer 拖住进程。
      const race = await new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve(null), FALLBACK_RACE_MS);
        fallback.then((outcome) => { clearTimeout(timer); resolve(outcome); });
      });
      const applyFallback = (outcome: any): void => {
        if (this.removed || sequence !== this.sequence || realApplied) return;
        if (!outcome || outcome.ok !== true) {
          if (this.timing === timing) timing.fallbackSkipped = outcome ? 'error' : 'race-timeout';
          return;
        }
        const { features, metadata, failedTiles } = outcome.result;
        const fallbackTruncated = metadata.some((m: any) => m.truncated);
        if (failedTiles > 0 || features.length === 0 || fallbackTruncated) {
          // 部分、空或截断的 fallback 静默跳过；真实请求照常继续。
          if (this.timing === timing) {
            timing.fallbackSkipped = failedTiles > 0 ? 'partial' : fallbackTruncated ? 'truncated' : 'empty';
          }
          return;
        }
        this.mark('fallbackApplied');
        this.applyData(features, metadata, requested, fallbackZ, {
          fallback: true,
          fallbackZoom: fallbackZ,
          // 本周期的 timing 记录属于真实请求；fallback 不能设置它的 version
          // 或关闭它的 mark。
          recordTiming: false,
        });
        if (this.timing === timing) timing.fallbackApplied = true;
        if (!realSettled) {
          // 低精度集已上屏但真实请求仍在飞：保持 fetch 闸门开启并重新武装
          // 宽限时钟（applyData 把两者都清了）。
          this.fetching = true;
          this.armGraceTimer();
          this.notify();
        }
      };
      if (race) applyFallback(race);
      else fallback.then(applyFallback); // 晚到：只在真实集之前应用
      if (this.removed || sequence !== this.sequence) return;
    }

    try {
      // 800 ms 上界的证据：这个 mark 是真实请求发出的时刻。fallback 慢时它必须
      // 停在 FALLBACK_RACE_MS 附近。
      if (this.timing === timing) timing.realStart = Math.round((performance.now() - timing.start) * 10) / 10;
      const result = await this.fetchCycle(z, requested, signal);
      // 只保留客户端的真实请求耗时；候选的 origins 重试/roadsOrigin 属于 demo 的
      // loopback 池，主项目没有对应物。
      if (this.timing === timing) timing.realFetchMs = Math.round((performance.now() - timing.start) * 10) / 10;
      this.mark('fetched');
      if (this.removed || sequence !== this.sequence) return;
      if (this.timing) {
        this.timing.gzBytes = result.gzBytes;
        this.timing.serverHttp = result.serverTimings;
      }
      const { features, metadata, failedTiles } = result;
      if (failedTiles > 0) {
        // 上游部分失败：几何不完整，不能接管（否则会把半空视野当成当前数据），
        // 也不能缓存复用。保留已应用数据 / atlas 底线，像错误周期一样释放接管，
        // 并在 source 恢复后重试同一个静态视野。
        realSettled = true;
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
      // R12 P3: 截断响应是不完整几何。如果已经应用了完整集合（fallback 或上一轮
      // 真实集），保留它：不替换、不清 appliedFallback、不置 this.truncated。
      // 后续 refresh 拿到完整真实集时仍会正常替换 fallback。没有任何好数据时，
      // 走下面的既有路径应用截断集，handoff()/atlasCoverage() 保持 0。
      const responseTruncated = metadata.some((m: any) => m.truncated);
      if (responseTruncated && this.features > 0 && !this.truncated) {
        realApplied = true; // 本周期已决出；晚到 fallback 不得覆盖
        realSettled = true;
        this.fetching = false;
        this.graceExpired = false;
        this.disarmGraceTimer();
        this.lastError = `夜路数据被截断（${features.length} 段），保留已载入路段`;
        if (this.timing) this.timing.error = this.lastError;
        this.endTiming('fetchTruncated');
        this.notify();
        return;
      }
      this.partialRetries = 0;
      this.partialView = null;
      realApplied = true;
      realSettled = true;
      this.applyData(features, metadata, requested, z);
    } catch (error: any) {
      realSettled = true;
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

  private applyData(
    features: any[],
    metadata: any[],
    boxes: number[][],
    z: number,
    options: { fallback?: boolean; fallbackZoom?: number; recordTiming?: boolean } = {},
  ): void {
    const fallback = options.fallback === true;
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
    // R12 P2: fallback 在真实集的 worker job 确认之前一直是*可见*集合
    //（atlas 衰减也保持）。所以 appliedFallback 的含义是“source 当前可画的数据
    // 是低精度 fallback”，而不是“最后一次提交的是 fallback”；updateLoaded()
    // 在真实版本可画时精确翻回 false。
    if (fallback) {
      this.appliedFallback = true;
      this.fallbackZoom = options.fallbackZoom ?? z;
      this.realVersion = null;
    }
    const version = this.submitData({ type: 'FeatureCollection', features });
    this.appliedVersion = version;
    // 候选还维护 fallbackVersion，但它全文件只写不读（strict noUnusedLocals 会拒绝）；
    // 真正决定当前可见集的是 appliedFallback + realVersion（见 updateLoaded）。
    if (!fallback) {
      this.realVersion = version;
      if (!this.appliedFallback) this.fallbackZoom = null;
    }
    this.coverage = this.features > 0 ? { boxes: boxes.map((box) => box.slice()) } : null;
    this.appliedZoom = z;
    if (this.features > 0 && !this.truncated && !fallback) {
      // 主题重建复用缓存：几何和烘焙后的每段属性都是视野静态的（只有太阳/小时
      // 表达式在变），重新提交同一个 collection 等价于重新取数。
      // 低精度 fallback 故意不缓存：重建后的样式必须取真实近景集，不能复用降级集。
      LAST_APPLIED = { features, metadata, boxes: boxes.map((box) => box.slice()), z, at: performance.now(), truncated: false };
    }
    if (this.timing && options.recordTiming !== false) {
      this.timing.version = this.appliedVersion;
      this.timing.features = this.features;
      this.timing.server = metadata.map((m) => ({
        elapsedMs: m.elapsedMs, timing: m.timing || null, tiles: m.tiles,
        features: m.features, vertices: m.vertices, truncated: m.truncated,
      }));
      this.mark('submit');
    }
    this.updateLoaded();
    // worker 尚未确认版本时这是 no-op；数据变为可画的瞬间 sourcedata handler 会重跑。
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
      this.appliedFallback = false;
      this.fallbackZoom = null;
      this.realVersion = null;
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

  // R12 P2: 超过宽限的 fetch 是 stale —— 除非当前应用的是低精度 fallback。
  // preview 在真实近景请求仍在飞时按设计就是当前数据（这正是它的意义），
  // 所以它保留交接直到真实集应用。真实请求失败时，fallback 就是最终可画数据，
  // 继续拥有交接。版本确认、覆盖与 abort 语义不变。
  private fetchStale(): boolean {
    return this.fetching && !this.appliedFallback
      && (this.graceExpired || performance.now() - this.lastSuccess > FETCH_GRACE_MS);
  }

  handoff(): number {
    if (!this.enabled || this.removed) return 0;
    if (!this.isDrawable() || this.truncated) return 0;
    const z = this.map.getZoom();
    if (z < HANDOFF_ZOOM_START) return 0;
    if (!this.coversView(z)) return 0;
    if (this.fetchStale()) return 0;
    const value = smootherstep(HANDOFF_ZOOM_START, HANDOFF_ZOOM_END, z);
    if (value > 0 && this.timing && this.timing.version === this.appliedVersion
        && this.timing.marks.takeover === undefined) {
      this.mark('takeover');
      this.endTiming('takeover');
    }
    return value;
  }

  // Round 09 的 mid pass 交接。与 handoff() 相同的闸门（部分/过期/截断视野绝不让
  // atlas 变暗），但数值独立：3.5 开始、5.5 满、7.0 前后淡出。
  // R12 P1: 逐字节保留为旧诊断值（旧审计断言 3.5..5.5 上升与 5.9..7.0 淡出）。
  // 着色器不再消费它；着色器读 atlasCoverage()。
  midHandoff(): number {
    if (!this.enabled || this.removed) return 0;
    if (!this.isDrawable() || this.truncated) return 0;
    const z = this.map.getZoom();
    if (z < ATLAS_MIN_ZOOM) return 0;
    if (this.appliedZoom === null || Math.abs(z - this.appliedZoom) > MID_COVERAGE_ZOOM_SLACK) return 0;
    if (this.fetchStale()) return 0;
    const base = smootherstep(MID_HANDOFF_ZOOM_START, MID_HANDOFF_ZOOM_FULL, z)
      * (1 - smootherstep(MID_HANDOFF_FADE_START, MID_HANDOFF_FADE_END, z));
    return base * this.coverageFraction();
  }

  // R12 P1-4: 着色器的 atlas 调光权重。与两个 handoff 相同的可用性闸门
  //（drawable、未截断、当前、未超过宽限），然后返回视野被应用请求盒覆盖的*比例*。
  // 原作的 smoothstep(3.5, 5.5, detail) 在 round03.frag 里应用，所以这里绝不能再乘
  // 一遍（会把 ramp 平方）。
  // 部分覆盖正是重点：视野覆盖 40% 时 atlas 只暗 0.55 * 0.40，而不是全量；
  // 未覆盖区域保留自己的 atlas。
  atlasCoverage(): number {
    if (!this.enabled || this.removed) return 0;
    if (!this.isDrawable() || this.truncated) return 0;
    const z = this.map.getZoom();
    if (z < ATLAS_MIN_ZOOM) return 0;
    if (this.appliedZoom === null || Math.abs(z - this.appliedZoom) > MID_COVERAGE_ZOOM_SLACK) return 0;
    if (this.fetchStale()) return 0;
    return clamp(this.coverageFraction(), 0, 1);
  }

  diagnostics(): any {
    const z = typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;
    const metadata = this.lastMetadata || [];
    return {
      attached: this.attached,
      enabled: this.enabled,
      zoom: z,
      appliedZoom: this.appliedZoom,
      // R12 P2: 当前应用的是低精度 fallback，且真实近景请求尚未替换它。
      fallback: this.appliedFallback === true,
      fallbackZoom: this.appliedFallback ? this.fallbackZoom : null,
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
      // 着色器的 0..1 覆盖权重（含部分覆盖）。3.5..5.5 的 smoothstep 在 shader 里，
      // 不在这里。
      atlasCoverage: +this.atlasCoverage().toFixed(4),
      handoff: this.handoff(),
      midHandoff: this.midHandoff(),
      nearLayers: this.layerIds.length,
      midLayers: this.midLayerIds.length,
      litLayers: this.litLayerIds.length,
      localGlowLayers: this.layerIds.length,
      r2GlowLayers: this.r2LayerIds.length,
      litBandLayers: this.litBandLayerIds.length,
    };
  }

  status(): string {
    if (this.removed) return '夜间路网：已释放';
    if (!this.attached) return '夜间路网：准备中';
    if (!this.enabled) return '夜间路网：已关闭';
    if (this.fetching && this.graceExpired) return '夜间路网：等待数据超时（atlas 保持）';
    if (this.lastError && !this.loaded) return '夜间路网：不可用（atlas 保持）';
    if (this.fetching) return this.loaded
      ? (this.appliedFallback ? '夜间路网：低清路网先显，正在更新…' : '夜间路网：更新中…')
      : '夜间路网：载入中';
    if (this.lastError && this.lastError.includes('截断')) {
      return `夜间路网：数据被截断，沿用已载入路段（${this.features} 段）`;
    }
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
    for (const id of [...this.layerIds, ...this.r2LayerIds, ...this.litLayerIds, ...this.litBandLayerIds]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    this.layerIds = [];
    this.layerSpecs.clear();
    this.r2LayerIds = [];
    this.r2LayerSpecs.clear();
    this.midLayerIds = [];
    this.midLayerSpecs.clear();
    this.litLayerIds = [];
    this.litLayerSpecs.clear();
    this.litBandLayerIds = [];
    this.litBandLayerSpecs.clear();
    if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
    this.attached = false;
  }
}
