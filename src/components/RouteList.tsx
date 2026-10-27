import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LegInfo, RouteEntry } from '../map/MapController';
import { convertDistance, type Units } from '../geo/greatCircle';
import type { Strings } from '../i18n/strings';
import { ROUTE_COLORS } from '../map/routeStyle';

// 色板与地图航线默认色共用一份定义（demo 浅黄绿/青在前，其余保留原可辨识色）
export { ROUTE_COLORS } from '../map/routeStyle';

interface Props {
  routes: RouteEntry[];
  selectedId: string | null;
  legsMap: Record<string, LegInfo[]>;
  units: Units;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onStyle: (id: string, patch: { color?: string; width?: number }) => void;
  t: Strings;
}

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
      <path
        d="M2 10c1.6-3.4 4.6-5.3 8-5.3s6.4 1.9 8 5.3c-1.6 3.4-4.6 5.3-8 5.3S3.6 13.4 2 10z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {off && <line x1="3.5" y1="16.5" x2="16.5" y2="3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

/** 左侧航线列表：每行一条航线，含显隐开关 / 颜色样式 / 删除，点击行选中 */
export function RouteList({ routes, selectedId, legsMap, units, onSelect, onToggle, onDelete, onStyle, t }: Props) {
  const [styleOpenId, setStyleOpenId] = useState<string | null>(null);
  const styleEntry = styleOpenId ? routes.find((r) => r.id === styleOpenId) : null;
  const modalRef = useRef<HTMLDivElement>(null);

  // 样式弹窗支持 Esc 关闭（点击遮罩/×也可）
  useEffect(() => {
    if (!styleOpenId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStyleOpenId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [styleOpenId]);

  // 弹窗打开移焦到容器（键盘/读屏进入对话框），关闭还焦到触发它的色点
  useEffect(() => {
    if (!styleOpenId) return;
    const opener = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();
    return () => opener?.focus?.();
  }, [styleOpenId]);

  return (
    <div className="card route-list">
      <div className="route-list-head">
        <span className="route-list-title">{t.routeList}</span>
        <span className="route-list-count">{routes.length}</span>
      </div>
      <div className="route-items">
        {routes.map((r) => {
          const legs = legsMap[r.id] ?? [];
          const totalKm = legs.reduce((s, l) => s + l.km, 0);
          const codes = r.airports.map((a) => a.iata || a.icao).join('-');
          return (
            <div
              key={r.id}
              className={`route-row${r.id === selectedId ? ' selected' : ''}${r.visible ? '' : ' off'}`}
              onClick={() => onSelect(r.id)}
            >
              <button
                type="button"
                className="route-eye"
                title={r.visible ? t.hideRoute : t.showRoute}
                aria-label={r.visible ? t.hideRoute : t.showRoute}
                onClick={(e) => { e.stopPropagation(); onToggle(r.id); }}
              >
                <EyeIcon off={!r.visible} />
              </button>
              <button
                type="button"
                className="route-dot"
                style={{ background: r.color }}
                title={t.style}
                aria-label={t.style}
                onClick={(e) => { e.stopPropagation(); setStyleOpenId(r.id); }}
              />
              <span
                className="route-codes"
                role="button"
                tabIndex={0}
                aria-pressed={r.id === selectedId}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(r.id);
                  }
                }}
              >{codes}</span>
              {legs.length > 0 && (
                <span className="route-dist">
                  {Math.round(convertDistance(totalKm, units)).toLocaleString('en-US')} {units}
                </span>
              )}
              <button
                type="button"
                className="route-x"
                title={t.deleteRoute}
                aria-label={t.deleteRoute}
                onClick={(e) => { e.stopPropagation(); if (styleOpenId === r.id) setStyleOpenId(null); onDelete(r.id); }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {styleEntry &&
        createPortal(
          <div className="style-modal-backdrop" onMouseDown={() => setStyleOpenId(null)}>
            <div
              className="style-modal"
              role="dialog"
              aria-modal="true"
              aria-label={`${t.style} · ${styleEntry.airports.map((a) => a.iata || a.icao).join('-')}`}
              tabIndex={-1}
              ref={modalRef}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="style-modal-head">
                <span className="style-modal-title">{t.style}</span>
                <span className="style-modal-codes">
                  {styleEntry.airports.map((a) => a.iata || a.icao).join('-')}
                </span>
                <button
                  type="button"
                  className="style-modal-x"
                  title={t.close}
                  aria-label={t.close}
                  onClick={() => setStyleOpenId(null)}
                >
                  ×
                </button>
              </div>
              <div className="style-row-label">{t.color}</div>
              <div className="swatches">
                {ROUTE_COLORS.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    className={`swatch${c.toLowerCase() === styleEntry.color.toLowerCase() ? ' active' : ''}`}
                    style={{ background: c }}
                    aria-label={`${t.color} · ${t.colorNames[i] ?? c}`}
                    aria-pressed={c.toLowerCase() === styleEntry.color.toLowerCase()}
                    onClick={() => onStyle(styleEntry.id, { color: c })}
                  />
                ))}
                <label
                  className={`swatch custom${ROUTE_COLORS.some((c) => c.toLowerCase() === styleEntry.color.toLowerCase()) ? '' : ' active'}`}
                  title={t.customColor}
                >
                  <input
                    type="color"
                    aria-label={t.customColor}
                    value={styleEntry.color}
                    onChange={(e) => onStyle(styleEntry.id, { color: e.target.value })}
                  />
                </label>
              </div>
              <div className="style-row-label">{t.width}</div>
              <div className="width-row">
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.25}
                  value={styleEntry.width}
                  aria-label={t.width}
                  onChange={(e) => onStyle(styleEntry.id, { width: Number(e.target.value) })}
                />
                <span className="width-val">×{styleEntry.width}</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
