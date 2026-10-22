// Restarting mid-game on the real table: no leftover or extra balls, and the
// next ball comes after a drain. Run: node tools/run-ts.mjs tools/restart-check.ts <packDir>
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
	const table = new TotemTable(sim, { sample: noop, loop: noop, cue: noop });
	const rules = new TotemRules(table, { ...DEFAULT_RULES, ballsPerGame: 5 }, { credits: 0, hstd: 0, lastScores: [] });
	table.connect({
		switchClosed: s => rules.switchClosed(s),
		switchOpened: s => rules.switchOpened(s),
		drained: () => rules.drained(),
	}, { setScore: noop, setStatus: noop, setLamp: noop });
	rules.boot();
	let t = 0;
	const run = (ms: number) => { const end = t + ms; while (t < end) { t += 5; sim.advanceTo(t); sim.animate(); table.updateVisuals(); } };
	const plunge = () => { table.plunger(true); run(600); table.plunger(false); };
	let failures = 0;
	const check = (name: string, ok: boolean, detail = '') => { if (!ok) { failures++; } console.log(ok ? 'ok  ' : 'FAIL', name, detail); };
	const restart = () => { rules.abort(); rules.start(1); };

	// 1. Restart with a ball waiting in the shooter lane.
	rules.start(1);
	run(1500);
	check('ball in shooter lane', sim.balls.length === 1 && table.ballInShooterLane);
	restart();
	check('restart empties the table', sim.balls.length === 0);
	run(1500);
	check('one ball after restart', sim.balls.length === 1 && table.ballInShooterLane, `${sim.balls.length} balls`);

	// 2. Launch, restart, launch, restart... (the multiball trick).
	for (let i = 0; i < 5; i++) {
		plunge();
		run(1500);
		restart();
		run(1500);
	}
	check('no balls stacked by launch/restart', sim.balls.length === 1, `${sim.balls.length} balls`);

	// 3. Restart with a ball held in the hole.
	plunge();
	run(1000);
	table['t'].kickers.sw41.getApi().CreateBall();
	restart();
	check('hole released on restart', !table['t'].kickers.sw41.hit?.ball && sim.balls.length === 0);
	run(1500);
	check('one ball after hole restart', sim.balls.length === 1, `${sim.balls.length} balls`);

	// 4. Play the ball out with dead flippers: the drain is counted and ball 2 is served.
	plunge();
	let waited = 0;
	while (rules.ball === 1 && waited < 120000) { run(1000); waited += 1000; }
	run(3000);
	check('drain moves to ball 2', rules.ball === 2, `ball ${rules.ball} after ${waited / 1000}s`);
	check('ball 2 served', sim.balls.length === 1 && table.ballInShooterLane, `${sim.balls.length} balls`);

	console.log(failures ? `${failures} FAILED` : 'all restart checks passed');
	process.exit(failures ? 1 : 0);
})();
