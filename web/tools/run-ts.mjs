// Bundles a TypeScript tool with esbuild and runs it in Node.
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const [entry, ...args] = process.argv.slice(2);
const out = join(mkdtempSync(join(tmpdir(), 'tw-')), 'tool.cjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning', loader: { '.json': 'json' } });
process.argv = [process.argv[0], out, ...args];
await import(pathToFileURL(out).href);
