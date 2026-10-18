import { useState } from 'react';
import { sumJournalKm, type JournalData } from '../state/saved';
import type { Strings } from '../i18n/strings';

interface Props {
  journal: JournalData;
  onRemoveEntry: (id: string) => void;
  onClear: () => void;
  t: Strings;
}

/** 折叠日期 "10/18"（本地时区，仅展示用） */
const fmtDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });

/** 左侧面板的飞行足迹卡：默认折叠为一行统计，展开看逐条记录（去过的机场在 Pin 信息卡标记） */
export function JournalCard({ journal, onRemoveEntry, onClear, t }: Props) {
  const [open, setOpen] = useState(false);
  const totalKm = sumJournalKm(journal.entries);
  // 折叠行统计：有记录显示完整统计；只有足迹标记时显示机场数；全空显示占位
  const summary = journal.entries.length
    ? t.journalStats(journal.entries.length, totalKm, journal.visited.length)
    : journal.visited.length
      ? t.visitedCount(journal.visited.length)
      : t.journalEmpty;
  return (
    <div className="card journal-card">
      <button
        type="button"
        className="journal-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="journal-title">{t.journalTitle}</span>
        <span className="journal-summary">{summary}</span>
        <svg
          className={`journal-chev${open ? ' open' : ''}`}
          viewBox="0 0 20 20"
          width="12"
          height="12"
          aria-hidden
        >
          <path
            d="M6 8l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="journal-body">
          {journal.entries.length ? (
            <>
              <div className="journal-rows">
                {journal.entries.map((e) => (
                  <div className="journal-row" key={e.id}>
                    <b className="journal-codes">{e.codes}</b>
                    <span className="journal-km">
                      {Math.round(e.km).toLocaleString('en-US')} km
                    </span>
                    <span className="journal-date">{fmtDate(e.at)}</span>
                    <button
                      type="button"
                      className="journal-x"
                      title={t.deleteRoute}
                      aria-label={`${t.deleteRoute} ${e.codes}`}
                      onClick={() => onRemoveEntry(e.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="journal-foot">
                <span>{t.visitedCount(journal.visited.length)}</span>
                <button type="button" className="journal-clear" onClick={onClear}>
                  {t.journalClear}
                </button>
              </div>
            </>
          ) : (
            <div className="journal-hint">{t.journalHint}</div>
          )}
        </div>
      )}
    </div>
  );
}
