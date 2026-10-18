// SimBrief 解析器 Node 级验证（esbuild 打包真实模块，验证后删除）
import { parseOfp } from '../src/simbrief/simbrief';

let failed = 0;
const check = (name: string, cond: boolean, extra?: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed++;
};

// 1) 标准十进制坐标 OFP（线上 fetcher 预期格式）
const decimalOfp = {
  fetch: { userid: '42', time: '0.02' },
  general: { origin_icao: 'KJFK', dest_icao: 'LGAV', route_distance: '4823', cruise_tas: '470', cruise_mach: '.84' },
  times: { est_time_enroute: '07:55:00', sched_time_enroute: '08:05:00' },
  origin: { icao_code: 'KJFK', iata_code: 'JFK' },
  destination: { icao_code: 'LGAV', iata_code: 'ATH' },
  route: 'DCT ...',
  navlog: {
    fix: [
      { ident: 'KJFK', type: 'apt', pos_lat: '40.63980', pos_long: '-73.77890' },
      { ident: 'WPT01', type: 'wpt', pos_lat: '43.37925', pos_long: '-67.99345' },
      { ident: 'WPT02', type: 'wpt', pos_lat: '45.80064', pos_long: '-61.69431' },
      { ident: 'LGAV', type: 'apt', pos_lat: '37.93640', pos_long: '23.94450' },
    ],
  },
};
const r1 = parseOfp(decimalOfp);
check('标准 OFP：航点数 4', r1.waypoints.length === 4);
check('标准 OFP：首末是起降机场', r1.waypoints[0].ident === 'KJFK' && r1.waypoints[3].ident === 'LGAV');
check('标准 OFP：origin/dest 代码', r1.originIcao === 'KJFK' && r1.originIata === 'JFK' && r1.destIata === 'ATH');
check(
  '标准 OFP：总距离落在 JFK-ATH 合理区间 (6500-8500km)',
  r1.totalKm > 6500 && r1.totalKm < 8500,
  `${Math.round(r1.totalKm)}km`,
);
check('标准 OFP：计划元数据 07:55:00→475min', r1.plan?.timeMin === 475, String(r1.plan?.timeMin));
check('标准 OFP：TAS 470kt / 马赫 M.84', r1.plan?.tasKts === 470 && r1.plan?.mach === 'M.84');
check('标准 OFP：签名稳定', r1.sig === parseOfp(decimalOfp).sig);
const modified = JSON.parse(JSON.stringify(decimalOfp));
modified.navlog.fix[1].pos_lat = '44.37925';
check('标准 OFP：签名对内容敏感', r1.sig !== parseOfp(modified).sig);

// 1b) est_time_enroute 纯秒数（旧样本格式）：~154km 航段 × 3121 秒 ≈ 52 分钟（分钟解释只有 3km/h，被包络否决）
const r1b = parseOfp({
  general: { cruise_tas: '288', cruise_mach: 'M.44' },
  navlog: {
    fix: [
      { ident: 'A', pos_lat: '10.5', pos_long: '20.25' },
      { ident: 'B', pos_lat: '11.5', pos_long: '21.25' },
    ],
  },
  times: { est_time_enroute: '3121' },
});
check(
  '秒数格式：3121s × ~154km → ≈52min',
  r1b.plan != null && Math.abs(r1b.plan.timeMin - 3121 / 60) < 0.01,
  String(r1b.plan?.timeMin),
);
check('秒数格式：M.44 前缀归一', r1b.plan?.mach === 'M.44' && r1b.plan?.tasKts === 288);

// 1c) 无时间字段 → plan null；有 sched 兜底；0.84 马赫归一
const r1c = parseOfp({
  general: { cruise_mach: '0.84' },
  navlog: {
    fix: [
      { ident: 'A', pos_lat: '10.5', pos_long: '20.25' },
      { ident: 'B', pos_lat: '11.5', pos_long: '21.25' },
    ],
  },
});
check('无时间字段：plan 为 null', r1c.plan === null);
const r1d = parseOfp({
  general: { cruise_tas: '400' },
  navlog: {
    fix: [
      { ident: 'A', pos_lat: '10.5', pos_long: '20.25' },
      { ident: 'B', pos_lat: '11.5', pos_long: '21.25' },
    ],
  },
  times: { sched_time_enroute: '01:30:00' },
});
check('sched 兜底 + 无马赫', r1d.plan?.timeMin === 90 && r1d.plan?.mach === null);

// 1e) sbt 编解码：round trip / 占位 / 垃圾输入
import { encodeSbfMeta, parseSbfMeta } from '../src/simbrief/simbrief';
const meta = { timeMin: 475, tasKts: 470, mach: 'M.84' };
const enc2 = encodeSbfMeta(meta);
check('sbt 编码格式', enc2 === '475-470-M.84', enc2);
const dec3 = parseSbfMeta(enc2);
check('sbt round trip', dec3?.timeMin === 475 && dec3?.tasKts === 470 && dec3?.mach === 'M.84');
check('sbt 无速度字段编码', encodeSbfMeta({ timeMin: 90, tasKts: null, mach: null }) === '90--');
check('sbt 占位/垃圾 → null', parseSbfMeta('-') === null && parseSbfMeta('garbage') === null && parseSbfMeta('') === null);
check('sbt 越界分钟 → null', parseSbfMeta('99999-470-M.84') === null);

