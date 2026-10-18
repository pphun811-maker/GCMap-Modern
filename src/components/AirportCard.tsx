import type { Airport } from '../data/search';
import type { Strings } from '../i18n/strings';

interface Props {
  airport: Airport;
  /** Pin 的屏幕坐标（相对地图容器，MapController 计算并已做水平夹紧） */
  x: number;
  y: number;
  visited: boolean;
  onToggleVisited: () => void;
  onClose: () => void;
  t: Strings;
}

/** 机场 Pin 信息卡：代码/名称/城市/标高/坐标 + 足迹标记。
 *  定位在 Pin 上方（靠上时翻转到下方），不跟随地图移动 —— 地图一动即关闭（App 订阅 move） */
export function AirportCard({ airport, x, y, visited, onToggleVisited, onClose, t }: Props) {
  const code = airport.iata || airport.icao;
  const flip = y < 200;
  const place = [airport.city, airport.country].filter(Boolean).join(', ');
  const elevFt = airport.elev;
  const fmtN = (n: number) => n.toLocaleString('en-US');
  const lat = `${Math.abs(airport.lat).toFixed(4)}° ${airport.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(airport.lon).toFixed(4)}° ${airport.lon >= 0 ? 'E' : 'W'}`;
  return (
    <div
      className={`airport-card card${flip ? ' flip' : ''}`}
      style={{ left: x, top: y }}
      role="dialog"
      aria-label={code}
    >
      <div className="airport-card-head">
        <b className="airport-card-code">{code}</b>
        {airport.iata && airport.icao && <span className="airport-card-icao">{airport.icao}</span>}
        <button
          type="button"
          className="airport-card-x"
          title={t.close}
          aria-label={t.close}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="airport-card-name">{airport.name}</div>
      {place && <div className="airport-card-meta">{place}</div>}
      {elevFt != null && (
        <div className="airport-card-meta">
          {t.elevation} {fmtN(Math.round(elevFt * 0.3048))} m · {fmtN(elevFt)} ft
        </div>
      )}
      <div className="airport-card-meta">
        {lat}, {lon}
      </div>
      <button
        type="button"
        className={`visit-btn${visited ? ' on' : ''}`}
        aria-pressed={visited}
        onClick={onToggleVisited}
      >
        {visited ? `✓ ${t.visitedLabel}` : t.markVisited}
      </button>
    </div>
  );
}
