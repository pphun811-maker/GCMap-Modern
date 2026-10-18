import { useEffect, useLayoutEffect, useRef, useState } from 'react';
// MapController（连带 maplibre 引擎）是异步 chunk：此处只引用类型，运行时动态 import
//（2026-10-16 性能预算：maplibre ~1MB 不再阻塞首帧）
import type { MapController, LegInfo, RouteEntry } from './map/MapController';
import type { BaseMode, LabelLanguage } from './map/styleFactory';
import { KEY_EDITABLE, hasRuntimeStadiaKey } from './map/styleFactory';
import { airportsReady, findByCode, findAirportNear, type Airport } from './data/search';
import { convertDistance, haversineKm, type Units } from './geo/greatCircle';
import {
  decodePolyline, encodePolyline, dispatchTypeForKm, fetchLatestOfp, parseSbfMeta,
  simbriefDispatchUrl, encodeSbfMeta,
} from './simbrief/simbrief';
import { STRINGS, type Lang } from './i18n/strings';
import {
  decodeRoute, encodeRoute, loadBootState, nextId,
  readFavorites, readJournal, toggleVisited, writeDraft, writeFavorites, writeJournal,
  type FavoriteEntry, type JournalData, type JournalEntry,
} from './state/saved';
import { SearchPanel } from './components/SearchPanel';
import { RouteList, ROUTE_COLORS } from './components/RouteList';
import { RouteSummary } from './components/RouteSummary';
import { TopRightMenu } from './components/TopRightMenu';
import { FavoritesMenu } from './components/FavoritesMenu';
import { JournalCard } from './components/JournalCard';
import { AirportCard } from './components/AirportCard';

const SB_USER_KEY = 'gcmap.sbfuser';

// 多条航线用 ; 分隔（单条内机场用 - 连接），旧单航线链接自动兼容。
// 无法识别的代码不静默丢弃：收集起来交给一次性提示（分享链接缺字符时可感知）
function parseRoutesParam(v: string | null): { routes: RouteEntry[]; dropped: string[] } {
  const routes: RouteEntry[] = [];
  const dropped: string[] = [];
  for (const part of (v ?? '').split(';')) {
    const codes = part.split('-').map((c) => c.trim()).filter(Boolean);
    if (!codes.length) continue;
    const airports: Airport[] = [];
    for (const c of codes) {
      const a = findByCode(c);
      if (a) airports.push(a);
      else dropped.push(c);
    }
    if (!airports.length) continue;
    routes.push({
      id: nextId(),
      airports,
      visible: true,
      color: ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
      width: 1,
    });
  }
  return { routes, dropped };
}

// SimBrief 真实航路快照：每条一个 sbr=<polyline> 参数，首末航点解析回机场供 Pin/列表显示；
// 计划元数据（飞行时间/巡航速度）随 sbt= 参数按顺序一一对应（legacy 链接无 sbt → 退回估算）
function parseSbrParam(q: URLSearchParams): { routes: RouteEntry[]; dropped: number } {
  const sbrVals = q.getAll('sbr');
  const sbtVals = q.getAll('sbt');
  const routes: RouteEntry[] = [];
  let dropped = 0;
  sbrVals.forEach((val, i) => {
    let pts: { lat: number; lon: number }[];
    try {
      pts = decodePolyline(val);
    } catch {
      dropped++;
      return;
    }
    if (pts.length < 2) {
      dropped++;
      return;
    }
    const a = findAirportNear(pts[0].lat, pts[0].lon);
    const b = findAirportNear(pts[pts.length - 1].lat, pts[pts.length - 1].lon);
    if (!a || !b) {
      dropped++;
      return;
    }
    // sbt 与 sbr 数量一致才按序配对（防御：手工编辑的链接两边可能不同步）
    const meta = sbtVals.length === sbrVals.length ? parseSbfMeta(sbtVals[i]) : null;
    routes.push({
      id: nextId(),
      airports: [a, b],
      visible: true,
      color: ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
      width: 1,
      waypoints: pts.map((p) => ({ ident: '', lat: p.lat, lon: p.lon })),
      ofp: meta ?? undefined,
    });
  });
  return { routes, dropped };
}

interface UrlState {
  lang: Lang;
  base: BaseMode;
  units: Units;
  labels: boolean;
  globe: boolean;
  dark: boolean;
  sbf: string;
  /** 装饰小飞机巡航开关（默认关） */
  plane: boolean;
  /** 3D 地形起伏（默认关） */
  terrain: boolean;
}

