// 太阳位置：沿用游戏 globeLighting 模块的 NOAA 低精度公式（候选 app.js 已验收实现）。
// 主项目不再用 demo 的固定日期 + UTC 滑杆，改为真实 UTC 时钟：
//   - 初始值 = 当前时刻，每 60 s 重算一次（终夜线随真实时间缓慢移动）；
//   - 航班预计到达时间等业务时间不参与太阳计算（避免把 ETA 误当太阳时刻）。

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86400000;
const UNIX_EPOCH_JD = 2440587.5;
const J2000_JD = 2451545;

const norm360 = (x: number) => ((x % 360) + 360) % 360;
const wrap180 = (x: number) => ((x + 540) % 360) - 180;

export interface SolarPosition {
  latDeg: number;
  lonDeg: number;
}

/** 太阳直射点（纬度/经度，单位度）。 */
export function solarPosition(epochMs: number): SolarPosition {
  const d = epochMs / DAY_MS + UNIX_EPOCH_JD - J2000_JD;
  const meanLon = norm360(280.46 + 0.9856474 * d);
  const anomaly = norm360(357.528 + 0.9856003 * d) * RAD;
  const eclLon = norm360(meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const obliq = (23.439 - 4e-7 * d) * RAD;
  const ra = norm360(Math.atan2(Math.cos(obliq) * Math.sin(eclLon), Math.cos(eclLon)) * DEG);
  const dec = Math.asin(Math.sin(obliq) * Math.sin(eclLon)) * DEG;
  const lon = wrap180(ra - norm360(280.46061837 + 360.98564736629 * d));
  return { latDeg: dec, lonDeg: lon };
}

/** 着色器用单位向量 + 一天中的 UTC 比例（0..1）。 */
export function sunVector(epochMs: number): { sun: [number, number, number]; timeDays: number } {
  const p = solarPosition(epochMs);
  const lon = p.lonDeg * RAD;
  const lat = p.latDeg * RAD;
  const sun: [number, number, number] = [
    Math.sin(lon) * Math.cos(lat),
    Math.sin(lat),
    Math.cos(lon) * Math.cos(lat),
  ];
  const day = ((epochMs % DAY_MS) + DAY_MS) % DAY_MS;
  return { sun, timeDays: day / DAY_MS };
}
