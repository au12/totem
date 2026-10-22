/*
 * The physical Totem table: connects the VPX items (switches, coils, lamps,
 * moving toys) to the rules, the way the original wiring harness did, and
 * makes the mechanical noises. This replaces the Visual Pinball table
 * script, which expected the PinMAME ROM to run the game.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Sim } from '../engine/sim';
import { HitObject } from '../vpx/physics/hit-object';
import { Ball } from '../vpx/vpt/ball/ball';
import { Bumper } from '../vpx/vpt/bumper/bumper';
import { Flipper } from '../vpx/vpt/flipper/flipper';
import { Gate } from '../vpx/vpt/gate/gate';
import { HitTarget } from '../vpx/vpt/hit-target/hit-target';
import { Kicker } from '../vpx/vpt/kicker/kicker';
import { Primitive } from '../vpx/vpt/primitive/primitive';
import { Rubber } from '../vpx/vpt/rubber/rubber';
import { Surface } from '../vpx/vpt/surface/surface';
import { Hardware, LampState, SoundCue, Solenoid } from './hardware';
import { SoundSink } from './sound-sink';
import { SW } from './totem-rules';

export interface SwitchListener {
	switchClosed(sw: number): void;
	switchOpened(sw: number): void;
	drained(): void;
}

export interface DisplaySink {
	setScore(player: number, value: number | null): void;
	setStatus(credits: number | null, ball: number | null): void;
	setLamp(lamp: number, state: LampState): void;
}

/** Items the table logic moves or hides; the renderer keeps them separate. */
export const TOTEM_DYNAMIC_ITEMS = [
	'lflipb', 'lflipr', 'rflipb', 'rflipr', 'FlipperLSh', 'FlipperRSh',
	'VariTargetP', 'Pkickarm', 'SLING1', 'Pgate',
	'RSling', 'RSling1', 'RSling2',
	'instcard', 'repcard',
];

/** Desktop-only or script-driven decorations we draw differently. */
export const TOTEM_HIDDEN_ITEMS = ['BallShadow1', 'BallShadow2', 'BallShadow3', 'BallShadow4', 'BallShadow5'];

const VARI_DELAY = 0.85;          // ball slows as it pushes the vari-target arm
const VARI_POSITIONS = [2, 12, 18]; // trigger index thresholds: 42, 42, 51

export class TotemTable implements Hardware {

	private readonly t: any;
	private flippersEnabled = false;
	private flipLeft = false;
	private flipRight = false;
	private listener?: SwitchListener;
	/** Bumped by clearTable(), so callbacks from an abandoned game are dropped. */
	private generation = 0;
	private display?: DisplaySink;
	private variMax = -1;
	private variScored = false;
	private variResetting = false;
	private variAngle = 0;
	private kickArm = 0;
	private sling = 0;
	private slingTimer?: number;
	private readonly lampLights = new Map<number, any[]>();
	private readonly lampState = new Map<number, LampState>();
	private plungerHeld = false;
	public onSolenoid?: (sol: Solenoid) => void;

	constructor(public readonly sim: Sim, private readonly audio: SoundSink) {
		this.t = sim.table as any;
		this.indexLamps();
		this.wire();
		for (const name of Object.keys(this.t.lights)) {
			const l = this.t.lights[name];
			if (!l.data.isBackglass && /^(gi_|light)/i.test(name)) {
				l.getApi().State = 1;
			}
		}
		this.sim.physics.onCollide = (ball, obj, speed) => this.collisionSound(ball, obj, speed);
	}

	public connect(listener: SwitchListener, display: DisplaySink): void {
		this.listener = listener;
		this.display = display;
	}

	// --- Hardware -------------------------------------------------------------

	public now(): number {
		return this.sim.now;
	}

	public after(ms: number, fn: () => void): number {
		return this.sim.after(ms, fn);
	}

	public every(ms: number, fn: () => void): number {
		return this.sim.every(ms, fn);
	}

	public cancel(id: number | undefined): void {
		this.sim.cancel(id);
	}

	public setLamp(lamp: number, state: LampState): void {
		this.lampState.set(lamp, state);
		for (const l of this.lampLights.get(lamp) || []) {
			l.getApi().State = state;
		}
		this.display?.setLamp(lamp, state);
	}

	public setScore(player: number, value: number | null): void {
		this.display?.setScore(player, value);
	}

