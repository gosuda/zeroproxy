import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  appType: 'custom',
  publicDir: false,
  build: {
    outDir: 'dist/web',
    emptyOutDir: false,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.join(repoRoot, 'web/runtime-prelude.mjs'),
      output: {
        entryFileNames: 'runtime-prelude.js',
        format: 'iife',
      },
    },
  },
});
