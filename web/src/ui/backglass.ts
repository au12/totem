/*
 * The backglass: the cabinet artwork from the .directb2s, with the score
 * displays and backglass lamps drawn from the game state.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { LoadedPack, PackBackglass } from '../engine/pack';
import { LAMP_BALL_IN_PLAY, LAMP_GAME_OVER, LAMP_HSTD, LAMP_MATCH, LAMP_SHOOT_AGAIN, LAMP_TILT, LampState } from '../game/hardware';
import { DisplaySink } from '../game/totem-table';
import { drawDigits, scoreText } from './segments';

/** Which machine lamp each backglass bulb shows, matched by its caption. */
function lampForText(text: string): number | undefined {
	const t = text.toUpperCase();
	if (t.includes('GAME OVER')) {
		return LAMP_GAME_OVER;
	}
	if (t.includes('TILT')) {
		return LAMP_TILT;
	}
	if (t.includes('HIGH')) {
		return LAMP_HSTD;
	}
	if (t.includes('SHOOT')) {
		return LAMP_SHOOT_AGAIN;
	}
	if (t.includes('BALL IN PLAY')) {
		return LAMP_BALL_IN_PLAY;
	}
	if (t.includes('MATCH')) {
		return LAMP_MATCH;
	}
	return undefined;
}

async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	const blob = await res.blob();
	if (typeof createImageBitmap === 'function') {
		return createImageBitmap(blob);
	}
	const img = new Image();
	img.src = URL.createObjectURL(blob);
	await img.decode();
	return img;
}

export class Backglass implements DisplaySink {

