// 观感动画包回归测试（本地保留，.git/info/exclude，不入公开仓库）
// 跑法： node scripts/run-route-anim-test.mjs
// 覆盖：生长切片（多段顺序/边界/原样返回）、缓动、时长与循环时长夹紧、
//       巡航路径拼接（共享端点去重）、时刻插值（端点/中点/段缓存一致性）。
import {
  buildPlanePath, easeInOutCubic, growDurationMs, planeAt, planeLoopSec,
  revealLineFeatures, type PlanePath,
} from '../src/geo/routeAnim';

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

console.log('anim: 缓动与时长');
check('ease(0)=0', easeInOutCubic(0) === 0);
check('ease(0.5)=0.5', Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-9);
check('ease(1)=1', easeInOutCubic(1) === 1);
check('ease 单调', [0.1, 0.3, 0.5, 0.7, 0.9].every((t, i, a) => i === 0 || easeInOutCubic(t) > easeInOutCubic(a[i - 1])));
check('grow 1 段=700ms', growDurationMs(1) === 700);
check('grow 2 段=1000ms', growDurationMs(2) === 1000);
check('grow 长航线封顶 1600ms', growDurationMs(99) === 1600);
check('loop 短航班夹紧下限', planeLoopSec(60) === 5, String(planeLoopSec(60)));
check('loop 等比（300min→8.4s）', Math.abs(planeLoopSec(300) - 8.4) < 1e-9, String(planeLoopSec(300)));
check('loop 超长航班夹紧上限', planeLoopSec(2000) === 24);

console.log('anim: 生长切片');
const mk = (n: number, tag: string) => ({
  properties: { leg: tag },
  geometry: { coordinates: Array.from({ length: n }, (_, i) => [i, i] as [number, number]) },
});
const feats = [mk(4, 'a'), mk(4, 'b')];
check('reveal 1 → 首段 1 点', JSON.stringify(revealLineFeatures(feats, 1)[0].geometry.coordinates) === '[[0,0]]');
check('reveal 1 → 后段不出现', revealLineFeatures(feats, 1).length === 1);
check('reveal 4 → 首段全量', revealLineFeatures(feats, 4)[0].geometry.coordinates.length === 4);
check('reveal 5 → 首段全量+次段 1 点', revealLineFeatures(feats, 5).length === 2 && revealLineFeatures(feats, 5)[1].geometry.coordinates.length === 1);
check('reveal ≥ 总数 → 返回原引用', revealLineFeatures(feats, 8) === feats);
check('reveal 0 → 至少 1 点', revealLineFeatures(feats, 0)[0].geometry.coordinates.length === 1);
check('切片不改动原 features', feats[0].geometry.coordinates.length === 4);
check('properties 保留', revealLineFeatures(feats, 6)[1].properties.leg === 'b');

console.log('anim: 巡航路径与时刻');
// 两段共享端点 (2,2)：A(0,0) → B(2,2) → C(4,2)（维度同一小范围内公里级近似）
const legs: [number, number][][] = [
  [[0, 0], [1, 1], [2, 2]],
  [[2, 2], [3, 2], [4, 2]],
];
const path: PlanePath = buildPlanePath(legs);
check('共享端点去重（6 → 5 点）', path.coords.length === 5, JSON.stringify(path.coords));
check('逐点朝向数 = 点数-1', path.bearings.length === 4);
check('累积里程单调且末端=总里程', path.cumKm.every((v, i, a) => i === 0 || v > a[i - 1]) && Math.abs(path.cumKm[4] - path.totalKm) < 1e-9);
const p0 = planeAt(path, 0);
check('t=0 在起点', p0.lngLat[0] === 0 && p0.lngLat[1] === 0);
check('t=0 朝向第一段', p0.bearing === path.bearings[0]);
const pEnd = planeAt(path, 1 - 1e-12);
check('t≈1 临近终点', Math.abs(pEnd.lngLat[0] - 4) < 0.01 && Math.abs(pEnd.lngLat[1] - 2) < 0.01);
// 第二段比第一段短（2km vs 2.83km），t=0.6 应已进入第二段
const mid = planeAt(path, 0.6);
check('t=0.6 命中第二段', mid.seg >= 2, `seg=${mid.seg}`);
check('段缓存一致性（fromSeg 起扫结果相同）', JSON.stringify(planeAt(path, 0.6, 2)) === JSON.stringify(mid));
check('t=0.5 落在两段之间', Math.abs(planeAt(path, 0.5).lngLat[0]) > 0 && planeAt(path, 0.5).lngLat[0] < 4);

console.log(`\nroute-anim: ${passed} passed / ${failed} failed`);
export default failed;
