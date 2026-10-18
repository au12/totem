/*
 * Seven-segment digits drawn like Gottlieb's blue-green vacuum fluorescent
 * displays: slanted, softly glowing, with faint unlit segments.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

//  aaa
// f   b
//  ggg
// e   c
//  ddd
const DIGITS: { [d: string]: string } = {
	'0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
	'-': 'g', ' ': '',
};

type Seg = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

function segPath(ctx: CanvasRenderingContext2D, seg: Seg, x: number, y: number, w: number, h: number, t: number, slant: number): void {
	// Segment as an elongated hexagon in a unit box, then slanted.
	const half = h / 2;
	const pts: Array<[number, number]> = [];
	const hseg = (cy: number) => {
		const x0 = x + t * 0.6, x1 = x + w - t * 0.6;
		pts.push([x0, cy], [x0 + t / 2, cy - t / 2], [x1 - t / 2, cy - t / 2], [x1, cy], [x1 - t / 2, cy + t / 2], [x0 + t / 2, cy + t / 2]);
	};
	const vseg = (cx: number, y0: number, y1: number) => {
		y0 += t * 0.6;
		y1 -= t * 0.6;
		pts.push([cx, y0], [cx + t / 2, y0 + t / 2], [cx + t / 2, y1 - t / 2], [cx, y1], [cx - t / 2, y1 - t / 2], [cx - t / 2, y0 + t / 2]);
	};
	switch (seg) {
		case 'a': hseg(y); break;
		case 'g': hseg(y + half); break;
		case 'd': hseg(y + h); break;
		case 'f': vseg(x, y, y + half); break;
		case 'b': vseg(x + w, y, y + half); break;
		case 'e': vseg(x, y + half, y + h); break;
		case 'c': vseg(x + w, y + half, y + h); break;
	}
	ctx.moveTo(pts[0][0] + (y + h - pts[0][1]) * slant, pts[0][1]);
	for (let i = 1; i < pts.length; i++) {
		ctx.lineTo(pts[i][0] + (y + h - pts[i][1]) * slant, pts[i][1]);
	}
	ctx.closePath();
}

export interface DisplayStyle {
	lit: string;
	glow: string;
	unlit: string;
}

export const VFD: DisplayStyle = { lit: '#7ff3ff', glow: 'rgba(40, 200, 255, 0.85)', unlit: 'rgba(60, 120, 150, 0.10)' };

/**
 * Draws `text` (digits/space/dash, one char per position) into the box.
 */
export function drawDigits(ctx: CanvasRenderingContext2D, text: string, bx: number, by: number, bw: number, bh: number, style: DisplayStyle = VFD): void {
	const n = text.length;
	const cell = bw / n;
	const dh = bh * 0.72;
	const dw = Math.min(cell * 0.58, dh * 0.55);
	const t = Math.max(1.5, dw * 0.2);
	const slant = 0.12;
	const y = by + (bh - dh) / 2;
	for (let i = 0; i < n; i++) {
		const x = bx + i * cell + (cell - dw) / 2 - dh * slant / 2;
		const on = DIGITS[text[i]] ?? '';
		// Unlit segments: the faint grid of a real VFD.
		ctx.beginPath();
		for (const s of 'abcdefg') {
			if (!on.includes(s)) {
				segPath(ctx, s as Seg, x, y, dw, dh, t, slant);
			}
		}
		ctx.fillStyle = style.unlit;
		ctx.fill();
		if (!on) {
			continue;
		}
		ctx.beginPath();
		for (const s of on) {
			segPath(ctx, s as Seg, x, y, dw, dh, t, slant);
		}
		ctx.save();
		ctx.shadowColor = style.glow;
		ctx.shadowBlur = t * 2.2;
		ctx.fillStyle = style.lit;
		ctx.fill();
		ctx.restore();
	}
}

/** Formats a score for an n-digit display: blank leading zeros, at least "00". */
export function scoreText(value: number | null, digits: number): string {
	if (value === null || value === undefined) {
		return ' '.repeat(digits);
	}
	let s = String(Math.max(0, Math.floor(value)));
	if (s.length < 2) {
		s = s.padStart(2, '0');
	}
	if (s.length > digits) {
		s = s.slice(-digits);
	}
	return s.padStart(digits, ' ');
}
