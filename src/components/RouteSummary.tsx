import type { LegInfo, RouteEntry } from '../map/MapController';
import {
  compassPoint, convertDistance, haversineKm, KM_PER_NM, type Units,
} from '../geo/greatCircle';
import {
  ASSUMED_CRUISE_KMH, convertSpeed, estimateLegMinutes, SPEED_UNIT_LABEL,
} from '../geo/flightTime';
import type { Strings } from '../i18n/strings';

const UNIT_LABEL: Record<Units, string> = { km: 'km', mi: 'mi', nm: 'nm' };

interface Props {
  legs: LegInfo[];
  /** 当前选中的航线（存在 waypoints 时显示真实航路备注） */
  route: RouteEntry | null;
  units: Units;
  onUnits: (u: Units) => void;
  t: Strings;
}

export function RouteSummary({ legs, route, units, onUnits, t }: Props) {
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

  // 飞行时间：SimBrief 计划元数据优先（OFP 真实数据，已含风）；否则按距离估算
  const ofp = route?.ofp ?? null;
  const totalMin = ofp ? ofp.timeMin : legs.reduce((s, l) => s + estimateLegMinutes(l.km), 0);
  const speedStr = (kmh: number) =>
    `${Math.round(convertSpeed(kmh, units)).toLocaleString('en-US')} ${SPEED_UNIT_LABEL[units]}`;
  let timeNote: string;
  if (ofp) {
    const speedBits = [ofp.mach, ofp.tasKts != null ? speedStr(ofp.tasKts * KM_PER_NM) : null]
      .filter(Boolean)
      .join(' · ');
    timeNote = speedBits ? `${t.cruise} ${speedBits} · SimBrief` : 'SimBrief';
  } else {
    timeNote = `${t.assumedCruise} ${speedStr(ASSUMED_CRUISE_KMH)} · ${t.noWind}`;
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
    </div>
  );
}
