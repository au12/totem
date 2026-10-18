// Fires balls at a rubber ring and reports any that end up inside it.
import { readFileSync } from 'fs';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { Sim } from '../src/engine/sim';
import { Vertex3D } from '../src/vpx/math/vertex3d';
const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);
function inside(poly: number[][], x: number, y: number) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }
(async () => {
	const [dir, name, nStr] = process.argv.slice(2);
	const pack = await loadPack(dir, 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	const sim = new Sim(pack.table);
	const rubber: any = (pack.table as any).rubbers[name];
	const poly = rubber.data.dragPoints.map((d: any) => [d.vertex.x, d.vertex.y]);
	const cx = poly.reduce((a: number, p: number[]) => a + p[0], 0) / poly.length, cy = poly.reduce((a: number, p: number[]) => a + p[1], 0) / poly.length;
	if (process.env.BRUTE) {
		const phys: any = sim.physics;
		phys.hitOcTree.hitTestBall = (ball: any, coll: any, physics: any) => {
			const bb = ball.hit.hitBBox;
			for (const h of phys.hitObjects) {
				const o = h.hitBBox;
				if (o.right < bb.left || o.left > bb.right || o.bottom < bb.top || o.top > bb.bottom || o.zhigh < bb.zlow || o.zlow > bb.zhigh) continue;
				h.doHitTest(ball, coll, physics);
			}
		};
	}
	let t = 0, bad = 0;
	const N = +(nStr || 200);
	for (let i = 0; i < N; i++) {
		const ang = Math.random() * Math.PI * 2, dist = 110 + Math.random() * 60;
		const x = cx + Math.cos(ang) * dist, y = cy + Math.sin(ang) * dist;
		const sp = 10 + Math.random() * 70;
		const dx = cx - x + (Math.random() - 0.5) * 60, dy = cy - y + (Math.random() - 0.5) * 60; const l = Math.hypot(dx, dy);
		const ball = sim.player.createBall({ getBallCreationPosition: () => new Vertex3D(x, y, 0), getBallCreationVelocity: () => new Vertex3D(dx / l * sp, dy / l * sp, 0), onBallCreated() {} } as any);
		for (let k = 0; k < 60; k++) { t += 5; sim.advanceTo(t); }
		const p = ball.state.pos;
		if (inside(poly, p.x, p.y)) { bad++; console.log('INSIDE', i, 'start', x.toFixed(0), y.toFixed(0), 'speed', sp.toFixed(1), 'end', p.x.toFixed(0), p.y.toFixed(0), p.z.toFixed(0)); }
		sim.player.destroyBall(ball);
	}
	console.log('done', bad, '/', N);
})();
