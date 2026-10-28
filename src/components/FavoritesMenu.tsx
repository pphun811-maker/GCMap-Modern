import { useEffect, useRef, useState } from 'react';
import type { FavoriteEntry } from '../state/saved';
import type { Strings } from '../i18n/strings';

interface Props {
  docked?: boolean;
  favorites: FavoriteEntry[];
  /** 当前有航线才显示保存行 */
  hasRoutes: boolean;
  onSave: (name: string) => void;
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  t: Strings;
}

/** 右上角航线收藏：书签按钮拉起面板，命名保存当前航线组 / 点击恢复（替换当前航线）/ 删除。
 *  与地图选项菜单同材质同交互（点外部 / Esc 关闭） */
export function FavoritesMenu({ favorites, hasRoutes, onSave, onApply, onDelete, t, docked = false }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || docked) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, docked]);

  const save = () => {
    onSave(name);
    setName('');
  };

  return (
    <div className={docked ? 'pro-docked-favorites' : 'map-menu fav-menu'} ref={rootRef}>
      {!docked && <button
        type="button"
        className={`menu-btn${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.favRow}
        title={t.favRow}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
          <path
            d="M5.5 3.5h9c.6 0 1 .4 1 1V17l-5.5-3.6L4.5 17V4.5c0-.6.4-1 1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </button>}
      {(open || docked) && (
        <div className="card menu-panel fav-panel" aria-label={t.favRow}>
          {hasRoutes && (
            <div className="fav-save">
              <input
                className="fav-name"
                value={name}
                spellCheck={false}
                autoComplete="off"
                placeholder={t.favNamePlaceholder}
                aria-label={t.favSave}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    save();
                  }
                }}
              />
              <button type="button" className="sb-go" onClick={save}>
                {t.favSave}
              </button>
            </div>
          )}
          {favorites.length ? (
            <div className="fav-list">
              {favorites.map((f) => (
                <div
                  key={f.id}
                  className="fav-row"
                  role="button"
                  tabIndex={0}
                  title={t.favRestoreTitle}
                  onClick={() => {
                    onApply(f.id);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onApply(f.id);
                      setOpen(false);
                    }
                  }}
                >
                  <span className="fav-name-label">
                    <b>{f.name}</b>
                    <span className="fav-codes">
                      {f.routes.map((r) => r.c.join('-')).join(' + ')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="fav-x"
                    title={t.favDelete}
                    aria-label={`${t.favDelete} ${f.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(f.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="fav-empty">{hasRoutes ? t.favEmptyHint : t.favEmpty}</div>
          )}
        </div>
      )}
    </div>
  );
}
