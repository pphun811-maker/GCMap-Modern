// 时区到达时间（2026-10-16，路线③）：给定出发时刻，沿航线链式推算各站当地到达/起飞时间。
// 本模块只做纯日期/时区数学（链式推算、IANA 时区格式化、zoned↔UTC 互转），
// 坐标→IANA 时区名的查询依赖 @photostructure/tz-lookup（CC0，88KB）——懒加载，
// 只有时间线真的被渲染时才拉取，且不并入我们提交的 airports.json（保持 OurAirports 公共领域数据的纯净）。
// 所有链式推算都在 UTC 进制上进行，时区只影响"显示"，DST/半时区/跨日期线交给 Intl 处理。

/** 中转地面时间假设（分钟）：各站到达→下一站起飞的间隔，UI 备注里说明 */
export const GROUND_MIN = 60;

export interface TimelineStop {
  code: string;
  /** 到达时刻（UTC）；首站为 null */
  arrival: Date | null;
  /** 起飞时刻（UTC）；末站为 null */
  departure: Date | null;
}

/** 沿站点链推算：legMinutes[i] 是 stop i → i+1 的空中时间（分钟）。
 *  首站起飞 = departAt；中间站起飞 = 到达 + GROUND_MIN。全部 UTC，与任何时区无关 */
export function computeTimeline(
  codes: string[],
  legMinutes: number[],
  departAt: Date,
  groundMin = GROUND_MIN,
): TimelineStop[] {
  const stops: TimelineStop[] = [];
  let cursor = departAt.getTime(); // 当前站的"到达时刻"（首站 = 出发时刻）
  for (let i = 0; i < codes.length; i++) {
    const arrival = i === 0 ? null : new Date(cursor);
    const depTs = cursor + (i === 0 ? 0 : groundMin * 60000);
    const departure = i === codes.length - 1 ? null : new Date(depTs);
    stops.push({ code: codes[i], arrival, departure });
    cursor = depTs + (legMinutes[i] ?? 0) * 60000;
  }
  return stops;
}

/** tz 当地的墙上时钟偏移（分钟）：当地墙钟 − UTC 墙钟。DST 由 Intl 按 instant 判定 */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = zoneParts(instant, tz);
  if (!parts) return 0;
  const asUtc = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
  return (asUtc - instant.getTime()) / 60000;
}

/** 把"某时区的墙上时钟"解释回 UTC 时刻（datetime-local 输入值的语义）。
 *  两次逼近收敛；DST 空档（不存在的墙钟）落在最近的合法时刻上 */
export function zonedToUtc(ymdhm: string, tz: string): Date {
  const asUtc = Date.parse(`${ymdhm}:00Z`);
  if (Number.isNaN(asUtc)) return new Date(NaN);
  let ts = asUtc;
  for (let i = 0; i < 2; i++) {
    const offMin = tzOffsetMinutes(new Date(ts), tz);
    ts = asUtc - offMin * 60000;
  }
  return new Date(ts);
}

export interface LocalTime {
  /** "HH:mm"（24 小时制） */
  time: string;
  /** "YYYY-MM-DD"（当地日历日） */
  ymd: string;
}

/** instant 在 tz 当地的墙钟时间；tz 非法/缺失返回 null */
export function localTime(instant: Date, tz: string): LocalTime | null {
  const parts = zoneParts(instant, tz);
  if (!parts) return null;
  const time = `${String(parts.h).padStart(2, '0')}:${String(parts.mi).padStart(2, '0')}`;
  const ymd = `${parts.y}-${String(parts.mo).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  return { time, ymd };
}

/** 当地日历日相对基准日（同为 ymd 字符串）的整天数差（用于 "+1d" 标记） */
export function dayDelta(baseYmd: string, ymd: string): number {
  const a = Date.parse(`${baseYmd}T00:00Z`);
  const b = Date.parse(`${ymd}T00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** "YYYY-MM-DDTHH:mm" 形式的当前当地墙钟（datetime-local 输入框的取值格式） */
export function nowInZone(tz: string): string {
  const lt = localTime(new Date(), tz);
  return lt ? `${lt.ymd}T${lt.time}` : '';
}

interface ZoneParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function zoneParts(instant: Date, tz: string): ZoneParts | null {
  if (!tz || Number.isNaN(instant.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    const map: Record<string, number> = {};
    for (const p of fmt.formatToParts(instant)) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const y = map.year;
    const mo = map.month;
    const d = map.day;
    const h = map.hour;
    const mi = map.minute;
    const s = map.second;
    if (y == null || mo == null || d == null || h == null || mi == null || s == null) return null;
    return { y, mo, d, h, mi, s };
  } catch {
    return null; // 非法时区名（数据脏）不抛出，由调用方决定降级
  }
}

// ---- 坐标 → IANA 时区（懒加载 @photostructure/tz-lookup，CC0） ----

type TzLookupFn = (lat: number, lon: number) => string;
let lookup: TzLookupFn | null = null;
let lookupPromise: Promise<void> | null = null;

/** 拉取 tz 查询模块；幂等，失败可重试。时间线 UI 在 ready 前不渲染 */
export function initTzLookup(): Promise<void> {
  lookupPromise ??= import('@photostructure/tz-lookup')
    .then((mod: any) => {
      const fn = (mod.default ?? mod) as TzLookupFn;
      if (typeof fn !== 'function') throw new Error('tz-lookup unexpected export');
      lookup = fn;
    })
    .catch((e) => {
      lookupPromise = null; // 允许下次重试
      throw e;
    });
  return lookupPromise;
}

export function tzLookupReady(): boolean {
  return lookup != null;
}

/** 坐标 → IANA 时区名；未初始化/查询失败返回 null（调用方降级隐藏时间线） */
export function tzAt(lat: number, lon: number): string | null {
  if (!lookup) return null;
  try {
    return lookup(lat, lon) || null;
  } catch {
    return null;
  }
}