// 非航线字段首帧同步解析（不依赖机场数据，chunk 加载窗口内也即时生效）
function parseUrl(q: URLSearchParams): UrlState {
  return {
    lang: q.get('lang') === 'en' ? 'en' : 'zh',
    base: q.get('base') === 'satellite' ? 'satellite' : 'vector',
    units: q.get('u') === 'mi' || q.get('u') === 'nm' ? (q.get('u') as Units) : 'km',
    labels: q.get('labels') !== '0',
    globe: q.get('globe') === '1',
    dark: q.get('theme') !== 'light',
    sbf: q.get('sbf') ?? '',
    plane: q.get('plane') === '1',
    terrain: q.get('terrain') === '1',
  };
}

// 航线参数依赖机场数据（已拆为异步 chunk），数据就绪后调用；
// 快照航线在前、代码航线在后：初始选中（最后一条）落在用户最近在操作的代码航线上
function parseUrlRoutes(q: URLSearchParams): { routes: RouteEntry[]; dropped: { codes: string[]; snapshots: number } } {
  const sbr = parseSbrParam(q);
  const rt = parseRoutesParam(q.get('route'));
  return { routes: [...sbr.routes, ...rt.routes], dropped: { codes: rt.dropped, snapshots: sbr.dropped } };
}

/** SimBrief 导入的 UI 状态：空闲 / 输用户名 / 等待生成（轮询中）/ 结果提示 */
type SbfUi =
  | { kind: 'idle' }
  | { kind: 'ask' }
  | { kind: 'waiting'; username: string; routeId: string; codes: string }
  | { kind: 'msg'; text: string; error: boolean };

/** 单步撤销快照：恢复到操作（删除航线 / 恢复收藏替换）前的整组航线与选中项。
 *  label 为已按语言格式化的展示文本（toast 直接显示） */
interface PendingUndo {
  label: string;
  prevRoutes: RouteEntry[];
  prevSelected: string | null;
}

