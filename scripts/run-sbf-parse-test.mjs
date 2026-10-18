// test-sbf-parse.mts 的运行器：用 Vite SSR 加载并执行该测试。
// 背景（2026-10-10 实测）：旧文档说用 esbuild 打包，但 Vite 8 用 rolldown，依赖里没有 esbuild，
// 直接 `node scripts/test-sbf-parse.mts` 也跑不了（TS 语法）。Vite SSR 能原生处理 TS + 相对导入。
// 跑法： env -u NODE_OPTIONS node scripts/run-sbf-parse-test.mjs
// 测试文件自带 process.exit(0/1)，跑完进程即退出。
// 仅本地保留（.git/info/exclude），不入公开仓库。
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

try {
  const mod = await server.ssrLoadModule('/scripts/test-sbf-parse.mts');
  await server.close();
  // 测试文件自然结束（不再自带 process.exit），结果经 default export 带回
  process.exitCode = mod?.default ? 1 : 0;
} catch (e) {
  console.error('LOAD FAIL', e);
  await server.close();
  process.exitCode = 1;
}
