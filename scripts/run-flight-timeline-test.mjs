// test-flight-timeline.mts 的运行器：用 Vite SSR 加载并执行该测试（TS + 动态 import 由 Vite 处理）。
// 跑法： node scripts/run-flight-timeline-test.mjs
// 仅本地保留（.git/info/exclude），不入公开仓库。
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

try {
  const mod = await server.ssrLoadModule('/scripts/test-flight-timeline.mts');
  const failed = (await mod?.default) ?? 1;
  await server.close();
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('LOAD FAIL', e);
  await server.close();
  process.exitCode = 1;
}
