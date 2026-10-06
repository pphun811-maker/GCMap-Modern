// SimBrief 接入：取用户最新飞行计划（OFP）并解析成带坐标的航点序列。
// 数据源是官方免 key 的 fetcher API（实测 Access-Control-Allow-Origin: *，浏览器可直连）；
// 生成动作走"带参跳转 SimBrief 生成页 + 用户点 Generate + 本应用轮询拉回"，不需要后端。

import { haversineKm, type LonLat } from '../geo/greatCircle';

export interface SbfWaypoint {
  ident: string;
  lat: number;
  lon: number;
}

export interface SbfRoute {
  originIcao: string;
  originIata: string;
  destIcao: string;
  destIata: string;
  /** 含起降机场在内的完整航点序列（去掉相邻重复点后的顺序即真实航路形状） */
  waypoints: SbfWaypoint[];
  totalKm: number;
  /** 内容签名（起降/总距离/航点数/首末航点），用于"生成后自动导入"的新旧判断 */
  sig: string;
}

const FETCHER_URL = 'https://www.simbrief.com/api/xml.fetcher.php';

/** 生成页默认机型（用户定稿 A359）。 SimBrief 的设备代码，改这里即可全局换 */
export const SBF_DEFAULT_TYPE = 'A359';

/** 生成页入口：官方 Dispatch Redirect 格式（论坛指南 5299），ICAO 代码。
 *  新 UI 会把 query 参数整体转发给 v2/flights/custom 做服务端预填，无需 key，仅要求登录 */
export function simbriefDispatchUrl(
  origCode: string,
  destCode: string,
  type: string = SBF_DEFAULT_TYPE,
): string {
  return `https://dispatch.simbrief.com/options/custom?orig=${encodeURIComponent(origCode)}&dest=${encodeURIComponent(destCode)}&type=${encodeURIComponent(type)}`;
}

// ---- 航线快照持久化（Google Polyline 算法，精度 1e-5 度 ≈ 1m）----
// 真实航路的航点几十上百个，URL 里存原始坐标太长；polyline 编码后一条洲际航线约 200-400 字符

function encChunk(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

export function encodePolyline(points: { lat: number; lon: number }[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lon = Math.round(p.lon * 1e5);
    out += encChunk(lat - prevLat) + encChunk(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

export function decodePolyline(s: string): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const decChunk = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i <= s.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += decChunk();
    lon += decChunk();
    pts.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return pts;
}

/**
 * 坐标解析：正常情况是十进制度字符串（如 "40.63980"）；
 * 兜底支持 SimBrief XML 风格的度分格式（如 "N040.38.328" = 40°38.328′）。
 */
function parseCoord(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().toUpperCase();
  const dms = /^([NSWE])(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(s);
  if (dms) {
    const deg = Number(dms[2]);
    const min = Number(`${dms[3]}.${dms[4]}`);
    const val = deg + min / 60;
    return dms[1] === 'S' || dms[1] === 'W' ? -val : val;
  }
  return parseFloat(s);
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** OFP 布局：成功时各分区在顶层、元数据在 fetch 键（个别包装会把全部分区塞进 fetch 键，两者都容） */
function ofpRoot(data: any): any {
  return data && typeof data === 'object' && data.fetch?.navlog ? data.fetch : data;
}

/** 解析 OFP JSON；数据不完整（无航点序列）时抛错，错误文案取 fetch.status */
export function parseOfp(data: unknown): SbfRoute {
  const ofp = ofpRoot(data);
  if (ofp?.fetch?.status && String(ofp.fetch.status).startsWith('Error')) {
    throw new Error(String(ofp.fetch.status).replace(/^Error:\s*/, ''));
  }
  // XML→JSON 转换的历史坑：只有一个 fix 时 fix 是对象不是数组
  const rawFixes = ofp?.navlog?.fix;
  const fixes: any[] = Array.isArray(rawFixes) ? rawFixes : rawFixes ? [rawFixes] : [];
  const waypoints: SbfWaypoint[] = [];
  for (const f of fixes) {
    const lat = parseCoord(f?.pos_lat);
    const lon = parseCoord(f?.pos_long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const last = waypoints[waypoints.length - 1];
    // 相邻重复点（同一点位的爬升/巡航/下降记录）只保留一个
    if (last && Math.abs(last.lat - lat) < 1e-4 && Math.abs(last.lon - lon) < 1e-4) continue;
    waypoints.push({ ident: String(f?.ident ?? '').trim() || 'WPT', lat, lon });
  }
  if (waypoints.length < 2) throw new Error('no navlog fixes in OFP');

  let totalKm = 0;
  for (let i = 1; i < waypoints.length; i++) {
    totalKm += haversineKm(waypoints[i - 1] as LonLat, waypoints[i] as LonLat);
  }

  const origin = ofp?.origin ?? {};
  const dest = ofp?.destination ?? {};
  const originIcao = String(origin.icao_code ?? '').toUpperCase();
  const destIcao = String(dest.icao_code ?? '').toUpperCase();
  // 签名纳入全部航点：任何一段航路变化都能被轮询识别为"新计划"
  const sig = [
    originIcao,
    destIcao,
    String(ofp?.general?.route_distance ?? ''),
    ...waypoints.map((w) => `${w.ident}@${round4(w.lat)},${round4(w.lon)}`),
  ].join('|');

  return {
    originIcao,
    originIata: String(origin.iata_code ?? '').toUpperCase(),
    destIcao,
    destIata: String(dest.iata_code ?? '').toUpperCase(),
    waypoints,
    totalKm,
    sig,
  };
}

/** 拉取某用户最新 OFP 并解析。用户不存在/尚未生成过计划时抛带 API 文案的 Error */
export async function fetchLatestOfp(username: string, signal?: AbortSignal): Promise<SbfRoute> {
  const url = `${FETCHER_URL}?username=${encodeURIComponent(username)}&json=1`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'network error');
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应走下面的统一报错 */
  }
  if (!res.ok) {
    const apiMsg = body?.fetch?.status;
    throw new Error(
      apiMsg ? String(apiMsg).replace(/^Error:\s*/, '') : `HTTP ${res.status}`,
    );
  }
  return parseOfp(body);
}
