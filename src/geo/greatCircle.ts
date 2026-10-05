// 大圆航线几何计算（球面模型，纯函数）
export interface LonLat {
  lon: number;
  lat: number;
}

const R_KM = 6371.0088; // IUGG 平均地球半径
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function haversineKm(a: LonLat, b: LonLat): number {
  const φ1 = a.lat * D2R;
  const φ2 = b.lat * D2R;
  const dφ = (b.lat - a.lat) * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

/** 起飞初始方位角（0-360，正北为 0） */
export function initialBearing(a: LonLat, b: LonLat): number {
  const φ1 = a.lat * D2R;
  const φ2 = b.lat * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

function toVec(p: LonLat): [number, number, number] {
  const φ = p.lat * D2R;
  const λ = p.lon * D2R;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

function toLonLat(v: [number, number, number]): LonLat {
  const [x, y, z] = v;
  return { lon: Math.atan2(y, x) * R2D, lat: Math.atan2(z, Math.hypot(x, y)) * R2D };
}

/** 沿大圆插值取 n 个点（含两端），经度已 unwrap 保证连续（可越过 ±180°） */
export function greatCirclePoints(a: LonLat, b: LonLat, n = 128): [number, number][] {
  const va = toVec(a);
  const vb = toVec(b);
  const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const ω = Math.acos(dot);

  const pts: [number, number][] = [];
  let prevLon = a.lon;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let p: LonLat;
    if (ω < 1e-9) {
      p = { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
    } else {
      const s1 = Math.sin((1 - t) * ω) / Math.sin(ω);
      const s2 = Math.sin(t * ω) / Math.sin(ω);
      p = toLonLat([
        s1 * va[0] + s2 * vb[0],
        s1 * va[1] + s2 * vb[1],
        s1 * va[2] + s2 * vb[2],
      ]);
    }
    // unwrap：让相邻点经度差 < 180°，并锚定在起点所在的"世界副本"
    while (p.lon - prevLon > 180) p.lon -= 360;
    while (p.lon - prevLon < -180) p.lon += 360;
    prevLon = p.lon;
    pts.push([p.lon, p.lat]);
  }
  return pts;
}

/** 大圆中点（用于距离标签） */
export function greatCircleMidpoint(a: LonLat, b: LonLat): LonLat {
  const pts = greatCirclePoints(a, b, 2);
  return { lon: pts[1][0], lat: pts[1][1] };
}

/** 从起点沿方位角 bearingDeg 偏移 distKm 的点（用于把距离标签挪离航线）。
 *  经度保持与起点同一"世界副本"（不归一到 ±180），跟随 unwrap 后的航线坐标。 */
export function destinationPoint(start: LonLat, bearingDeg: number, distKm: number): LonLat {
  const δ = distKm / R_KM;
  const θ = bearingDeg * D2R;
  const φ1 = start.lat * D2R;
  const λ1 = start.lon * D2R;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  let lon = (λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - sinφ2 * Math.sin(φ1))) * R2D;
  while (lon - start.lon > 180) lon -= 360;
  while (lon - start.lon < -180) lon += 360;
  return { lon, lat: φ2 * R2D };
}

/** 对多段航线的机场坐标做整体 unwrap，使 bbox 连续（用于 fitBounds） */
export function unwrapSequence(points: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  let prev = 0;
  for (const p of points) {
    let lon = p.lon;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push({ lon, lat: p.lat });
  }
  return out;
}

export const KM_PER_MI = 1.609344;
export const KM_PER_NM = 1.852;

export type Units = 'km' | 'mi' | 'nm';

export function convertDistance(km: number, units: Units): number {
  if (units === 'mi') return km / KM_PER_MI;
  if (units === 'nm') return km / KM_PER_NM;
  return km;
}

/** 16 方位罗盘缩写（供航向显示） */
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(bearingDeg: number): string {
  return COMPASS_16[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16];
}