	public setStatus(credits: number | null, ball: number | null): void {
		this.display?.setStatus(credits, ball);
	}

	public fire(sol: Solenoid): void {
		this.onSolenoid?.(sol);
		switch (sol) {
			case 'outhole': this.serveBall(); break;
			case 'hole': this.kickHole(); break;
			case 'dropReset': this.resetDrops(); break;
			case 'variReset': this.resetVari(); break;
			case 'knocker': this.audio.sample('knocker', { volume: 1 }); break;
		}
	}

	public setFlippers(enabled: boolean): void {
		this.flippersEnabled = enabled;
		if (!enabled) {
			this.flipper('left', false, true);
			this.flipper('right', false, true);
		} else {
			if (this.flipLeft) {
				this.flipper('left', true, true);
			}
			if (this.flipRight) {
				this.flipper('right', true, true);
			}
		}
	}

	public sound(cue: SoundCue): void {
		this.audio.cue(cue);
	}

	public ballsOnTable(): number {
		return this.sim.balls.length;
	}

	public clearTable(): void {
		// Drains already in flight belong to the old game.
		this.generation++;
		// Kickers keep a reference to the ball they hold; let them release it.
		for (const name of ['sw41', 'BallRelease', 'Drain']) {
			this.t.kickers[name]?.getApi().DestroyBall();
		}
		for (const ball of [...this.sim.balls]) {
			this.sim.player.destroyBall(ball);
		}
		this.flipper('left', false);
		this.flipper('right', false);
		this.plunger(false);
	}

	// --- player controls --------------------------------------------------------

	/** Flipper button state; the coil only fires while the game enables flippers. */
	public flipper(side: 'left' | 'right', down: boolean, force = false): void {
		const prev = side === 'left' ? this.flipLeft : this.flipRight;
		if (!force) {
			if (side === 'left') {
				this.flipLeft = down;
			} else {
				this.flipRight = down;
			}
			if (prev === down) {
				return;
			}
		}
		const name = side === 'left' ? 'LeftFlipper' : 'RightFlipper';
		const f = this.t.flippers[name];
		if (!f) {
			return;
		}
		const api = f.getApi();
		const x = f.data.center.x, y = f.data.center.y;
		if (down && this.flippersEnabled) {
			api.RotateToEnd();
			this.audio.sample('fx_Flipperup', { x, y });
		} else if (!down || !this.flippersEnabled) {
			const wasUp = Math.abs(api.CurrentAngle - f.data.startAngle) > 2;
			api.RotateToStart();
			if (wasUp || (!force && this.flippersEnabled)) {
				this.audio.sample('fx_Flipperdown', { x, y });
			}
		}
	}

	public plunger(down: boolean): void {
		const p = this.t.plungers.Plunger;
		if (!p || down === this.plungerHeld) {
			return;
		}
		this.plungerHeld = down;
		const api = p.getApi();
		if (down) {
			api.PullBack();
			this.audio.sample('plungerpull', { x: p.data.center.x, y: p.data.center.y });
		} else {
			api.Fire();
			this.audio.sample('plunger', { x: p.data.center.x, y: p.data.center.y });
		}
	}

	/** A ball sitting in the shooter lane, waiting to be plunged. */
	public get ballInShooterLane(): boolean {
		for (const b of this.sim.balls) {
			const p = b.state.pos;
			if (p.x > 860 && p.y > 1450) {
				return true;
			}
		}
		return false;
	}

	// --- wiring -------------------------------------------------------------------

	private indexLamps(): void {
		const byLower = new Map<string, any>();
		for (const [name, l] of Object.entries<any>(this.t.lights)) {
			byLower.set(name.toLowerCase(), l);
		}
		for (let n = 4; n <= 36; n++) {
			const l = byLower.get('l' + n);
			if (l && !l.data.isBackglass) {
				this.lampLights.set(n, [l]);
			}
		}
	}

	private on(item: any, event: string, fn: (...args: any[]) => void): void {
		if (item) {
			item.getApi().on(event, fn);
		}
	}

	private ball(): Ball | undefined {
		return this.sim.player.getActiveBall();
	}

	private closed(sw: number): void {
		this.listener?.switchClosed(sw);
	}

	private opened(sw: number): void {
		this.listener?.switchOpened(sw);
	}

	private pulse(sw: number): void {
		this.closed(sw);
		this.sim.after(40, () => this.opened(sw));
	}

