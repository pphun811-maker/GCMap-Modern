import { useEffect, useRef, useState } from 'react';
import { MapController, type LegInfo, type RouteEntry } from './map/MapController';
import type { BaseMode, LabelLanguage } from './map/styleFactory';
import { findByCode, findAirportNear, type Airport } from './data/search';
import { convertDistance, type Units } from './geo/greatCircle';
import {
  decodePolyline, encodePolyline, fetchLatestOfp, simbriefDispatchUrl,
} from './simbrief/simbrief';
import { STRINGS, type Lang } from './i18n/strings';
import { SearchPanel } from './components/SearchPanel';
import { RouteList, ROUTE_COLORS } from './components/RouteList';
import { RouteSummary } from './components/RouteSummary';
import { TopRightControls } from './components/TopRightControls';

let uid = 0;
const nextId = () => `rt-${++uid}`;

const SB_USER_KEY = 'gcmap.sbfuser';

interface UrlState {
  routes: RouteEntry[];
  lang: Lang;
  base: BaseMode;
  units: Units;
  labels: boolean;
  sbf: string;
}

// 多条航线用 ; 分隔（单条内机场用 - 连接），旧单航线链接自动兼容
function parseRoutesParam(v: string | null): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const part of (v ?? '').split(';')) {
    const airports = part
      .split('-')
      .map((c) => findByCode(c.trim()))
      .filter((a): a is Airport => !!a);
    if (!airports.length) continue;
    out.push({
      id: nextId(),
      airports,
      visible: true,
      color: ROUTE_COLORS[out.length % ROUTE_COLORS.length],
      width: 1,
    });
  }
  return out;
}

// SimBrief 真实航路快照：每条一个 sbr=<polyline> 参数，首末航点解析回机场供 Pin/列表显示
function parseSbrParam(q: URLSearchParams): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const val of q.getAll('sbr')) {
    let pts: { lat: number; lon: number }[];
    try {
      pts = decodePolyline(val);
    } catch {
      continue;
    }
    if (pts.length < 2) continue;
    const a = findAirportNear(pts[0].lat, pts[0].lon);
    const b = findAirportNear(pts[pts.length - 1].lat, pts[pts.length - 1].lon);
    if (!a || !b) continue;
    out.push({
      id: nextId(),
      airports: [a, b],
      visible: true,
      color: ROUTE_COLORS[out.length % ROUTE_COLORS.length],
      width: 1,
      waypoints: pts.map((p) => ({ ident: '', lat: p.lat, lon: p.lon })),
    });
  }
  return out;
}

function parseUrl(): UrlState {
  const q = new URLSearchParams(window.location.search);
  return {
    // 快照航线在前、代码航线在后：初始选中（最后一条）落在用户最近在操作的代码航线上
    routes: [...parseSbrParam(q), ...parseRoutesParam(q.get('route'))],
    lang: q.get('lang') === 'en' ? 'en' : 'zh',
    base: q.get('base') === 'satellite' ? 'satellite' : 'vector',
    units: q.get('u') === 'mi' || q.get('u') === 'nm' ? (q.get('u') as Units) : 'km',
    labels: q.get('labels') !== '0',
    sbf: q.get('sbf') ?? '',
  };
}

/** SimBrief 导入的 UI 状态：空闲 / 输用户名 / 等待生成（轮询中）/ 结果提示 */
type SbfUi =
  | { kind: 'idle' }
  | { kind: 'ask' }
  | { kind: 'waiting'; username: string; routeId: string; codes: string }
  | { kind: 'msg'; text: string; error: boolean };

