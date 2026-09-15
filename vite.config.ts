import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { output: { entryFileNames: 'assets/game.js', assetFileNames: 'assets/[name][extname]' } },
  },
  server: { port: 5173, strictPort: false },
});
