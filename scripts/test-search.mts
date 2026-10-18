// 机场搜索回归测试（本地保留，.git/info/exclude，不入公开仓库）
// 跑法： env -u NODE_OPTIONS node scripts/run-search-test.mjs
// 覆盖：都市圈别名（搜主城名能找到卫星城机场）+ 原有代码/名称/城市匹配不回归。
// 2026-10-16 起机场数据为懒加载 chunk，查询前先等数据就绪。
import { airportsReady, findByCode, searchAirports } from '../src/data/search';

// 包成异步 IIFE：Vite SSR 对含顶层 await 的模块会提前返回（函数体不执行），
// 结果经 Promise 形式的 default export 带回，runner 侧 await
export default (async () => {
await airportsReady;

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

const codes = (q: string, limit = 8) => searchAirports(q, limit).map((a) => a.iata || a.icao);

console.log('search: 都市圈别名');
check('tokyo 含 HND+NRT', ['HND', 'NRT'].every((c) => codes('tokyo').includes(c)), codes('tokyo').join(','));
check('tokyo 首位是 HND', codes('tokyo')[0] === 'HND', codes('tokyo').join(','));
check('newyork 含 JFK+LGA+EWR', ['JFK', 'LGA', 'EWR'].every((c) => codes('newyork').includes(c)), codes('newyork').join(','));
check('nyc 含 EWR', codes('nyc').includes('EWR'), codes('nyc').join(','));
check('taipei 含 TPE+TSA', ['TPE', 'TSA'].every((c) => codes('taipei').includes(c)), codes('taipei').join(','));
check('kualalumpur 含 KUL+SZB', ['KUL', 'SZB'].every((c) => codes('kualalumpur').includes(c)), codes('kualalumpur').join(','));
check('paris 含 CDG+ORY+BVA', ['CDG', 'ORY', 'BVA'].every((c) => codes('paris').includes(c)), codes('paris').join(','));
check('milan 含 MXP+LIN+BGY', ['MXP', 'LIN', 'BGY'].every((c) => codes('milan').includes(c)), codes('milan').join(','));
check('brussels 含 BRU+CRL', ['BRU', 'CRL'].every((c) => codes('brussels').includes(c)), codes('brussels').join(','));
check('losangeles 含 LAX+LGB+BUR', ['LAX', 'LGB', 'BUR'].every((c) => codes('losangeles').includes(c)), codes('losangeles').join(','));
check('manila 含 MNL+CRK', ['MNL', 'CRK'].every((c) => codes('manila').includes(c)), codes('manila').join(','));
check('mexicocity 含 MEX+TLC', ['MEX', 'TLC'].every((c) => codes('mexicocity').includes(c)), codes('mexicocity').join(','));
check('oslo 含 OSL+TRF', ['OSL', 'TRF'].every((c) => codes('oslo').includes(c)), codes('oslo').join(','));
check('toky 前缀也能带出 NRT', codes('toky').includes('NRT'), codes('toky').join(','));

console.log('search: 短词不被都市圈刷屏（别名需 q>=3）');
// 注意：MEX 本身 city="Mexico City" 就能匹配 "me"（城市前缀），属正常；
// 别名要挡的是 Toluca 这类邻城机场被短词带出来。
check('me 不含 TLC（别名未生效）', !codes('me', 20).includes('TLC'), codes('me', 20).join(','));

console.log('search: 原有匹配不回归');
check('lhr 精确首位', codes('lhr')[0] === 'LHR', codes('lhr').join(','));
check('rjtt 按 ICAO 命中 HND', codes('rjtt').includes('HND'), codes('rjtt').join(','));
check('narita 仍能找到 NRT', codes('narita').includes('NRT'), codes('narita').join(','));
check('findByCode(NRT)', findByCode('NRT')?.iata === 'NRT');
check('findByCode(nrt) 大小写无关', findByCode('nrt')?.icao === 'RJAA');
check('shanghai 含 PVG+SHA', ['PVG', 'SHA'].every((c) => codes('shanghai').includes(c)), codes('shanghai').join(','));
check('beijing 含 PEK+PKX', ['PEK', 'PKX'].every((c) => codes('beijing').includes(c)), codes('beijing').join(','));
check('london 含 LHR+LGW', ['LHR', 'LGW'].every((c) => codes('london').includes(c)), codes('london').join(','));
check('osaka 含 KIX+ITM', ['KIX', 'ITM'].every((c) => codes('osaka').includes(c)), codes('osaka').join(','));
check('bangkok 含 BKK+DMK', ['BKK', 'DMK'].every((c) => codes('bangkok').includes(c)), codes('bangkok').join(','));
check('seoul 含 ICN+GMP', ['ICN', 'GMP'].every((c) => codes('seoul').includes(c)), codes('seoul').join(','));
check('istanbul 含 IST+SAW', ['IST', 'SAW'].every((c) => codes('istanbul').includes(c)), codes('istanbul').join(','));
check('moscow 含 SVO+DME', ['SVO', 'DME'].every((c) => codes('moscow').includes(c)), codes('moscow').join(','));
check('dubai 含 DXB+DWC', ['DXB', 'DWC'].every((c) => codes('dubai').includes(c)), codes('dubai').join(','));
check('空串返回空', codes('').length === 0);
check('乱码不崩且为空', codes('zzzzqq').length === 0);
check('limit 生效', searchAirports('tokyo', 1).length === 1);
check('结果去重（同代码不重复）', new Set(codes('london', 8)).size === codes('london', 8).length);

console.log(`\nsearch: ${passed} passed / ${failed} failed`);
return failed;
})();
