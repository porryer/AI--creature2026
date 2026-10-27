import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 模式：
// - 默认：读取 VITE_BACKEND（api 连接后端，mock 使用本地模拟数据）
// - single：离线演示版，输出单个内联 HTML（固定为 mock 模式）
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  resolve: {
    alias: { '@creature/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  define: mode === 'single' ? { 'import.meta.env.VITE_BACKEND': JSON.stringify('mock') } : {},
  server: {
    proxy: { '/v1': { target: process.env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true } },
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
  },
}));
