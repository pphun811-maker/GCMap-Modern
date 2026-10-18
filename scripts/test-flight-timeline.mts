// 时区到达时间回归测试（本地保留，.git/info/exclude，不入公开仓库）
// 跑法： node scripts/run-flight-timeline-test.mjs
// 覆盖：链式推算（含中转）、时区偏移与 DST（冬/夏）、zoned→UTC（含 DST 空档）、
//       半时区（加德满都 +5:45）、跨天标记、跨日期线往返、tz 坐标查询（真实调用 tz-lookup）。
import {
  computeTimeline, dayDelta, initTzLookup, localTime, nowInZone, tzAt,
  tzLookupReady, tzOffsetMinutes, zonedToUtc,
} from '../src/geo/flightTimeline';

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

const utc = (iso: string) => new Date(iso);
const hm = (d: Date | null, tz: string) => (d ? localTime(d, tz)?.time ?? 'null' : 'null');

console.log('timeline: 链式推算（3 站 2 段，中转 60 分）');
const tl = computeTimeline(['A', 'B', 'C'], [100, 200], utc('2026-01-10T00:00:00Z'));
check('首站只起飞 00:00Z', tl[0].arrival === null && tl[0].departure?.toISOString() === '2026-01-10T00:00:00.000Z');
check('中站到达 01:40Z', tl[1].arrival?.toISOString() === '2026-01-10T01:40:00.000Z');
check('中站起飞 02:40Z（+60 中转）', tl[1].departure?.toISOString() === '2026-01-10T02:40:00.000Z');
check('末站到达 06:00Z 只到达', tl[2].arrival?.toISOString() === '2026-01-10T06:00:00.000Z' && tl[2].departure === null);

console.log('timeline: 时区偏移与 DST');
check('上海 1 月 +8h', tzOffsetMinutes(utc('2026-01-10T00:00:00Z'), 'Asia/Shanghai') === 480);
check('纽约 1 月 -5h（EST）', tzOffsetMinutes(utc('2026-01-10T00:00:00Z'), 'America/New_York') === -300);
check('纽约 7 月 -4h（EDT，DST 生效）', tzOffsetMinutes(utc('2026-07-10T00:00:00Z'), 'America/New_York') === -240);

console.log('timeline: 当地墙钟 → UTC');
check('上海 08:00 = 00:00Z', zonedToUtc('2026-01-10T08:00', 'Asia/Shanghai').toISOString() === '2026-01-10T00:00:00.000Z');
check('纽约 7 月 12:00（EDT）= 16:00Z', zonedToUtc('2026-07-01T12:00', 'America/New_York').toISOString() === '2026-07-01T16:00:00.000Z');
check('纽约 1 月 12:00（EST）= 17:00Z', zonedToUtc('2026-01-01T12:00', 'America/New_York').toISOString() === '2026-01-01T17:00:00.000Z');
{
  // DST 春季空档：02:30 不存在，落回合法时刻且日期不变
  const d = zonedToUtc('2026-03-08T02:30', 'America/New_York');
  const back = localTime(d, 'America/New_York');
  check('DST 空档 02:30 不炸且日期保持', back?.ymd === '2026-03-08' && !!back?.time, JSON.stringify(back));
}

console.log('timeline: 当地格式化与半时区');
check('02:40Z 东京 = 11:40', hm(utc('2026-01-10T02:40:00Z'), 'Asia/Tokyo') === '11:40');
check('02:40Z 上海 = 10:40', hm(utc('2026-01-10T02:40:00Z'), 'Asia/Shanghai') === '10:40');
check('02:40Z 加德满都 = 08:25（+5:45 半时区）', hm(utc('2026-01-10T02:40:00Z'), 'Asia/Kathmandu') === '08:25');
check('非法时区名返回 null 不抛', localTime(utc('2026-01-10T00:00:00Z'), 'Mars/Olympus') === null);
check('空时区名返回 null', localTime(utc('2026-01-10T00:00:00Z'), '') === null);

console.log('timeline: 跨天与跨日期线');
check('dayDelta +1', dayDelta('2026-01-10', '2026-01-11') === 1);
check('dayDelta 0', dayDelta('2026-01-10', '2026-01-10') === 0);
check('dayDelta -1', dayDelta('2026-01-10', '2026-01-09') === -1);
{
  // 洛杉矶 1/10 23:00 起飞（-8 → 1/11 07:00Z），飞 14h → 1/11 21:00Z → 东京 1/12 06:00（+1d）
  const dep = zonedToUtc('2026-01-10T23:00', 'America/Los_Angeles');
  const arr = new Date(dep.getTime() + 840 * 60000);
  const lt = localTime(arr, 'Asia/Tokyo');
  check('LAX→东京 跨天 +1d', lt?.ymd === '2026-01-12' && lt?.time === '06:00', JSON.stringify(lt));
  check('出发地日为 1/10（当地）', localTime(dep, 'America/Los_Angeles')?.ymd === '2026-01-10');
}
{
  // 跨日期线向西：东京 1/10 23:00（14:00Z）+9h → 23:00Z → 洛杉矶 1/10 15:00（当地日期反而更早，dayDelta 0）
  const dep = zonedToUtc('2026-01-10T23:00', 'Asia/Tokyo');
  const arr = new Date(dep.getTime() + 540 * 60000);
  const lt = localTime(arr, 'America/Los_Angeles');
  check('东京→洛杉矶 同日到达（日历往回走）', lt?.ymd === '2026-01-10' && lt?.time === '15:00', JSON.stringify(lt));
}

console.log('timeline: tz 坐标查询（真实调用 tz-lookup）');
check('未初始化时 tzAt 返回 null', tzAt(31.1443, 121.8083) === null && !tzLookupReady());
await initTzLookup();
check('PVG → Asia/Shanghai', tzAt(31.1443, 121.8083) === 'Asia/Shanghai', tzAt(31.1443, 121.8083) ?? 'null');
check('NRT → Asia/Tokyo', tzAt(35.7647, 140.3863) === 'Asia/Tokyo', tzAt(35.7647, 140.3863) ?? 'null');
check('LAX → America/Los_Angeles', tzAt(33.9425, -118.4081) === 'America/Los_Angeles', tzAt(33.9425, -118.4081) ?? 'null');
check('nowInZone 输出 datetime-local 格式', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowInZone('Asia/Shanghai')), nowInZone('Asia/Shanghai'));

console.log(`\nflight-timeline: ${passed} passed / ${failed} failed`);
export default (async () => failed)();