export default function App() {
  // 开机状态：URL 带参数（分享链接/书签）以 URL 为准；裸 URL 用本地草稿恢复上次会话
  //（设置 + 含样式的航线快照）。bootQuery 始终是 URL 原始查询串，机场数据就绪后
  // 解析航线参数仍从它读；草稿航线由 boot effect 直接解码，不走 URL 解析。
  const boot = useRef(loadBootState()).current;
  const bootQuery = boot.query;
  const initial = useRef(parseUrl(bootQuery)).current;
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [base, setBase] = useState<BaseMode>(initial.base);
  const [units, setUnits] = useState<Units>(initial.units);
  // 航线来自 URL 解析，等机场数据 chunk 就绪后由 boot effect 填充
  const [routes, setRoutes] = useState<RouteEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // URL 航线参数是否已解析完：完成前 URL 同步挂起，避免首帧 replaceState 把未解析的 route/sbr 抹掉
  const [urlBooted, setUrlBooted] = useState(false);
  const [labelsOn, setLabelsOn] = useState(initial.labels);
  const [globeOn, setGlobeOn] = useState(initial.globe);
  const [dark, setDark] = useState(initial.dark);
  const [planeOn, setPlaneOn] = useState(initial.plane);
  const [terrainOn, setTerrainOn] = useState(initial.terrain);
  // 本地持久化状态：收藏 / 飞行足迹（草稿静默无 UI 状态；均为设备本地，不进 URL）
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => readFavorites());
  const [journal, setJournal] = useState<JournalData>(() => readJournal());
  // 单步撤销：最近一次"删除航线 / 恢复收藏"前的完整航线组（toast 入口，8 秒自动过期）
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  // 机场 Pin 信息卡（airport + Pin 屏幕坐标，相对地图容器）
  const [pinCard, setPinCard] = useState<{ airport: Airport; x: number; y: number } | null>(null);
  const [legsMap, setLegsMap] = useState<Record<string, LegInfo[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [sbfUi, setSbfUi] = useState<SbfUi>({ kind: 'idle' });
  const [mapReady, setMapReady] = useState(false);
  // 地图样式加载失败（load 永不触发，如断网/瓦片服务不可达）：30s 未就绪给出可恢复提示
  const [mapFailed, setMapFailed] = useState(false);
  // 公开版：用户已填入自己的卫星 key（存 localStorage；填过则菜单收起为换 Key 按钮）
  const [satKeySet, setSatKeySet] = useState(hasRuntimeStadiaKey);

  const mapDivRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  const readyRef = useRef(false);
  const fmtRef = useRef<(km: number, u: Units) => string>(() => '');
  // 就绪竞态防线：onReady 同步的是"当前最新"状态，而不是挂载时的 URL 快照
  //（用户可能在地图 load 完成前就通过 UI 添加了航线）
  const routesRef = useRef(routes);
  const unitsRef = useRef(units);
  routesRef.current = routes;
  unitsRef.current = units;
  // base/labels/globe 同样有就绪竞态：readyRef 置位前的 UI 切换会被 effect 守卫跳过，
  // onReady 必须按"当前最新" state 重放，否则地图停在初始模式、React 状态与地图永久脱节
  //（2026-10-13 实测：地图就绪前点"卫星"→ 卫星层永不显示，即此洞）
  const baseRef = useRef(base);
  const labelsRef = useRef(labelsOn);
  const globeRef = useRef(globeOn);
  // 语言/地形同样有就绪竞态：onReady 按"当前最新"重放
  //（2026-10-18 修复：慢加载时切语言，地图标注停在初始语言）
  const langRef = useRef(lang);
  const terrainRef = useRef(terrainOn);
  baseRef.current = base;
  labelsRef.current = labelsOn;
  globeRef.current = globeOn;
  langRef.current = lang;
  terrainRef.current = terrainOn;
  // SimBrief 轮询：基线签名（undefined=基线未定 / null=无历史计划或基线拉取失败）/ 防重入 / 轮询函数
  const sbfBaselineRef = useRef<string | null | undefined>(undefined);
  const sbfBusyRef = useRef(false);
  const pollSbfRef = useRef<() => void>(() => {});
  // 视野适配意图：加航线→适配该条（批量→适配新增并集）；删航线/编辑经停→适配目标；样式与显隐变化不挪视野
  const fitTargetRef = useRef<{ id?: string; ids?: string[]; all?: boolean } | null>(null);

  const t = STRINGS[lang];

  fmtRef.current = (km, u) =>
    `${Math.round(convertDistance(km, u)).toLocaleString('en-US')} ${u}`;

  // 地图初始化（仅一次）：maplibre chunk 与机场数据 chunk 并行拉取，
  // 面板/骨架先渲染，引擎模块就绪后再建图
  useEffect(() => {
    let disposed = false;
    let controller: MapController | null = null;
    import('./map/MapController')
      .then(({ MapController: MapControllerImpl }) => {
        if (disposed || !mapDivRef.current) return;
        controller = new MapControllerImpl(mapDivRef.current, initial.lang as LabelLanguage, initial.base, initial.globe);
        controllerRef.current = controller;
        // 机场 Pin 点击 → 信息卡（水平夹紧在视口内，卡片宽约 230px）
        controller.onPinClick((airport, x, y) => {
          setPinCard({ airport, x: Math.min(Math.max(x, 125), window.innerWidth - 125), y });
        });
        controller.onReady(() => {
          readyRef.current = true;
          setMapReady(true);
          controller!.setBase(baseRef.current);
          controller!.setLabelsVisible(labelsRef.current);
          // globe 初始值已在构造/buildStyle 内置，只重放就绪前发生过的切换
          if (globeRef.current !== initial.globe) controller!.setGlobe(globeRef.current);
          // 语言初始值在构造参数内置，只重放就绪前发生过的切换；
          // 地形无条件重放（幂等）：?terrain=1 直开时靠它上地形，同时把晕染联动置好
          if (langRef.current !== initial.lang) {
            controller!.setLabelsLanguage(langRef.current === 'zh' ? 'zh' : 'latin');
          }
          controller!.setTerrain(terrainRef.current);
          const latest = routesRef.current;
          if (latest.length) {
            setLegsMap(controller!.syncRoutes(latest, unitsRef.current, (km, u) => fmtRef.current(km, u)));
            controller!.fitRoutes(latest.filter((r) => r.visible));
          }
        });
      })
      .catch((e) => {
        // chunk 加载失败：地图区保持背景色，30s 兜底提示（mapFailed）给出刷新入口
        console.error('[boot] maplibre chunk failed', e);
      });
    return () => {
      disposed = true;
      controller?.map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 机场数据 chunk 就绪后：解析航线（URL 参数，或裸 URL 时的本地草稿快照），
  // 无法识别的部分一次性提示（错误样式，可关闭）。
  // 数据加载失败不拦界面：地图与面板仍可用，航线/搜索待下次刷新恢复；
  // 且 urlBooted 保持 false（URL 回写挂起），否则空 routes 会把深链的 route/sbr 抹掉。
  useEffect(() => {
    let cancelled = false;
    airportsReady
      .then(() => {
        if (cancelled) return;
        if (boot.draftRoutes) {
          // 裸 URL + 草稿：航线来自本地快照（含颜色/线宽/显隐/真实航路），无需 dropped 提示
          const parsed = boot.draftRoutes.map(decodeRoute).filter((r): r is RouteEntry => r !== null);
          if (parsed.length) {
            setRoutes(parsed);
            setSelectedId(parsed[parsed.length - 1].id);
          }
        } else {
          const { routes: parsed, dropped } = parseUrlRoutes(bootQuery);
          if (parsed.length) {
            setRoutes(parsed);
            setSelectedId(parsed[parsed.length - 1].id);
          }
          if (dropped.codes.length || dropped.snapshots) {
            const parts: string[] = [];
            if (dropped.codes.length) parts.push(t.urlDroppedCodes(dropped.codes));
            if (dropped.snapshots) parts.push(t.urlDroppedSnapshots(dropped.snapshots));
            showSbfMsg(parts.join(' '), true);
          }
        }
        // 只有成功才放开 URL 回写（2026-10-18 修复待证风险①）
        setUrlBooted(true);
      })
      .catch(() => {
        if (!cancelled) showSbfMsg(t.airportsFail, true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 样式加载失败兜底：onReady 永不触发时给出刷新重试入口（状态全在 URL，刷新即完整恢复）
  useEffect(() => {
    if (mapReady) return;
    const timer = setTimeout(() => {
      if (!readyRef.current) setMapFailed(true);
    }, 30000);
    return () => clearTimeout(timer);
  }, [mapReady]);

  // 语言切换：UI + 地图标注
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t.docTitle;
    controllerRef.current?.setLabelsLanguage(lang === 'zh' ? 'zh' : 'latin');
  }, [lang, t.docTitle]);

  // 底图切换
  useEffect(() => {
    if (readyRef.current) controllerRef.current?.setBase(base);
  }, [base]);

  // 航线列表变化：全量同步（增删/显隐/样式都走这里），按 fitTarget 决定是否挪视野
  useEffect(() => {
    if (!readyRef.current) return;
    const c = controllerRef.current!;
    setLegsMap(c.syncRoutes(routes, units, (km, u) => fmtRef.current(km, u)));
    const ft = fitTargetRef.current;
    if (ft) {
      fitTargetRef.current = null;
      if (ft.id) {
        const r = routes.find((x) => x.id === ft.id);
        if (r) c.fitRoute(r.airports);
      } else if (ft.ids) {
        const targets = routes.filter((r) => ft.ids!.includes(r.id) && r.visible);
        if (targets.length) c.fitRoutes(targets);
      } else if (ft.all) {
        c.fitRoutes(routes.filter((r) => r.visible));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes]);

  // 单位切换：仅重绘标签
  useEffect(() => {
    if (!readyRef.current) return;
    controllerRef.current?.syncRoutes(routes, units, (km, u) => fmtRef.current(km, u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  // 地名标注显隐
  useEffect(() => {
    if (readyRef.current) controllerRef.current?.setLabelsVisible(labelsOn);
  }, [labelsOn]);

  // 3D 地球投影（初始值已在 buildStyle 内置，运行时切换走 setProjection）
  useEffect(() => {
    if (readyRef.current) controllerRef.current?.setGlobe(globeOn);
  }, [globeOn]);

  // 3D 地形（初始 false，onReady 只重放就绪前发生过的切换，这里处理 ready 后的切换）
  useEffect(() => {
    if (readyRef.current) controllerRef.current?.setTerrain(terrainOn);
  }, [terrainOn, mapReady]);

  // Pin 信息卡生命周期：地图一动即关（锚点坐标已失效）、Esc 关
  useEffect(() => {
    if (!pinCard) return;
    const close = () => setPinCard(null);
    const c = controllerRef.current;
    c?.map.on('move', close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinCard(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      c?.map.off('move', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinCard]);

  // 航线组变化即关信息卡（Pin 可能已随代码序列重建，锚点不再可靠）
  useEffect(() => {
    setPinCard(null);
  }, [routes]);

  // 装饰小飞机总开关（默认关）。控制器是异步 chunk，mapReady 后才接得上
  useEffect(() => {
    controllerRef.current?.setPlanesEnabled(planeOn);
  }, [planeOn, mapReady]);

  // 深色模式：html.dark 类切换整套 CSS 变量（useLayoutEffect 避免首帧闪浅色）
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // URL 同步（replaceState，不产生历史记录）。urlBooted 前挂起：
  // 机场数据 chunk 未就绪时 route/sbr 还没解析，先写会把参数从 URL 里抹掉
  useEffect(() => {
    if (!urlBooted) return;
    const q = new URLSearchParams();
    // 普通航线进 route 参数；真实航路（含航点）无法用机场代码表达，逐条存 polyline 快照 sbr=
    const wpRoutes = routes.filter((r) => r.waypoints && r.waypoints.length >= 2);
    const codeRoutes = routes.filter((r) => !(r.waypoints && r.waypoints.length >= 2));
    if (codeRoutes.length) {
      q.set('route', codeRoutes.map((r) => r.airports.map((a) => a.iata || a.icao).join('-')).join(';'));
    }
    for (const r of wpRoutes) {
      q.append('sbr', encodePolyline(r.waypoints!));
    }
    // 有任一条带计划元数据才写 sbt（全无时保持 URL 干净，legacy 语义）
    if (wpRoutes.some((r) => r.ofp)) {
      for (const r of wpRoutes) q.append('sbt', encodeSbfMeta(r.ofp));
    }
    if (lang !== 'zh') q.set('lang', lang);
    if (base !== 'vector') q.set('base', base);
    if (globeOn) q.set('globe', '1');
    if (units !== 'km') q.set('u', units);
    if (!labelsOn) q.set('labels', '0');
    if (!dark) q.set('theme', 'light');
    if (planeOn) q.set('plane', '1');
    if (terrainOn) q.set('terrain', '1');
    const qs = q.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    // 草稿 = 同一份设置 + 完整航线快照（URL 分享格式不带样式，草稿在本地把
    // 颜色/线宽/显隐/真实航路补齐，裸 URL 打开时恢复）。与 URL 回写共用挂起门：
    // 机场数据失败期间不写，避免把深链/草稿一并清掉。
    const set: Record<string, string> = {};
    for (const [k, v] of q) {
      if (k !== 'route' && k !== 'sbr' && k !== 'sbt') set[k] = v;
    }
    writeDraft({ v: 1, set, routes: routes.map(encodeRoute) });
  }, [routes, lang, base, units, labelsOn, globeOn, dark, planeOn, terrainOn, urlBooted]);

  // ---- 面板操作 ----
  // 加航线（单条或多条）：逐条取色板中第一个未被占用的颜色，避免删加之后两条航线同色；用满 8 色后再循环
  // extra：SimBrief 直达链接载入时附带的 waypoints / simbriefUser / ofp 计划元数据
  const addRoutes = (
    groups: Airport[][],
    extra?: Partial<Pick<RouteEntry, 'waypoints' | 'simbriefUser' | 'ofp'>>,
  ) => {
    if (!groups.length) return;
    const used = new Set(routes.map((r) => r.color.toLowerCase()));
    const entries: RouteEntry[] = groups.map((airports, i) => {
      const color =
        ROUTE_COLORS.find((c) => !used.has(c.toLowerCase())) ??
        ROUTE_COLORS[(routes.length + i) % ROUTE_COLORS.length];
      used.add(color.toLowerCase());
      return { id: nextId(), airports, visible: true, color, width: 1, ...extra };
    });
    setRoutes((rs) => [...rs, ...entries]);
    setSelectedId(entries[entries.length - 1].id);
    fitTargetRef.current = { ids: entries.map((e) => e.id) };
  };

  const addRoute = (airports: Airport[]) => addRoutes([airports]);

  const patchRoute = (id: string, patch: Partial<Omit<RouteEntry, 'id'>>) => {
    setRoutes((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // 列表行操作（不改视野：显隐/样式属于查看中的调整）
  const toggleRoute = (id: string) => {
    const r = routes.find((x) => x.id === id);
    if (r) patchRoute(id, { visible: !r.visible });
  };

  const styleRoute = (id: string, patch: { color?: string; width?: number }) => {
    patchRoute(id, patch);
  };

  const deleteRoute = (id: string) => {
    const removed = routes.find((r) => r.id === id);
    if (!removed) return;
    setPendingUndo({
      label: t.deletedRoute(removed.airports.map((a) => a.iata || a.icao).join('-')),
      prevRoutes: routes,
      prevSelected: selectedId,
    });
    const next = routes.filter((r) => r.id !== id);
    setRoutes(next);
    if (selectedId === id) setSelectedId(next.length ? next[next.length - 1].id : null);
    fitTargetRef.current = { all: true };
  };

  // 单步撤销：恢复到删除/收藏恢复之前的整组航线与选中项（toast 入口；新操作会整条替换）
  const undoPending = () => {
    if (!pendingUndo) return;
    const { prevRoutes, prevSelected } = pendingUndo;
    setPendingUndo(null);
    setRoutes(prevRoutes);
    setSelectedId(prevSelected ?? (prevRoutes.length ? prevRoutes[prevRoutes.length - 1].id : null));
    fitTargetRef.current = { all: true };
  };

  // 撤销 toast 8 秒自动过期（依赖对象身份：期间再次删除/恢复则计时重置）
  useEffect(() => {
    if (!pendingUndo) return;
    const timer = setTimeout(() => setPendingUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [pendingUndo]);

  // 选中航线的经停更新（当前唯一入口是搜索行的 ⇄ 反向钮；空数组=整条删除，防御保留）。
  // 经停一旦变动，原真实航路折线不再成立，回退为大圆弧
  const editSelected = (airports: Airport[]) => {
    if (!selectedId) return;
    if (!airports.length) {
      deleteRoute(selectedId);
      return;
    }
    // 经停一旦变动，原真实航路折线与计划元数据都不再成立，回退大圆弧 + 估算
    patchRoute(selectedId, { airports, waypoints: undefined, simbriefUser: undefined, ofp: undefined });
    fitTargetRef.current = { id: selectedId };
  };

  // ---- SimBrief 真实航路（路线 B：带参跳转生成页 + 轮询拉回，无需 key/后端） ----
  const showSbfMsg = (text: string, error = false) => setSbfUi({ kind: 'msg', text, error });

  const importSbf = async (username: string, routeId: string): Promise<boolean> => {
    try {
      const r = await fetchLatestOfp(username);
      // 起降机场以 OFP 为准（ICAO 优先，解析失败时保留原机场）
      const oa = findByCode(r.originIcao) ?? findByCode(r.originIata);
      const da = findByCode(r.destIcao) ?? findByCode(r.destIata);
      setRoutes((rs) =>
        rs.map((x) =>
          x.id === routeId
            ? {
                ...x,
                airports: oa && da ? [oa, da] : x.airports,
                waypoints: r.waypoints,
                simbriefUser: username,
                ofp: r.plan ?? undefined,
              }
            : x,
        ),
      );
      fitTargetRef.current = { id: routeId };
      setSbfUi({ kind: 'msg', text: t.sbfImported(r.waypoints.length), error: false });
      return true;
    } catch (e) {
      setSbfUi({ kind: 'msg', text: t.sbfFail(e instanceof Error ? e.message : String(e)), error: true });
      return false;
    }
  };

  const startSbf = (username: string) => {
    const name = username.trim();
    if (!name) {
      setSbfUi({ kind: 'ask' });
      return;
    }
    const route = routes.find((r) => r.id === selectedId);
    if (!route || route.airports.length < 2) {
      showSbfMsg(t.sbfNeedSelect, true);
      return;
    }
    localStorage.setItem(SB_USER_KEY, name);
    const orig = route.airports[0];
    const dest = route.airports[route.airports.length - 1];
    // 传 ICAO（官方跳转格式与 v2 后端均按 ICAO 示例）；机型按大圆距离分档：<4000km 窄体 A21N，否则 A359
    window.open(
      simbriefDispatchUrl(
        orig.icao || orig.iata,
        dest.icao || dest.iata,
        dispatchTypeForKm(haversineKm(orig, dest)),
      ),
      '_blank',
      'noopener',
    );
    const codes = `${orig.iata || orig.icao} → ${dest.iata || dest.icao}`;
    sbfBaselineRef.current = undefined;
    setSbfUi({ kind: 'waiting', username: name, routeId: route.id, codes });
    // 记下当前最新计划的签名作基线；轮询到不同签名才自动导入（重复生成同一条计划时用"立即导入"兜底）。
    // 基线拉取失败保持 undefined（下轮重试），不能置 null——那会被当成"无历史计划"而误导入旧计划
    fetchLatestOfp(name)
      .then((r) => {
        sbfBaselineRef.current = r.sig;
      })
      .catch(() => {
        sbfBaselineRef.current = undefined;
      });
  };

  const onSimbriefClick = () => {
    const route = routes.find((r) => r.id === selectedId);
    if (!route || route.airports.length < 2) {
      showSbfMsg(t.sbfNeedSelect, true);
      return;
    }
    const saved = localStorage.getItem(SB_USER_KEY);
    if (saved) startSbf(saved);
    else setSbfUi({ kind: 'ask' });
  };

  const importSbfNow = () => {
    if (sbfUi.kind !== 'waiting') return;
    void importSbf(sbfUi.username, sbfUi.routeId);
  };

  // 回到空闲态：取消等待/输入，或关掉导入结果提示（消息右上角的小 ×）
  const cancelSbf = () => setSbfUi({ kind: 'idle' });

  // 公开版：用户在菜单填入自己的 Stadia key（UI 侧已预验证）→ 换卫星源并记住
  const applySatKey = (key: string) => {
    controllerRef.current?.applySatelliteKey(key);
    setSatKeySet(true);
  };

  // ---- 航线收藏（本地持久化；恢复替换当前航线，经撤销可还原） ----
  const saveFavorite = (name: string) => {
    if (!routes.length) return;
    const entry: FavoriteEntry = {
      id: `fv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name:
        name.trim() ||
        routes.map((r) => r.airports.map((a) => a.iata || a.icao).join('-')).join(' + '),
      at: Date.now(),
      routes: routes.map(encodeRoute),
    };
    setFavorites((list) => {
      const next = [entry, ...list].slice(0, 20);
      writeFavorites(next);
      return next;
    });
  };

  const applyFavorite = (id: string) => {
    const fav = favorites.find((f) => f.id === id);
    if (!fav) return;
    const prevRoutes = routes;
    const prevSelected = selectedId;
    // 机场数据未就绪时 findByCode 查不到：挂在 ready 后再解码
    void airportsReady.then(() => {
      const parsed = fav.routes.map(decodeRoute).filter((r): r is RouteEntry => r !== null);
      if (!parsed.length) return;
      setPendingUndo({ label: t.restoredFavorite(fav.name), prevRoutes, prevSelected });
      setRoutes(parsed);
      setSelectedId(parsed[parsed.length - 1].id);
      fitTargetRef.current = { all: true };
    });
  };

  const deleteFavorite = (id: string) => {
    setFavorites((list) => {
      const next = list.filter((f) => f.id !== id);
      writeFavorites(next);
      return next;
    });
  };

  // ---- 飞行足迹（去过机场 + 航程记录，localStorage 持久化） ----
  const recordSelectedRoute = () => {
    if (!selected) return;
    const legs = legsMap[selected.id] ?? [];
    if (!legs.length) return;
    const entry: JournalEntry = {
      id: `jr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      codes: selected.airports.map((a) => a.iata || a.icao).join('-'),
      km: Math.round(legs.reduce((s, l) => s + l.km, 0)),
      at: Date.now(),
    };
    setJournal((j) => {
      const next = { ...j, entries: [entry, ...j.entries].slice(0, 200) };
      writeJournal(next);
      return next;
    });
  };

  const toggleVisitedCode = (code: string) => {
    setJournal((j) => {
      const next = { ...j, visited: toggleVisited(j.visited, code) };
      writeJournal(next);
      return next;
    });
  };

  const removeJournalEntry = (id: string) => {
    setJournal((j) => {
      const next = { ...j, entries: j.entries.filter((e) => e.id !== id) };
      writeJournal(next);
      return next;
    });
  };

  const clearJournalEntries = () => {
    setJournal((j) => {
      const next = { ...j, entries: [] };
      writeJournal(next);
      return next;
    });
  };

  // 轮询一轮：签名与基线不同（或无基线）即自动导入
  pollSbfRef.current = () => {
    if (sbfUi.kind !== 'waiting' || sbfBusyRef.current) return;
    sbfBusyRef.current = true;
    const { username, routeId } = sbfUi;
    fetchLatestOfp(username)
      .then((r) => {
        const base = sbfBaselineRef.current;
        if (base === undefined) return; // 基线尚未确定（含拉取失败待重试），下一轮再比
        if (base === null || r.sig !== base) return importSbf(username, routeId);
      })
      .catch(() => {
        /* 轮询期间的暂时性错误忽略，等下一轮 */
      })
      .finally(() => {
        sbfBusyRef.current = false;
      });
  };

  // 等待期间：每 8s 轮询一次 + 窗口回到前台立即轮询
  useEffect(() => {
    if (sbfUi.kind !== 'waiting') return;
    const timer = setInterval(() => pollSbfRef.current(), 8000);
    const onFocus = () => pollSbfRef.current();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [sbfUi]);

  // 深链里无法识别的部分：已并入机场数据就绪后的 boot effect（parseUrlRoutes 的 dropped）

  // 直达链接 ?sbf=<用户名>：地图与机场数据都就绪后拉取最新 OFP 作为一条新航线
  useEffect(() => {
    if (!mapReady || !initial.sbf) return;
    let cancelled = false;
    airportsReady
      .then(() => (cancelled ? null : fetchLatestOfp(initial.sbf)))
      .then((r) => {
        if (cancelled || !r) return;
        const oa = findByCode(r.originIcao) ?? findByCode(r.originIata);
        const da = findByCode(r.destIcao) ?? findByCode(r.destIata);
        if (!oa || !da) return;
        addRoutes([[oa, da]], {
          waypoints: r.waypoints,
          simbriefUser: initial.sbf,
          ofp: r.plan ?? undefined,
        });
      })
      .catch(() => {
        /* 直达链接拉取失败：地图照常打开，不打断 */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  const selected = routes.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="app-root">
      <div ref={mapDivRef} className="map-root" />
      <div className={`flight-panel${panelOpen ? '' : ' collapsed'}`}>
        <SearchPanel
          selected={selected?.airports ?? []}
          t={t}
          onAdd={addRoute}
          onAddMany={addRoutes}
          onUpdateSelected={editSelected}
          sbf={{
            ask: sbfUi.kind === 'ask',
            waitingCodes: sbfUi.kind === 'waiting' ? sbfUi.codes : null,
            msg: sbfUi.kind === 'msg' ? sbfUi.text : null,
            msgError: sbfUi.kind === 'msg' && sbfUi.error,
            onOpen: onSimbriefClick,
            onConfirmUser: startSbf,
            onCancel: cancelSbf,
            onImportNow: importSbfNow,
            onDismissMsg: cancelSbf,
          }}
        />
        <JournalCard
          journal={journal}
          onRemoveEntry={removeJournalEntry}
          onClear={clearJournalEntries}
          t={t}
        />
        {routes.length > 0 && (
          <div className="panel-lower">
            <RouteList
              routes={routes}
              selectedId={selectedId}
              legsMap={legsMap}
              units={units}
              onSelect={setSelectedId}
              onToggle={toggleRoute}
              onDelete={deleteRoute}
              onStyle={styleRoute}
              t={t}
            />
            <RouteSummary
              legs={selected ? legsMap[selected.id] ?? [] : []}
              route={selected}
              units={units}
              onUnits={setUnits}
              lang={lang}
              t={t}
              onRecord={
                selected && (legsMap[selected.id]?.length ?? 0) > 0 ? recordSelectedRoute : undefined
              }
            />
          </div>
        )}
      </div>
      <button
        type="button"
        className={`panel-toggle${panelOpen ? '' : ' collapsed'}`}
        onClick={() => setPanelOpen((o) => !o)}
        aria-expanded={panelOpen}
        aria-label={panelOpen ? t.collapsePanel : t.expandPanel}
        title={panelOpen ? t.collapsePanel : t.expandPanel}
      >
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
          <path
            d="M7.5 4l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <FavoritesMenu
        favorites={favorites}
        hasRoutes={routes.length > 0}
        onSave={saveFavorite}
        onApply={applyFavorite}
        onDelete={deleteFavorite}
        t={t}
      />
      <TopRightMenu
        base={base}
        onBase={setBase}
        globeOn={globeOn}
        onGlobe={setGlobeOn}
        terrainOn={terrainOn}
        onTerrain={setTerrainOn}
        onReset={() => controllerRef.current?.resetView()}
        lang={lang}
        onLang={setLang}
        labelsOn={labelsOn}
        onLabels={setLabelsOn}
        dark={dark}
        onDark={setDark}
        planeOn={planeOn}
        onPlane={setPlaneOn}
        keyEditable={KEY_EDITABLE}
        hasSatKey={satKeySet}
        onSatKey={applySatKey}
        t={t}
      />
      <div className="brand">
        <span className="brand-name">{t.appName}</span>
      </div>
      {pinCard && (
        <AirportCard
          airport={pinCard.airport}
          x={pinCard.x}
          y={pinCard.y}
          visited={journal.visited.includes(pinCard.airport.iata || pinCard.airport.icao)}
          onToggleVisited={() => toggleVisitedCode(pinCard.airport.iata || pinCard.airport.icao)}
          onClose={() => setPinCard(null)}
          t={t}
        />
      )}
      {pendingUndo && (
        <div className="card undo-toast" role="status">
          <span className="undo-label">{pendingUndo.label}</span>
          <button type="button" className="sb-go" onClick={undoPending}>
            {t.undo}
          </button>
          <button
            type="button"
            className="undo-x"
            title={t.close}
            aria-label={t.close}
            onClick={() => setPendingUndo(null)}
          >
            ×
          </button>
        </div>
      )}
      {mapFailed && !mapReady && (
        <div className="map-fail card" role="alert">
          <span>{t.mapLoadFail}</span>
          <button type="button" className="sb-go" onClick={() => location.reload()}>
            {t.retry}
          </button>
        </div>
      )}
    </div>
  );
}
