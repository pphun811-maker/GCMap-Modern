// 昼夜光照与手动 UTC 时刻：主项目统一策略（App 状态 ⇄ MapController ⇄ 行星层/夜路）。
//
// demo（round-11 候选）的 cycle 开关语义：cycle 控制昼夜光照，时间滑杆手动指定太阳时刻。
// 主项目默认跟随真实 UTC（每 60 s 重算）；用户拖动滑杆后进入手动时刻，真实时钟不再覆盖。
// 日期始终取当前 UTC 日期，手动值只是当天时刻——与航班 ETA/SimBrief 时间完全无关。

/** 手动 UTC 时刻的合法范围（小时，0–24；24:00 归一为次日 00:00） */
export const UTC_HOURS_MAX = 24;
/** 滑杆步长（小时）：0.1 h = 6 分钟 */
export const UTC_HOURS_STEP = 0.1;
/** 显示时区偏移范围（整点小时，UTC−12…UTC+14） */
export const UTC_OFFSET_MIN = -12;
export const UTC_OFFSET_MAX = 14;

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
 * 解析用户直接输入的时刻文本（菜单里点时刻后的输入框）。
 * 接受 "14"、"14:30"、"9:05"、"1430"、"930"、"14.5"（小数小时）；越界/乱码返回 null，
 * 由调用方保持原值。24:00 与 normalizeUtcHours 同语义归一为 0。
 */
export function parseClockInput(text: string): number | null {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let hours: number;
  if (/^\d{1,2}\s*[:：]\s*\d{1,2}$/.test(s)) {
    const [hh, mm] = s.split(/[:：]/);
    const h = Number(hh);
    const m = Number(mm);
    if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return null;
    hours = h + m / 60;
  } else if (/^\d{3,4}$/.test(s)) {
    const h = Number(s.slice(0, s.length - 2));
    const m = Number(s.slice(-2));
    if (m > 59) return null;
    hours = h + m / 60;
  } else if (/^\d{1,2}(\.\d+)?$/.test(s)) {
    hours = Number(s);
  } else {
    return null;
  }
  if (!Number.isFinite(hours) || hours < 0 || hours > UTC_HOURS_MAX) return null;
  return hours === UTC_HOURS_MAX ? 0 : hours;
}

/** 显示时区偏移归一化：整点小时，越界/坏值回 0（UTC） */
export function normalizeUtcOffset(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const h = Math.round(n);
  if (h < UTC_OFFSET_MIN || h > UTC_OFFSET_MAX) return 0;
  return h;
}

/** 时区后缀文本：0 → "UTC"；东八区 → "UTC+8"；西五区 → "UTC-5" */
export function utcOffsetLabel(offset: number): string {
  const o = normalizeUtcOffset(offset);
  if (o === 0) return 'UTC';
  return `UTC${o > 0 ? '+' : '-'}${Math.abs(o)}`;
}

/** UTC 小时 → 指定时区的本地小时（0–24 循环） */
export function toLocalHours(utcHours: number, offset: number): number {
  const shifted = (utcHours + normalizeUtcOffset(offset)) % UTC_HOURS_MAX;
  return shifted < 0 ? shifted + UTC_HOURS_MAX : shifted;
}

/** 指定时区的本地小时 → UTC 小时（0–24 循环）；toLocalHours 的逆运算 */
export function toUtcHours(localHours: number, offset: number): number {
  return toLocalHours(localHours, -normalizeUtcOffset(offset));
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
