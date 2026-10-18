/*
 * The subset of vpx-js's IRenderApi its item updaters call, implemented for
 * three.js. Updaters compute transforms in VPX render space; we apply them
 * as node matrices under the table root.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Matrix4, Mesh as ThreeMesh, Object3D } from 'three';
import { Matrix3D } from '../vpx/math/matrix3d';
import { Mesh } from '../vpx/vpt/mesh';

const m4 = new Matrix4();

export function matrix3DToMatrix4(matrix: Matrix3D, out: Matrix4): Matrix4 {
	// VPX matrices are row-vector (v * M); three.js uses column vectors.
	return out.set(
		matrix._11, matrix._21, matrix._31, matrix._41,
		matrix._12, matrix._22, matrix._32, matrix._42,
		matrix._13, matrix._23, matrix._33, matrix._43,
		matrix._14, matrix._24, matrix._34, matrix._44,
	);
}

export class UpdaterApi {

	public findInGroup(group: Object3D | undefined, name: string): Object3D | undefined {
		if (!group) {
			return undefined;
		}
		return group.children.find(c => c.name === name);
	}

	public applyMatrixToNode(matrix: Matrix3D, obj: Object3D | undefined): void {
		if (!obj) {
			return;
		}
		matrix3DToMatrix4(matrix, m4);
		obj.matrix.copy(m4);
		obj.matrixWorldNeedsUpdate = true;
	}

	public applyVisibility(isVisible: boolean | number, obj: Object3D | undefined): void {
		if (obj) {
			obj.visible = !!isVisible;
		}
	}

	public applyMeshToNode(mesh: Mesh, obj: Object3D | undefined): void {
		const target = obj as ThreeMesh | undefined;
		const pos = target?.geometry?.attributes.position;
		if (!pos) {
			return;
		}
		const arr = pos.array as Float32Array;
		const n = Math.min(mesh.vertices.length, arr.length / 3);
		for (let i = 0; i < n; i++) {
			const v = mesh.vertices[i];
			arr[i * 3] = v.x;
			arr[i * 3 + 1] = v.y;
			arr[i * 3 + 2] = v.z;
		}
		pos.needsUpdate = true;
		target!.geometry.computeBoundingSphere();
	}

	public applyMaterial(): void {
		// Materials are fixed per node; texture swaps are handled by the game layer.
	}

	public applyLighting(): void {
		// Lamps are rendered through the light map, not scene lights.
	}
}
