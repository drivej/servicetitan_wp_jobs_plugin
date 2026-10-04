import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts', 'src/server/migrate.ts', 'src/server/check-database.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  outdir: 'dist/server',
  external: ['express', 'vite', 'dotenv', 'dotenv/config', 'pg', 'openid-client', 'undici', 'ipaddr.js', 'stripe'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
