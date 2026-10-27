// 昼夜光照与手动 UTC 时刻：主项目统一策略（App 状态 ⇄ MapController ⇄ 行星层/夜路）。
//
// demo（round-11 候选）的 cycle 开关语义：cycle 控制昼夜光照，时间滑杆手动指定太阳时刻。
// 主项目默认跟随真实 UTC（每 60 s 重算）；用户拖动滑杆后进入手动时刻，真实时钟不再覆盖。
// 日期始终取当前 UTC 日期，手动值只是当天时刻——与航班 ETA/SimBrief 时间完全无关。

/** 手动 UTC 时刻的合法范围（小时，0–24；24:00 归一为次日 00:00） */
export const UTC_HOURS_MAX = 24;
/** 滑杆步长（小时）：0.1 h = 6 分钟 */
export const UTC_HOURS_STEP = 0.1;

/**
 * 归一化手动 UTC 时刻：拒绝 NaN/空串/越界值（返回 null，调用方保持原值）。
 * 24:00 按次日 00:00 归一为 0。
 */
export function normalizeUtcHours(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > UTC_HOURS_MAX) return null;
  return n === UTC_HOURS_MAX ? 0 : n;
}

/** 当前 UTC 一天中的小时数（0–24，含小数） */
export function currentUtcHours(nowMs: number = Date.now()): number {
  const day = ((nowMs % 86_400_000) + 86_400_000) % 86_400_000;
  return day / 3_600_000;
}

/** HH:mm（UTC）；24:00 显示为 00:00（次日零点归一） */
export function formatUtcHours(hours: number): string {
  const normalized = ((hours % UTC_HOURS_MAX) + UTC_HOURS_MAX) % UTC_HOURS_MAX;
  const total = Math.round(normalized * 60) % (UTC_HOURS_MAX * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 太阳计算用的纪元时间：手动时刻用「当前 UTC 日期 + 手动时刻」，
 * 未手动（null）时直接用真实当前时刻。60 s 真实时钟重算不会改写手动值。
 */
export function sunEpochMs(nowMs: number, manualUtc: number | null): number {
  if (manualUtc === null) return nowMs;
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return dayStart + manualUtc * 3_600_000;
}

/** 行星层 u_cycle / u_lights：关闭时同时取消昼夜暗化与城市夜光，材质/大气仍由 u_material/u_atmosphere 保留 */
export function dayNightUniforms(on: boolean): { cycle: number; lights: number } {
  return { cycle: on ? 1 : 0, lights: on ? 1 : 0 };
}

/** 行星层是否激活只由底图模式决定（卫星不叠地球地表）；关闭昼夜不会关掉材质层 */
export function planetActiveFor(base: 'vector' | 'satellite'): boolean {
  return base === 'vector';
}

/** 夜间路网只在矢量底图且昼夜光照开启时接管 atlas */
export function roadsEnabled(on: boolean, base: 'vector' | 'satellite'): boolean {
  return on && base === 'vector';
}