// 1f) 跳转生成页默认机型按大圆距离分档（与估算速度分档同阈值 4000km）
import { dispatchTypeForKm } from '../src/simbrief/simbrief';
check('机型分档：<4000km → A21N', dispatchTypeForKm(1435) === 'A21N');
check('机型分档：恰 4000km → A359', dispatchTypeForKm(4000) === 'A359');
check('机型分档：>4000km → A359', dispatchTypeForKm(9565) === 'A359');

// 2) 单 fix 塌缩成对象（XML→JSON 转换坑）→ 至少 2 点才可用的报错路径
try {
  parseOfp({ navlog: { fix: { ident: 'KJFK', pos_lat: '40.6', pos_long: '-73.7' } } });
  check('单 fix 对象：<2 点应抛错', false);
} catch {
  check('单 fix 对象：<2 点应抛错', true);
}

// 3) DMS 兜底格式 N040.38.328 = 40°38.328′
const r4 = parseOfp({
  general: { origin_icao: 'EDDF', dest_icao: 'KJFK' },
  origin: { icao_code: 'EDDF' },
  destination: { icao_code: 'KJFK' },
  navlog: {
    fix: [
      { ident: 'EDDF', pos_lat: 'N050.03.000', pos_long: 'W008.34.000' },
      { ident: 'KJFK', pos_lat: 'N040.38.328', pos_long: 'W073.46.382' },
    ],
  },
});
check(
  'DMS 兜底：N040.38.328 ≈ 40.6388',
  Math.abs(r4.waypoints[1].lat - (40 + 38.328 / 60)) < 1e-6,
  `${r4.waypoints[1].lat}`,
);
check(
  'DMS 兜底：西经为负',
  Math.abs(r4.waypoints[1].lon - -(73 + 46.382 / 60)) < 1e-6,
  `${r4.waypoints[1].lon}`,
);

// 5) 相邻重复坐标去重（爬升/巡航/下降记录同一点位）
const r5 = parseOfp({
  general: { origin_icao: 'AAAA', dest_icao: 'BBBB' },
  navlog: {
    fix: [
      { ident: 'AAAA', pos_lat: '10.0', pos_long: '10.0' },
      { ident: 'AAAA', pos_lat: '10.000000', pos_long: '10.000000' },
      { ident: 'MID', pos_lat: '10.5', pos_long: '10.5' },
      { ident: 'BBBB', pos_lat: '11.0', pos_long: '11.0' },
    ],
  },
});
check('相邻重复点去重：4 条 fix → 3 航点', r5.waypoints.length === 3);

// 6) API 错误透传
try {
  parseOfp({ fetch: { status: 'Error: Unknown UserID' } });
  check('API 错误透传', false);
} catch (e) {
  check('API 错误透传', e instanceof Error && e.message === 'Unknown UserID', String(e));
}

// 7) 数值型坐标（防御）
const r7 = parseOfp({
  navlog: {
    fix: [
      { ident: 'A', pos_lat: 10.5, pos_long: 20.25 },
      { ident: 'B', pos_lat: 11.5, pos_long: 21.25 },
    ],
  },
});
check('数值型坐标', r7.waypoints.length === 2 && r7.waypoints[0].lat === 10.5);

// 8) polyline 编解码往返（问题 3 的 URL 快照持久化）
import { decodePolyline, encodePolyline } from '../src/simbrief/simbrief';
const lhrSin = r1.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
const enc = encodePolyline(lhrSin);
check('polyline：编码是紧凑 ASCII', /^[\x3F-\x7E]+$/.test(enc), `${enc.length} 字符`);
const dec = decodePolyline(enc);
check(
  'polyline：往返精度 ≤1e-5 度',
  dec.length === lhrSin.length &&
    dec.every((p, i) => Math.abs(p.lat - lhrSin[i].lat) < 1e-5 && Math.abs(p.lon - lhrSin[i].lon) < 1e-5),
);
// 负坐标与跨日界线（±179）
const tricky = [
  { lat: -33.9, lon: 151.2 },
  { lat: 35.5, lon: 139.8 },
  { lat: 21.3, lon: -157.9 },
  { lat: 1.36, lon: 179.99 },
  { lat: -1.36, lon: -179.99 },
];
const dec2 = decodePolyline(encodePolyline(tricky));
check(
  'polyline：负值/跨日界线往返',
  dec2.every((p, i) => Math.abs(p.lat - tricky[i].lat) < 1e-5 && Math.abs(p.lon - tricky[i].lon) < 1e-5),
);
check('polyline：损坏输入返回空数组而非抛错', (() => {
  try {
    const pts = decodePolyline('!!!!garbage!!!!');
    return Array.isArray(pts);
  } catch {
    return false;
  }
})());

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
// 不用 process.exit：本机 Git Bash 下管道/重定向的 stdout 是异步的，exit 会丢缓冲。
// 自然结束让输出刷净；结果经 default export 交给运行器（或读 exitCode）。
process.exitCode = failed ? 1 : 0;
export default failed;
