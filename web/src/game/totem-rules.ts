/*
 * Gottlieb's TOTEM (1979, System 1, game #429) — the game rules.
 *
 * The original ROM is not available here, so this reconstructs the rules
 * from the table's instruction cards (5-ball and 3-ball versions, replay
 * card), the playfield artwork and lamp layout, the switch wiring used by
 * the Visual Pinball table, and published rule sheets. Where those sources
 * are silent the choice is noted ("assumed").
 *
 * Instruction card (5 balls):
 *   A, B, C or D rollovers light corresponding drop targets for increased
 *   value. Completing both "B" or "C" drop targets and corresponding rollover
 *   increases bonus multiplier. Completing all drop targets increases bonus
 *   multiplier, resets targets, scores 5000 points and lights "Extra Ball"
 *   target. Completing A-B-C-D rollovers and all drop targets lights hole
 *   for "Special". Hole lights for "Scores Bonus" when bonus value is 20,000.
 *   Pop bumpers and rollover buttons score 100 points. A tilt does not
 *   disqualify a player. Matching last two numbers in score to number that
 *   appears on backglass after game is over scores one replay.
 *
 * 3-ball card differences: "A" and "D" rollovers are tied together;
 * completing A-B-C-D rollovers OR all drop targets lights "Extra Ball";
 * pop bumpers and rollover buttons score 1000.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Hardware, LAMP_BALL_IN_PLAY, LAMP_GAME_OVER, LAMP_HSTD, LAMP_MATCH, LAMP_SHOOT_AGAIN, LAMP_TILT, LampState } from './hardware';

export const SW = {
	TILT: 4,
	LANE_ADD3: 10,
	LANE_ADD2: 11,
	BUMPER: 14,
	DT_A: 20,
	DT_B_CENTER: 21,
	DT_B_LEFT: 24,
	DT_C_CENTER: 30,
	DT_C_RIGHT: 31,
	DT_D: 34,
	STAR_40: 40,
	HOLE: 41,
	VARI: 42,
	STAR_50: 50,
	OUTLANE: 51,
	RUBBER: 60,
	GATE: 61,
	STANDUP: 62,
	EXTRA_BALL: 64,
	LANE_B: 70,
	LANE_C: 71,
	LANE_D: 72,
	LANE_A: 74,
} as const;

type Letter = 'A' | 'B' | 'C' | 'D';
const LETTERS: Letter[] = ['A', 'B', 'C', 'D'];

/** Drop targets, left to right, with the insert that lights for 5000. */
export const DROP_TARGETS: Array<{ sw: number, letter: Letter, lamp: number }> = [
	{ sw: SW.DT_A, letter: 'A', lamp: 14 },
	{ sw: SW.DT_B_LEFT, letter: 'B', lamp: 12 },
	{ sw: SW.DT_B_CENTER, letter: 'B', lamp: 11 },
	{ sw: SW.DT_C_CENTER, letter: 'C', lamp: 9 },
	{ sw: SW.DT_C_RIGHT, letter: 'C', lamp: 10 },
	{ sw: SW.DT_D, letter: 'D', lamp: 8 },
];

const LANE_SWITCH: { [sw: number]: Letter } = { [SW.LANE_A]: 'A', [SW.LANE_B]: 'B', [SW.LANE_C]: 'C', [SW.LANE_D]: 'D' };
const LANE_LAMP: { [l in Letter]: number } = { A: 17, B: 18, C: 16, D: 15 };

