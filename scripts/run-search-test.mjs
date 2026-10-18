// test-search.mts 的运行器：用 Vite SSR 加载并执行该测试（TS + JSON 导入由 Vite 处理）。
// 跑法： env -u NODE_OPTIONS node scripts/run-search-test.mjs
// 仅本地保留（.git/info/exclude），不入公开仓库。
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

try {
  const mod = await server.ssrLoadModule('/scripts/test-search.mts');
  // 测试结果是 Promise（异步 IIFE，内部还挂着机场数据 chunk 的动态 import）：
  // 必须先等它跑完再关 server，否则传输先断、动态 import 报 "transport was disconnected"
  const failed = (await mod?.default) ?? 1;
  await server.close();
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('LOAD FAIL', e);
  await server.close();
  process.exitCode = 1;
}
