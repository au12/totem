// Quick development build of the harness into dev-dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
mkdirSync('dev-dist', { recursive: true });
cpSync('src/dev.html', 'dev-dist/index.html');
const opts = { entryPoints: { dev: 'src/dev.ts' }, bundle: true, format: 'esm', outdir: 'dev-dist', sourcemap: true, target: 'es2022', logLevel: 'warning', loader: { '.json': 'json', '.png': 'file' }, define: { global: 'globalThis' }, inject: ['tools/buffer-shim.js'] };
if (process.argv.includes('--watch')) { const ctx = await context(opts); await ctx.watch(); } else { await build(opts); }
