import { useEffect, useRef, useState } from 'react';
import type { BaseMode } from '../map/styleFactory';
import type { Lang, Strings } from '../i18n/strings';

interface Props {
  base: BaseMode;
  onBase: (m: BaseMode) => void;
  globeOn: boolean;
  onGlobe: (v: boolean) => void;
  onReset: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  labelsOn: boolean;
  onLabels: (v: boolean) => void;
  dark: boolean;
  onDark: (v: boolean) => void;
  t: Strings;
}

/** 右上角唯一入口：一个按钮拉起菜单，收拢底图/3D/回正/地名/语言/深色模式全部控件 */
export function TopRightMenu({
  base, onBase, globeOn, onGlobe, onReset, lang, onLang, labelsOn, onLabels, dark, onDark, t,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  return (
    <div className="map-menu" ref={rootRef}>
      <button
        type="button"
        className={`menu-btn${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.menu}
        title={t.menu}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden>
          <line x1="6.5" y1="3" x2="6.5" y2="17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <line x1="13.5" y1="3" x2="13.5" y2="17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="6.5" cy="12.5" r="2.5" fill="currentColor" />
          <circle cx="13.5" cy="7.5" r="2.5" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="card menu-panel" role="menu">
          <div className="menu-row">
            <span className="menu-label">{t.baseMap}</span>
            <div className="seg seg-small">
              <button className={base === 'vector' ? 'active' : ''} onClick={() => onBase('vector')}>
                {t.vector}
              </button>
              <button className={base === 'satellite' ? 'active' : ''} onClick={() => onBase('satellite')}>
                {t.satellite}
              </button>
            </div>
          </div>
          <div className="menu-row">
            <span className="menu-label">{t.globeRow}</span>
            <button
              type="button"
              className={`switch${globeOn ? ' on' : ''}`}
              role="switch"
              aria-checked={globeOn}
              aria-label={t.globeRow}
              title={t.globeTip}
              onClick={() => onGlobe(!globeOn)}
            />
          </div>
          <button type="button" className="menu-row menu-action" title={t.resetViewTip} onClick={onReset}>
            <span className="menu-label">{t.resetView}</span>
            {/* lucide rotate-cw：箭头尖沿圆弧切线朝外（手搓版夹角朝内被用户打回） */}
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
              <path
                d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M21 3v5h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="menu-row">
            <span className="menu-label">{t.labels}</span>
            <button
              type="button"
              className={`switch${labelsOn ? ' on' : ''}`}
              role="switch"
              aria-checked={labelsOn}
              aria-label={t.labels}
              onClick={() => onLabels(!labelsOn)}
            />
          </div>
          <div className="menu-row">
            <span className="menu-label">{t.language}</span>
            <div className="seg seg-small">
              <button className={lang === 'zh' ? 'active' : ''} onClick={() => onLang('zh')}>
                中
              </button>
              <button className={lang === 'en' ? 'active' : ''} onClick={() => onLang('en')}>
                EN
              </button>
            </div>
          </div>
          <div className="menu-row">
            <span className="menu-label">{t.darkMode}</span>
            <button
              type="button"
              className={`switch${dark ? ' on' : ''}`}
              role="switch"
              aria-checked={dark}
              aria-label={t.darkMode}
              onClick={() => onDark(!dark)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