	public readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private bg?: PackBackglass;
	private art?: ImageBitmap | HTMLImageElement;
	private readonly lampImages = new Map<number, { img: ImageBitmap | HTMLImageElement, x: number, y: number, w: number, h: number }>();
	private readonly scores: Array<number | null> = [null, null, null, null];
	private credits: number | null = null;
	private ballOrMatch: number | null = null;
	private readonly lamps = new Map<number, LampState>();
	private dirty = true;
	private blinkPlayer = -1;
	private blinkOn = true;
	public onChange?: () => void;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d')!;
	}

	public get aspect(): number {
		return this.bg ? this.bg.w / this.bg.h : 2500 / 2183;
	}

	public get available(): boolean {
		return !!this.bg;
	}

	public async load(pack: LoadedPack): Promise<void> {
		const bg = pack.manifest.backglass;
		if (!bg) {
			return;
		}
		this.bg = bg;
		const hd = pack.quality === 'hd';
		this.art = await loadImage(pack.url(hd ? bg.on.hd : bg.on.sd));
		await Promise.all(bg.lamps.map(async l => {
			const lamp = lampForText(l.text || '');
			if (lamp === undefined) {
				return;
			}
			try {
				const img = await loadImage(pack.url(hd ? l.image.hd : l.image.sd));
				this.lampImages.set(lamp, { img, x: l.x, y: l.y, w: l.w, h: l.h });
			} catch {
				// a missing bulb image just stays dark
			}
		}));
		this.dirty = true;
	}

	// --- DisplaySink ----------------------------------------------------------

	public setScore(player: number, value: number | null): void {
		if (this.scores[player] !== value) {
			this.scores[player] = value;
			this.markDirty();
		}
	}

	public setStatus(credits: number | null, ball: number | null): void {
		if (this.credits !== credits || this.ballOrMatch !== ball) {
			this.credits = credits;
			this.ballOrMatch = ball;
			this.markDirty();
		}
	}

	public setLamp(lamp: number, state: LampState): void {
		if (this.lamps.get(lamp) !== state) {
			this.lamps.set(lamp, state);
			if (this.lampImages.has(lamp)) {
				this.markDirty();
			}
		}
	}

	/** Flashes a player's display (whose turn it is, before the ball is in play). */
	public setBlink(player: number, on: boolean): void {
		const p = on ? player : -1;
		if (this.blinkPlayer !== p) {
			this.blinkPlayer = p;
			this.markDirty();
		}
	}

	public tick(now: number): void {
		if (this.blinkPlayer >= 0) {
			const on = Math.floor(now / 300) % 2 === 0;
			if (on !== this.blinkOn) {
				this.blinkOn = on;
				this.markDirty();
			}
		}
	}

	public getScore(player: number): number | null {
		return this.scores[player];
	}

	public get status(): { credits: number | null, ball: number | null } {
		return { credits: this.credits, ball: this.ballOrMatch };
	}

	public lamp(n: number): LampState {
		return this.lamps.get(n) ?? 0;
	}

	private markDirty(): void {
		this.dirty = true;
		this.onChange?.();
	}

	// --- drawing -------------------------------------------------------------

	/** Sizes the canvas backing store for its CSS box. */
	public resize(cssWidth: number, cssHeight: number, dpr: number): void {
		const w = Math.max(1, Math.round(cssWidth * dpr));
		const h = Math.max(1, Math.round(cssHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.dirty = true;
		}
	}

	public draw(force = false): void {
		if (!this.dirty && !force) {
			return;
		}
		this.dirty = false;
		const ctx = this.ctx;
		const cw = this.canvas.width, ch = this.canvas.height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, cw, ch);
		if (!this.bg || !this.art) {
			return;
		}
		const bg = this.bg;
		const s = Math.min(cw / bg.w, ch / bg.h);
		const ox = (cw - bg.w * s) / 2, oy = (ch - bg.h * s) / 2;
		ctx.setTransform(s, 0, 0, s, ox, oy);
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(this.art, 0, 0, bg.w, bg.h);
		for (const [lamp, li] of this.lampImages) {
			const st = this.lamps.get(lamp) ?? 0;
			if (st === 1 || (st === 2 && this.blinkOn)) {
				ctx.globalCompositeOperation = 'lighter';
				ctx.globalAlpha = 0.9;
				ctx.drawImage(li.img, li.x, li.y, li.w, li.h);
				ctx.globalCompositeOperation = 'source-over';
				ctx.globalAlpha = 1;
			}
		}
		// Score windows: darken the glass first so digits read cleanly.
		const sorted = [...bg.scores].sort((a, b) => a.id - b.id);
		const players = sorted.filter(sc => sc.digits >= 6);
		const small = sorted.filter(sc => sc.digits < 6).sort((a, b) => a.x - b.x);
		players.forEach((sc, i) => {
			ctx.fillStyle = 'rgba(0, 4, 8, 0.82)';
			ctx.fillRect(sc.x, sc.y, sc.w, sc.h);
			const hide = i === this.blinkPlayer && !this.blinkOn;
			drawDigits(ctx, hide ? ' '.repeat(sc.digits) : scoreText(this.scores[i] ?? null, sc.digits), sc.x + sc.w * 0.02, sc.y, sc.w * 0.96, sc.h);
		});
		// Status display: credits on the left, ball in play / match on the right.
		const [left, right] = small;
		if (left) {
			ctx.fillStyle = 'rgba(0, 4, 8, 0.82)';
			ctx.fillRect(left.x, left.y, left.w, left.h);
			drawDigits(ctx, scoreText(this.credits, left.digits).replace(/^ (\d)$/, '0$1'), left.x, left.y, left.w, left.h);
		}
		if (right) {
			ctx.fillStyle = 'rgba(0, 4, 8, 0.82)';
			ctx.fillRect(right.x, right.y, right.w, right.h);
			const v = this.ballOrMatch;
			const text = v === null ? '  ' : v < 10 && this.lamps.get(LAMP_MATCH) !== 1 ? ' ' + v : String(v).padStart(2, '0');
			drawDigits(ctx, text, right.x, right.y, right.w, right.h);
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
	}
}
