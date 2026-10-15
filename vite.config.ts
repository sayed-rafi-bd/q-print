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
  build: {
    // The Designer is loaded on demand, so its own dependencies have to be a separate chunk or
    // Rollup would pull them back into the entry file and defeat the split. Without this the
    // lazy-load saves nothing.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]@pdfme[\\/]ui[\\/]/.test(id) || /[\\/]antd[\\/]/.test(id)
            || /[\\/]@ant-design[\\/]/.test(id) || /[\\/]rc-[^\\/]*[\\/]/.test(id)
            || /[\\/]date-fns[\\/]/.test(id)) {
            return 'designer-vendor';
          }
          if (/[\\/]@pdfme[\\/](?!ui)[^\\/]*[\\/]/.test(id) || /[\\/]pdf-lib[\\/]/.test(id)
            || /[\\/]bwip-js[\\/]/.test(id)) {
            return 'pdf-vendor';
          }
          if (/[\\/](react-dom|react|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/](@libsql|drizzle-orm)[\\/]/.test(id)) return 'db-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
