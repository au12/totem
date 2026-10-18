// Lists the heaviest meshes in the table.
import { readFileSync } from 'fs';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { Light } from '../src/vpx/vpt/light/light';
const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);
(async () => {
	const pack = await loadPack(process.argv[2], 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	const t: any = pack.table;
	const rows: Array<[number, string]> = [];
	let total = 0;
	for (const item of t.getRenderables()) {
		if (item instanceof Light || item === t) continue;
		let meshes: any;
		try { meshes = item.getMeshes(t, {}, {}); } catch { continue; }
		for (const [k, info] of Object.entries<any>(meshes)) {
			if (!info.mesh) continue;
			const tris = info.mesh.indices.length / 3;
			if (info.isVisible) total += tris;
			rows.push([tris, `${item.getName()}.${k} vis=${info.isVisible} mat=${info.material?.name} map=${info.map?.getName?.()}`]);
		}
	}
	rows.sort((a, b) => b[0] - a[0]);
	for (const r of rows.slice(0, 30)) console.log(r[0], r[1]);
	console.log('total visible tris', total);
})();
