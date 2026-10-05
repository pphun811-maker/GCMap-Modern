import { useEffect, useRef, useState } from 'react';
import { MapController, type LegInfo, type RouteEntry } from './map/MapController';
import type { BaseMode, LabelLanguage } from './map/styleFactory';
import { findByCode, type Airport } from './data/search';
import { convertDistance, type Units } from './geo/greatCircle';
import { STRINGS, type Lang } from './i18n/strings';
import { SearchPanel } from './components/SearchPanel';
import { RouteList, ROUTE_COLORS } from './components/RouteList';
import { RouteSummary } from './components/RouteSummary';
import { TopRightControls } from './components/TopRightControls';

let uid = 0;
const nextId = () => `rt-${++uid}`;

interface UrlState {
  routes: RouteEntry[];
  lang: Lang;
  base: BaseMode;
  units: Units;
  labels: boolean;
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

function parseUrl(): UrlState {
  const q = new URLSearchParams(window.location.search);
  return {
    routes: parseRoutesParam(q.get('route')),
    lang: q.get('lang') === 'en' ? 'en' : 'zh',
    base: q.get('base') === 'satellite' ? 'satellite' : 'vector',
    units: q.get('u') === 'mi' || q.get('u') === 'nm' ? (q.get('u') as Units) : 'km',
    labels: q.get('labels') !== '0',
  };
}

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

  const mapDivRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  const readyRef = useRef(false);
  const fmtRef = useRef<(km: number, u: Units) => string>(() => '');
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
    if (routes.length) {
      q.set('route', routes.map((r) => r.airports.map((a) => a.iata || a.icao).join('-')).join(';'));
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
  const addRoutes = (groups: Airport[][]) => {
    if (!groups.length) return;
    const used = new Set(routes.map((r) => r.color.toLowerCase()));
    const entries: RouteEntry[] = groups.map((airports, i) => {
      const color =
        ROUTE_COLORS.find((c) => !used.has(c.toLowerCase())) ??
        ROUTE_COLORS[(routes.length + i) % ROUTE_COLORS.length];
      used.add(color.toLowerCase());
      return { id: nextId(), airports, visible: true, color, width: 1 };
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

  // 选中航线的经停编辑（chips 删除 / 反向）；删到没有经停时整条删除
  const editSelected = (airports: Airport[]) => {
    if (!selectedId) return;
    if (!airports.length) {
      deleteRoute(selectedId);
      return;
    }
    patchRoute(selectedId, { airports });
    fitTargetRef.current = { id: selectedId };
  };

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
        <RouteSummary legs={selected ? legsMap[selected.id] ?? [] : []} units={units} onUnits={setUnits} t={t} />
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
