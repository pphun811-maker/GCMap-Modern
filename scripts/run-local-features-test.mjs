// test-local-features.mts 的运行器：用 Vite SSR 加载并执行该测试（TS + 相对导入由 Vite 处理）。
// 跑法： node scripts/run-local-features-test.mjs
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

try {
  const mod = await server.ssrLoadModule('/scripts/test-local-features.mts');
  // 测试结果是 Promise（异步 IIFE：内部要等机场数据 chunk 就绪）
  const failed = (await mod?.default) ?? 1;
  await server.close();
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('LOAD FAIL', e);
  await server.close();
  process.exitCode = 1;
}
