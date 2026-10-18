// 本地持久化功能回归测试（草稿/收藏共用的航线快照编解码 + 足迹纯函数 + 存储降级）。
// 跑法： node scripts/run-local-features-test.mjs
// 依赖 Vite SSR 加载真实模块（search 机场数据 / simbrief 编解码），
// decodeRoute 经 findByCode 依赖机场索引，需先等 airportsReady。
import {
  decodeRoute, encodeRoute, readFavorites, readJournal, toggleVisited, sumJournalKm,
  type SavedRoute,
} from '../src/state/saved';
import { airportsReady, findByCode } from '../src/data/search';
import type { RouteEntry } from '../src/map/MapController';

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

export default (async () => {
  await airportsReady;

  console.log('saved: 航线快照编解码');
  const pek = findByCode('PEK')!;
  const lax = findByCode('LAX')!;
  check('测试夹具机场可解析', !!pek && !!lax);
  const route: RouteEntry = {
    id: 'rt-t1', airports: [pek, lax], visible: true, color: '#123ABC', width: 1.5,
  };
  const snap = encodeRoute(route);
  check('encode: 代码序列（IATA 优先）', snap.c[0] === 'PEK' && snap.c[1] === 'LAX', JSON.stringify(snap.c));
  check('encode: 样式（显隐/颜色/粗细）', snap.vis === 1 && snap.col === '#123ABC' && snap.w === 1.5);
  const back = decodeRoute(snap);
  check('decode: 机场与样式往返', !!back
    && back.airports[0].iata === 'PEK'
    && back.airports[1].iata === 'LAX'
    && back.color === '#123ABC'
    && back.width === 1.5
    && back.visible === true);
  check('decode: 分配新 id（不与原航线撞号）', !!back && back.id !== route.id);
  check('decode: 大圆弧航线无 waypoints', !!back && back.waypoints === undefined);

  const wpRoute: RouteEntry = {
    ...route,
    // 首末航点贴近起降机场（真实 OFP 语义；decodeRoute 会拒绝端点远离机场的折线）
    waypoints: [
      { ident: '', lat: 40.0801, lon: 116.5846 }, // PEK
      { ident: '', lat: 45.0, lon: 60.0 }, // 中途航点
      { ident: '', lat: 33.9425, lon: -118.4081 }, // LAX
    ],
    ofp: { timeMin: 700, tasKts: 480, mach: 'M.85' },
  };
  const back2 = decodeRoute(encodeRoute(wpRoute))!;
  check('decode: 真实航路折线还原', back2.waypoints?.length === 3
    && Math.abs(back2.waypoints[1].lat - 45) < 1e-4
    && Math.abs(back2.waypoints[1].lon - 60) < 1e-4
    && Math.abs(back2.waypoints[0].lat - 40.0801) < 1e-4);
  check('decode: 计划元数据还原', back2.ofp?.timeMin === 700
    && back2.ofp?.tasKts === 480
    && back2.ofp?.mach === 'M.85');
  check('decode: 隐藏航线往返', decodeRoute(encodeRoute({ ...route, visible: false }))!.visible === false);

  console.log('saved: 坏数据防御');
  check('decode: 未知代码 → 整条放弃', decodeRoute({ c: ['PEK', 'ZZZZ'], vis: 1, col: '#fff', w: 1 }) === null);
  check('decode: 不足两站 → null', decodeRoute({ c: ['PEK'], vis: 1, col: '#fff', w: 1 }) === null);
  const bad = decodeRoute({ c: ['PEK', 'LAX'], vis: 0, col: 'javascript:alert(1)', w: 99 } as unknown as SavedRoute);
  check('decode: 坏颜色回退默认色', bad?.color === '#0B7BE8', bad?.color);
  check('decode: 越界粗细回退 1', bad?.width === 1);
  check('decode: 坏折线退回大圆弧', decodeRoute({ c: ['PEK', 'LAX'], vis: 1, col: '#fff', w: 1, wp: '!!坏数据!!' })?.waypoints === undefined);

  console.log('saved: 足迹纯函数');
  check('toggleVisited: 加入 → 移除', JSON.stringify(toggleVisited(toggleVisited([], 'PEK'), 'PEK')) === '[]');
  check('toggleVisited: 已存在则移除', toggleVisited(['PEK'], 'PEK').length === 0);
  check('toggleVisited: 新增不重复', toggleVisited(['LAX'], 'PEK').length === 2
    && toggleVisited(['LAX'], 'PEK').filter((c) => c === 'PEK').length === 1);
  check('sumJournalKm: 求和', sumJournalKm([
    { id: 'a', codes: 'A-B', km: 100, at: 0 },
    { id: 'b', codes: 'C-D', km: 23.6, at: 0 },
  ]) === 123.6);
  check('sumJournalKm: 忽略坏数据', sumJournalKm([
    { id: 'a', codes: 'A-B', km: 100, at: 0 },
    { id: 'b', codes: 'C-D', km: NaN, at: 0 },
  ]) === 100);

  console.log('saved: 存储降级（无 localStorage 环境 = SSR/隐私模式）');
  check('readJournal: 安全返回空', Array.isArray(readJournal().visited) && Array.isArray(readJournal().entries));
  check('readFavorites: 安全返回空', Array.isArray(readFavorites()));

  console.log(`\nlocal-features: ${passed} passed / ${failed} failed`);
  return failed;
})();
