import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig(({ mode }) => ({
  // Relative base so the build works when served from a GitHub Pages subpath.
  base: './',
  // Rapier's physics engine ships as a .wasm file, compiled while it downloads. The single-file
  // preview can't fetch one, so it uses the compat package, which inlines the wasm in its script.
  plugins: mode === 'preview' ? [] : [wasm()],
  resolve: mode === 'preview' ? { alias: { '@dimforge/rapier3d': '@dimforge/rapier3d-compat' } } : {},
  build: {
    // `npm run build:preview` inlines models into the JS so the whole game is one script file,
    // for hosts that only serve web file types (the claude.ai preview link).
    assetsInlineLimit: mode === 'preview' ? Infinity : 4096,
    outDir: mode === 'preview' ? 'dist-preview' : 'dist',
    // The preview host caps each file at 16 MB, so the inlined models go in chunks of their own
    // beside the game's script: the tunnels', and everything else.
    rolldownOptions:
      mode === 'preview'
        ? {
            output: {
              manualChunks: (id: string) => (id.includes('/src/assets/') ? (id.includes('/tunnels') ? 'models-tunnels' : 'models') : undefined),
              // Fixed names, so each publish replaces the same files.
              entryFileNames: 'assets/game.js',
              chunkFileNames: 'assets/[name].js',
            },
          }
        : {},
  },
}));
