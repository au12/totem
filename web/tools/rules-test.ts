/*
 * Unit tests for the reconstructed Totem rules, against a fake machine with
 * a manual clock. Run: node tools/run-ts.mjs tools/rules-test.ts
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Hardware, LampState, SoundCue, Solenoid } from '../src/game/hardware';
import { DEFAULT_RULES, PersistentState, RulesSettings, SW, TotemRules } from '../src/game/totem-rules';

class FakeMachine implements Hardware {
	public t = 0;
	public timers = new Map<number, { at: number, fn: () => void, every?: number }>();
	private nextId = 1;
	public lamps = new Map<number, LampState>();
	public scores: Array<number | null> = [null, null, null, null];
	public status: [number | null, number | null] = [null, null];
	public fired: Solenoid[] = [];
	public sounds: SoundCue[] = [];
	public flippers = false;
	public balls = 0;

	now() { return this.t; }
	after(ms: number, fn: () => void) { const id = this.nextId++; this.timers.set(id, { at: this.t + ms, fn }); return id; }
	every(ms: number, fn: () => void) { const id = this.nextId++; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
	cancel(id: number | undefined) { if (id !== undefined) { this.timers.delete(id); } }
	setLamp(n: number, s: LampState) { this.lamps.set(n, s); }
	setScore(p: number, v: number | null) { this.scores[p] = v; }
	setStatus(c: number | null, b: number | null) { this.status = [c, b]; }
	fire(s: Solenoid) {
		this.fired.push(s);
		if (s === 'outhole') { this.balls++; }
	}
	setFlippers(e: boolean) { this.flippers = e; }
	sound(c: SoundCue) { this.sounds.push(c); }
	ballsOnTable() { return this.balls; }

	/** Runs the clock forward, firing timers in order. */
	advance(ms: number) {
		const end = this.t + ms;
		for (;;) {
			let next: [number, { at: number, fn: () => void, every?: number }] | undefined;
			for (const e of this.timers) {
				if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) {
					next = e;
				}
			}
			if (!next) { break; }
			const [id, timer] = next;
			this.t = timer.at;
			if (timer.every) { timer.at += timer.every; } else { this.timers.delete(id); }
			timer.fn();
		}
		this.t = end;
	}
}

let failures = 0;
let count = 0;
function check(name: string, cond: boolean, detail = ''): void {
	count++;
	if (!cond) {
		failures++;
		console.log(`FAIL ${name} ${detail}`);
	}
}

function setup(settings: Partial<RulesSettings> = {}, persistent: Partial<PersistentState> = {}) {
	const hw = new FakeMachine();
	const p: PersistentState = { credits: 0, hstd: 0, lastScores: [], ...persistent };
	const events: string[] = [];
	let over: { scores: number[], hstd: boolean } | undefined;
	const rules = new TotemRules(hw, { ...DEFAULT_RULES, ...settings }, p, {
		onGameStart: n => events.push('start' + n),
		onBallStart: (pl, b) => events.push(`ball${pl}:${b}`),
		onGameOver: (scores, hstd) => { over = { scores, hstd }; },
		onCallout: t => events.push(t),
	});
	rules.boot();
	const hit = (sw: number) => { rules.switchClosed(sw); hw.advance(3000); };
	const drain = () => { hw.balls = 0; rules.drained(); hw.advance(20000); };
	return { hw, rules, p, events, hit, drain, over: () => over };
}

// Starting a game serves a ball and enables the flippers.
{
	const { hw, rules, events } = setup();
	check('start', rules.start(1));
	hw.advance(1000);
	check('ball 1', rules.ball === 1 && events.includes('ball0:1'));
	check('served', hw.fired.includes('outhole') && hw.balls === 1);
	check('flippers on', hw.flippers);
	check('attract ended', rules.mode === 'game');
}

