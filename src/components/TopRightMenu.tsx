import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BaseMode } from '../map/styleFactory';
import {
  validateMapTilerKey,
  type MapTilerKeyCheck,
} from '../map/styleFactory';
import {
  UTC_HOURS_MAX, UTC_HOURS_STEP, UTC_OFFSET_MIN, UTC_OFFSET_MAX,
  currentUtcHours, formatUtcHours, normalizeUtcHours, normalizeUtcOffset,
  parseClockInput, toLocalHours, toUtcHours, utcOffsetLabel,
} from '../map/dayNight';
import { readUtcOffset, writeUtcOffset } from '../state/saved';
import type { Lang, Strings } from '../i18n/strings';

interface Props {
  docked?: boolean;
  legacyUi?: boolean;
  onToggleUi?: () => void;
  base: BaseMode;
  onBase: (m: BaseMode) => void;
  globeOn: boolean;
  onGlobe: (v: boolean) => void;
  /** 3D 地形起伏开关（默认关） */
  terrainOn: boolean;
  onTerrain: (v: boolean) => void;
  /** 昼夜光照开关（demo cycle 语义） */
  cycleOn: boolean;
  onCycle: (v: boolean) => void;
  /** 手动 UTC 时刻（小时 0–24）；null = 跟随真实时间 */
  utcHours: number | null;
  /** 设置手动 UTC 时刻；传 null = 同步到现在并继续跟随真实时间 */
  onUtc: (hours: number | null) => void;
  onReset: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  labelsOn: boolean;
  onLabels: (v: boolean) => void;
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

/** 时区下拉的整点偏移选项（UTC−12…UTC+14） */
const UTC_OFFSET_OPTIONS = Array.from(
  { length: UTC_OFFSET_MAX - UTC_OFFSET_MIN + 1 },
  (_, i) => UTC_OFFSET_MIN + i,
);
/** 时区浮层尺寸：宽度与最大高度（27 项，超出时浮层内部滚动） */
const TZ_POP_W = 96;
const TZ_POP_MAX_H = 236;

/** 右上角唯一入口：一个按钮拉起菜单，收拢底图/3D/回正/地名/语言/深色模式全部控件 */
export function TopRightMenu({
  base, onBase, globeOn, onGlobe, terrainOn, onTerrain, cycleOn, onCycle, utcHours, onUtc, onReset, lang, onLang, labelsOn, onLabels, planeOn, onPlane, t,
  keyEditable, hasSatKey, onSatKey, docked = false, legacyUi = false, onToggleUi,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 跟随真实时间时，菜单打开期间每 30 s 刷新一次显示（太阳每 60 s 重算，显示不需要更快）
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!open || utcHours !== null) return;
    const timer = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [open, utcHours]);
  // 卫星底图不叠地球昼夜：控件禁用但保留显示值，切回矢量恢复
  const satMode = base === 'satellite';
  const effectiveUtc = utcHours ?? currentUtcHours();
  // 显示时区（设备本地偏好，默认 UTC）：只改显示与手动输入的解释口径，
  // 太阳/夜路仍由真实 UTC 时刻计算，URL 里的 utc= 也始终是 UTC
  const [utcOffset, setUtcOffset] = useState(() => normalizeUtcOffset(readUtcOffset() ?? 0));
  const displayUtc = toLocalHours(effectiveUtc, utcOffset);
  // 点时刻 → 原地换成输入框；回车/失焦提交，Esc 取消
  const [timeEditing, setTimeEditing] = useState(false);
  const [timeDraft, setTimeDraft] = useState('');
  // 点时区后缀 → 浮层下拉（整点偏移）
  const [tzOpen, setTzOpen] = useState(false);
  const [tzPos, setTzPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const tzTriggerRef = useRef<HTMLButtonElement>(null);
  const tzPopRef = useRef<HTMLDivElement>(null);
  // Esc 取消后 input 卸载仍可能触发 blur：用标记跳过那一次提交
  const skipTimeCommitRef = useRef(false);
  // 卫星 key 导入：editing=输入态（无 key 时初始即输入态）；checking=验证中；err=上次验证失败（区分无效/网络）
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyVal, setKeyVal] = useState('');
  const [keyChecking, setKeyChecking] = useState(false);
  const [keyErr, setKeyErr] = useState<Exclude<MapTilerKeyCheck, 'ok'> | null>(null);

