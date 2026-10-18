/*
 * Drives the VPX physics on a game clock: steps it in 1 ms increments up to
 * a target time, runs game timers on that same clock (so rules and physics
 * never drift apart), and models nudging.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Player } from '../vpx/game/player';
import { PlayerPhysics } from '../vpx/game/player-physics';
import { Ball } from '../vpx/vpt/ball/ball';
import { Table } from '../vpx/vpt/table/table';

interface Timer {
	at: number;
	fn: () => void;
	id: number;
	every?: number;
}

export class Sim {

	public readonly player: Player;
	public readonly physics: PlayerPhysics;
	private readonly timers: Timer[] = [];
	private nextTimerId = 1;
	private readonly stepHooks: Array<(t: number) => void> = [];

	/** Game clock in ms (physics time). */
	public now = 0;

	// Nudge: the cabinet as a damped spring; balls feel its acceleration.
	private nudgeX = 0;
	private nudgeY = 0;
	private nudgeVX = 0;
	private nudgeVY = 0;
	private nudgeLastT = -1;

	constructor(public readonly table: Table) {
		this.player = new Player(table).init();
		this.physics = this.player.getPhysics();
		this.physics.onStep = t => this.step(t);
	}

	/** Advances physics (and timers) to game time t, in ms. */
	public advanceTo(t: number): void {
		if (t <= this.now) {
			return;
		}
		this.player.updatePhysics(t);
		this.now = Math.max(this.now, this.physics.timeMsec);
	}

	/** Runs light/bumper/target animations up to the current time. */
	public animate(): void {
		this.player.updateAnimations(this.physics.timeMsec);
	}

	private step(t: number): void {
		this.now = t;
		// Timers, in order. A timer may add timers; those due now run too.
		for (let guard = 0; guard < 1000; guard++) {
			let first = -1;
			for (let i = 0; i < this.timers.length; i++) {
				if (this.timers[i].at <= t && (first < 0 || this.timers[i].at < this.timers[first].at)) {
					first = i;
				}
			}
			if (first < 0) {
				break;
			}
			const timer = this.timers[first];
			if (timer.every) {
				timer.at += timer.every;
			} else {
				this.timers.splice(first, 1);
			}
			timer.fn();
		}
		this.stepNudge(t);
		for (const hook of this.stepHooks) {
			hook(t);
		}
	}

	public onStep(fn: (t: number) => void): void {
		this.stepHooks.push(fn);
	}

	public after(ms: number, fn: () => void): number {
		const id = this.nextTimerId++;
		this.timers.push({ at: this.now + ms, fn, id });
		return id;
	}

	public every(ms: number, fn: () => void): number {
		const id = this.nextTimerId++;
		this.timers.push({ at: this.now + ms, fn, id, every: ms });
		return id;
	}

	public cancel(id: number | undefined): void {
		if (id === undefined) {
			return;
		}
		const i = this.timers.findIndex(t => t.id === id);
		if (i >= 0) {
			this.timers.splice(i, 1);
		}
	}

	public cancelAll(): void {
		this.timers.length = 0;
	}

	public get balls(): Ball[] {
		return this.player.getBalls();
	}

	/**
	 * Bumps the cabinet. dx/dy in VPX units per ms of initial cabinet
	 * velocity (positive y pushes the table away from the player).
	 */
	public nudge(dx: number, dy: number): void {
		this.nudgeVX += dx;
		this.nudgeVY += dy;
		// The cabinet jumps; the balls, not attached to it, do not.
		this.pushBalls(-dx * 10, -dy * 10);
	}

	private pushBalls(dvx: number, dvy: number): void {
		for (const ball of this.player.getBalls()) {
			if (ball.state.isFrozen) {
				continue;
			}
			const v = ball.hit.vel;
			v.x += dvx;
			v.y += dvy;
		}
	}

	/** Cabinet displacement for the camera shake, VPX units. */
	public get shake(): { x: number, y: number } {
		return { x: this.nudgeX, y: this.nudgeY };
	}

	private stepNudge(t: number): void {
		const dt = this.nudgeLastT < 0 ? 1 : Math.min(5, t - this.nudgeLastT);
		this.nudgeLastT = t;
		if (this.nudgeVX === 0 && this.nudgeVY === 0 && this.nudgeX === 0 && this.nudgeY === 0) {
			return;
		}
		// Spring-damper (critically-ish damped, ~6 Hz).
		const k = 0.0016, c = 0.06;
		const ax = -k * this.nudgeX - c * this.nudgeVX;
		const ay = -k * this.nudgeY - c * this.nudgeVY;
		const vx0 = this.nudgeVX, vy0 = this.nudgeVY;
		this.nudgeVX += ax * dt;
		this.nudgeVY += ay * dt;
		this.nudgeX += this.nudgeVX * dt;
		this.nudgeY += this.nudgeVY * dt;
		// The balls stay put while the cabinet moves under them: in table
		// coordinates they get the opposite velocity change. Physics velocity
		// units are per 10 ms.
		this.pushBalls(-(this.nudgeVX - vx0) * 10, -(this.nudgeVY - vy0) * 10);
		if (Math.abs(this.nudgeX) < 0.01 && Math.abs(this.nudgeY) < 0.01 && Math.abs(this.nudgeVX) < 0.0005 && Math.abs(this.nudgeVY) < 0.0005) {
			this.nudgeX = this.nudgeY = this.nudgeVX = this.nudgeVY = 0;
		}
	}
}
