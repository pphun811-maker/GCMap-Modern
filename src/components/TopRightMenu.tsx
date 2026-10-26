import { useEffect, useRef, useState } from 'react';
import type { BaseMode } from '../map/styleFactory';
import { validateMapTilerKey, type MapTilerKeyCheck } from '../map/styleFactory';
import type { Lang, Strings } from '../i18n/strings';

interface Props {
  base: BaseMode;
  onBase: (m: BaseMode) => void;
  globeOn: boolean;
  onGlobe: (v: boolean) => void;
  /** 3D 地形起伏开关（默认关） */
  terrainOn: boolean;
  onTerrain: (v: boolean) => void;
  onReset: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  labelsOn: boolean;
  onLabels: (v: boolean) => void;
  dark: boolean;
  onDark: (v: boolean) => void;
  /** 装饰小飞机巡航开关（默认关） */
  planeOn: boolean;
  onPlane: (v: boolean) => void;
  t: Strings;
  /** 公开构建（无内置 key）才显示卫星 key 导入入口 */
  keyEditable: boolean;
  /** 用户已填入自己的 key（输入框+注册链接随之收起，只留换 Key 按钮） */
  hasSatKey: boolean;
  /** 保存并应用 key（调用方已通过 validateMapTilerKey 预验证） */
  onSatKey: (key: string) => void;
}

// MapTiler 云控制台直达链接（免费计划：10 万瓦片请求/月，非商用）
const MAPTILER_SIGNUP_URL = 'https://cloud.maptiler.com';

/** 右上角唯一入口：一个按钮拉起菜单，收拢底图/3D/回正/地名/语言/深色模式全部控件 */
export function TopRightMenu({
  base, onBase, globeOn, onGlobe, terrainOn, onTerrain, onReset, lang, onLang, labelsOn, onLabels, dark, onDark, planeOn, onPlane, t,
  keyEditable, hasSatKey, onSatKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 卫星 key 导入：editing=输入态（无 key 时初始即输入态）；checking=验证中；err=上次验证失败（区分无效/网络）
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyVal, setKeyVal] = useState('');
  const [keyChecking, setKeyChecking] = useState(false);
  const [keyErr, setKeyErr] = useState<Exclude<MapTilerKeyCheck, 'ok'> | null>(null);

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

  // 回车提交：先抓一张小瓦片验证 key，通过才保存（保存后输入框与注册链接一起消失）
  const submitKey = async () => {
    if (keyChecking) return;
    const key = keyVal.trim();
    if (!key) {
      // 空回车 = 收起输入态；从未设置过 key 时视为误触不动
      if (hasSatKey) {
        setKeyEditing(false);
        setKeyErr(null);
        setKeyVal('');
      }
      return;
    }
    setKeyChecking(true);
    setKeyErr(null);
    const res = await validateMapTilerKey(key);
    setKeyChecking(false);
    if (res !== 'ok') {
      setKeyErr(res);
      return;
    }
    onSatKey(key);
    setKeyEditing(false);
    setKeyVal('');
  };

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
        <div className="card menu-panel" aria-label={t.menu}>
          <div className="menu-row">
            <span className="menu-label">{t.baseMap}</span>
            <div className="seg seg-small">
              <button type="button" className={base === 'vector' ? 'active' : ''} aria-pressed={base === 'vector'} onClick={() => onBase('vector')}>
                {t.vector}
              </button>
              <button type="button" className={base === 'satellite' ? 'active' : ''} aria-pressed={base === 'satellite'} onClick={() => onBase('satellite')}>
                {t.satellite}
              </button>
            </div>
          </div>
          {keyEditable && (
            <div className="menu-key" title={t.satKeyTip}>
              {hasSatKey && !keyEditing ? (
                <div className="key-row">
                  <span className="menu-label">{t.satKey}</span>
                  <button
                    type="button"
                    className="key-change"
                    onClick={() => {
                      setKeyEditing(true);
                      setKeyErr(null);
                      setKeyVal('');
                    }}
                  >
                    {t.changeKey}
                  </button>
                </div>
              ) : (
                <div className="menu-key-edit">
                  <div className="key-edit-label">{t.satKey}</div>
                  <input
                    className="key-input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    placeholder={t.keyPlaceholder}
                    aria-label={t.satKey}
                    value={keyVal}
                    disabled={keyChecking}
                    onChange={(e) => {
                      setKeyVal(e.target.value);
                      setKeyErr(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitKey();
                      }
                    }}
                  />
                  <div className="key-hint">
                    {/* 是什么 / 免费吗 / 能得到什么——常驻说明；验证中与报错为临时状态行 */}
                    <div className="key-why">{t.keyWhy}</div>
                    {keyChecking && <div className="key-status">{t.keyChecking}</div>}
                    {keyErr === 'invalid' && <div className="key-status key-err-text">{t.keyInvalid}</div>}
                    {keyErr === 'network' && <div className="key-status">{t.keyNetwork}</div>}
                    <a href={MAPTILER_SIGNUP_URL} target="_blank" rel="noreferrer noopener">
                      {t.keySignup}
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}
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
          <div className="menu-row">
            <span className="menu-label">{t.terrainRow}</span>
            <button
              type="button"
              className={`switch${terrainOn ? ' on' : ''}`}
              role="switch"
              aria-checked={terrainOn}
              aria-label={t.terrainRow}
              title={t.terrainTip}
              onClick={() => onTerrain(!terrainOn)}
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
              <button type="button" className={lang === 'zh' ? 'active' : ''} aria-pressed={lang === 'zh'} onClick={() => onLang('zh')}>
                中
              </button>
              <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => onLang('en')}>
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
          <div className="menu-row">
            <span className="menu-label">{t.planeRow}</span>
            <button
              type="button"
              className={`switch${planeOn ? ' on' : ''}`}
              role="switch"
              aria-checked={planeOn}
              aria-label={t.planeRow}
              title={t.planeTip}
              onClick={() => onPlane(!planeOn)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
