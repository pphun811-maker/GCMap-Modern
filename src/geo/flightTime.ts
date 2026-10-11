// 飞行时间估算（无 SimBrief 数据时的兜底）与巡航假设（纯函数）。
// 估算按"单段距离"分档选巡航假设：< 4000 km 视为窄体航段，≥ 4000 km 视为宽体航段；
// 每段固定开销 30 分钟近似滑行 + 爬升/下降阶段相对巡航速度的速度亏欠。
// 跳转 SimBrief 生成页的默认机型分档沿用同一阈值（simbrief.dispatchTypeForKm）。

/** 航程分档阈值（km）：单段 < 阈值 → 窄体假设，≥ 阈值 → 宽体假设 */
export const TYPE_THRESHOLD_KM = 4000;
/** 一档巡航假设：马赫 + 对应真空速（km/h）。两者保持自洽（FL350 ISA 声速 ≈ 1062 km/h） */
export interface CruiseAssumption {
  mach: number;
  kmh: number;
}

/** 窄体巡航假设：M0.78 ≈ 830 km/h ≈ 448 kt（A320neo/A321neo 一档的巡航中位水平） */
export const NARROWBODY_CRUISE: CruiseAssumption = { mach: 0.78, kmh: 830 };

/** 宽体巡航假设：M0.85 ≈ 903 km/h ≈ 488 kt（A350/B787 典型 LRC） */
export const WIDEBODY_CRUISE: CruiseAssumption = { mach: 0.85, kmh: 903 };

/** 单段距离对应的巡航假设 */
export function cruiseAssumption(km: number): CruiseAssumption {
  return km < TYPE_THRESHOLD_KM ? NARROWBODY_CRUISE : WIDEBODY_CRUISE;
}

/** 每段固定开销（分钟）：滑行 + 爬升/下降亏欠 */
export const PER_LEG_FIXED_MIN = 30;

/** 一段的估算飞行时间（分钟）。多段航线各自计入开销（每段都是一次起降） */
export function estimateLegMinutes(km: number): number {
  return (km / cruiseAssumption(km).kmh) * 60 + PER_LEG_FIXED_MIN;
}
