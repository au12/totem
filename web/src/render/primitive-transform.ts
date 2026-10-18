/*
 * Moves animated primitives (flippers, the gate, the vari-target, the kick
 * arm, the slingshot arm). Their geometry is built once with the table's
 * placement baked in, so the node matrix undoes that placement and applies
 * the current one: exact for any combination of rotations, unlike applying
 * only the change in angle.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Matrix4 } from 'three';
import { degToRad } from '../vpx/math/float';
import { Matrix3D } from '../vpx/math/matrix3d';
import { matrix3DToMatrix4 } from './updater-api';

interface Vec {
	x: number;
	y: number;
	z: number;
}

/** A primitive's placement: position, size and the nine rotation/translation values. */
export interface Placement {
	position: Vec;
	size: Vec;
	rotAndTra: number[];
}

/** vpx-js's PrimitiveMeshGenerator.getMatrix for an arbitrary placement (VPX row-vector form). */
function placementMatrix(p: Placement, scaleZ: number): Matrix3D {
	const rt = p.rotAndTra;
	const rotTrans = new Matrix3D().setTranslation(rt[3], rt[4], rt[5]);
	const temp = new Matrix3D();
	rotTrans.multiply(temp.rotateZMatrix(degToRad(rt[2])));
	rotTrans.multiply(temp.rotateYMatrix(degToRad(rt[1])));
	rotTrans.multiply(temp.rotateXMatrix(degToRad(rt[0])));
	rotTrans.multiply(temp.rotateZMatrix(degToRad(rt[8])));
	rotTrans.multiply(temp.rotateYMatrix(degToRad(rt[7])));
	rotTrans.multiply(temp.rotateXMatrix(degToRad(rt[6])));
	const full = new Matrix3D().setScaling(p.size.x, p.size.y, p.size.z);
	full.multiply(rotTrans);
	full.multiply(new Matrix3D().setTranslation(p.position.x, p.position.y, p.position.z));
	full.multiply(new Matrix3D().setScaling(1, 1, scaleZ));
	return full;
}

/** VPX space to render space (z = -height); its own inverse. */
const RIGHT_HANDED = new Matrix4().makeScale(1, 1, -1);

export class PrimitiveTransform {

	/** Undoes the placement baked into the geometry. */
	private readonly unbake: Matrix4;
	private readonly scaleZ: number;
	private readonly current = new Matrix4();

	constructor(baked: Placement, scaleZ: number) {
		this.scaleZ = scaleZ;
		this.unbake = matrix3DToMatrix4(placementMatrix(baked, scaleZ), new Matrix4()).invert();
	}

	/** The node matrix (three.js, render space) for the primitive's current placement. */
	public matrix(now: Placement, out: Matrix4): Matrix4 {
		matrix3DToMatrix4(placementMatrix(now, this.scaleZ), this.current);
		// Row-vector RH * baked⁻¹ * now * RH, written for column vectors.
		return out.copy(RIGHT_HANDED).multiply(this.current).multiply(this.unbake).multiply(RIGHT_HANDED);
	}
}
