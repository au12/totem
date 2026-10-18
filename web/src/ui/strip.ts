/*
 * The compact score strip shown over the table when the backglass doesn't
 * fit (phones in portrait): the current player's score in the same blue
 * display style, the ball in play, and the backglass lamps that matter.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { LAMP_GAME_OVER, LAMP_SHOOT_AGAIN, LAMP_TILT } from '../game/hardware';
import { Backglass } from './backglass';
import { drawDigits, scoreText } from './segments';

export class ScoreStrip {

	private readonly ctx: CanvasRenderingContext2D;
	private key = '';
	public current = 0;
	public players = 1;

	constructor(private readonly canvas: HTMLCanvasElement, private readonly bg: Backglass) {
		this.ctx = canvas.getContext('2d')!;
	}

	public resize(dpr: number): void {
		const r = this.canvas.getBoundingClientRect();
		const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
		if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.key = '';
		}
	}

	public draw(): void {
		const bg = this.bg;
		const p = this.current;
		const score = bg.getScore(p);
		const { ball } = bg.status;
		const tilt = bg.lamp(LAMP_TILT) === 1;
		const again = bg.lamp(LAMP_SHOOT_AGAIN) === 1;
		const over = bg.lamp(LAMP_GAME_OVER) === 1;
		const key = [p, this.players, score, ball, tilt, again, over].join('|');
		if (key === this.key) {
			return;
		}
		this.key = key;
		const ctx = this.ctx;
		const W = this.canvas.width, H = this.canvas.height;
		ctx.clearRect(0, 0, W, H);
		const pad = H * 0.12;
		const label = (text: string, x: number, y: number, color: string, align: CanvasTextAlign) => {
			ctx.font = `600 ${Math.round(H * 0.22)}px Antonio, 'Arial Narrow', sans-serif`;
			ctx.textAlign = align;
			ctx.textBaseline = 'middle';
			ctx.fillStyle = color;
			ctx.fillText(text, x, y);
		};
		const sideW = W * 0.17;
		// Player
		label(this.players > 1 ? 'PLAYER' : 'SCORE', sideW / 2, H * 0.28, 'rgba(127,243,255,0.55)', 'center');
		if (this.players > 1) {
			drawDigits(ctx, String(p + 1), sideW * 0.3, H * 0.42, sideW * 0.4, H * 0.5);
		}
		// Score
		drawDigits(ctx, scoreText(score, 6), sideW, pad, W - sideW * 2, H - pad * 2);
		// Ball
		label(over ? 'GAME' : 'BALL', W - sideW / 2, H * 0.28, 'rgba(127,243,255,0.55)', 'center');
		if (over) {
			label('OVER', W - sideW / 2, H * 0.68, '#7ff3ff', 'center');
		} else if (ball !== null) {
			drawDigits(ctx, String(ball).slice(-1), W - sideW * 0.7, H * 0.42, sideW * 0.4, H * 0.5);
		}
		if (tilt || again) {
			label(tilt ? 'TILT' : 'SHOOT AGAIN', W / 2, H * 0.12, tilt ? '#ff6a5d' : '#f1de6b', 'center');
		}
	}
}
