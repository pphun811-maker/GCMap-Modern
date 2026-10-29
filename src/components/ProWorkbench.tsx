import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { Units } from '../geo/greatCircle';
import type { BaseMode } from '../map/styleFactory';
import type { Lang, Strings } from '../i18n/strings';
import workbenchCss from '../pro-workbench.css?inline';

interface Props {
  legacyUi: boolean;
  lang: Lang;
  t: Strings;
  base: BaseMode;
  onBase: (value: BaseMode) => void;
  globe: boolean;
  onGlobe: (value: boolean) => void;
  labels: boolean;
  onLabels: (value: boolean) => void;
  units: Units;
  onUnits: (value: Units) => void;
  onFit: () => void;
  panelOpen: boolean;
  onPanel: () => void;
  mapReady: boolean;
  mapZoom: number | null;
  attributionRef: RefObject<HTMLDivElement | null>;
  routeCount: number;
  selectedCodes: string[];
  map: ReactNode;
  search: ReactNode;
  routes: ReactNode;
  summary: ReactNode;
  journal: ReactNode;
  favorites: ReactNode;
  options: ReactNode;
  overlays: ReactNode;
}

function ToolIcon({ kind }: { kind: 'routes' | 'favorites' | 'journal' | 'details' | 'panel' }) {
  const path = {
    routes: 'M4 6h16M4 12h12M4 18h14',
    favorites: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
    journal: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4',
    details: 'M4 4h16v16H4zM14 4v16M7 9h4M7 13h4',
    panel: 'M3 4h18v16H3zM9 4v16',
  }[kind];
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

/** Docked UI shell. Existing feature components retain their state and business handlers. */
export function ProWorkbench(p: Props) {
  const [tab, setTab] = useState<'routes' | 'favorites' | 'journal'>('routes');
  const [detailsOpen, setDetailsOpen] = useState(() => window.matchMedia('(min-width: 1001px)').matches);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [clock, setClock] = useState(() => new Date().toISOString().slice(11, 19));
  const zh = p.lang === 'zh';
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toISOString().slice(11, 19)), 1000);
    return () => clearInterval(timer);
  }, []);
  const showTab = (next: typeof tab) => { setTab(next); if (!p.panelOpen) p.onPanel(); };
  const title = tab === 'routes' ? (zh ? '航线工作区' : 'Route workspace') : tab === 'favorites' ? p.t.favRow : p.t.journalTitle;
  if (p.legacyUi) {
    return (
      <div className="app-root legacy-ui">
        <style>{`.legacy-ui .pro-route-intro,.legacy-ui .pro-route-metrics,.legacy-ui .pro-create-route,.legacy-ui .sb-btn span{display:none}.legacy-ui .pro-search-tools{display:contents}.legacy-ui .pro-empty{padding:12px;color:var(--text-muted);font-size:12px}.menu-ui-switch{border-top:1px solid var(--hairline-strong);padding:12px 0 8px}.menu-ui-switch button{width:100%}`}</style>
        {p.map}
        <div className={`flight-panel${p.panelOpen ? '' : ' collapsed'}`}>
          {p.search}
          {p.journal}
          {p.routeCount > 0 && <div className="panel-lower">{p.routes}{p.summary}</div>}
        </div>
        <button type="button" className={`panel-toggle${p.panelOpen ? '' : ' collapsed'}`} onClick={p.onPanel} aria-expanded={p.panelOpen} aria-label={p.panelOpen ? p.t.collapsePanel : p.t.expandPanel} title={p.panelOpen ? p.t.collapsePanel : p.t.expandPanel}><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M7.5 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        {p.favorites}
        {p.options}
        <div className="brand"><span className="brand-name">{p.t.appName}</span></div>
        {p.overlays}
      </div>
    );
  }
  return (
    <div className={`app-root pro-workbench${p.panelOpen ? '' : ' sidebar-collapsed'}${detailsOpen ? ' inspector-open' : ' inspector-collapsed'}`}>
      <style>{workbenchCss}</style>
      <header id="pro-appbar" className="pro-appbar" hidden={!headerOpen}>
        <div className="pro-brand"><b>GCMap</b><span>MODERN</span></div>
        <div className="pro-app-actions"><span className="pro-session"><i />{zh ? '本机自动保存' : 'Autosaved locally'}</span><time>{clock} UTC</time><button type="button" className="pro-save" onClick={() => showTab('favorites')}><ToolIcon kind="favorites" />{p.t.favRow}</button></div>
      </header>
      <div className="pro-toolbar" role="toolbar" aria-label={zh ? '地图工具栏' : 'Map toolbar'}>
        <span className="pro-tool-label">{p.t.baseMap}</span>
        <div className="seg seg-small"><button type="button" className={p.base === 'vector' ? 'active' : ''} aria-pressed={p.base === 'vector'} onClick={() => p.onBase('vector')}>{p.t.vector}</button><button type="button" className={p.base === 'satellite' ? 'active' : ''} aria-pressed={p.base === 'satellite'} onClick={() => p.onBase('satellite')}>{p.t.satellite}</button></div>
        <div className="pro-divider" />
        <button type="button" className={p.globe ? 'active' : ''} aria-pressed={p.globe} onClick={() => p.onGlobe(!p.globe)}>{p.t.globeRow}</button>
        <button type="button" className={p.labels ? 'active' : ''} aria-pressed={p.labels} onClick={() => p.onLabels(!p.labels)}>{p.t.labels}</button>
        <button type="button" onClick={p.onFit}>{zh ? '适配航线' : 'Fit routes'}</button>
        <div className="pro-toolbar-spacer" />
        <div className="seg seg-small pro-units" aria-label={zh ? '距离单位' : 'Distance units'}>{(['km', 'nm', 'mi'] as const).map(u => <button key={u} type="button" className={p.units === u ? 'active' : ''} aria-pressed={p.units === u} onClick={() => p.onUnits(u)}>{u}</button>)}</div>
        <button type="button" className="pro-header-toggle" onClick={() => setHeaderOpen(v => !v)} aria-expanded={headerOpen} aria-controls="pro-appbar" aria-label={zh ? (headerOpen ? '收起顶栏' : '展开顶栏') : (headerOpen ? 'Collapse top bar' : 'Expand top bar')} title={zh ? (headerOpen ? '收起顶栏' : '展开顶栏') : (headerOpen ? 'Collapse top bar' : 'Expand top bar')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d={headerOpen ? 'm5 12 5-5 5 5' : 'm5 8 5 5 5-5'} /></svg></button>
        <button type="button" className={`pro-inspector-toggle${detailsOpen ? ' active' : ''}`} onClick={() => setDetailsOpen(v => !v)} aria-expanded={detailsOpen} aria-label={zh ? (detailsOpen ? '收起右侧栏' : '展开右侧栏') : (detailsOpen ? 'Collapse right sidebar' : 'Expand right sidebar')} title={zh ? '右侧栏' : 'Right sidebar'}><ToolIcon kind="details" /></button>
      </div>
      <main className="pro-body">
        <nav className="pro-rail" aria-label={zh ? '工作区导航' : 'Workspace navigation'}>
          {(['routes', 'favorites', 'journal'] as const).map(key => <button key={key} type="button" className={p.panelOpen && tab === key ? 'active' : ''} onClick={() => showTab(key)} aria-pressed={p.panelOpen && tab === key} title={key === 'routes' ? p.t.routeList : key === 'favorites' ? p.t.favRow : p.t.journalTitle} aria-label={key === 'routes' ? p.t.routeList : key === 'favorites' ? p.t.favRow : p.t.journalTitle}><ToolIcon kind={key} /></button>)}
          <span className="pro-rail-bottom">GC</span>
        </nav>
        <aside className="pro-explorer" aria-label={title}>
          <div className="pro-pane-heading"><span>{title}</span><span>EXPLORER</span><button type="button" className="pro-dock-collapse" onClick={p.onPanel} aria-label={zh ? '收起左侧栏' : 'Collapse left sidebar'} title={p.t.collapsePanel}>‹</button></div>
          <div className="pro-routes-tab" hidden={tab !== 'routes'}>
            <div className="pro-search-heading">{zh ? '建立航线' : 'Build a route'}<span>IATA / ICAO</span></div>
            {p.search}
            <div className="pro-route-scroll">{p.routes}</div>
            <div className="pro-sidebar-note">{zh ? '航线、样式与收藏保存在本机' : 'Routes, styles and saved sets stay on this device'}</div>
          </div>
          <div className="pro-favorites-tab" hidden={tab !== 'favorites'}>{p.favorites}</div>
          <div className="pro-journal-tab" hidden={tab !== 'journal'}>{p.journal}</div>
        </aside>
        <section className="pro-map-viewport" aria-label={zh ? '航线地图' : 'Route map'}>
          {p.map}
          {p.selectedCodes.length >= 2 && <div className="pro-map-caption"><strong>{p.selectedCodes.join(' → ')}</strong></div>}
        </section>
        <aside className="pro-inspector" aria-label={zh ? '航线详情' : 'Route details'}>
          <div className="pro-pane-heading"><span>{zh ? '航线详情' : 'Route details'}</span><span>INSPECTOR</span><button type="button" className="pro-dock-collapse" onClick={() => setDetailsOpen(false)} aria-label={zh ? '收起右侧栏' : 'Collapse right sidebar'} title={p.t.collapsePanel}>›</button></div>
          <div className="pro-summary-scroll">{p.summary}<div className="pro-settings">{p.options}</div></div>
        </aside>
      </main>
      <footer className="pro-statusbar"><span><i className={p.mapReady ? 'ready' : ''} />{p.mapReady ? (zh ? '地图已就绪' : 'Map ready') : (zh ? '加载地图中' : 'Loading map')}</span><span className="pro-status-route-count">{p.routeCount} {zh ? '条航线' : 'routes'}</span><span className="pro-status-projection">{p.globe ? 'GLOBE' : 'MERCATOR'}</span><div className="pro-attribution" ref={p.attributionRef} aria-label={zh ? '地图来源与授权' : 'Map attribution'} /><span className="pro-status-end" title={p.mapZoom === null ? '' : `MapLibre z${p.mapZoom.toFixed(2)}`}>{zh ? '缩放' : 'Zoom'} {p.mapZoom === null ? '—' : `${(2 ** p.mapZoom).toFixed(2)}×`}</span></footer>
      {p.overlays}
    </div>
  );
}
