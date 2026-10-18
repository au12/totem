/*
 * Images that Visual Pinball ships with the player rather than the table
 * (bumper parts). vpx-js names them by file; they are bundled with the app.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import bumperBase from '../vpx/res/maps/bumperbase.png';
import bumperRing from '../vpx/res/maps/bumperring.png';
import bumperSkirt from '../vpx/res/maps/bumperskirt.png';

const files: { [name: string]: string } = {
	'bumperbase.png': bumperBase,
	'bumperring.png': bumperRing,
	'bumperskirt.png': bumperSkirt,
};

/** Absolute URL of a built-in image, or undefined. */
export function builtinMap(name: string): string | undefined {
	const file = files[name.toLowerCase()];
	return file ? new URL(file, import.meta.url).href : undefined;
}