const LAMP_SCORES_BONUS = 5;
const LAMP_SPECIAL = 7;
const LAMP_EXTRA_BALL = 13;
const LAMP_ADD3 = 21;
const LAMP_ADD2 = 22;
/** Bonus ladder: 1000 … 10,000 then 20,000. */
const BONUS_LAMPS = [23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const LAMP_BONUS_20K = 33;
/** Multiplier inserts for 2X..5X. */
const MULT_LAMPS: { [m: number]: number } = { 2: 6, 3: 36, 4: 35, 5: 34 };

const PLAYFIELD_LAMPS = [LAMP_SHOOT_AGAIN, LAMP_SCORES_BONUS, 6, LAMP_SPECIAL, 8, 9, 10, 11, 12, LAMP_EXTRA_BALL, 14, 15, 16, 17, 18,
	LAMP_ADD3, LAMP_ADD2, ...BONUS_LAMPS, LAMP_BONUS_20K, 34, 35, 36];

export const MAX_PLAYERS = 4;
export const MAX_BONUS = 20;

export interface RulesSettings {
	ballsPerGame: 3 | 5;
	/** Replay score levels (0 = off). */
	replayLevels: number[];
	/** Replays awarded for beating the high score to date (0 = off). */
	hstdReplays: number;
	match: boolean;
	/** "Extra ball" game mode turns specials into extra balls (DIP 11). */
	specialAwardsExtraBall: boolean;
}

export const DEFAULT_RULES: RulesSettings = {
	ballsPerGame: 5,
	replayLevels: [240000, 380000, 540000],
	hstdReplays: 3,
	match: true,
	specialAwardsExtraBall: false,
};

export interface PersistentState {
	credits: number;
	hstd: number;
	lastScores: number[];
}

export type Mode = 'attract' | 'game' | 'ending';

interface PlayerState {
	score: number;
	replaysEarned: number;
}

export interface RulesEvents {
	onGameStart?(players: number): void;
	onGameOver?(scores: number[], hstdBeaten: boolean): void;
	onBallStart?(player: number, ball: number): void;
	onBallEnd?(player: number, ball: number): void;
	onPersist?(p: PersistentState): void;
	onTilt?(): void;
	/** Human-readable feature callouts for the UI ("Extra ball lit", ...). */
	onCallout?(text: string): void;
}

export class TotemRules {

	public mode: Mode = 'attract';
	public players: PlayerState[] = [];
	public current = 0;
	public ball = 0;
	public tilted = false;

	// Feature state for the ball in play.
	private bonus = 0;
	private multiplier = 1;
	private lanes = new Set<Letter>();
	private dropsDown = new Set<number>();
	private bAwarded = false;
	private cAwarded = false;
	private allDropsCompleted = false;
	private extraBallLit = false;
	private specialLit = false;
	private shootAgain = 0;
	private add3Lit = true;
	private ballInPlay = false;
	private resettingDrops = false;
	private holeBusy = false;

	// Scoring is tallied the way System 1 did: 5,000 is five 1,000 steps,
	// each with its tone, which gives the game its rhythm.
	private queue: number[] = [];
	private queueTimer?: number;
	private attractTimer?: number;
	private attractStep = 0;
	private hstdShowTimer?: number;
	private readonly lamps = new Map<number, LampState>();
	private endingTimers: number[] = [];

	constructor(
		private readonly hw: Hardware,
		public settings: RulesSettings,
		public persistent: PersistentState,
		private readonly events: RulesEvents = {},
	) {}

	// --- public API --------------------------------------------------------

	/** Puts the machine in attract mode (call once after construction). */
	public boot(): void {
		this.enterAttract();
	}

	/** Start button: starts a game, or adds a player during ball 1. */
	public start(players = 1): boolean {
		if (this.mode === 'attract') {
			this.beginGame(Math.max(1, Math.min(MAX_PLAYERS, players)));
			return true;
		}
		if (this.mode === 'game' && this.ball === 1 && this.current === 0 && this.players.length < MAX_PLAYERS && !this.tilted) {
			this.players.push({ score: 0, replaysEarned: 0 });
			this.hw.setScore(this.players.length - 1, 0);
			this.hw.sound('playerAdd');
			return true;
		}
		return false;
	}

	/** Abandons the game in progress (menu "restart"/"quit"). */
	public abort(): void {
		this.cancelTimers();
		this.queue.length = 0;
		this.mode = 'attract';
		this.enterAttract();
	}

	public get currentScore(): number {
		return this.players[this.current]?.score ?? 0;
	}

	public get isPlaying(): boolean {
		return this.mode === 'game';
	}

	public get playerCount(): number {
		return this.players.length;
	}

	public lamp(n: number): LampState {
		return this.lamps.get(n) ?? 0;
	}

	public switchClosed(sw: number): void {
		if (this.mode !== 'game') {
			return;
		}
		if (sw === SW.TILT) {
			this.tilt();
			return;
		}
		if (this.tilted) {
			// Physical things still happen while tilted: the hole kicks the ball out.
			if (sw === SW.HOLE) {
				this.hw.after(400, () => this.hw.fire('hole'));
			}
			return;
		}
		if (!this.ballInPlay) {
			this.ballInPlay = true;
		}
		const three = this.settings.ballsPerGame === 3;
		switch (sw) {
			case SW.BUMPER:
				this.score(three ? 1000 : 100);
				// Assumed: the pop bumpers alternate the lit return lane.
				this.add3Lit = !this.add3Lit;
				this.updateLaneLamps();
				break;
			case SW.STAR_40:
			case SW.STAR_50:
				// "Rollover buttons" — 100 (1000 in 3-ball play); the right
				// orbit is marked "ADD BONUS".
				this.score(three ? 1000 : 100);
				this.addBonus(1);
				break;
			case SW.RUBBER:
				this.score(10);
				break;
			case SW.LANE_A:
			case SW.LANE_B:
			case SW.LANE_C:
			case SW.LANE_D:
				this.topLane(LANE_SWITCH[sw]);
				break;
			case SW.DT_A:
			case SW.DT_B_LEFT:
			case SW.DT_B_CENTER:
			case SW.DT_C_CENTER:
			case SW.DT_C_RIGHT:
			case SW.DT_D:
				this.dropTarget(sw);
				break;
			case SW.STANDUP:
				// "500 & ADD BONUS" arrows above the three target banks.
				this.score(500);
				this.addBonus(1);
				break;
			case SW.GATE:
				// "5000 & ADD BONUS" beside the gate right of the bumpers.
				this.score(5000);
				this.addBonus(1);
				break;
			case SW.EXTRA_BALL:
				if (this.extraBallLit) {
					this.extraBallLit = false;
					this.awardExtraBall();
				} else {
					this.score(500);
				}
				this.updateLamps();
				break;
			case SW.LANE_ADD3:
				// Return lane: 3000, and adds 3 to the bonus when lit.
				this.score(3000);
				if (this.add3Lit) {
					this.addBonus(3);
				}
				break;
			case SW.LANE_ADD2:
				this.score(2000);
				if (!this.add3Lit) {
					this.addBonus(2);
				}
				break;
			case SW.OUTLANE:
				// Outlanes and the vari-target's last position: "ADD 5 BONUS"
				// and "5000 & ADVANCE BONUS MULTIPLIER".
				this.score(5000);
				this.addBonus(5);
				this.advanceMultiplier();
				break;
			case SW.VARI:
				// Assumed: each vari-target contact passed scores 500 & adds bonus.
				this.score(500);
				this.addBonus(1);
				break;
			case SW.HOLE:
				this.hole();
				break;
		}
	}

	public switchOpened(_sw: number): void {
		// System 1 only scores on closure.
	}

	/** The outhole switch: a ball has drained. */
	public drained(): void {
		if (this.mode !== 'game') {
			return;
		}
		if (!this.ballInPlay && !this.tilted && this.hw.ballsOnTable() === 0) {
			// A ball that never scored (e.g. weak plunge falling back) is served again.
			this.hw.after(500, () => this.hw.fire('outhole'));
			return;
		}
		if (this.hw.ballsOnTable() > 0) {
			return;
		}
		this.endBall();
	}

	public tilt(): void {
		if (this.mode !== 'game' || this.tilted) {
			return;
		}
		this.tilted = true;
		this.queue.length = 0;
		this.hw.setFlippers(false);
		for (const l of PLAYFIELD_LAMPS) {
			this.setLamp(l, 0);
		}
		this.setLamp(LAMP_TILT, 1);
		this.hw.sound('tilt');
		this.events.onTilt?.();
	}

	// --- game flow ------------------------------------------------------------

	private beginGame(players: number): void {
		this.cancelTimers();
		this.mode = 'game';
		this.players = [];
		for (let i = 0; i < players; i++) {
			this.players.push({ score: 0, replaysEarned: 0 });
		}
		this.current = 0;
		this.ball = 1;
		this.shootAgain = 0;
		for (let i = 0; i < MAX_PLAYERS; i++) {
			this.hw.setScore(i, i < players ? 0 : null);
		}
		this.setLamp(LAMP_GAME_OVER, 0);
		this.setLamp(LAMP_HSTD, 0);
		this.setLamp(LAMP_MATCH, 0);
		this.setLamp(LAMP_TILT, 0);
		this.hw.sound('gameStart');
		this.events.onGameStart?.(players);
		this.startBall();
	}

	private startBall(): void {
		this.tilted = false;
		this.ballInPlay = false;
		this.bonus = 0;
		this.multiplier = 1;
		this.lanes.clear();
		this.bAwarded = false;
		this.cAwarded = false;
		this.allDropsCompleted = false;
		this.extraBallLit = false;
		this.specialLit = false;
		this.add3Lit = true;
		this.holeBusy = false;
		this.setLamp(LAMP_TILT, 0);
		this.setLamp(LAMP_BALL_IN_PLAY, 1);
		this.hw.setStatus(this.persistent.credits, this.ball);
		this.resetDropTargets(false);
		this.hw.fire('variReset');
		this.updateLamps();
		this.hw.setFlippers(true);
		this.hw.sound('ballStart');
		this.events.onBallStart?.(this.current, this.ball);
		this.hw.after(300, () => this.hw.fire('outhole'));
	}

	private endBall(): void {
		this.hw.setFlippers(false);
		this.ballInPlay = false;
		this.events.onBallEnd?.(this.current, this.ball);
		const afterBonus = () => {
			const again = this.shootAgain > 0 && !this.tilted;
			if (again) {
				this.shootAgain--;
				this.startBall();
				return;
			}
			this.shootAgain = 0;
			if (this.current < this.players.length - 1) {
				this.current++;
			} else if (this.ball < this.settings.ballsPerGame) {
				this.current = 0;
				this.ball++;
			} else {
				this.gameOver();
				return;
			}
			this.startBall();
		};
		this.whenQueueEmpty(() => {
			if (this.tilted) {
				this.hw.after(800, afterBonus);
			} else {
				this.countBonus(afterBonus);
			}
		});
	}

	private countBonus(done: () => void): void {
		const step = () => {
			if (this.bonus <= 0) {
				this.hw.after(400, done);
				return;
			}
			this.bonus--;
			this.addPoints(1000 * this.multiplier);
			this.hw.sound('bonusTick');
			this.updateBonusLamps();
			this.hw.after(this.multiplier > 1 ? 160 : 120, step);
		};
		this.hw.after(500, step);
	}

	private gameOver(): void {
		this.mode = 'ending';
		this.setLamp(LAMP_BALL_IN_PLAY, 0);
		for (const l of PLAYFIELD_LAMPS) {
			this.setLamp(l, 0);
		}
		const scores = this.players.map(p => p.score);
		const best = Math.max(...scores);
		let hstdBeaten = false;
		const steps: Array<() => void> = [];
		if (best > this.persistent.hstd) {
			hstdBeaten = this.persistent.hstd > 0;
			this.persistent.hstd = best;
			if (hstdBeaten && this.settings.hstdReplays > 0) {
				for (let i = 0; i < this.settings.hstdReplays; i++) {
					steps.push(() => this.awardCredit());
				}
			}
		}
		this.setLamp(LAMP_GAME_OVER, 1);
		this.hw.sound('gameOver');
		if (this.settings.match) {
			const n = Math.floor(Math.random() * 10) * 10;
			this.setLamp(LAMP_MATCH, 1);
			this.hw.setStatus(this.persistent.credits, n);
			const winners = scores.filter(s => s % 100 === n).length;
			if (winners) {
				steps.push(() => this.hw.sound('match'));
				for (let i = 0; i < winners; i++) {
					steps.push(() => this.awardCredit());
				}
			}
		} else {
			this.hw.setStatus(this.persistent.credits, null);
		}
		this.persistent.lastScores = scores;
		this.events.onPersist?.(this.persistent);
		let t = 900;
		for (const s of steps) {
			this.endingTimers.push(this.hw.after(t, s));
			t += 450;
		}
		this.endingTimers.push(this.hw.after(t + 300, () => {
			this.events.onPersist?.(this.persistent);
			this.events.onGameOver?.(scores, hstdBeaten);
			this.enterAttract();
		}));
	}

	// --- features --------------------------------------------------------------

	private topLane(letter: Letter): void {
		// "5000 & ADD BONUS" is printed over the four top lanes.
		this.score(5000);
		this.addBonus(1);
		const collect = (l: Letter) => {
			if (!this.lanes.has(l)) {
				this.lanes.add(l);
			}
		};
		collect(letter);
		if (this.settings.ballsPerGame === 3 && (letter === 'A' || letter === 'D')) {
			collect(letter === 'A' ? 'D' : 'A');
		}
		this.checkLetterGroups();
		if (this.lanes.size === 4 && this.settings.ballsPerGame === 3 && !this.extraBallLit) {
			this.lightExtraBall();
		}
		this.checkSpecial();
		this.updateLamps();
	}

	private dropTarget(sw: number): void {
		if (this.dropsDown.has(sw) || this.resettingDrops) {
			return;
		}
		this.dropsDown.add(sw);
		const dt = DROP_TARGETS.find(d => d.sw === sw)!;
		this.score(this.lanes.has(dt.letter) ? 5000 : 500);
		this.addBonus(1);
		this.checkLetterGroups();
		if (this.dropsDown.size === DROP_TARGETS.length) {
			// All six: multiplier, 5000, extra ball (and special when the
			// rollovers are done too), then the banks reset.
			this.allDropsCompleted = true;
			this.score(5000);
			this.advanceMultiplier();
			this.hw.sound('targetsComplete');
			if (!this.extraBallLit) {
				this.lightExtraBall();
			}
			this.checkSpecial();
			this.resettingDrops = true;
			this.hw.after(900, () => this.resetDropTargets(true));
		}
		this.updateLamps();
	}

	/** "Completing both B or C drop targets and corresponding rollover increases bonus multiplier." */
	private checkLetterGroups(): void {
		const both = (letter: Letter) => DROP_TARGETS.filter(d => d.letter === letter).every(d => this.dropsDown.has(d.sw));
		if (!this.bAwarded && this.lanes.has('B') && both('B')) {
			this.bAwarded = true;
			this.advanceMultiplier();
		}
		if (!this.cAwarded && this.lanes.has('C') && both('C')) {
			this.cAwarded = true;
			this.advanceMultiplier();
		}
	}

	private checkSpecial(): void {
		if (!this.specialLit && this.lanes.size === 4 && this.allDropsCompleted) {
			this.specialLit = true;
			this.events.onCallout?.('Special is lit');
		}
	}

	private lightExtraBall(): void {
		this.extraBallLit = true;
		this.events.onCallout?.('Extra ball is lit');
	}

	private resetDropTargets(physical: boolean): void {
		this.dropsDown.clear();
		this.bAwarded = false;
		this.cAwarded = false;
		this.resettingDrops = false;
		this.hw.fire('dropReset');
		if (physical) {
			this.updateLamps();
		}
	}

	private hole(): void {
		if (this.holeBusy) {
			return;
		}
		this.holeBusy = true;
		let delay = 300;
		this.score(5000);
		if (this.specialLit) {
			this.specialLit = false;
			this.hw.sound('special');
			if (this.settings.specialAwardsExtraBall) {
				this.awardExtraBall();
			} else {
				this.awardCredit();
			}
			delay += 600;
			this.events.onCallout?.('Special!');
		}
		if (this.bonus >= MAX_BONUS) {
			// Scores bonus: the whole bonus, multiplied, then it builds again.
			const amount = this.bonus * 1000 * this.multiplier;
			this.hw.sound('holeAward');
			this.events.onCallout?.(`Bonus scored: ${amount.toLocaleString('en-US')}`);
			const total = this.bonus;
			for (let i = 0; i < total; i++) {
				this.hw.after(delay + i * 110, () => {
					this.bonus = Math.max(0, this.bonus - 1);
					this.addPoints(1000 * this.multiplier);
					this.hw.sound('bonusTick');
					this.updateBonusLamps();
				});
			}
			delay += total * 110 + 300;
		}
		this.updateLamps();
		this.hw.after(delay + 500, () => {
			this.holeBusy = false;
			this.hw.fire('hole');
		});
	}

	private addBonus(n: number): void {
		const before = this.bonus;
		this.bonus = Math.min(MAX_BONUS, this.bonus + n);
		if (this.bonus !== before) {
			this.updateBonusLamps();
			if (this.bonus === MAX_BONUS) {
				this.setLamp(LAMP_SCORES_BONUS, 1);
				this.events.onCallout?.('Hole scores bonus');
			}
		}
	}

	private advanceMultiplier(): void {
		if (this.multiplier < 5) {
			this.multiplier++;
			this.hw.sound('multiplier');
			this.events.onCallout?.(`${this.multiplier}X bonus`);
			this.updateLamps();
		}
	}

	private awardExtraBall(): void {
		this.shootAgain++;
		this.setLamp(LAMP_SHOOT_AGAIN, 1);
		this.hw.sound('extraBall');
		this.events.onCallout?.('Extra ball!');
	}

	private awardCredit(): void {
		this.persistent.credits = Math.min(99, this.persistent.credits + 1);
		this.hw.fire('knocker');
		this.hw.sound('replay');
		this.hw.setStatus(this.persistent.credits, this.mode === 'game' ? this.ball : null);
		this.events.onPersist?.(this.persistent);
	}

	// --- scoring ----------------------------------------------------------------

	/** Queues points to be tallied in 10/100/1000 steps. */
	private score(points: number): void {
		if (this.tilted || this.mode !== 'game') {
			return;
		}
		let p = Math.round(points / 10) * 10;
		const units: number[] = [];
		for (const unit of [10000, 1000, 100, 10]) {
			while (p >= unit) {
				// 10,000s are tallied as ten 1,000s on System 1.
				if (unit === 10000) {
					for (let i = 0; i < 10; i++) {
						units.push(1000);
					}
				} else {
					units.push(unit);
				}
				p -= unit;
			}
		}
		this.queue.push(...units);
		this.pumpQueue();
	}

	private pumpQueue(): void {
		if (this.queueTimer !== undefined || !this.queue.length) {
			return;
		}
		const unit = this.queue.shift()!;
		this.addPoints(unit);
		this.hw.sound(unit >= 1000 ? 'tone1000' : unit >= 100 ? 'tone100' : 'tone10');
		const gap = unit >= 1000 ? 95 : unit >= 100 ? 70 : 40;
		this.queueTimer = this.hw.after(gap, () => {
			this.queueTimer = undefined;
			this.pumpQueue();
			if (!this.queue.length) {
				this.flushWaiters();
			}
		});
	}

	private waiters: Array<() => void> = [];

	private whenQueueEmpty(fn: () => void): void {
		if (!this.queue.length && this.queueTimer === undefined) {
			fn();
		} else {
			this.waiters.push(fn);
		}
	}

	private flushWaiters(): void {
		if (this.queueTimer !== undefined || this.queue.length) {
			return;
		}
		const w = this.waiters;
		this.waiters = [];
		for (const fn of w) {
			fn();
		}
	}

	private addPoints(points: number): void {
		const p = this.players[this.current];
		if (!p) {
			return;
		}
		p.score = Math.min(999990, p.score + points);
		this.hw.setScore(this.current, p.score);
		const levels = this.settings.replayLevels.filter(l => l > 0);
		while (p.replaysEarned < levels.length && p.score >= levels[p.replaysEarned]) {
			p.replaysEarned++;
			this.awardCredit();
		}
	}

	// --- lamps ----------------------------------------------------------------

	private setLamp(n: number, s: LampState): void {
		if (this.lamps.get(n) === s) {
			return;
		}
		this.lamps.set(n, s);
		this.hw.setLamp(n, s);
	}

	private updateLamps(): void {
		if (this.tilted || this.mode !== 'game') {
			return;
		}
		for (const l of LETTERS) {
			this.setLamp(LANE_LAMP[l], this.lanes.has(l) ? 1 : 0);
		}
		for (const d of DROP_TARGETS) {
			this.setLamp(d.lamp, this.lanes.has(d.letter) ? 1 : 0);
		}
		this.setLamp(LAMP_EXTRA_BALL, this.extraBallLit ? 1 : 0);
		this.setLamp(LAMP_SPECIAL, this.specialLit ? 1 : 0);
		this.setLamp(LAMP_SHOOT_AGAIN, this.shootAgain > 0 ? 1 : 0);
		for (const [m, lamp] of Object.entries(MULT_LAMPS)) {
			this.setLamp(lamp, Number(m) === this.multiplier ? 1 : 0);
		}
		this.updateLaneLamps();
		this.updateBonusLamps();
	}

	private updateLaneLamps(): void {
		if (this.tilted || this.mode !== 'game') {
			return;
		}
		this.setLamp(LAMP_ADD3, this.add3Lit ? 1 : 0);
		this.setLamp(LAMP_ADD2, this.add3Lit ? 0 : 1);
	}

	private updateBonusLamps(): void {
		if (this.tilted) {
			return;
		}
		const b = this.bonus;
		const ones = b >= MAX_BONUS ? 0 : b > 10 ? b - 10 : b === 10 ? 0 : b;
		for (let i = 0; i < 10; i++) {
			let on = false;
			if (i === 9) {
				on = b >= 10 && b < MAX_BONUS;
			} else {
				on = ones === i + 1;
			}
			this.setLamp(BONUS_LAMPS[i], on ? 1 : 0);
		}
		this.setLamp(LAMP_BONUS_20K, b >= MAX_BONUS ? 1 : 0);
		this.setLamp(LAMP_SCORES_BONUS, b >= MAX_BONUS ? 1 : 0);
	}

	// --- attract ----------------------------------------------------------------

	private enterAttract(): void {
		this.mode = 'attract';
		this.hw.setFlippers(false);
		this.setLamp(LAMP_GAME_OVER, 1);
		this.setLamp(LAMP_BALL_IN_PLAY, 0);
		this.setLamp(LAMP_TILT, 0);
		this.setLamp(LAMP_SHOOT_AGAIN, 0);
		this.showLastScores();
		this.cancel(this.attractTimer);
		this.attractStep = 0;
		this.attractTimer = this.hw.every(110, () => this.attractFrame());
		this.cancel(this.hstdShowTimer);
		let showingHstd = false;
		this.hstdShowTimer = this.hw.every(5000, () => {
			showingHstd = !showingHstd && this.persistent.hstd > 0;
			if (showingHstd) {
				for (let i = 0; i < MAX_PLAYERS; i++) {
					this.hw.setScore(i, this.persistent.hstd);
				}
				this.setLamp(LAMP_HSTD, 1);
			} else {
				this.showLastScores();
				this.setLamp(LAMP_HSTD, 0);
			}
		});
	}

	private showLastScores(): void {
		const last = this.persistent.lastScores || [];
		for (let i = 0; i < MAX_PLAYERS; i++) {
			this.hw.setScore(i, i < last.length ? last[i] : (i === 0 ? 0 : null));
		}
		this.hw.setStatus(this.persistent.credits, null);
	}

	/** A sweeping chase up the bonus ladder and around the inserts. */
	private attractFrame(): void {
		const s = this.attractStep++;
		const ladder = [...BONUS_LAMPS, LAMP_BONUS_20K];
		ladder.forEach((l, i) => this.setLamp(l, (s - i) % 12 === 0 || (s - i) % 12 === 1 ? 1 : 0));
		const mult = [6, 36, 35, 34];
		mult.forEach((l, i) => this.setLamp(l, Math.floor(s / 3) % 4 === i ? 1 : 0));
		const letters = [17, 18, 16, 15];
		letters.forEach((l, i) => this.setLamp(l, Math.floor(s / 4) % 5 > i ? 1 : 0));
		DROP_TARGETS.forEach((d, i) => this.setLamp(d.lamp, Math.floor(s / 2) % 6 === i ? 1 : 0));
		const blink = Math.floor(s / 5) % 2 === 0;
		this.setLamp(LAMP_SPECIAL, blink ? 1 : 0);
		this.setLamp(LAMP_SCORES_BONUS, blink ? 0 : 1);
		this.setLamp(LAMP_EXTRA_BALL, blink ? 1 : 0);
		this.setLamp(LAMP_ADD3, blink ? 1 : 0);
		this.setLamp(LAMP_ADD2, blink ? 0 : 1);
	}

	// --- helpers ------------------------------------------------------------------

	private cancel(id: number | undefined): void {
		if (id !== undefined) {
			this.hw.cancel(id);
		}
	}

	private cancelTimers(): void {
		this.cancel(this.attractTimer);
		this.cancel(this.hstdShowTimer);
		this.cancel(this.queueTimer);
		this.attractTimer = this.hstdShowTimer = this.queueTimer = undefined;
		for (const t of this.endingTimers) {
			this.cancel(t);
		}
		this.endingTimers = [];
		this.waiters = [];
	}

	/** Snapshot for the UI. */
	public get view() {
		return {
			mode: this.mode,
			players: this.players.map(p => p.score),
			current: this.current,
			ball: this.ball,
			bonus: this.bonus,
			multiplier: this.multiplier,
			tilted: this.tilted,
			shootAgain: this.shootAgain,
			credits: this.persistent.credits,
			hstd: this.persistent.hstd,
		};
	}
}