	private wire(): void {
		const t = this.t;
		// Rollovers: wire lanes and star buttons.
		const rollovers: Array<[string, number]> = [
			['sw10', SW.LANE_ADD3], ['sw11', SW.LANE_ADD2], ['sw51', SW.OUTLANE], ['sw51a', SW.OUTLANE],
			['sw70', SW.LANE_B], ['sw71', SW.LANE_C], ['sw72', SW.LANE_D], ['sw74', SW.LANE_A],
			['sw40', SW.STAR_40], ['sw40a', SW.STAR_40], ['sw50', SW.STAR_50],
		];
		for (const [name, sw] of rollovers) {
			const trig = t.triggers[name];
			this.on(trig, 'Hit', () => {
				this.closed(sw);
				const b = this.ball();
				this.audio.sample('rollover', { x: b?.state.pos.x, y: b?.state.pos.y, volume: 0.9 });
			});
			this.on(trig, 'Unhit', () => this.opened(sw));
		}

		// Pop bumpers.
		for (const name of ['Bumper1', 'Bumper2']) {
			const b = t.bumpers[name];
			this.on(b, 'Hit', () => {
				this.pulse(SW.BUMPER);
				this.audio.sample('fx_bumper1', { x: b.data.center.x, y: b.data.center.y, volume: 1 });
			});
		}

		// Stand-up targets.
		for (const [name, sw] of [['sw62a', SW.STANDUP], ['sw62b', SW.STANDUP], ['sw62c', SW.STANDUP], ['sw64', SW.EXTRA_BALL]] as Array<[string, number]>) {
			const target = t.hitTargets[name];
			this.on(target, 'Hit', () => {
				this.pulse(sw);
				this.audio.sample('target', { x: target.data.position.x, y: target.data.position.y, volume: this.hitVolume(0.6) });
			});
		}

		// Drop targets.
		for (const [name, sw] of [['sw20', SW.DT_A], ['sw24', SW.DT_B_LEFT], ['sw21', SW.DT_B_CENTER], ['sw30', SW.DT_C_CENTER], ['sw31', SW.DT_C_RIGHT], ['sw34', SW.DT_D]] as Array<[string, number]>) {
			const target = t.hitTargets[name];
			this.on(target, 'Hit', () => {
				this.audio.sample('DTDrop', { x: target.data.position.x, y: target.data.position.y });
			});
			this.on(target, 'Dropped', () => this.closed(sw));
			this.on(target, 'Raised', () => this.opened(sw));
		}

		// Scoring rubbers (invisible slingshot walls) and the right slingshot.
		for (const name of ['sw60a', 'sw60b', 'sw60c', 'sw60d', 'sw60e']) {
			const s = t.surfaces[name];
			this.on(s, 'Slingshot', () => {
				this.pulse(SW.RUBBER);
				const b = this.ball();
				this.audio.sample(name === 'sw60d' ? 'left_slingshot' : 'fx_rubber2', { x: b?.state.pos.x, y: b?.state.pos.y, volume: name === 'sw60d' ? 1 : 0.6 });
			});
		}
		this.on(t.surfaces.RightSlingShot, 'Slingshot', () => {
			this.pulse(SW.RUBBER);
			this.audio.sample('right_slingshot', { x: 710, y: 1400 });
			this.animateSling();
		});

		// Right bumper gate.
		const gate2 = t.gates.Gate2;
		this.on(gate2, 'Hit', () => {
			this.pulse(SW.GATE);
			this.audio.sample('gate4', { x: gate2.data.center.x, y: gate2.data.center.y, volume: 0.8 });
		});
		this.on(t.gates.Gate, 'Hit', () => this.audio.sample('gate', { x: 769, y: 187, volume: 0.6 }));

		// The hole.
		const hole = t.kickers.sw41;
		this.on(hole, 'Hit', () => {
			this.audio.sample('popper_ball', { x: hole.data.center.x, y: hole.data.center.y });
			this.closed(SW.HOLE);
		});

		// Drain (outhole).
		const drain = t.kickers.Drain;
		this.on(drain, 'Hit', () => {
			this.audio.sample('drain', { x: drain.data.center.x, y: drain.data.center.y });
			const api = drain.getApi();
			api.DestroyBall();
			// Let the physics finish this step before the rules react.
			const generation = this.generation;
			this.sim.after(0, () => {
				if (generation === this.generation) {
					this.listener?.drained();
				}
			});
		});

		// Vari-target: 21 triggers along the left lane track how far the ball
		// pushes the arm (port of the VPX table's VariTarget routines).
		for (let i = 1; i <= 21; i++) {
			const trig = t.triggers['varitrigger' + i];
			const idx = i - 1;
			this.on(trig, 'Hit', () => this.variHit(idx));
		}

		// Flipper hits make a rubbery slap.
		for (const name of ['LeftFlipper', 'RightFlipper']) {
			const f = t.flippers[name];
			this.on(f, 'Collide', () => {
				const b = this.ball();
				const n = 1 + Math.floor(Math.random() * 3);
				this.audio.sample('flip_hit_' + n, { x: b?.state.pos.x, y: b?.state.pos.y, volume: this.hitVolume(0.5) });
			});
		}
	}

