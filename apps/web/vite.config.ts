import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // @novnc/novnc 1.7 使用 top-level await（WebCodecs 探测）；Electron 与本机 Chrome 都支持 ES2022。
  build: { target: 'es2022' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:47801',
    },
  },
});
