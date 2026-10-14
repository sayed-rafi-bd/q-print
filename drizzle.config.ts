import { defineConfig } from 'drizzle-kit';
import { readFileSync } from 'node:fs';

// Read from .env the same way the app does, so `pnpm db:*` talks to the same database the app does.
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: env.VITE_TURSO_URL,
    authToken: env.VITE_TURSO_TOKEN,
  },
  // The migrations are applied by the app at start-up as well as by `pnpm db:migrate`.
  strict: true,
  verbose: true,
});
