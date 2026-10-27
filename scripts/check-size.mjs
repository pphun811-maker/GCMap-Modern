// 首屏性能预算（2026-10-16，对应审查 FND-017）：dist 产物超出预算即退出 1。
// 跑法： npm run size（CI 在 Pages 部署前执行，防止拆分成果被悄悄吃回去）。
// 预算口径：JS/CSS 按 gzip 传输体积计；图片本身已压缩，按原始体积计。
// 调整预算时同步更新 HANDOFF PHASE 2 台账的性能预算一节。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const assets = join(process.cwd(), 'dist', 'assets');

// [文件名正则, 预算 KB, 口径, 说明]（构建产物带 8 位 hash 后缀）
// 2026-10-27 主项目地图整合：旧 Apple 矢量底图的 NASA 绿毯（两张 webp）已退出运行时，
// 对应预算规则一并移除；MapController 预算保持 320KB（当前 295KB，含 Flightline
// 行星光照/夜路/样式/着色器）。这不是放宽预算，新增体积见 REVIEW-REQUEST.md。
const RULES = [
  { re: /^index-.*\.js$/, maxKb: 120, gz: true, label: '首屏 JS（react + 应用 + 搜索壳）' },
  { re: /^index-.*\.css$/, maxKb: 10, gz: true, label: '首屏 CSS' },
  { re: /^MapController-.*\.js$/, maxKb: 320, gz: true, label: 'maplibre + Flightline 异步 chunk' },
  { re: /^MapController-.*\.css$/, maxKb: 12, gz: true, label: 'maplibre 异步 CSS' },
  { re: /^airports-.*\.js$/, maxKb: 380, gz: true, label: '机场数据异步 chunk' },
  { re: /^tz-.*\.js$/, maxKb: 36, gz: true, label: 'tz-lookup 懒加载 chunk（时间线用到才拉取）' },
];

const files = readdirSync(assets);
// Browser-only Pages resource reader and off-main-thread road baking are lazy chunks.
for (const rule of [
  { re: /^staticTiles-.*\.js$/, maxKb: 12, gz: true, label: 'Pages PMTiles reader' },
  { re: /^staticRoadWorker-.*\.js$/, maxKb: 20, gz: true, label: 'Pages road worker' },
  { re: /^staticRoadClient-.*\.js$/, maxKb: 2, gz: true, label: 'Pages road worker client' },
]) {
  if (files.some((file) => rule.re.test(file))) RULES.push(rule);
}
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

let failed = false;
const seen = new Set();
console.log('产物                        实际      预算   说明');
for (const { re, maxKb, gz, label } of RULES) {
  const hit = files.find((f) => re.test(f));
  if (!hit) {
    console.log(`缺文件                      —         ≤${maxKb}KB  ${label}`);
    failed = true;
    continue;
  }
  seen.add(hit);
  const raw = readFileSync(join(assets, hit));
  const size = gz ? gzipSync(raw).length : raw.length;
  const over = size > maxKb * 1024;
  if (over) failed = true;
  console.log(
    `${hit.padEnd(26)} ${kb(size).padStart(8)}   ≤${maxKb}KB  ${over ? '超预算 ✗' : 'ok'}  ${label}`,
  );
}

for (const f of files) {
  if (/\.(js|css)$/.test(f) && !seen.has(f)) {
    console.log(`${f.padEnd(26)} 未纳入预算（新增 chunk？请更新 check-size.mjs 规则）`);
  }
}

console.log(failed ? '\nsize budget: FAIL' : '\nsize budget: ok');
process.exitCode = failed ? 1 : 0;