// Scores tally in steps; top lane = 5000 and lights the letter's drop targets.
{
	const { hw, rules, hit } = setup();
	rules.start(1);
	hw.advance(1000);
	rules.switchClosed(SW.LANE_B);
	hw.advance(100);
	check('tally in progress', rules.currentScore > 0 && rules.currentScore < 5000, String(rules.currentScore));
	hw.advance(3000);
	check('top lane 5000', rules.currentScore === 5000, String(rules.currentScore));
	check('lane lamp B', hw.lamps.get(18) === 1);
	check('B targets lit', hw.lamps.get(12) === 1 && hw.lamps.get(11) === 1);
	hit(SW.DT_B_LEFT);
	check('lit drop target 5000', rules.currentScore === 10000, String(rules.currentScore));
	hit(SW.DT_A);
	check('unlit drop target 500', rules.currentScore === 10500, String(rules.currentScore));
	check('bonus counts', rules.view.bonus === 3, String(rules.view.bonus));
	hit(SW.DT_B_CENTER);
	check('B group + lane -> 2X', rules.view.multiplier === 2, String(rules.view.multiplier));
	hit(SW.DT_B_CENTER);
	check('a dropped target scores once', rules.currentScore === 15500, String(rules.currentScore));
}

// All six drop targets: 5000, multiplier, extra ball lit, targets reset.
{
	const { hw, rules, hit, events } = setup();
	rules.start(1);
	hw.advance(1000);
	for (const sw of [SW.DT_A, SW.DT_B_LEFT, SW.DT_B_CENTER, SW.DT_C_CENTER, SW.DT_C_RIGHT, SW.DT_D]) {
		hit(sw);
	}
	check('six drops', rules.currentScore === 6 * 500 + 5000, String(rules.currentScore));
	check('multiplier 2X', rules.view.multiplier === 2);
	check('extra ball lit', hw.lamps.get(13) === 1 && events.includes('Extra ball is lit'));
	check('drop reset', hw.fired.filter(s => s === 'dropReset').length >= 2);
	hit(SW.EXTRA_BALL);
	check('extra ball awarded', rules.view.shootAgain === 1 && hw.lamps.get(4) === 1);
	hit(SW.EXTRA_BALL);
	check('unlit EB target 500', rules.view.shootAgain === 1);
	// Drain: bonus 6 x 2 = 12,000, then the same player shoots again on ball 1.
	const before = rules.currentScore;
	const { drain } = { drain: () => { hw.balls = 0; rules.drained(); hw.advance(20000); } };
	drain();
	check('bonus counted with multiplier', rules.currentScore - before === 12000, String(rules.currentScore - before));
	check('shoot again keeps ball 1', rules.ball === 1 && rules.view.shootAgain === 0);
	check('multiplier reset', rules.view.multiplier === 1);
}

// Special: A-B-C-D lanes plus all drops light the hole; the hole awards a replay.
{
	const { hw, rules, hit, p, events } = setup();
	rules.start(1);
	hw.advance(1000);
	for (const sw of [SW.LANE_A, SW.LANE_B, SW.LANE_C, SW.LANE_D]) {
		hit(sw);
	}
	for (const sw of [SW.DT_A, SW.DT_B_LEFT, SW.DT_B_CENTER, SW.DT_C_CENTER, SW.DT_C_RIGHT, SW.DT_D]) {
		hit(sw);
	}
	check('special lit', events.includes('Special is lit') && hw.lamps.get(7) === 1);
	const credits = p.credits;
	hit(SW.HOLE);
	check('special replay', p.credits === credits + 1 && hw.fired.includes('knocker'));
	check('hole kicks out', hw.fired.includes('hole'));
}

// Bonus 20,000 lights the hole for "scores bonus".
{
	const { hw, rules, hit, events } = setup();
	rules.start(1);
	hw.advance(1000);
	for (let i = 0; i < 4; i++) {
		hit(SW.OUTLANE); // +5 bonus and multiplier each
	}
	check('bonus capped at 20', rules.view.bonus === 20);
	check('multiplier capped at 5', rules.view.multiplier === 5);
	check('scores bonus lit', events.includes('Hole scores bonus') && hw.lamps.get(5) === 1);
	const before = rules.currentScore;
	rules.switchClosed(SW.HOLE);
	hw.advance(10000);
	check('hole scores bonus', rules.currentScore - before === 5000 + 20 * 5000, String(rules.currentScore - before));
	check('bonus rebuilt from 0', rules.view.bonus === 0);
}

