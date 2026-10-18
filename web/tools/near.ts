// Lists collidable hit shapes near a point.
import { readFileSync } from 'fs';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { Sim } from '../src/engine/sim';
const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);
(async () => {
	const [dir, xs, ys, rs] = process.argv.slice(2);
	const X = +xs, Y = +ys, R = +(rs || 40);
	const pack = await loadPack(dir, 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	const sim = new Sim(pack.table);
	const phys: any = sim.physics;
	const counts: { [k: string]: number } = {};
	for (const h of phys.hitObjects) {
		const bb = h.hitBBox;
		if (bb.left - R > X || bb.right + R < X || bb.top - R > Y || bb.bottom + R < Y) continue;
		const name = h.obj?.playable?.getName?.() ?? '?';
		const key = `${name} ${h.getType()} z[${bb.zlow.toFixed(0)},${bb.zhigh.toFixed(0)}]`;
		counts[key] = (counts[key] || 0) + 1;
	}
	for (const [k, v] of Object.entries(counts)) console.log(v, k);
})();
