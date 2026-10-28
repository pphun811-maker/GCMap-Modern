// 本地持久化（localStorage，设备本地，不进 URL）：草稿 / 航线收藏 / 飞行足迹
// - 草稿 gcmap.draft：整组航线（含颜色/线宽/显隐/真实航路折线/计划元数据）+ 视图设置，
//   随改动静默保存；打开裸 URL（无任何查询参数）时整体恢复。URL 带参数（分享链接/书签）
//   时一切以 URL 为准，草稿不介入 —— "链接定义内容，裸开是我的工作台"。
//   URL 分享格式保持不变（不带样式），草稿在本地把样式补齐。
// - 收藏 gcmap.favorites：命名保存的航线快照列表，一键恢复（替换当前航线，可撤销）。
// - 足迹 gcmap.journal：去过的机场代码集合 + 逐条记录的航程（累计里程）。
// 全部读写包 try/catch：隐私模式 / 存储被禁时静默降级为会话内状态，不抛错。

import { findByCode, type Airport } from '../data/search';
import type { RouteEntry } from '../map/MapController';
import { haversineKm } from '../geo/greatCircle';
import { decodePolyline, encodePolyline, encodeSbfMeta, parseSbfMeta } from '../simbrief/simbrief';

export const DRAFT_KEY = 'gcmap.draft';
export const FAVORITES_KEY = 'gcmap.favorites';
export const JOURNAL_KEY = 'gcmap.journal';
/** 菜单 UTC 显示时区偏移（整点小时；设备本地偏好，不进 URL/草稿） */
export const UTC_OFFSET_KEY = 'gcmap.utcOffset';

// 全局唯一 id 源（URL 解析 / 草稿与收藏恢复 / App 新建共用，避免跨模块撞号）
let uid = 0;
export const nextId = () => `rt-${++uid}`;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隐私模式 / 存储被禁
  }
}

function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* 隐私模式：本会话内存状态仍有效 */
  }
}

/** 读取本地保存的 UTC 显示时区偏移（整点小时）；无记录/坏值返回 null，由调用方归一 */
export function readUtcOffset(): number | null {
  const raw = lsGet(UTC_OFFSET_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function writeUtcOffset(offset: number): void {
  lsSet(UTC_OFFSET_KEY, String(offset));
}

// ---- 航线快照编解码（草稿与收藏共用的最小持久化形态） ----

/** 一条航线的可持久化快照：机场代码序列 + 样式 +（可选）真实航路折线与计划元数据 */
export interface SavedRoute {
  /** 机场代码序列（IATA 优先，无 IATA 用 ICAO） */
  c: string[];
  vis: 0 | 1;
  col: string;
  w: number;
  /** 真实航路折线（polyline 编码）；大圆弧航线无此字段 */
  wp?: string;
  /** 计划元数据（"<分钟>-<TAS>-<马赫>"，同 URL sbt 编码） */
  ofp?: string;
}

export function encodeRoute(r: RouteEntry): SavedRoute {
  return {
    c: r.airports.map((a) => a.iata || a.icao),
    vis: r.visible ? 1 : 0,
    col: r.color,
    w: r.width,
    ...(r.waypoints && r.waypoints.length >= 2 ? { wp: encodePolyline(r.waypoints) } : {}),
    ...(r.ofp ? { ofp: encodeSbfMeta(r.ofp) } : {}),
  };
}

/** 快照 → 航线（分配新 id）。机场代码无法解析或数量不足时整条放弃返回 null；
 *  正常情况下本机数据静态，不会发生。坏颜色/粗细按防御默认值回退。 */
export function decodeRoute(s: SavedRoute): RouteEntry | null {
  const airports: Airport[] = [];
  for (const c of s.c ?? []) {
    const a = findByCode(String(c));
    if (!a) return null;
    airports.push(a);
  }
  if (airports.length < 2) return null;
  let waypoints: RouteEntry['waypoints'];
  if (s.wp) {
    try {
      const pts = decodePolyline(s.wp);
      // 防御：decodePolyline 对垃圾输入不抛错、会解出乱坐标，
      // 校验坐标有限且首末航点确实落在首末机场附近（≤50km），否则退回大圆弧
      const end = pts[pts.length - 1];
      const okGeo =
        pts.length >= 2 &&
        pts.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)) &&
        haversineKm(pts[0], airports[0]) < 50 &&
        haversineKm(end, airports[airports.length - 1]) < 50;
      if (okGeo) waypoints = pts.map((p) => ({ ident: '', lat: p.lat, lon: p.lon }));
    } catch {
      /* 坏折线：退回大圆弧 */
    }
  }
  const ofp = s.ofp ? (parseSbfMeta(s.ofp) ?? undefined) : undefined;
  return {
    id: nextId(),
    airports,
    visible: s.vis !== 0,
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(s.col)) ? s.col : '#0B7BE8',
    width: Number.isFinite(s.w) && s.w >= 0.5 && s.w <= 3 ? s.w : 1,
    ...(waypoints ? { waypoints } : {}),
    ...(ofp ? { ofp } : {}),
  };
}