// Tilt: flippers off, no bonus, next ball.
{
	const { hw, rules, hit, drain } = setup();
	rules.start(1);
	hw.advance(1000);
	hit(SW.LANE_A);
	rules.tilt();
	check('flippers off on tilt', !hw.flippers && rules.tilted);
	const before = rules.currentScore;
	hit(SW.BUMPER);
	check('no scoring while tilted', rules.currentScore === before);
	drain();
	check('no bonus after tilt', rules.currentScore === before);
	check('next ball after tilt', rules.ball === 2 && !rules.tilted && hw.flippers);
}

// A ball that drains without touching a switch is served again.
{
	const { hw, rules } = setup();
	rules.start(1);
	hw.advance(1000);
	const served = hw.fired.filter(s => s === 'outhole').length;
	hw.balls = 0;
	rules.drained();
	hw.advance(2000);
	check('re-served', rules.ball === 1 && hw.fired.filter(s => s === 'outhole').length === served + 1);
}

// Two players alternate; a player can be added during ball 1 only.
{
	const { hw, rules, hit, drain } = setup();
	rules.start(1);
	hw.advance(1000);
	check('add player on ball 1', rules.start(1) && rules.playerCount === 2);
	hit(SW.BUMPER);
	drain();
	check('player 2 up', rules.current === 1 && rules.ball === 1);
	hit(SW.BUMPER);
	drain();
	check('back to player 1, ball 2', rules.current === 0 && rules.ball === 2);
	check('no adding after ball 1', !rules.start(1) && rules.playerCount === 2);
}

// Full game: game over after five balls, high score to date, replays, match.
{
	const { hw, rules, hit, drain, p, over } = setup({ match: false }, { hstd: 100000, credits: 0 });
	rules.start(1);
	hw.advance(1000);
	for (let ball = 1; ball <= 5; ball++) {
		check(`ball ${ball}`, rules.ball === ball);
		for (let i = 0; i < 6; i++) {
			hit(SW.GATE); // 5000 each
		}
		drain();
	}
	const o = over();
	check('game over', !!o && rules.mode === 'attract');
	check('final score', o?.scores[0] === 5 * (6 * 5000 + 6000), String(o?.scores[0]));
	check('hstd beaten', o?.hstd === true && p.hstd === o?.scores[0]);
	check('hstd replays', p.credits === 3, String(p.credits));
	check('game over lamp', hw.lamps.get(1) === 1);
	check('flippers off after game', !hw.flippers);
}

// Replay level.
{
	const { hw, rules, p } = setup({ replayLevels: [20000] });
	rules.start(1);
	hw.advance(1000);
	for (let i = 0; i < 4; i++) {
		rules.switchClosed(SW.GATE);
	}
	hw.advance(10000);
	check('replay at level', p.credits === 1, String(p.credits));
}

// 3-ball: A and D lanes tied, ABCD lights extra ball, bumpers 1000.
{
	const { hw, rules, hit, events } = setup({ ballsPerGame: 3 });
	rules.start(1);
	hw.advance(1000);
	hit(SW.LANE_A);
	check('A lights D', hw.lamps.get(15) === 1 && hw.lamps.get(17) === 1);
	hit(SW.LANE_B);
	hit(SW.LANE_C);
	check('3-ball ABCD lights EB', events.includes('Extra ball is lit'));
	const before = rules.currentScore;
	hit(SW.BUMPER);
	check('3-ball bumper 1000', rules.currentScore - before === 1000);
}

// Abort returns to attract and stops the tally.
{
	const { hw, rules } = setup();
	rules.start(1);
	hw.advance(1000);
	rules.switchClosed(SW.GATE);
	rules.abort();
	hw.advance(5000);
	check('abort to attract', rules.mode === 'attract' && !hw.flippers);
}

console.log(`${count - failures}/${count} rule checks passed`);
if (failures) {
	process.exit(1);
}
