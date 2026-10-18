/*
 * Camera placement: frames the whole table for any screen shape, from a
 * cabinet-like angle down to straight overhead.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

export interface ViewSpec {
	/** Angle of the view above the playfield plane, degrees (90 = straight down). */
	pitch: number;
	/** Vertical field of view, degrees. */
	fov: number;
	/** Fraction of the viewport kept free around the table. */
	margin: number;
	/** Shift the framing up (positive) or down, in NDC units. */
	offsetY?: number;
	/** Extra zoom (1 = fit). */
	zoom?: number;
	/** Part of the table to frame, as fractions of its width/height. */
	crop?: { left: number, right: number, top: number, bottom: number };
}

export const VIEWS: { [key: string]: ViewSpec } = {
	cabinet: { pitch: 52, fov: 30, margin: 0.015 },
	high: { pitch: 68, fov: 24, margin: 0.015, crop: { left: 0.01, right: 0.99, top: 0, bottom: 0.965 } },
	overhead: { pitch: 89.5, fov: 16, margin: 0.01 },
};

const tmp = new Vector3();

/**
 * Positions the camera so every point of the box (table area plus some
 * height) is inside the viewport, centred, as large as possible.
 */
export function frameTable(camera: PerspectiveCamera, width: number, height: number, aspect: number, spec: ViewSpec, box: { minY: number, maxY: number }): void {
	camera.fov = spec.fov;
	camera.aspect = aspect;
	camera.near = 10;
	camera.far = 20000;
	const pitch = MathUtils.degToRad(spec.pitch);
	// Looking towards -Z (away from the player) and down by `pitch`.
	const dir = new Vector3(0, -Math.sin(pitch), -Math.cos(pitch)).normalize();
	const pts: Vector3[] = [];
	const crop = spec.crop ?? { left: 0, right: 1, top: 0, bottom: 1 };
	for (const x of [width * crop.left, width * crop.right]) {
		for (const z of [height * crop.top, height * crop.bottom]) {
			for (const y of [box.minY, box.maxY]) {
				pts.push(new Vector3(x, y, z));
			}
		}
	}
	const target = new Vector3(width / 2, 0, height / 2);
	let dist = Math.max(width, height) * 2;
	const margin = 1 - spec.margin * 2;
	for (let iter = 0; iter < 40; iter++) {
		camera.position.copy(target).addScaledVector(dir, -dist);
		camera.up.set(0, 1, 0);
		if (spec.pitch > 89) {
			camera.up.set(0, 0, -1);
		}
		camera.lookAt(target);
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld(true);
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const p of pts) {
			tmp.copy(p).project(camera);
			minX = Math.min(minX, tmp.x);
			maxX = Math.max(maxX, tmp.x);
			minY = Math.min(minY, tmp.y);
			maxY = Math.max(maxY, tmp.y);
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2 - (spec.offsetY ?? 0);
		const extent = Math.max((maxX - minX) / 2, (maxY - minY) / 2) / margin;
		// Recentre: move the target in camera space by the NDC offset.
		const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
		const halfH = Math.tan(MathUtils.degToRad(camera.fov / 2)) * dist;
		const halfW = halfH * camera.aspect;
		target.addScaledVector(right, cx * halfW * 0.9).addScaledVector(up, cy * halfH * 0.9);
		const fit = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
		const scale = fit / margin;
		dist *= 1 + (scale - 1) * 0.8;
		if (Math.abs(cx) < 1e-4 && Math.abs(cy) < 1e-4 && Math.abs(extent - 1) < 1e-4) {
			break;
		}
	}
	if (spec.zoom && spec.zoom !== 1) {
		camera.zoom = spec.zoom;
		camera.updateProjectionMatrix();
	}
}
