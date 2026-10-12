import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `tauri android dev` sets TAURI_DEV_HOST to the machine's LAN IP so the phone can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
