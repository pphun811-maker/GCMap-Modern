import { useEffect, useMemo, useState } from 'react';
import type { LegInfo, RouteEntry } from '../map/MapController';
import {
  compassPoint, convertDistance, haversineKm, KM_PER_NM, type Units,
} from '../geo/greatCircle';
import {
  estimateLegMinutes, NARROWBODY_CRUISE, TYPE_THRESHOLD_KM, WIDEBODY_CRUISE,
} from '../geo/flightTime';
import {
  computeTimeline, dayDelta, initTzLookup, localTime, nowInZone, tzAt, tzLookupReady, zonedToUtc,
} from '../geo/flightTimeline';
import type { Strings } from '../i18n/strings';

const UNIT_LABEL: Record<Units, string> = { km: 'km', mi: 'mi', nm: 'nm' };

/** "+1d" 形式的跨天标记（同日返回空串） */
const dayTag = (d: number | null) => (d != null && d > 0 ? ` +${d}d` : '');

/** 马赫显示归一为 "M0.84"（OFP 原值形如 "M.84"） */
const fmtMach = (raw: string) => {
  const v = raw.startsWith('M') ? raw.slice(1) : raw;
  return `M${v.startsWith('.') ? `0${v}` : v}`;
};

/** 巡航速度三单位（km/h + kt 与马赫互相自洽；与界面单位制无关，恒定同显） */
const speedTrio = (mach: string, kmh: number) =>
  `${mach} · ${Math.round(kmh).toLocaleString('en-US')} km/h · ${Math.round(kmh / KM_PER_NM)} kt`;

interface Props {
  legs: LegInfo[];
  /** 当前选中的航线（存在 waypoints 时显示真实航路备注） */
  route: RouteEntry | null;
  units: Units;
  onUnits: (u: Units) => void;
  t: Strings;
}

