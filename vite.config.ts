import { configDefaults } from 'vitest/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `tauri android dev` sets TAURI_DEV_HOST to the machine's LAN IP so the phone can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // `src/test/setup.ts` gives the node test environment the `localStorage` the app uses.
  test: { setupFiles: ['./src/test/setup.ts'], exclude: [...configDefaults.exclude, 'e2e/**'] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
