import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
