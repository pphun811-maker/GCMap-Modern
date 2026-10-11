// 飞行时间估算（无 SimBrief 数据时的兜底）与速度单位换算（纯函数）。
// 估算模型：距离 ÷ 假设巡航速度 + 每段固定开销。假设速度取典型喷气客机中位水平
//（M0.82 @ FL350 无风真空速 ≈ 870 km/h ≈ 470 kt）；固定开销 30 分钟近似滑行 +
// 爬升/下降阶段相对巡航速度的速度亏欠。粗略估算，未计风——有 SimBrief 计划时优先用其真实数据。

import { KM_PER_MI, KM_PER_NM, type Units } from './greatCircle';

/** 估算用假设巡航速度（km/h 地速≈真空速，未计风） */
export const ASSUMED_CRUISE_KMH = 870;

/** 每段固定开销（分钟）：滑行 + 爬升/下降亏欠 */
export const PER_LEG_FIXED_MIN = 30;

/** 一段的估算飞行时间（分钟）。多段航线各自计入开销（每段都是一次起降） */
export function estimateLegMinutes(km: number): number {
  return (km / ASSUMED_CRUISE_KMH) * 60 + PER_LEG_FIXED_MIN;
}

/** 速度换算：km/h → 当前单位制（km/h / mph / kt） */
export function convertSpeed(kmh: number, units: Units): number {
  if (units === 'mi') return kmh / KM_PER_MI;
  if (units === 'nm') return kmh / KM_PER_NM;
  return kmh;
}

export const SPEED_UNIT_LABEL: Record<Units, string> = { km: 'km/h', mi: 'mph', nm: 'kt' };