export default function App() {
  const initial = useRef(parseUrl()).current;
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [base, setBase] = useState<BaseMode>(initial.base);
  const [units, setUnits] = useState<Units>(initial.units);
  const [routes, setRoutes] = useState<RouteEntry[]>(initial.routes);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.routes.length ? initial.routes[initial.routes.length - 1].id : null,
  );
  const [labelsOn, setLabelsOn] = useState(initial.labels);
  const [legsMap, setLegsMap] = useState<Record<string, LegInfo[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [sbfUi, setSbfUi] = useState<SbfUi>({ kind: 'idle' });
  const [mapReady, setMapReady] = useState(false);

  const mapDivRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  const readyRef = useRef(false);
  const fmtRef = useRef<(km: number, u: Units) => string>(() => '');
  // SimBrief 轮询：基线签名（undefined=基线未定 / null=无历史计划或基线拉取失败）/ 防重入 / 轮询函数
  const sbfBaselineRef = useRef<string | null | undefined>(undefined);
  const sbfBusyRef = useRef(false);
  const pollSbfRef = useRef<() => void>(() => {});
  // 视野适配意图：加航线→适配该条（批量→适配新增并集）；删航线/编辑经停→适配目标；样式与显隐变化不挪视野
  const fitTargetRef = useRef<{ id?: string; ids?: string[]; all?: boolean } | null>(null);

  const t = STRINGS[lang];

  fmtRef.current = (km, u) =>
    `${Math.round(convertDistance(km, u)).toLocaleString('en-US')} ${u}`;

  // 地图初始化（仅一次）
  useEffect(() => {
    if (!mapDivRef.current) return;
    const controller = new MapController(mapDivRef.current, initial.lang as LabelLanguage, initial.base);
    controllerRef.current = controller;
    controller.onReady(() => {
      readyRef.current = true;
      setMapReady(true);
      controller.setBase(initial.base);
      controller.setLabelsVisible(initial.labels);
      if (initial.routes.length) {
        setLegsMap(controller.syncRoutes(initial.routes, initial.units, (km, u) => fmtRef.current(km, u)));
        controller.fitRoutes(initial.routes.filter((r) => r.visible));
      }
    });
    return () => controller.map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // URL 同步（replaceState，不产生历史记录）
  useEffect(() => {
    const q = new URLSearchParams();
    // 普通航线进 route 参数；真实航路（含航点）无法用机场代码表达，逐条存 polyline 快照 sbr=
    const codeRoutes = routes.filter((r) => !(r.waypoints && r.waypoints.length >= 2));
    if (codeRoutes.length) {
      q.set('route', codeRoutes.map((r) => r.airports.map((a) => a.iata || a.icao).join('-')).join(';'));
    }
    for (const r of routes) {
      if (r.waypoints && r.waypoints.length >= 2) {
        q.append('sbr', encodePolyline(r.waypoints));
      }
    }
    if (lang !== 'zh') q.set('lang', lang);
    if (base !== 'vector') q.set('base', base);
    if (units !== 'km') q.set('u', units);
    if (!labelsOn) q.set('labels', '0');
    const qs = q.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [routes, lang, base, units, labelsOn]);

  // ---- 面板操作 ----
  // 加航线（单条或多条）：逐条取色板中第一个未被占用的颜色，避免删加之后两条航线同色；用满 8 色后再循环
  // extra：SimBrief 直达链接载入时附带的 waypoints / simbriefUser
  const addRoutes = (
    groups: Airport[][],
    extra?: Partial<Pick<RouteEntry, 'waypoints' | 'simbriefUser'>>,
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
    const next = routes.filter((r) => r.id !== id);
    setRoutes(next);
    if (selectedId === id) setSelectedId(next.length ? next[next.length - 1].id : null);
    fitTargetRef.current = { all: true };
  };

  // 选中航线的经停编辑（chips 删除 / 反向）；删到没有经停时整条删除。
  // 经停一旦编辑，原真实航路折线不再成立，回退为大圆弧
  const editSelected = (airports: Airport[]) => {
    if (!selectedId) return;
    if (!airports.length) {
      deleteRoute(selectedId);
      return;
    }
    patchRoute(selectedId, { airports, waypoints: undefined, simbriefUser: undefined });
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
    // 传 ICAO（官方跳转格式与 v2 后端均按 ICAO 示例），机型默认 A359
    window.open(
      simbriefDispatchUrl(orig.icao || orig.iata, dest.icao || dest.iata),
      '_blank',
      'noopener',
    );
    const codes = `${orig.iata || orig.icao} → ${dest.iata || dest.icao}`;
    sbfBaselineRef.current = undefined;
    setSbfUi({ kind: 'waiting', username: name, routeId: route.id, codes });
    // 记下当前最新计划的签名作基线；轮询到不同签名才自动导入（重复生成同一条计划时用"立即导入"兜底）
    fetchLatestOfp(name)
      .then((r) => {
        sbfBaselineRef.current = r.sig;
      })
      .catch(() => {
        sbfBaselineRef.current = null;
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

  const cancelSbf = () => setSbfUi({ kind: 'idle' });

  // 轮询一轮：签名与基线不同（或无基线）即自动导入
  pollSbfRef.current = () => {
    if (sbfUi.kind !== 'waiting' || sbfBusyRef.current) return;
    sbfBusyRef.current = true;
    const { username, routeId } = sbfUi;
    fetchLatestOfp(username)
      .then((r) => {
        const base = sbfBaselineRef.current;
        if (base === undefined) return; // 基线尚未确定，下一轮再比
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

  // 直达链接 ?sbf=<用户名>：地图就绪后拉取最新 OFP 作为一条新航线
  useEffect(() => {
    if (!mapReady || !initial.sbf) return;
    let cancelled = false;
    fetchLatestOfp(initial.sbf)
      .then((r) => {
        if (cancelled) return;
        const oa = findByCode(r.originIcao) ?? findByCode(r.originIata);
        const da = findByCode(r.destIcao) ?? findByCode(r.destIata);
        if (!oa || !da) return;
        addRoutes([[oa, da]], { waypoints: r.waypoints, simbriefUser: initial.sbf });
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
          }}
        />
        {routes.length > 0 && (
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
        )}
        <RouteSummary
          legs={selected ? legsMap[selected.id] ?? [] : []}
          route={selected}
          units={units}
          onUnits={setUnits}
          t={t}
        />
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
      <TopRightControls
        base={base}
        onBase={setBase}
        lang={lang}
        onLang={setLang}
        labelsOn={labelsOn}
        onLabels={setLabelsOn}
        t={t}
      />
      <div className="brand">
        <span className="brand-name">{t.appName}</span>
      </div>
    </div>
  );
}
