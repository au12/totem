// Production build: bundles the front end, fingerprints every asset so it can
// be cached forever, writes the service worker's precache list, and stores
// Brotli + gzip variants next to each file for the server to hand out.

import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const pub = path.join(root, 'public');
const out = path.join(root, 'dist');
const assets = path.join(out, 'assets');
const watch = process.argv.includes('--watch');

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

async function compress(dir) {
  const compressible = /\.(html|js|mjs|css|json|webmanifest|svg|txt)$/i;
  const files = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (compressible.test(e.name)) files.push(p);
    }
  };
  await walk(dir);
  await Promise.all(files.map(async (f) => {
    const data = await fs.readFile(f);
    if (data.length < 1024) return;
    const br = zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      },
    });
    const gz = zlib.gzipSync(data, { level: 9 });
    if (br.length < data.length * 0.95) await fs.writeFile(f + '.br', br);
    if (gz.length < data.length * 0.95) await fs.writeFile(f + '.gz', gz);
  }));
}

async function main() {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(assets, { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const buildInfo = { version: process.env.VERSION || pkg.version };

  const options = {
    entryPoints: { app: path.join(src, 'main.ts') },
    bundle: true,
    format: 'esm',
    target: ['es2022', 'chrome100', 'firefox110', 'safari16'],
    minify: !watch,
    sourcemap: false,
    legalComments: 'linked',
    outdir: assets,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    metafile: true,
    loader: { '.woff2': 'file', '.woff': 'file', '.png': 'file', '.json': 'json' },
    define: { __BUILD__: JSON.stringify(buildInfo), global: 'globalThis' },
    inject: [path.join(root, 'tools/buffer-shim.js')],
    logLevel: 'info',
  };

  const finish = async (result) => {
    const outputs = Object.keys(result.metafile.outputs);
    const rel = (p) => path.relative(out, path.resolve(root, p)).split(path.sep).join('/');
    const entry = outputs.find((o) => result.metafile.outputs[o].entryPoint?.endsWith('main.ts'));
    const css = outputs.find((o) => o.endsWith('.css'));
    const appJs = rel(entry);
    const appCss = css ? rel(css) : null;

    await fs.cp(pub, out, { recursive: true });
    const licenses = {
      'three-MIT.txt': 'node_modules/three/LICENSE',
      'fflate-MIT.txt': 'node_modules/fflate/LICENSE',
      'buffer-MIT.txt': 'node_modules/buffer/LICENSE',
      'events-MIT.txt': 'node_modules/events/LICENSE',
      'Antonio-OFL.txt': 'node_modules/@fontsource/antonio/LICENSE',
      'Jost-OFL.txt': 'node_modules/@fontsource-variable/jost/LICENSE',
      'vpx-js-GPL-2.0.txt': 'src/vpx/LICENSE',
    };
    await fs.mkdir(path.join(out, 'licenses'), { recursive: true });
    for (const [name, from] of Object.entries(licenses)) {
      await fs.copyFile(path.join(root, from), path.join(out, 'licenses', name));
    }

    let html = await fs.readFile(path.join(src, 'index.html'), 'utf8');
    html = html
      .replace('<!--build:head-->', [
        appCss && `<link rel="stylesheet" href="${appCss}">`,
        `<link rel="modulepreload" href="${appJs}">`,
      ].filter(Boolean).join('\n  '))
      .replace('<!--build:body-->', `<script type="module" src="${appJs}"></script>`);
    await fs.writeFile(path.join(out, 'index.html'), html);

    const assetFiles = (await fs.readdir(assets))
      .filter((f) => !/\.(map|br|gz|txt|woff)$/.test(f) && !/LEGAL/.test(f))
      .map((f) => `assets/${f}`);
    const precache = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', ...assetFiles];
    const version = hashOf(precache.join('\n') + html);
    const sw = (await fs.readFile(path.join(src, 'sw.js'), 'utf8'))
      .replaceAll("'__VERSION__'", JSON.stringify(version))
      .replaceAll('__PRECACHE__', JSON.stringify(precache));
    if (sw.includes('__VERSION__') || sw.includes('__PRECACHE__')) throw new Error('sw.js placeholders were not filled in');
    await fs.writeFile(path.join(out, 'sw.js'), sw);
    await fs.writeFile(path.join(out, 'build.json'), JSON.stringify({ ...buildInfo, build: version, builtAt: new Date().toISOString() }, null, 2));
    return version;
  };

  if (watch) {
    const ctx = await context({ ...options, plugins: [{ name: 'finish', setup(b) { b.onEnd((r) => r.metafile && finish(r)); } }] });
    await ctx.watch();
    console.log('Watching for changes…');
    return;
  }

  const result = await build(options);
  const version = await finish(result);
  await compress(out);
  const js = (await fs.stat(path.join(out, Object.keys(result.metafile.outputs).find((o) => o.endsWith('.js') && result.metafile.outputs[o].entryPoint).replace(/^dist\//, '')))).size;
  console.log(`Built ${version}: app ${(js / 1024).toFixed(0)} KiB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
