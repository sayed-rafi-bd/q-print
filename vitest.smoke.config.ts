import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/db/smoke.check.ts'],
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
  },
});
