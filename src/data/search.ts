import airportsJson from './airports.json';

export interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  size: number; // 0 large / 1 medium / 2 small
  sched: number; // 1 有定期航班
}

export const AIRPORTS = airportsJson as Airport[];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

/**
 * 都市圈别名（2026-10-15 新增）
 * OurAirports 的 municipality 写的是卫星城/邻城：NRT=Narita、EWR=Newark、TPE=Taoyuan、
 * SZB=Subang、BGY=Bergamo、BVA=Beauvais……只按 city/name 匹配时，搜主城名会漏掉同都市圈的
 * 另一个机场（用户实测：搜 tokyo 只有 HND，找不到 NRT）。
 * 键 = 都市圈名（归一化后：小写、去音标、只留字母数字），值 = 该都市圈的机场 IATA 代码
 * （写全，不只是漏掉的那个——顺序即期望排序，主枢纽在前）。新增条目照此格式补即可。
 */
const METRO_ALIASES: Record<string, string[]> = {
  tokyo: ['HND', 'NRT'],
  newyork: ['JFK', 'LGA', 'EWR'],
  nyc: ['JFK', 'LGA', 'EWR'],
  taipei: ['TPE', 'TSA'],
  kualalumpur: ['KUL', 'SZB'],
  manila: ['MNL', 'CRK'],
  paris: ['CDG', 'ORY', 'BVA'],
  milan: ['MXP', 'LIN', 'BGY'],
  brussels: ['BRU', 'CRL'],
  losangeles: ['LAX', 'LGB', 'BUR', 'SNA', 'ONT'],
  mexicocity: ['MEX', 'NLU', 'TLC'],
  oslo: ['OSL', 'TRF'],
};

/** 代码（小写）-> 所属都市圈别名键，建索引时一次查好 */
const METRO_BY_CODE = new Map<string, string[]>();
for (const [key, codes] of Object.entries(METRO_ALIASES)) {
  for (const code of codes) {
    const k = code.toLowerCase();
    const prev = METRO_BY_CODE.get(k);
    if (prev) prev.push(key);
    else METRO_BY_CODE.set(k, [key]);
  }
}

// 预建索引，避免每次输入都全量归一化
const INDEX = AIRPORTS.map((a) => ({
  a,
  iata: a.iata.toLowerCase(),
  icao: a.icao.toLowerCase(),
  name: norm(a.name),
  city: norm(a.city),
  metros: METRO_BY_CODE.get(a.iata.toLowerCase()) ?? [],
  nameWords: norm(a.name).split(' ').filter(Boolean),
}));

/** 代码精确匹配（IATA 优先） */
export function findByCode(code: string): Airport | undefined {
  const c = code.trim().toLowerCase();
  if (!c) return undefined;
  const hits = INDEX.filter((e) => e.iata === c || e.icao === c);
  if (!hits.length) return undefined;
  hits.sort((x, y) => x.a.size - y.a.size || y.a.sched - x.a.sched);
  return hits[0].a;
}

/** 按坐标找最近机场（真实航路快照恢复：航点序列首末应落在机场上），等距圆柱近似在 5km 阈值内足够 */
export function findAirportNear(lat: number, lon: number, maxKm = 5): Airport | undefined {
  let best: Airport | undefined;
  let bestDkm = maxKm;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const a of AIRPORTS) {
    const dkm = Math.hypot(
      (a.lat - lat) * 111.32,
      (a.lon - lon) * 111.32 * cosLat,
    );
    if (dkm < bestDkm) {
      bestDkm = dkm;
      best = a;
    }
  }
  return best;
}

export interface Suggestion {
  airport: Airport;
  score: number;
}

/** 模糊搜索：代码前缀 > 名称/城市前缀 > 名称/城市词首 > 子串 */
export function searchAirports(query: string, limit = 8): Airport[] {
  const q = norm(query);
  if (!q) return [];
  const hits: Suggestion[] = [];

  for (const e of INDEX) {
    let score = 0;
    if (e.iata && e.iata.startsWith(q)) score = 1000 - (e.iata === q ? 0 : 40);
    else if (e.icao && e.icao.startsWith(q)) score = 980 - (e.icao === q ? 0 : 40);
    else if (e.city.startsWith(q)) score = 800 - e.city.length * 0.1;
    // 都市圈别名：搜主城名时补上卫星城机场（q 太短时不启用，避免短词被都市圈刷屏）
    else if (q.length >= 3 && e.metros.some((m) => m.startsWith(q) || q.startsWith(m))) score = 780;
    else if (e.nameWords.some((w) => w.startsWith(q))) score = 700 - e.name.length * 0.05;
    else if (e.city.includes(q)) score = 500;
    else if (e.name.includes(q)) score = 480;
    if (score <= 0) continue;
    // 大机场与有定期航班者排前
    score += (2 - e.a.size) * 12 + e.a.sched * 10;
    hits.push({ airport: e.a, score });
  }

  hits.sort((x, y) => y.score - x.score || x.airport.name.localeCompare(y.airport.name));
  const seen = new Set<string>();
  const out: Airport[] = [];
  for (const h of hits) {
    const key = h.airport.iata || h.airport.icao;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h.airport);
    if (out.length >= limit) break;
  }
  return out;
}