  // 关菜单 / 切到卫星底图时收起时间输入与时区下拉，避免下次打开菜单停在编辑态
  useEffect(() => {
    if (!open || satMode) {
      setTimeEditing(false);
      setTzOpen(false);
      skipTimeCommitRef.current = false;
    }
  }, [open, satMode]);

  const beginTimeEdit = () => {
    skipTimeCommitRef.current = false;
    setTimeDraft(formatUtcHours(displayUtc));
    setTzOpen(false);
    setTimeEditing(true);
  };

  const commitTime = () => {
    if (!timeEditing) return;
    setTimeEditing(false);
    if (skipTimeCommitRef.current) {
      skipTimeCommitRef.current = false;
      return;
    }
    const typed = parseClockInput(timeDraft);
    if (typed === null) return; // 无效输入：静默保持原值
    onUtc(toUtcHours(typed, utcOffset));
  };

  const cancelTimeEdit = () => {
    skipTimeCommitRef.current = true;
    setTimeEditing(false);
  };

  const changeTz = (offset: number) => {
    const next = normalizeUtcOffset(offset);
    setUtcOffset(next);
    writeUtcOffset(next);
    setTzOpen(false);
  };

  // 时区浮层：portal 到 body + fixed 定位。菜单面板是 overflow-y:auto，
  // 子浮层会被裁切/被面板滚动带走（同 DepartPicker 的教训）
  const positionTz = () => {
    const el = tzTriggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    const openUp = below < 160 && above > below;
    const maxHeight = Math.min(TZ_POP_MAX_H, Math.max(96, openUp ? above : below));
    const top = openUp ? Math.max(8, r.top - maxHeight - 6) : r.bottom + 6;
    setTzPos({ top, right, maxHeight });
  };

  const openTz = () => {
    positionTz(); // 与 setTzOpen 同批提交，浮层首帧就在正确位置
    setTzOpen(true);
  };

  // 浮层打开时聚焦当前选中项，并让它在浮层内可见
  useLayoutEffect(() => {
    if (!tzOpen) return;
    const sel = tzPopRef.current?.querySelector<HTMLButtonElement>('.menu-tz-opt.on');
    if (!sel) return;
    sel.focus({ preventScroll: true });
    // 居中显示当前选中项：上下都能看到邻近时区，首帧不是"贴着列表底部"
    sel.scrollIntoView({ block: 'center' });
  }, [tzOpen]);

