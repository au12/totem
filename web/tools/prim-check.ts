// Checks PrimitiveTransform against vpx-js's mesh generator: the baked mesh
// moved by the node matrix must match a mesh generated at the new placement.
// Run: node tools/run-ts.mjs tools/prim-check.ts <packDir>
import { readFileSync } from 'fs';
import { Matrix4, Vector3 } from 'three';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { PrimitiveTransform } from '../src/render/primitive-transform';
const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);
(async () => {
	const pack = await loadPack(process.argv[2], 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	const t: any = pack.table;
	const cases: Array<[string, number, number]> = [['lflipb', 2, 70], ['rflipb', 2, -70], ['FlipperRSh', 2, -70], ['Pgate', 0, 60], ['VariTargetP', 0, -12], ['Pkickarm', 2, 40], ['SLING1', 5, -20]];
	let worst = 0;
	for (const [name, idx, value] of cases) {
		const p = t.primitives[name];
		const d = p.data;
		const baked = p.getMeshes(t).primitive.mesh;
		const xf = new PrimitiveTransform({ position: d.position, size: d.size, rotAndTra: [...d.rotAndTra] }, t.getScaleZ());
		const now = [...d.rotAndTra];
		now[idx] = value;
		const m = xf.matrix({ position: d.position, size: d.size, rotAndTra: now }, new Matrix4());
		// Reference: regenerate the mesh with the new placement.
		const saved = d.rotAndTra[idx];
		d.rotAndTra[idx] = value;
		p.mesh = undefined;
		const ref = p.getMeshes(t).primitive.mesh;
		d.rotAndTra[idx] = saved;
		p.mesh = undefined;
		let err = 0;
		const v = new Vector3();
		for (let i = 0; i < baked.vertices.length; i += 7) {
			const b = baked.vertices[i], r = ref.vertices[i];
			v.set(b.x, b.y, b.z).applyMatrix4(m);
			err = Math.max(err, Math.hypot(v.x - r.x, v.y - r.y, v.z - r.z));
		}
		worst = Math.max(worst, err);
		console.log(name.padEnd(12), `rotAndTra[${idx}] ${d.rotAndTra[idx]} -> ${value}`, 'max error', err.toFixed(4));
	}
	console.log(worst < 0.05 ? 'OK' : 'MISMATCH');
})();
