import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { calendarCells, type CalendarCell } from '../geo/flightTimeline';
import type { Lang, Strings } from '../i18n/strings';

// 自定义出发时刻选择器（2026-10-16 收尾美化）：浏览器原生日历弹窗是封闭 Shadow DOM
// 无法主题化，这里自绘 —— 玻璃材质 / Inter / 项目蓝色高亮。弹层必须 createPortal 到
// body + fixed：summary 卡在 .panel-lower 滚动容器里、.card 的 backdrop-filter 还会把
// fixed 后代的包含块改到卡片上——不 portal 会被裁剪到完全不可见（同下拉建议的教训）。

interface Props {
  /** "YYYY-MM-DDTHH:mm"（出发地当地墙钟） */
  value: string;
  onChange: (v: string) => void;
  /** 今天标记用（出发地当地日历日） */
  todayYmd: string;
  lang: Lang;
  t: Strings;
}

const WEEK_START: Record<Lang, 0 | 1> = { zh: 1, en: 0 };
const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en-GB' };
const POPOVER_W = 296;
const POPOVER_H = 348;

const pad2 = (n: number) => String(n).padStart(2, '0');

function splitValue(v: string): { ymd: string; hour: number; minute: number } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return { ymd: '', hour: 0, minute: 0 };
  return { ymd: m[1], hour: Number(m[2]), minute: Number(m[3]) };
}

/** 分钟选项 0/5/…/55；当前值不在 5 分格上时补进去（显示不撒谎） */
function minuteOptions(current: number): number[] {
  const opts = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!opts.includes(current)) {
    opts.push(current);
    opts.sort((a, b) => a - b);
  }
  return opts;
}

export function DepartPicker({ value, onChange, todayYmd, lang, t }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const cur = splitValue(value);
  // 同一轮里连点日期+时间的处理器要拿到"刚写入"的值：prop 在本轮渲染内是旧的，
  // 用 ref 即时同步（React 批处理下 props 要到下一轮渲染才更新）
  const valueRef = useRef(value);
  valueRef.current = value;
  // 弹层内独立维护"正在浏览的年月"：翻页不改选中值
  const [view, setView] = useState<{ y: number; m: number }>(() => ({
    y: cur.ymd ? Number(cur.ymd.slice(0, 4)) : new Date().getFullYear(),
    m: cur.ymd ? Number(cur.ymd.slice(5, 7)) : new Date().getMonth() + 1,
  }));

  const cells = useMemo(() => calendarCells(view.y, view.m, WEEK_START[lang]), [view, lang]);
  const weekdayLabels = useMemo(() => {
    // 取 2026-10-04（周日）起的一周做标签，按 weekStart 排序
    const fmt = new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short' });
    const labels = Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2026, 9, 4 + i))),
    );
    return WEEK_START[lang] === 1 ? [...labels.slice(1), labels[0]] : labels;
  }, [lang]);

  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(LOCALE[lang], { year: 'numeric', month: 'long' }).format(new Date(Date.UTC(view.y, view.m - 1, 1))),
    [view, lang],
  );

  const setValue = (ymd: string, hour: number, minute: number) => {
    const v = `${ymd}T${pad2(hour)}:${pad2(minute)}`;
    valueRef.current = v; // 同轮后续处理器（先选日期再选时间）立刻可见
    onChange(v);
  };
  // 所有处理器从 ref 现读当前值：同轮内"选日期→选时间"时 prop 还是旧的
  const curNow = () => splitValue(valueRef.current);

  const reposition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W - 8));
    const below = r.bottom + 8;
    const top = below + POPOVER_H > window.innerHeight - 8 ? Math.max(8, r.top - POPOVER_H - 8) : below;
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      // 弹层 portal 在 body，不在 rootRef 内——单独包含判定
      if (popRef.current?.contains(target)) return;
      // 点触发钮由其 onClick 翻转处理
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMove = () => reposition();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true); // 面板内滚动也要跟随
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const nav = (delta: number) =>
    setView((v) => {
      const m0 = v.m - 1 + delta;
      return { y: v.y + Math.floor(m0 / 12), m: ((m0 % 12) + 12) % 12 + 1 };
    });

  const minutes = minuteOptions(cur.minute);

  return (
    <div className="dp-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="tl-input dp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{value ? value.replace('T', ' ') : '—'}</span>
        <svg className="dp-icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden>
          <rect x="3" y="4.5" width="14" height="12.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.6" />
          <line x1="7" y1="2.8" x2="7" y2="5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="13" y1="2.8" x2="13" y2="5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="dp-pop card" role="dialog" aria-label={t.departAt} ref={popRef} style={{ top: pos.top, left: pos.left }}>
          <div className="dp-head">
            <button type="button" className="dp-nav" aria-label="‹" onClick={() => nav(-1)}>
              <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden>
                <path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="dp-month">{monthTitle}</span>
            <button type="button" className="dp-nav" aria-label="›" onClick={() => nav(1)}>
              <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden>
                <path d="M7.5 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="dp-week">
            {weekdayLabels.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="dp-grid">
            {cells.map((c: CalendarCell) => (
              <button
                key={c.ymd}
                type="button"
                className={`dp-day${c.ymd === cur.ymd ? ' selected' : ''}${c.ymd === todayYmd ? ' today' : ''}${c.inMonth ? '' : ' out'}`}
                onClick={() => {
                  const c0 = curNow();
                  setValue(c.ymd, c0.hour, c0.minute);
                }}
              >
                {c.day}
              </button>
            ))}
          </div>
          <div className="dp-time">
            <select
              className="tl-input dp-select"
              aria-label="HH"
              value={cur.hour}
              onChange={(e) => {
                const c0 = curNow();
                setValue(c0.ymd, Number(e.target.value), c0.minute);
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{pad2(h)}</option>
              ))}
            </select>
            <span className="dp-colon">:</span>
            <select
              className="tl-input dp-select"
              aria-label="mm"
              value={cur.minute}
              onChange={(e) => {
                const c0 = curNow();
                setValue(c0.ymd, c0.hour, Number(e.target.value));
              }}
            >
              {minutes.map((m) => (
                <option key={m} value={m}>{pad2(m)}</option>
              ))}
            </select>
          </div>
        </div>,
          document.body,
        )}
      </div>
  );
}