  // 滚动（含菜单面板内滚动）/窗口缩放时跟随重定位
  useEffect(() => {
    if (!tzOpen) return;
    const onMove = () => positionTz();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [tzOpen]);

  // 浮层内键盘：Esc 只关浮层（不连带关整个菜单），上下键移动选项，回车/空格选定
  const onTzKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setTzOpen(false);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const el = document.activeElement as HTMLButtonElement | null;
      if (el?.dataset.tz != null) {
        e.preventDefault();
        e.stopPropagation();
        changeTz(Number(el.dataset.tz));
      }
      return;
    }
    const nav = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!nav && e.key !== 'Home' && e.key !== 'End') return;
    const opts = Array.from(tzPopRef.current?.querySelectorAll<HTMLButtonElement>('.menu-tz-opt') ?? []);
    if (!opts.length) return;
    e.preventDefault();
    const cur = opts.indexOf(document.activeElement as HTMLButtonElement);
    const idx =
      e.key === 'Home' ? 0
        : e.key === 'End' ? opts.length - 1
          : Math.min(opts.length - 1, Math.max(0, cur + nav));
    opts[idx].focus();
  };

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!open || docked) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      // 时区浮层 portal 到 body，不在 rootRef 内：点它不能连带关掉菜单
      if (tzPopRef.current?.contains(target)) return;
      setOpen(false);
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
    <div className={`map-menu${docked ? ' pro-docked-settings' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`menu-btn${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup={docked ? undefined : 'menu'}
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
        {docked && <><span>{t.menu}</span><span className="pro-settings-chevron" aria-hidden="true">{open ? '−' : '+'}</span></>}
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
          <div className="menu-row">
            <span className="menu-label">{t.dayNightRow}</span>
            <button
              type="button"
              className={`switch${cycleOn ? ' on' : ''}`}
              role="switch"
              aria-checked={cycleOn}
              aria-label={t.dayNightRow}
              title={t.dayNightTip}
              disabled={satMode}
              onClick={() => onCycle(!cycleOn)}
            />
          </div>
          <div className="menu-time">
            <div className="menu-time-head">
              <span className="menu-label">{t.utcRow}</span>
              {timeEditing ? (
                <span className="menu-time-editing">
                  <input
                    className="menu-time-input"
                    type="text"
                    inputMode="numeric"
                    maxLength={5}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={t.utcTimeInputLabel}
                    title={t.utcTimeInputLabel}
                    value={timeDraft}
                    onChange={(e) => setTimeDraft(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={commitTime}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur(); // 与失焦走同一条提交路径
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation(); // 只退出输入态，不关整个菜单
                        cancelTimeEdit();
                      }
                    }}
                  />
                  <span className="menu-time-tz">{utcOffsetLabel(utcOffset)}</span>
                </span>
              ) : (
                <output className="menu-time-value">
                  <button
                    type="button"
                    className="menu-time-clock"
                    title={t.utcEditTip}
                    aria-label={`${formatUtcHours(displayUtc)} — ${t.utcEditTip}`}
                    disabled={satMode}
                    onClick={beginTimeEdit}
                  >
                    {formatUtcHours(displayUtc)}
                  </button>{' '}
                  <button
                    ref={tzTriggerRef}
                    type="button"
                    className="menu-time-tz"
                    title={t.utcTzTip}
                    aria-label={`${utcOffsetLabel(utcOffset)} — ${t.utcTzTip}`}
                    aria-haspopup="listbox"
                    aria-expanded={tzOpen}
                    disabled={satMode}
                    onClick={() => (tzOpen ? setTzOpen(false) : openTz())}
                  >
                    {utcOffsetLabel(utcOffset)}
                  </button>
                </output>
              )}
              <button
                type="button"
                className="menu-time-now"
                title={t.utcSyncTip}
                aria-label={t.utcSyncNow}
                disabled={satMode || utcHours === null}
                onClick={() => onUtc(null)}
              >
                {/* lucide rotate-cw（与「回正」同款箭头方向） */}
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
                  <path
                    d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M21 3v5h-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={UTC_HOURS_MAX}
              step={UTC_HOURS_STEP}
              value={effectiveUtc}
              aria-label={t.utcSliderLabel}
              aria-valuetext={`${formatUtcHours(displayUtc)} ${utcOffsetLabel(utcOffset)}`}
              disabled={satMode || !cycleOn}
              onChange={(e) => {
                const next = normalizeUtcHours(Number(e.target.value));
                if (next !== null) onUtc(next);
              }}
            />
            <div className="menu-time-hint">
              {satMode ? t.utcVectorOnly : !cycleOn ? t.utcOffHint : utcHours === null ? t.utcFollow : t.utcManual}
            </div>
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
          {onToggleUi && <div className="menu-ui-switch"><button type="button" className="sb-mini" onClick={() => { setOpen(false); onToggleUi(); }}>{lang === 'zh' ? (legacyUi ? '切换到 Pro UI' : '切换回原 UI') : (legacyUi ? 'Switch to Pro UI' : 'Switch to original UI')}</button></div>}
        </div>
      )}
      {open && tzOpen && tzPos &&
        createPortal(
          <div
            ref={tzPopRef}
            className="card menu-tz-pop"
            role="listbox"
            aria-label={t.utcTzLabel}
            style={{ top: tzPos.top, right: tzPos.right, width: TZ_POP_W, maxHeight: tzPos.maxHeight }}
            onKeyDown={onTzKeyDown}
          >
            {UTC_OFFSET_OPTIONS.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                data-tz={o}
                aria-selected={o === utcOffset}
                tabIndex={o === utcOffset ? 0 : -1}
                className={`menu-tz-opt${o === utcOffset ? ' on' : ''}`}
                onClick={() => changeTz(o)}
              >
                {utcOffsetLabel(o)}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
