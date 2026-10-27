import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createMapResourceMiddleware } from './server/mapResources.mjs';

// 地图资源（PMTiles Range / 夜路几何 / 游戏纹理与字体 / 冰雪支撑掩膜）挂在主项目
// 自己的 /map-res/ 前缀下：dev 与 preview 共用同一中间件，浏览器侧只看到同源路径。
// 纯静态托管（GitHub Pages）没有 Node 中间件，本阶段不部署；见 HANDOFF Phase 3。
function mapResources(): Plugin {
  return {
    name: 'flightline-map-resources',
    configureServer(server) {
      server.middlewares.use(createMapResourceMiddleware(server.config.base) as unknown as Connect.NextHandleFunction);
    },
    configurePreviewServer(server) {
      server.middlewares.use(createMapResourceMiddleware(server.config.base) as unknown as Connect.NextHandleFunction);
    },
  };
}

export default defineConfig({
  plugins: [react(), mapResources()],
  build: {
    // 拆分后的异步 chunk（maplibre ~1MB、机场数据 ~1.3MB）本就超过 500KB 默认阈值，
    // 属于性能预算内的设计结果（scripts/check-size.mjs 管），压掉构建警告噪音
    chunkSizeWarningLimit: 1400,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
