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

// 预建索引，避免每次输入都全量归一化
const INDEX = AIRPORTS.map((a) => ({
  a,
  iata: a.iata.toLowerCase(),
  icao: a.icao.toLowerCase(),
  name: norm(a.name),
  city: norm(a.city),
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