export function RouteSummary({ legs, route, units, onUnits, t }: Props) {
  // ---- 时区到达时间线（路线③）：tz 查询懒加载 + 出发时刻（出发地当地墙钟，语义见 zonedToUtc） ----
  const [tzReady, setTzReady] = useState(tzLookupReady());
  const [departInput, setDepartInput] = useState<string | null>(null);
  useEffect(() => {
    if (tzReady) return;
    void initTzLookup()
      .then(() => setTzReady(true))
      .catch(() => {
        /* tz chunk 加载失败：时间线整体隐藏，不影响其它功能 */
      });
  }, [tzReady]);

  const stopsAirports = route?.airports ?? [];
  const originTz = tzReady && stopsAirports.length >= 2 ? tzAt(stopsAirports[0].lat, stopsAirports[0].lon) : null;
  // 未手动输入时跟随"现在"（出发地当地墙钟）；手动输入后固定，直到点"现在"复位
  const departValue = departInput ?? (originTz ? nowInZone(originTz) : '');
  const departAt = useMemo(
    () => (departValue && originTz ? zonedToUtc(departValue, originTz) : null),
    [departValue, originTz],
  );

  const timeline = useMemo(() => {
    if (!route || !departAt || Number.isNaN(departAt.getTime())) return null;
    if (!route.airports.every((a) => tzAt(a.lat, a.lon))) return null;
    // SimBrief 航线用 OFP 真实空中时间（单段），否则按段距离分档估算
    const legMin =
      route.ofp && legs.length === 1 ? [route.ofp.timeMin] : legs.map((l) => estimateLegMinutes(l.km));
    const stops = computeTimeline(
      route.airports.map((a) => a.iata || a.icao),
      legMin,
      departAt,
    );
    const baseTz = tzAt(route.airports[0].lat, route.airports[0].lon);
    const base = baseTz ? localTime(departAt, baseTz) : null;
    if (!base) return null;
    return stops.map((s, i) => {
      const tz = tzAt(route.airports[i].lat, route.airports[i].lon);
      const arr = s.arrival && tz ? localTime(s.arrival, tz) : null;
      const dep = s.departure && tz ? localTime(s.departure, tz) : null;
      return {
        code: s.code,
        name: route.airports[i].name,
        arr,
        dep,
        arrDay: arr ? dayDelta(base.ymd, arr.ymd) : null,
        depDay: dep ? dayDelta(base.ymd, dep.ymd) : null,
      };
    });
  }, [route, legs, departAt]);

  if (legs.length === 0) return null;
  const totalKm = legs.reduce((s, l) => s + l.km, 0);
  const fmt = (km: number) =>
    Math.round(convertDistance(km, units)).toLocaleString('en-US');

  const wpts = route?.waypoints;
  let note: string | null = null;
  if (wpts && wpts.length >= 2 && route && route.airports.length >= 2) {
    const gcKm = haversineKm(route.airports[0], route.airports[route.airports.length - 1]);
    const pct = gcKm > 0 ? Math.round(((totalKm - gcKm) / gcKm) * 100) : 0;
    note = `${t.realRouteNote(wpts.length)} · +${pct}% ${t.vsDirect}`;
  }

  // 飞行时间：SimBrief 计划元数据优先（OFP 真实数据，已含风）；否则按距离估算（分段选窄体/宽体巡航假设）
  const ofp = route?.ofp ?? null;
  const totalMin = ofp ? ofp.timeMin : legs.reduce((s, l) => s + estimateLegMinutes(l.km), 0);
  let timeNote: string;
  if (ofp) {
    const bits: string[] = [];
    if (ofp.mach) bits.push(fmtMach(ofp.mach));
    if (ofp.tasKts != null) {
      bits.push(
        `${Math.round(ofp.tasKts * KM_PER_NM).toLocaleString('en-US')} km/h · ${Math.round(ofp.tasKts)} kt`,
      );
    }
    timeNote = bits.length ? `${t.cruise} ${bits.join(' · ')} · SimBrief` : 'SimBrief';
  } else {
    // 估算：全部航段同一档时只列该档假设；跨档时窄体/宽体各列一档（时间按段各自套用）
    const hasNarrow = legs.some((l) => l.km < TYPE_THRESHOLD_KM);
    const hasWide = legs.some((l) => l.km >= TYPE_THRESHOLD_KM);
    const entries: string[] = [];
    if (hasNarrow) {
      const c = NARROWBODY_CRUISE;
      entries.push(
        `${hasWide ? `${t.narrowbody} ` : ''}${speedTrio(`M${c.mach.toFixed(2)}`, c.kmh)}`,
      );
    }
    if (hasWide) {
      const c = WIDEBODY_CRUISE;
      entries.push(
        `${hasNarrow ? `${t.widebody} ` : ''}${speedTrio(`M${c.mach.toFixed(2)}`, c.kmh)}`,
      );
    }
    timeNote = `${t.assumedCruise} ${entries.join(' / ')}`;
  }

  return (
    <div className="card summary-card">
      <div className="summary-head">
        <span className="summary-title">
          {legs.length > 1 ? t.stops(legs.length) : t.direct}
        </span>
        <div className="seg seg-small">
          {(['km', 'mi', 'nm'] as Units[]).map((u) => (
            <button key={u} type="button" className={u === units ? 'active' : ''} aria-pressed={u === units} onClick={() => onUnits(u)}>
              {UNIT_LABEL[u]}
            </button>
          ))}
        </div>
      </div>
      {note && <div className="real-note">{note}</div>}
      {legs.map((l, i) => (
        <div className="leg-row" key={i}>
          <span className="leg-codes">
            {l.from.iata || l.from.icao} → {l.to.iata || l.to.icao}
          </span>
          <span className="leg-bearing">
            {t.bearing} {Math.round(l.bearing)}° {compassPoint(l.bearing)}
          </span>
          <span className="leg-dist">{fmt(l.km)} {UNIT_LABEL[units]}</span>
        </div>
      ))}
      {legs.length > 1 && (
        <div className="leg-row total">
          <span className="leg-codes">{t.total}</span>
          <span className="leg-dist">{fmt(totalKm)} {UNIT_LABEL[units]}</span>
        </div>
      )}
      <div className="time-row">
        <span className="time-main">
          {t.flightTime} {ofp ? '' : '≈ '}{t.duration(totalMin)}
        </span>
        <span className="time-note">{timeNote}</span>
      </div>
      {timeline && (
        <div className="time-line">
          <div className="tl-head">
            <label className="tl-label" htmlFor="depart-at">{t.departAt}</label>
            <input
              id="depart-at"
              type="datetime-local"
              className="tl-input"
              value={departValue}
              onChange={(e) => setDepartInput(e.target.value)}
            />
            <button
              type="button"
              className="tl-now"
              onClick={() => originTz && setDepartInput(nowInZone(originTz))}
            >
              {t.now}
            </button>
          </div>
          {timeline.map((s, i) => (
            <div className="tl-row" key={`${s.code}-${i}`}>
              <b className="tl-code">{s.code}</b>
              <span className="tl-city">{s.name}</span>
              <span className="tl-times">
                {s.arr && (
                  <span>
                    {s.arr.time}
                    <span className="tl-day">{dayTag(s.arrDay)}</span> {t.arr}
                  </span>
                )}
                {s.arr && s.dep && <span className="tl-sep">·</span>}
                {s.dep && (
                  <span>
                    {s.dep.time}
                    <span className="tl-day">{dayTag(s.depDay)}</span> {t.dep}
                  </span>
                )}
              </span>
            </div>
          ))}
          <span className="tl-note">{legs.length > 1 ? t.localNoteMulti : t.localNoteSingle}</span>
        </div>
      )}
    </div>
  );
}