// ---- 草稿 ----

export interface Draft {
  v: 1;
  /** 视图设置（与 URL 参数同名同值，仅存非默认项；route/sbr/sbt 不在此存） */
  set: Record<string, string>;
  routes: SavedRoute[];
}

export function readDraft(): Draft | null {
  const raw = lsGet(DRAFT_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft;
    if (d?.v !== 1 || !Array.isArray(d.routes) || typeof d.set !== 'object' || d.set === null) return null;
    return d;
  } catch {
    return null;
  }
}

export function writeDraft(d: Draft): void {
  lsSet(DRAFT_KEY, JSON.stringify(d));
}

/**
 * 开机状态：URL 带任何参数 → 一切以 URL 为准（draftRoutes=null，App 照旧解析 URL）；
 * 裸 URL 且有草稿 → 返回草稿的设置查询串 + 航线快照，由 App 在机场数据就绪后解码恢复。
 */
export function loadBootState(): { query: URLSearchParams; draftRoutes: SavedRoute[] | null } {
  const url = new URLSearchParams(window.location.search);
  if ([...url.keys()].length > 0) return { query: url, draftRoutes: null };
  const draft = readDraft();
  if (!draft || (!draft.routes.length && !Object.keys(draft.set).length)) {
    return { query: url, draftRoutes: null };
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(draft.set)) query.set(k, v);
  return { query, draftRoutes: draft.routes };
}

// ---- 收藏 ----

export interface FavoriteEntry {
  id: string;
  name: string;
  at: number;
  routes: SavedRoute[];
}

export function readFavorites(): FavoriteEntry[] {
  const raw = lsGet(FAVORITES_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((f) => f && typeof f === 'object' && Array.isArray(f.routes) && typeof f.id === 'string');
  } catch {
    return [];
  }
}

export function writeFavorites(list: FavoriteEntry[]): void {
  lsSet(FAVORITES_KEY, JSON.stringify(list));
}

// ---- 飞行足迹 ----

export interface JournalEntry {
  id: string;
  /** 航线代码串（如 "PEK-LAX"），仅展示用 */
  codes: string;
  /** 里程（km，整数） */
  km: number;
  at: number;
}

export interface JournalData {
  /** 去过的机场代码集合 */
  visited: string[];
  /** 航程记录（新记录在前） */
  entries: JournalEntry[];
}

export function readJournal(): JournalData {
  const raw = lsGet(JOURNAL_KEY);
  if (!raw) return { visited: [], entries: [] };
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return { visited: [], entries: [] };
    return {
      visited: Array.isArray(d.visited) ? d.visited.filter((c: unknown): c is string => typeof c === 'string') : [],
      entries: Array.isArray(d.entries)
        ? d.entries.filter(
            (e: unknown): e is JournalEntry =>
              !!e && typeof e === 'object' && typeof (e as JournalEntry).km === 'number' && typeof (e as JournalEntry).id === 'string',
          )
        : [],
    };
  } catch {
    return { visited: [], entries: [] };
  }
}

export function writeJournal(d: JournalData): void {
  lsSet(JOURNAL_KEY, JSON.stringify(d));
}

/** 纯函数：切换去过的机场（返回新数组，便于 React setState 与单测） */
export function toggleVisited(visited: string[], code: string): string[] {
  return visited.includes(code) ? visited.filter((c) => c !== code) : [...visited, code];
}

/** 纯函数：累计里程（忽略坏数据） */
export function sumJournalKm(entries: JournalEntry[]): number {
  return entries.reduce((s, e) => s + (Number.isFinite(e.km) ? e.km : 0), 0);
}