	private hitVolume(scale: number): number {
		const b = this.ball();
		if (!b) {
			return scale;
		}
		const v = b.hit.vel;
		const speed = Math.sqrt(v.x * v.x + v.y * v.y);
		return Math.min(1, (speed * speed) / 800) * scale + 0.08;
	}

	// --- vari-target ----------------------------------------------------------------

	private variHit(idx: number): void {
		const ball = this.ball();
		if (!ball || this.variResetting) {
			return;
		}
		const vel = ball.hit.vel;
		if (vel.y < 0) {
			// Moving up: pushing the arm back.
			vel.y *= VARI_DELAY;
			if (idx > this.variMax) {
				this.variMax = idx;
				this.variAngle = -(idx * 1.5);
			}
		} else if (!this.variScored && this.variMax >= VARI_POSITIONS[0]) {
			this.variScored = true;
			// Each contact the wiper passed closes the vari switch once; the
			// last position is wired to the "5 bonus & multiplier" switch.
			if (this.variMax >= VARI_POSITIONS[2]) {
				this.pulse(SW.OUTLANE);
				this.audio.cue('variMax');
			} else {
				const pulses = this.variMax >= VARI_POSITIONS[1] ? 2 : 1;
				for (let i = 0; i < pulses; i++) {
					this.sim.after(i * 120, () => this.pulse(SW.VARI));
				}
			}
			this.sim.after(900, () => this.resetVari());
		}
	}

	private resetVari(): void {
		if (this.variMax < 0 && this.variAngle === 0) {
			return;
		}
		this.variResetting = true;
		this.audio.sample('solenoid', { x: 120, y: 360, volume: 0.7 });
		const tick = () => {
			this.variAngle = Math.min(0, this.variAngle + 1.5);
			if (this.variAngle < 0) {
				this.sim.after(10, tick);
			} else {
				this.variMax = -1;
				this.variScored = false;
				this.variResetting = false;
			}
		};
		tick();
	}

	// --- coils ------------------------------------------------------------------------

	private serveBall(): void {
		const k = this.t.kickers.BallRelease;
		if (!k) {
			return;
		}
		if (this.sim.balls.length > 0) {
			// Totem is a one-ball game: the trough never feeds a second ball.
			console.warn('ball release skipped: a ball is already on the table');
			return;
		}
		const api = k.getApi();
		api.CreateBall();
		api.Kick(55, 6);
		this.audio.sample('ballrelease', { x: k.data.center.x, y: k.data.center.y });
		this.audio.sample('solenoid', { x: k.data.center.x, y: k.data.center.y, volume: 0.8 });
	}

	private kickHole(): void {
		const k = this.t.kickers.sw41;
		if (!k) {
			return;
		}
		this.opened(SW.HOLE);
		k.getApi().Kick(235, 6);
		this.audio.sample('solenoid', { x: k.data.center.x, y: k.data.center.y });
		this.kickArm = 15;
		this.sim.after(60, () => this.kickArm = 0);
	}

	private resetDrops(): void {
		let any = false;
		for (const name of ['sw20', 'sw21', 'sw24', 'sw30', 'sw31', 'sw34']) {
			const target = this.t.hitTargets[name];
			const api = target?.getApi();
			if (api && api.IsDropped) {
				api.IsDropped = false;
				any = true;
			}
		}
		if (any) {
			this.audio.sample('DTReset', { x: 450, y: 780 });
		}
	}

	private animateSling(): void {
		this.sim.cancel(this.slingTimer);
		this.sling = 1;
		this.slingTimer = this.sim.after(45, () => {
			this.sling = 2;
			this.slingTimer = this.sim.after(40, () => this.sling = 0);
		});
	}

