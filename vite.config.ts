import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: 'dist', sourcemap: false },
});
