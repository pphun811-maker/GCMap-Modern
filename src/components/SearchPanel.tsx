import { useEffect, useMemo, useRef, useState } from 'react';
import { findByCode, searchAirports, type Airport } from '../data/search';
import type { Strings } from '../i18n/strings';

const SEG_SPLIT = /[-—>→,，;；]+/;
// raw 模式里航线之间的分隔：半角逗号（全角/分号/换行也宽容接受）
const RAW_SPLIT = /[\n,，;；]+/;

/** SimBrief 真实航路导入的 UI 接线（状态与逻辑都在 App） */
export interface SbfProps {
  ask: boolean;
  /** 等待导入中：值为目标航线代码（如 "LHR → SIN"），null = 非等待态 */
  waitingCodes: string | null;
  msg: string | null;
  msgError: boolean;
  onOpen: () => void;
  onConfirmUser: (name: string) => void;
  onCancel: () => void;
  onImportNow: () => void;
}

interface Props {
  /** 当前选中航线（chips 展示与经停编辑的对象） */
  selected: Airport[];
  /** 标签 ≥2 且输入为空时回车 → 创建一条航线 */
  onAdd: (airports: Airport[]) => void;
  /** raw 模式：一次创建多条航线 */
  onAddMany: (groups: Airport[][]) => void;
  /** 选中航线的经停编辑（删除经停 / 反向） */
  onUpdateSelected: (airports: Airport[]) => void;
  sbf: SbfProps;
  t: Strings;
}

