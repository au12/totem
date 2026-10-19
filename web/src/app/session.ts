/*
 * One loaded table: physics, rules, scene, sounds and backglass, run from
 * the browser's frame loop.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PerspectiveCamera, WebGLRenderer } from 'three';
import { AudioEngine } from '../audio/audio';
import { LoadedPack } from '../engine/pack';
import { Sim } from '../engine/sim';
import { Solenoid } from '../game/hardware';
import { DEFAULT_RULES, PersistentState, RulesEvents, RulesSettings, SW, TotemRules } from '../game/totem-rules';
import { TOTEM_DYNAMIC_ITEMS, TOTEM_HIDDEN_ITEMS, TotemTable } from '../game/totem-table';
import { frameTable, TABLE_BOX, ViewSpec } from '../render/camera';
import { TableView } from '../render/table-view';
import { Backglass } from '../ui/backglass';

export type NudgeDir = 'left' | 'right' | 'up';

export interface SessionOptions {
	rules: RulesSettings;
	persistent: PersistentState;
	events: RulesEvents;
	tiltSensitivity: number; // 0 = never tilts
	onSolenoid?: (sol: Solenoid) => void;
}

const MAX_FRAME_MS = 100;

export class GameSession {

	public readonly sim: Sim;
	public readonly table: TotemTable;
	public readonly rules: TotemRules;
	public readonly view: TableView;
	public readonly camera = new PerspectiveCamera(30, 1, 10, 20000);
	public paused = false;
	private gameTime = 0;
	private lastWall = -1;
	private tiltLevel = 0;
	private tiltLastT = 0;
	private stillMs = 0;
	private viewSpec?: ViewSpec;
	private width = 1;
	private height = 1;
	public tiltSensitivity: number;
	public onFrame?: () => void;
	private readonly dim: { width: number, height: number };

	constructor(public readonly pack: LoadedPack, private readonly renderer: WebGLRenderer, private readonly audio: AudioEngine,
		public readonly backglass: Backglass, opts: SessionOptions) {
		this.sim = new Sim(pack.table);
		this.table = new TotemTable(this.sim, audio);
		this.table.onSolenoid = opts.onSolenoid;
		this.rules = new TotemRules(this.table, opts.rules ?? DEFAULT_RULES, opts.persistent, opts.events);
		this.table.connect({
			switchClosed: sw => this.rules.switchClosed(sw),
			switchOpened: sw => this.rules.switchOpened(sw),
			drained: () => this.rules.drained(),
		}, backglass);
		this.view = new TableView(pack, renderer, { dynamicItems: TOTEM_DYNAMIC_ITEMS, hiddenItems: TOTEM_HIDDEN_ITEMS });
		this.view.attach(this.sim.player);
		this.tiltSensitivity = opts.tiltSensitivity;
		this.dim = pack.table.getDimensions();
		this.rules.boot();
	}

	public get texturesReady(): Promise<void> {
		return this.view.textures.whenLoaded();
	}

	public setView(spec: ViewSpec, width: number, height: number): void {
		this.viewSpec = spec;
		this.width = Math.max(1, width);
		this.height = Math.max(1, height);
		frameTable(this.camera, this.dim.width, this.dim.height, this.width / this.height, spec, TABLE_BOX);
		this.baseCamPos = this.camera.position.clone();
	}

	private baseCamPos = this.camera.position.clone();

	// --- controls -------------------------------------------------------------

	/** Brings the simulation up to the moment an input event happened. */
	private catchUp(eventTime?: number): void {
		if (this.paused || this.lastWall < 0 || eventTime === undefined) {
			return;
		}
		const t = this.gameTime + Math.max(0, Math.min(MAX_FRAME_MS, eventTime - this.lastWall));
		if (t > this.sim.now) {
			this.sim.advanceTo(t);
		}
	}

	public flipper(side: 'left' | 'right', down: boolean, eventTime?: number): void {
		this.catchUp(eventTime);
		this.table.flipper(side, down);
	}

	public plunger(down: boolean, eventTime?: number): void {
		this.catchUp(eventTime);
		this.table.plunger(down);
	}

	/** Start button: start a game, or add a player while ball 1 is up. */
	public start(players = 1): boolean {
		return this.rules.start(players);
	}

	public nudge(dir: NudgeDir, eventTime?: number): void {
		if (this.paused) {
			return;
		}
		this.catchUp(eventTime);
		const s = 0.55;
		if (dir === 'left') {
			this.sim.nudge(s * 0.8, -s * 0.25);
		} else if (dir === 'right') {
			this.sim.nudge(-s * 0.8, -s * 0.25);
		} else {
			this.sim.nudge(0, -s);
		}
		this.audio.sample('fx_nudge', { volume: 0.8 });
		// The tilt bob swings more the more often the cabinet is bumped.
		if (this.tiltSensitivity > 0 && this.rules.isPlaying) {
			this.decayTilt();
			this.tiltLevel += 1;
			if (this.tiltLevel > 4.2 / this.tiltSensitivity) {
				this.tiltLevel = 0;
				this.rules.switchClosed(SW.TILT);
			}
		}
	}

	private decayTilt(): void {
		const t = this.sim.now;
		this.tiltLevel = Math.max(0, this.tiltLevel - (t - this.tiltLastT) / 1400);
		this.tiltLastT = t;
	}

	/** 0..1 for the tilt meter. */
	public get tiltDanger(): number {
		if (this.tiltSensitivity <= 0) {
			return 0;
		}
		this.decayTilt();
		return Math.min(1, this.tiltLevel / (4.2 / this.tiltSensitivity));
	}

	public pause(): void {
		this.paused = true;
		this.table.flipper('left', false);
		this.table.flipper('right', false);
		this.audio.stopLoops();
	}

	public resume(): void {
		this.paused = false;
		this.lastWall = -1;
	}

	// --- frame ------------------------------------------------------------------

	public frame(now: number): void {
		if (this.lastWall < 0) {
			this.lastWall = now;
		}
		const dt = Math.max(0, Math.min(MAX_FRAME_MS, now - this.lastWall));
		this.lastWall = now;
		if (!this.paused) {
			this.gameTime = Math.max(this.gameTime + dt, this.sim.now);
			this.sim.advanceTo(this.gameTime);
			this.sim.animate();
			this.table.updateVisuals();
			this.table.updateRolling();
			this.watchStuckBall(dt);
		}
		this.view.sync();
		const shake = this.sim.shake;
		this.camera.position.set(this.baseCamPos.x - shake.x, this.baseCamPos.y, this.baseCamPos.z - shake.y);
		this.renderer.render(this.view.scene, this.camera);
		this.backglass.tick(this.gameTime);
		this.onFrame?.();
	}

	/**
	 * A real ball never balances on a ledge forever; a simulated one
	 * occasionally does. After a few seconds without moving, give the
	 * cabinet a gentle bump, as a player would.
	 */
	private watchStuckBall(dt: number): void {
		const balls = this.sim.balls;
		if (!this.rules.isPlaying || balls.length !== 1 || this.table.ballInShooterLane) {
			this.stillMs = 0;
			return;
		}
		const b = balls[0];
		const v = b.hit.vel;
		if (b.state.isFrozen || Math.hypot(v.x, v.y) > 0.25) {
			this.stillMs = 0;
			return;
		}
		this.stillMs += dt;
		if (this.stillMs > 5000) {
			this.stillMs = 0;
			const dir = Math.random() < 0.5 ? 1 : -1;
			this.sim.nudge(0.35 * dir, -0.35);
		}
	}

	public dispose(): void {
		this.rules.abort();
		this.audio.stopLoops();
		this.view.dispose();
	}
}
