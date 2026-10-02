import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // Relative base so the build works when served from a GitHub Pages subpath.
  base: './',
  build: {
    // `npm run build:preview` inlines models into the JS so the whole game is one script file,
    // for hosts that only serve web file types (the claude.ai preview link).
    assetsInlineLimit: mode === 'preview' ? Infinity : 4096,
    outDir: mode === 'preview' ? 'dist-preview' : 'dist',
  },
}));