export function SearchPanel({ selected, onAdd, onAddMany, onUpdateSelected, sbf, t }: Props) {
  const [rawMode, setRawMode] = useState(false);
  const [tags, setTags] = useState<Airport[]>([]);
  const [text, setText] = useState('');
  const [raw, setRaw] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [sbName, setSbName] = useState('');
  const sbInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);

  const segments = useMemo(
    () => text.split(SEG_SPLIT).map((s) => s.trim()).filter(Boolean),
    [text],
  );
  const lastSegment = segments[segments.length - 1] ?? '';
  const suggestions = useMemo(
    () => (!rawMode && lastSegment.length >= 2 && open ? searchAirports(lastSegment, 7) : []),
    [rawMode, lastSegment, open],
  );

  useEffect(() => {
    if (rawMode) rawRef.current?.focus();
    else inputRef.current?.focus();
  }, [rawMode]);

  useEffect(() => {
    if (sbf.ask) sbInputRef.current?.focus();
  }, [sbf.ask]);

  const confirmSbfUser = () => {
    sbf.onConfirmUser(sbName.trim());
    setSbName('');
  };

  const resolveSegment = (seg: string): Airport | undefined =>
    findByCode(seg) ?? searchAirports(seg, 1)[0];

  /** 全部段落可解析时返回去重后的机场列表；否则写入第一个失败段的错误并返回 null */
  const resolveAll = (segs: string[]): Airport[] | null => {
    const out: Airport[] = [];
    for (const seg of segs) {
      const a = resolveSegment(seg);
      if (!a) {
        setError(t.notFound(seg));
        return null;
      }
      const key = a.iata || a.icao;
      if (!out.some((r) => (r.iata || r.icao) === key)) out.push(a);
    }
    return out;
  };

  /** 并入标签（输入内去重），清空输入、保持焦点，便于连续录入 */
  const pushTags = (added: Airport[]) => {
    setTags((prev) => {
      const next = [...prev];
      for (const a of added) {
        const key = a.iata || a.icao;
        if (!next.some((x) => (x.iata || x.icao) === key)) next.push(a);
      }
      return next;
    });
    setError(null);
    setText('');
    setActive(0);
    inputRef.current?.focus();
  };

  /** 标签模式回车（输入非空）：整段可解析则全部入标签，否则末段按高亮建议补全 */
  const commitText = () => {
    const liveText = inputRef.current?.value ?? text;
    const segs = liveText.split(SEG_SPLIT).map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return;
    const all = resolveAll(segs);
    if (all) {
      pushTags(all);
      return;
    }
    // 补全路径：前几段 + 高亮建议可整体解析才接受，避免静默丢字
    const picked = suggestions[active];
    if (picked) {
      const head = resolveAll(segs.slice(0, -1));
      if (head) {
        pushTags([...head, picked]);
        return;
      }
    }
    // 错误已由 resolveAll 写入（整段失败或前段失败，均为首个失败段）
  };

  /** 标签 ≥2 且输入为空时回车 → 创建航线并清空标签 */
  const createRoute = () => {
    onAdd(tags);
    setTags([]);
    setError(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 用输入框实时值解析，避免 Enter 时 React 状态尚未提交的竞态
    const liveText = inputRef.current?.value ?? text;
    if (e.key === 'Enter') {
      if (liveText.trim()) {
        commitText();
      } else if (tags.length >= 2) {
        createRoute();
      } else if (tags.length === 1) {
        setError(t.needTwo);
      }
    } else if (e.key === 'Backspace') {
      if (!liveText && tags.length) {
        e.preventDefault();
        setTags(tags.slice(0, -1));
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  /** 点选建议 = 回车补全的鼠标版：前段 + 建议整体可解析才入标签 */
  const pickSuggestion = (a: Airport) => {
    const segs = [...segments];
    segs[segs.length - 1] = a.iata || a.icao;
    const all = resolveAll(segs);
    if (all) pushTags(all);
  };

  const insertRawNewline = () => {
    const el = rawRef.current;
    if (!el) return;
    const start = el.selectionStart ?? raw.length;
    const end = el.selectionEnd ?? raw.length;
    setRaw(raw.slice(0, start) + '\n' + raw.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
  };

  /** raw 模式回车：按 RAW_SPLIT 拆多条航线，全部合法才一次创建（否则保留文本供修改） */
  const commitRaw = () => {
    const live = rawRef.current?.value ?? raw;
    const groups: Airport[][] = [];
    for (const part of live.split(RAW_SPLIT)) {
      const segs = part.split(SEG_SPLIT).map((s) => s.trim()).filter(Boolean);
      if (!segs.length) continue;
      const resolved = resolveAll(segs);
      if (!resolved) return;
      if (resolved.length < 2) {
        setError(t.needTwo);
        return;
      }
      groups.push(resolved);
    }
    if (!groups.length) return;
    setError(null);
    setRaw('');
    onAddMany(groups);
  };

  const rawKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) insertRawNewline();
      else commitRaw();
    }
  };

  const switchMode = () => {
    setRawMode((m) => !m);
    setError(null);
    setOpen(false);
  };

  const removeStop = (idx: number) => {
    onUpdateSelected(selected.filter((_, i) => i !== idx));
  };

  const swap = () => {
    onUpdateSelected([...selected].reverse());
  };

  return (
    <div className="card search-card">
      <div className="search-row">
        {!rawMode && (
          <svg className="search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="#8A8A86" strokeWidth="1.8" />
            <line x1="13" y1="13" x2="17" y2="17" stroke="#8A8A86" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
        {rawMode ? (
          <textarea
            ref={rawRef}
            className="raw-input"
            value={raw}
            spellCheck={false}
            placeholder={t.rawPlaceholder}
            onChange={(e) => { setRaw(e.target.value); setError(null); }}
            onKeyDown={rawKeyDown}
          />
        ) : (
          <div
            className="tag-field"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                e.preventDefault();
                inputRef.current?.focus();
              }
            }}
          >
            {tags.map((a, i) => (
              <span className="input-tag" key={`${a.iata || a.icao}-${i}`}>
                <b>{a.iata || a.icao}</b>
                <button
                  type="button"
                  className="input-tag-x"
                  aria-label="remove"
                  onClick={() => setTags(tags.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              className="tag-field-input"
              value={text}
              spellCheck={false}
              placeholder={tags.length ? '' : t.searchPlaceholder}
              onChange={(e) => { setText(e.target.value); setError(null); setOpen(true); setActive(0); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
        <button
          type="button"
          className={`raw-toggle${rawMode ? ' active' : ''}`}
          title={t.rawTitle}
          aria-pressed={rawMode}
          onClick={switchMode}
        >
          {t.rawToggle}
        </button>
        {!rawMode && selected.length > 0 && (
          <button className="chip-btn" title={t.swap} onClick={swap}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
              <path d="M5 7h9M12 4l3 3-3 3M15 13H6M8 10l-3 3 3 3" fill="none" stroke="#5B5B57" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!rawMode && selected.length >= 2 && (
          <button
            className="chip-btn sb-btn"
            title={t.simbriefTitle}
            aria-label={t.simbriefTitle}
            disabled={sbf.waitingCodes !== null}
            onClick={sbf.onOpen}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
              <path
                d="M18 2 8.5 11.5M18 2l-6.2 16-3.3-6.5L2 8.2z"
                fill="none"
                stroke="#5B5B57"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((a, i) => (
            <div
              key={`${a.iata}-${a.name}`}
              className={`sug-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickSuggestion(a); }}
            >
              <span className="sug-code">{a.iata || a.icao}</span>
              <span className="sug-name">{a.name}</span>
              <span className="sug-city">{a.city}{a.country ? `, ${a.country}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {selected.length > 0 && (
        <div className="chips">
          {selected.map((a, i) => (
            <span className="chip" key={`${a.iata}-${i}`}>
              <b>{a.iata || a.icao}</b>
              {i < selected.length - 1 && <span className="chip-arrow">→</span>}
              <button className="chip-x" onClick={() => removeStop(i)} aria-label="remove">×</button>
            </span>
          ))}
        </div>
      )}

      {sbf.ask && (
        <div className="sb-row">
          <input
            ref={sbInputRef}
            className="sb-input"
            value={sbName}
            spellCheck={false}
            placeholder={t.sbfAskLabel}
            onChange={(e) => setSbName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmSbfUser();
              else if (e.key === 'Escape') sbf.onCancel();
            }}
          />
          <button className="sb-go" onClick={confirmSbfUser}>
            {t.sbfOpen}
          </button>
          <button className="sb-mini" onClick={sbf.onCancel}>
            {t.sbfCancel}
          </button>
        </div>
      )}

      {sbf.waitingCodes !== null && (
        <div className="sb-status">
          <b className="sb-status-codes">{sbf.waitingCodes}</b>
          <span>{t.sbfWaiting}</span>
          <div className="sb-status-actions">
            <button className="sb-go" onClick={sbf.onImportNow}>
              {t.sbfImportNow}
            </button>
            <button className="sb-mini" onClick={sbf.onCancel}>
              {t.sbfCancel}
            </button>
          </div>
        </div>
      )}

      {error && <div className="search-error">{error}</div>}
      {!error && (
        <div className="search-hint">
          {rawMode ? t.rawHint : selected.length ? t.commitHint : t.searchHint}
        </div>
      )}
      {sbf.msg && <div className={sbf.msgError ? 'search-error' : 'sb-msg'}>{sbf.msg}</div>}
    </div>
  );
}
