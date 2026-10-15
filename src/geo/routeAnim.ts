// 观感动画包（2026-10-16）的纯几何/时序函数，供 MapController 接线。
// 这里不含 maplibre 依赖：生长切片、缓动、巡航路径与时刻都可以单独回归测试。
// 全部是纯视觉动画——与已移除的"真实航迹"功能无关，也不参与任何距离/时间计算口径。

import { haversineKm, initialBearing, type LonLat } from './greatCircle';

/** 生长动画时长（ms）：基础 + 每多一段加成（多段航线逐段连续生长），封顶 */
export const GROW_BASE_MS = 700;
export const GROW_PER_LEG_MS = 300;
export const GROW_MAX_MS = 1600;

/** 多条航线同时生长时的错峰间隔（ms） */
export const GROW_STAGGER_MS = 180;

/** 标签淡入时长（ms） */
export const LABEL_FADE_MS = 250;

/** 小飞机巡航循环时长与估算飞行时间的比例（秒/分钟），夹紧到 5–24s */
export const PLANE_SEC_PER_MIN = 0.028;
export const PLANE_LOOP_MIN_S = 5;
export const PLANE_LOOP_MAX_S = 24;

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function growDurationMs(legCount: number): number {
  return Math.min(GROW_MAX_MS, GROW_BASE_MS + GROW_PER_LEG_MS * Math.max(0, legCount - 1));
}

export function planeLoopSec(estMinutes: number): number {
  return Math.min(PLANE_LOOP_MAX_S, Math.max(PLANE_LOOP_MIN_S, estMinutes * PLANE_SEC_PER_MIN));
}

/** 航线沿线的巡航路径：坐标（已 unwrap 连续）、逐点朝向（指向下一点）、累积里程 */
export interface PlanePath {
  coords: [number, number][];
  bearings: number[];
  cumKm: number[];
  totalKm: number;
}

/** 从各段坐标（greatCirclePoints / 航点序列）拼接巡航路径；相邻段共享的端点只保留一份 */
export function buildPlanePath(perLegCoords: [number, number][][]): PlanePath {
  const coords: [number, number][] = [];
  for (const leg of perLegCoords) {
    for (let i = coords.length ? 1 : 0; i < leg.length; i++) coords.push(leg[i]);
  }
  const bearings: number[] = [];
  const cumKm: number[] = [0];
  let totalKm = 0;
  for (let i = 1; i < coords.length; i++) {
    const a: LonLat = { lon: coords[i - 1][0], lat: coords[i - 1][1] };
    const b: LonLat = { lon: coords[i][0], lat: coords[i][1] };
    totalKm += haversineKm(a, b);
    cumKm.push(totalKm);
    bearings.push(initialBearing(a, b));
  }
  return { coords, bearings, cumKm, totalKm };
}

export interface PlanePos {
  lngLat: [number, number];
  bearing: number;
  /** 实际命中的段索引（调用方可作为下一帧扫描起点缓存） */
  seg: number;
}

/** 巡航进度 t∈[0,1) 对应的位置与朝向（按累积里程线性插值，相邻点间朝向取当前段）；
 *  fromSeg 传上一帧的 seg 可避免从头扫描（t 单调递增时安全） */
export function planeAt(path: PlanePath, t: number, fromSeg = 0): PlanePos {
  const target = t * path.totalKm;
  let seg = Math.min(Math.max(0, fromSeg), path.cumKm.length - 2);
  while (seg < path.cumKm.length - 2 && path.cumKm[seg + 1] < target) seg++;
  const segLen = path.cumKm[seg + 1] - path.cumKm[seg] || 1;
  const f = Math.min(1, Math.max(0, (target - path.cumKm[seg]) / segLen));
  const [x0, y0] = path.coords[seg];
  const [x1, y1] = path.coords[seg + 1];
  return {
    lngLat: [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f],
    bearing: path.bearings[seg],
    seg,
  };
}

/**
 * 生长切片：reveal = 应显示的总点数（≥1）。按段顺序切片（多段航线逐段连续生长），
 * 段几何原样保留 properties。reveal ≥ 总点数时返回原 features（不复制）。
 */
export function revealLineFeatures<T extends { geometry: { coordinates: unknown[] } }>(
  features: T[],
  reveal: number,
): T[] {
  if (reveal >= features.reduce((s, f) => s + f.geometry.coordinates.length, 0)) return features;
  const out: T[] = [];
  let remain = Math.max(1, reveal);
  for (const f of features) {
    if (remain <= 0) break;
    const take = Math.min(f.geometry.coordinates.length, remain);
    out.push({
      ...f,
      geometry: { ...f.geometry, coordinates: f.geometry.coordinates.slice(0, take) },
    });
    remain -= take;
  }
  return out;
}
