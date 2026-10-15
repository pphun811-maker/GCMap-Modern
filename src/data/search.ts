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

// 机场数据懒加载（2026-10-16 性能预算）：airports.json（8799 条 / 1.28MB）不再打进首屏 JS，
// 拆为独立异步 chunk，模块加载即开始拉取（与 maplibre chunk 并行），首帧不再被它阻塞。
// 数据就绪前所有查询返回空 —— App 等 airportsReady 再解析 URL 航线，SearchPanel 就绪后重算建议。

let AIRPORTS: Airport[] = [];

interface IndexEntry {
  a: Airport;
  iata: string;
  icao: string;
  name: string;
  city: string;
  metros: string[];
  nameWords: string[];
}
let INDEX: IndexEntry[] = [];

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

// 预建索引，避免每次输入都全量归一化（数据加载完成后重建一次）
function rebuildIndex(): void {
  INDEX = AIRPORTS.map((a) => {
    const nName = norm(a.name);
    return {
      a,
      iata: a.iata.toLowerCase(),
      icao: a.icao.toLowerCase(),
      name: nName,
      city: norm(a.city),
      metros: METRO_BY_CODE.get(a.iata.toLowerCase()) ?? [],
      nameWords: nName.split(' ').filter(Boolean),
    };
  });
}

const readyListeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

/** 拉取机场数据并建索引；幂等，失败后可重试 */
export function loadAirports(): Promise<void> {
  loadPromise ??= import('./airports.json')
    .then((m) => {
      AIRPORTS = m.default as Airport[];
      rebuildIndex();
      const cbs = [...readyListeners];
      readyListeners.clear();
      for (const cb of cbs) cb();
    })
    .catch((e) => {
      loadPromise = null; // 允许下次重试
      throw e;
    });
  return loadPromise;
}

/** 模块加载即开始拉数据：首屏必用（URL 航线解析 + 搜索），越早并行越好 */
export const airportsReady = loadAirports();

/** 数据就绪回调（已就绪则同步调用）；供 UI 在数据到达后重算派生结果 */
export function onAirportsReady(cb: () => void): void {
  if (INDEX.length) cb();
  else readyListeners.add(cb);
}

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
