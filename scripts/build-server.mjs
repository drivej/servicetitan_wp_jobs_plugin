import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts', 'src/server/migrate.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  outdir: 'dist/server',
  external: ['express', 'vite', 'dotenv', 'dotenv/config', 'pg', 'openid-client', 'undici', 'ipaddr.js'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
