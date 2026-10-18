// Headless physics smoke test: node tools/run-ts.mjs tools/sim.ts <packDir>
import { readFileSync } from 'fs';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { Player } from '../src/vpx/game/player';

const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);

(async () => {
	const dir = process.argv[2];
	const t0 = Date.now();
	const pack = await loadPack(dir, 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	console.log('loaded', pack.manifest.name, Object.keys(pack.table.items).length, 'items in', Date.now() - t0, 'ms');
	const table: any = pack.table;
	const player = new Player(table).init();
	const kick = table.kickers.BallRelease.getApi();
	const ball = kick.CreateBall(); kick.Kick(90, 6);
	let t = 0; const step = (ms: number) => { t += ms; player.updatePhysics(t); };
	step(1500);
	const pl = table.plungers.Plunger.getApi();
	pl.PullBack(); step(1200); pl.Fire();
	for (let i = 0; i < 30; i++) { step(100); const p = ball.getState().pos; console.log(t, p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)); }
})().catch(e => { console.error(e); process.exit(1); });