	// --- per-frame visuals ------------------------------------------------------------

	/** Moves the toys that the original table script animated by hand. */
	public updateVisuals(): void {
		const t = this.t;
		const lf = t.flippers.LeftFlipper?.getApi().CurrentAngle ?? 0;
		const rf = t.flippers.RightFlipper?.getApi().CurrentAngle ?? 0;
		this.prim('lflipb', p => p.RotZ = lf);
		this.prim('lflipr', p => p.RotZ = lf);
		this.prim('FlipperLSh', p => p.RotZ = lf);
		this.prim('rflipb', p => p.RotZ = rf);
		this.prim('rflipr', p => p.RotZ = rf);
		this.prim('FlipperRSh', p => p.RotZ = rf);
		const gate = t.gates.Gate?.getApi();
		if (gate) {
			this.prim('Pgate', p => p.RotX = gate.CurrentAngle);
		}
		this.prim('VariTargetP', p => p.RotX = this.variAngle);
		this.prim('Pkickarm', p => p.RotZ = this.kickArm);
		this.prim('SLING1', p => p.TransZ = this.sling === 1 ? -20 : this.sling === 2 ? -10 : 0);
		this.rubberVisible('RSling', this.sling === 0);
		this.rubberVisible('RSling1', this.sling === 1);
		this.rubberVisible('RSling2', this.sling === 2);
	}

	private prim(name: string, fn: (api: any) => void): void {
		const p = this.t.primitives[name];
		if (p) {
			fn(p.getApi());
		}
	}

	private rubberVisible(name: string, visible: boolean): void {
		const r = this.t.rubbers[name];
		if (r && r.getApi().Visible !== visible) {
			r.getApi().Visible = visible;
		}
	}

	/** Ball rolling noise, called once per rendered frame. */
	public updateRolling(): void {
		const balls = this.sim.balls;
		for (let i = 0; i < 2; i++) {
			const b = balls[i];
			const key = 'roll' + i;
			if (!b || b.state.isFrozen) {
				this.audio.loop(key, 'fx_ballrolling0', { volume: 0 });
				continue;
			}
			const v = b.hit.vel;
			const speed = Math.sqrt(v.x * v.x + v.y * v.y);
			const onPlayfield = b.state.pos.z < 30;
			const vol = onPlayfield && speed > 1 ? Math.min(1, (speed * speed) / 1600) : 0;
			this.audio.loop(key, 'fx_ballrolling0', { volume: vol * 0.9, rate: 0.75 + Math.min(0.9, speed / 60), x: b.state.pos.x, y: b.state.pos.y });
		}
	}

	private lastCollision = 0;

	/** Generic impact sounds for posts, rubbers, metal guides and walls. */
	private collisionSound(ball: Ball, obj: HitObject, speed: number): void {
		if (speed < 2.5 || !obj.obj) {
			return;
		}
		const now = this.sim.now;
		if (now - this.lastCollision < 25) {
			return;
		}
		const item: any = (obj.obj as any).playable;
		if (!item || item instanceof Flipper || item instanceof Bumper || item instanceof HitTarget || item instanceof Kicker || item instanceof Gate) {
			return; // these have their own sounds
		}
		const name: string = item.getName?.() ?? '';
		const mat: string = (item.data?.szMaterial || item.data?.szSideMaterial || item.data?.szPhysicsMaterial || '').toLowerCase();
		const p = ball.state.pos;
		let sample: string | undefined;
		let vol = Math.min(1, speed / 28);
		if (item instanceof Rubber || mat.includes('rubber') || /rubber|post|peg|sling/i.test(name)) {
			sample = speed > 16 ? 'fx_rubber2' : `rubber_hit_${1 + Math.floor(Math.random() * 3)}`;
		} else if (mat.includes('metal') || mat.includes('chrome') || /rail|guide|wire|metal|screw/i.test(name)) {
			sample = speed > 10 ? 'metalhit_medium' : 'metalhit_thin';
			vol *= 0.7;
		} else if (item instanceof Surface || item instanceof Primitive) {
			sample = 'pinhit_low';
			vol *= 0.5;
		}
		if (sample) {
			this.lastCollision = now;
			this.audio.sample(sample, { x: p.x, y: p.y, volume: vol });
		}
	}
}
