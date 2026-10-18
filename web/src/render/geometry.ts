/*
 * Converts VPX meshes (vpx-js render space: x right, y towards the player,
 * z = -height, clockwise front faces) into three.js geometry.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { Mesh } from '../vpx/vpt/mesh';

export function meshToGeometry(mesh: Mesh): BufferGeometry {
	const n = mesh.vertices.length;
	const pos = new Float32Array(n * 3);
	const nrm = new Float32Array(n * 3);
	const uv = new Float32Array(n * 2);
	let hasUv = false;
	for (let i = 0; i < n; i++) {
		const v = mesh.vertices[i];
		pos[i * 3] = v.x;
		pos[i * 3 + 1] = v.y;
		pos[i * 3 + 2] = v.z;
		nrm[i * 3] = v.nx;
		nrm[i * 3 + 1] = v.ny;
		nrm[i * 3 + 2] = v.nz;
		if (v.tu !== undefined && v.tv !== undefined && !Number.isNaN(v.tu)) {
			uv[i * 2] = v.tu;
			uv[i * 2 + 1] = v.tv;
			hasUv = true;
		}
	}
	const idx = mesh.indices;
	const index = n > 65535 ? new Uint32Array(idx.length) : new Uint16Array(idx.length);
	// Reverse each triangle: VPX is clockwise-front, WebGL counter-clockwise.
	for (let i = 0; i + 2 < idx.length; i += 3) {
		index[i] = idx[i + 2];
		index[i + 1] = idx[i + 1];
		index[i + 2] = idx[i];
	}
	const g = new BufferGeometry();
	g.setAttribute('position', new BufferAttribute(pos, 3));
	g.setAttribute('normal', new BufferAttribute(nrm, 3));
	g.setAttribute('uv', new BufferAttribute(uv, 2));
	g.setIndex(new BufferAttribute(index, 1));
	g.name = mesh.name;
	if (!hasUv) {
		g.userData.noUv = true;
	}
	g.computeBoundingSphere();
	return g;
}

/**
 * Vertex-clustering simplification for small, dense meshes (screws, nuts):
 * vertices within a grid cell are merged and collapsed triangles dropped.
 * Normals are averaged per cluster, which keeps small parts looking round.
 */
export function decimate(g: BufferGeometry, cell: number): BufferGeometry {
	const pos = g.attributes.position.array as Float32Array;
	const nrm = g.attributes.normal.array as Float32Array;
	const uv = g.attributes.uv.array as Float32Array;
	const index = g.index!.array;
	const n = pos.length / 3;
	const inv = 1 / cell;
	const clusterOf = new Int32Array(n);
	const keys = new Map<string, number>();
	const acc: number[][] = []; // x y z nx ny nz u v count
	for (let i = 0; i < n; i++) {
		// Keep creases: vertices with very different normals do not merge.
		const key = `${Math.floor(pos[i * 3] * inv)},${Math.floor(pos[i * 3 + 1] * inv)},${Math.floor(pos[i * 3 + 2] * inv)},${Math.round(nrm[i * 3] * 1.5)},${Math.round(nrm[i * 3 + 1] * 1.5)},${Math.round(nrm[i * 3 + 2] * 1.5)}`;
		let c = keys.get(key);
		if (c === undefined) {
			c = acc.length;
			keys.set(key, c);
			acc.push([0, 0, 0, 0, 0, 0, 0, 0, 0]);
		}
		const a = acc[c];
		a[0] += pos[i * 3]; a[1] += pos[i * 3 + 1]; a[2] += pos[i * 3 + 2];
		a[3] += nrm[i * 3]; a[4] += nrm[i * 3 + 1]; a[5] += nrm[i * 3 + 2];
		a[6] += uv[i * 2]; a[7] += uv[i * 2 + 1];
		a[8]++;
		clusterOf[i] = c;
	}
	const m = acc.length;
	const p2 = new Float32Array(m * 3), n2 = new Float32Array(m * 3), u2 = new Float32Array(m * 2);
	for (let c = 0; c < m; c++) {
		const a = acc[c], k = 1 / a[8];
		p2[c * 3] = a[0] * k; p2[c * 3 + 1] = a[1] * k; p2[c * 3 + 2] = a[2] * k;
		const l = Math.hypot(a[3], a[4], a[5]) || 1;
		n2[c * 3] = a[3] / l; n2[c * 3 + 1] = a[4] / l; n2[c * 3 + 2] = a[5] / l;
		u2[c * 2] = a[6] * k; u2[c * 2 + 1] = a[7] * k;
	}
	const tris: number[] = [];
	const seen = new Set<string>();
	for (let i = 0; i + 2 < index.length; i += 3) {
		const a = clusterOf[index[i]], b = clusterOf[index[i + 1]], c = clusterOf[index[i + 2]];
		if (a === b || b === c || a === c) {
			continue;
		}
		const key = [a, b, c].sort((x, y) => x - y).join(',');
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		tris.push(a, b, c);
	}
	const out = new BufferGeometry();
	out.setAttribute('position', new BufferAttribute(p2, 3));
	out.setAttribute('normal', new BufferAttribute(n2, 3));
	out.setAttribute('uv', new BufferAttribute(u2, 2));
	out.setIndex(new BufferAttribute(m > 65535 ? new Uint32Array(tris) : new Uint16Array(tris), 1));
	out.name = g.name;
	out.computeBoundingSphere();
	return out;
}
