// Headless game test: an autopilot plays Totem and the rules are logged.
import { readFileSync } from 'fs';
import { Logger, Progress } from '../src/vpx/util/logger';
import { loadPack } from '../src/engine/pack';
import { Sim } from '../src/engine/sim';
import { TotemTable } from '../src/game/totem-table';
import { DEFAULT_RULES, TotemRules } from '../src/game/totem-rules';

const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);

(async () => {
	const pack = await loadPack(process.argv[2], 'sd', async url => { const b = readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); });
	const sim = new Sim(pack.table);
	const cues: { [k: string]: number } = {};
	const samples: { [k: string]: number } = {};
	const table = new TotemTable(sim, {
		sample: (n) => { samples[n] = (samples[n] || 0) + 1; },
		loop: () => {},
		cue: (c) => { cues[c] = (cues[c] || 0) + 1; },
	});
	const sw: { [k: number]: number } = {};
	const log = (...a: any[]) => console.log(`[${(sim.now / 1000).toFixed(1)}s]`, ...a);
	const rules = new TotemRules(table, { ...DEFAULT_RULES, ballsPerGame: Number(process.argv[3] || 3) as 3 | 5 }, { credits: 0, hstd: 0, lastScores: [] }, {
		onGameStart: n => log('game start', n),
		onBallStart: (p, b) => log('ball start player', p + 1, 'ball', b),
		onBallEnd: (p, b) => log('ball end player', p + 1, 'ball', b, 'score', rules.players[p].score),
		onGameOver: (s, h) => log('GAME OVER', s, 'hstd beaten', h),
		onCallout: t => log('  >>', t),
		onTilt: () => log('TILT'),
	});
	table.connect({
		switchClosed: s => { sw[s] = (sw[s] || 0) + 1; rules.switchClosed(s); },
		switchOpened: s => rules.switchOpened(s),
		drained: () => { log('drain'); rules.drained(); },
	}, { setScore: () => {}, setStatus: () => {}, setLamp: () => {} });
	rules.boot();
	rules.start(1);
	let t = 0;
	let plungeAt = -1;
	let gameOver = false;
	const origOnGameOver = rules['events'].onGameOver;
	rules['events'].onGameOver = (s: number[], h: boolean) => { origOnGameOver?.(s, h); gameOver = true; };
	const t0 = Date.now();
	let flipL = 0, flipR = 0;
	const maxT = Number(process.argv[4] || 600) * 1000;
	let lastLog = 0;
	while (!gameOver && t < maxT) {
		for (const b of sim.balls) { const v = b.hit.vel; const sp = Math.hypot(v.x, v.y); (b as any)._still = sp < 0.3 && !table.ballInShooterLane ? ((b as any)._still || 0) + 5 : 0; if (b.state.pos.z < -5 || b.state.pos.z > 200 || b.state.pos.x < -50 || b.state.pos.x > 1000 || b.state.pos.y > 2050) { if (!(b as any)._lost) { (b as any)._lost = 1; log('LOST BALL at', b.state.pos.x.toFixed(0), b.state.pos.y.toFixed(0), b.state.pos.z.toFixed(0)); } }
			if ((b as any)._still === 4000) log('STUCK at', b.state.pos.x.toFixed(0), b.state.pos.y.toFixed(0), b.state.pos.z.toFixed(0), 'frozen', b.state.isFrozen); }
		if (process.env.VERBOSE && t - lastLog >= 5000) { lastLog = t; log('balls', sim.balls.map(b => `(${b.state.pos.x.toFixed(0)},${b.state.pos.y.toFixed(0)},${b.state.pos.z.toFixed(0)}) v=(${b.hit.vel.x.toFixed(1)},${b.hit.vel.y.toFixed(1)}) frozen=${b.state.isFrozen}`).join(' '), 'shooter', table.ballInShooterLane); }
		t += 5;
		sim.advanceTo(t);
		sim.animate();
		table.updateVisuals();
		// autopilot: plunge a ball sitting in the shooter lane
		if (table.ballInShooterLane && plungeAt < 0) {
			plungeAt = t + 400;
			table.plunger(true);
		}
		if (plungeAt > 0 && t >= plungeAt) {
			table.plunger(false);
			plungeAt = -1;
		}
		// flip when a ball approaches a flipper
		for (const b of sim.balls) {
			const p = b.state.pos, v = b.hit.vel;
			if (v.y > 0 && p.y > 1520 && p.y < 1640) {
				if (p.x > 250 && p.x < 480 && flipL <= t) { table.flipper('left', true); flipL = t + 250; }
				if (p.x > 470 && p.x < 700 && flipR <= t) { table.flipper('right', true); flipR = t + 250; }
			}
		}
		if (flipL && t > flipL - 100) { table.flipper('left', false); }
		if (flipR && t > flipR - 100) { table.flipper('right', false); }
	}
	console.log('simulated', (t / 1000).toFixed(0), 's in', Date.now() - t0, 'ms');
	console.log('switches', JSON.stringify(sw));
	console.log('cues', JSON.stringify(cues));
	console.log('samples', JSON.stringify(samples));
	console.log('final', JSON.stringify(rules.view));
})().catch(e => { console.error(e); process.exit(1); });
