/*
 * Totem web — application shell: loading, layout, menus, input routing and
 * the frame loop.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import './styles.css';
import { NeutralToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';
import { GameSession, NudgeDir } from './app/session';
import { AudioEngine } from './audio/audio';
import { LoadedPack, loadPack, Quality } from './engine/pack';
import { LAMP_BALL_IN_PLAY } from './game/hardware';
import { DEFAULT_RULES, PersistentState, RulesSettings } from './game/totem-rules';
import { projectedAspect, VIEWS, ViewSpec } from './render/camera';
import { Backglass } from './ui/backglass';
import { Command, Input, keyName } from './ui/input';
import { formatScore, Scores } from './ui/scores';
import { ActionId, ACTIONS, DEFAULT_KEYS, Settings } from './ui/settings';
import { ScoreStrip } from './ui/strip';
import { Logger, Progress } from './vpx/util/logger';

declare const __BUILD__: { version: string };

const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: noop, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);

type State = 'boot' | 'error' | 'home' | 'help' | 'playing' | 'paused' | 'over';

interface TableInfo {
	id: string;
	name: string;
	gameName: string;
	status: 'ready' | 'converting' | 'error';
	pack?: string;
	error?: string;
	progress?: number;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

const MACHINE_KEY = 'totem.machine';
/** Tone-mapping exposure for the table at the default brightness (was 1.05). */
const TABLE_EXPOSURE = 0.78;

class App {

	private readonly settings = new Settings();
	private readonly scores = new Scores();
	private readonly audio = new AudioEngine();
	private readonly stage = $('#stage');
	private readonly tableCanvas = $<HTMLCanvasElement>('#table');
	private readonly backglass = new Backglass($<HTMLCanvasElement>('#backglass'));
	private readonly strip = new ScoreStrip($<HTMLCanvasElement>('#strip'), this.backglass);
	private readonly input: Input;
	private renderer?: WebGLRenderer;
	private session?: GameSession;
	private pack?: LoadedPack;
	private state: State = 'boot';
	private prevState: State = 'home';
	private showBackglass = true;
	private persistent: PersistentState;
	private wakeLock: any = null;
	private frames = 0;
	private fpsT = 0;
	private lastPlayers = 1;
	private pendingEntries: Array<{ player: number, score: number }> = [];
	private lastGameScores: number[] = [];
	private highlight?: { name: string, score: number };

	constructor() {
		this.persistent = this.loadMachine();
		this.input = new Input(this.stage, {
			onAction: (a, down, t) => this.onAction(a, down, t),
			onCommand: c => this.onCommand(c),
			onDevice: kind => this.onDevice(kind),
		});
		this.input.attachTouch(this.stage);
		this.applySettings();
		this.settings.addEventListener('change', () => this.applySettings());
		this.bindUi();
		addEventListener('resize', () => this.layout());
		screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.layout(), 50));
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				this.autoPause();
			} else if (this.state === 'playing') {
				this.requestWakeLock();
			}
		});
		addEventListener('blur', () => {
			if (this.settings.get('game.pauseOnBlur')) {
				this.autoPause();
			}
		});
		document.addEventListener('fullscreenchange', () => this.updateFullscreenButtons());
		this.boot().catch(err => this.fail('The table could not be loaded', `<p>${escapeHtml(String(err?.message || err))}</p>`));
	}

	// --- boot ----------------------------------------------------------------

	private async boot(): Promise<void> {
		this.setState('boot');
		const table = await this.findTable();
		if (!table) {
			return;
		}
		const quality = this.pickQuality();
		const total = { loaded: 0 };
		let expected = 0;
		const bar = $('#boot-bar');
		const progress = () => {
			const pct = expected > 0 ? Math.min(100, Math.round(total.loaded / expected * 100)) : 0;
			bar.style.width = pct + '%';
		};
		const fetcher = async (url: string): Promise<ArrayBuffer> => {
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`${url}: HTTP ${res.status}`);
			}
			if (!res.body) {
				const b = await res.arrayBuffer();
				total.loaded += b.byteLength;
				progress();
				return b;
			}
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let n = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				chunks.push(value);
				n += value.length;
				total.loaded += value.length;
				progress();
			}
			const out = new Uint8Array(n);
			let o = 0;
			for (const c of chunks) {
				out.set(c, o);
				o += c.length;
			}
			return out.buffer;
		};
		$('#boot-text').textContent = 'Loading the table…';
		const pack = await loadPack(table.pack!, quality, async url => {
			const b = await fetcher(url);
			if (url.endsWith('manifest.json')) {
				const m = JSON.parse(new TextDecoder().decode(b));
				expected = (m.bytes?.[quality] || 0) * 0.92;
			}
			return b;
		});
		this.pack = pack;
		document.title = 'Totem';

		const renderer = this.renderer = new WebGLRenderer({
			canvas: this.tableCanvas,
			antialias: this.highQuality,
			powerPreference: 'high-performance',
			alpha: false,
			stencil: false,
		});
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.toneMapping = NeutralToneMapping;
		renderer.toneMappingExposure = this.tableExposure();
		this.tableCanvas.addEventListener('webglcontextlost', e => {
			e.preventDefault();
			this.fail('The graphics stopped', '<p>Your browser reset its graphics. Reload the page to keep playing.</p>');
		});

		const bgLoad = this.backglass.load(pack).catch(() => {});
		const session = this.session = new GameSession(pack, renderer, this.audio, this.backglass, {
			rules: this.rulesSettings(),
			persistent: this.persistent,
			tiltSensitivity: this.settings.get<number>('game.tilt'),
			events: {
				onGameStart: n => this.onGameStart(n),
				onBallStart: (p) => {
					this.strip.current = p;
					this.backglass.setBlink(p, true);
				},
				onBallEnd: () => this.backglass.setBlink(-1, false),
				onGameOver: (s, h) => this.onGameOver(s, h),
				onPersist: p => this.saveMachine(p),
				onCallout: t => this.callout(t),
				onTilt: () => this.callout('Tilt'),
			},
		});
		this.applyCards();
		this.audio.loadSounds(pack.manifest.sounds.map(s => ({ name: s.name, url: pack.url(s.url) })), fetcher, pack.table.getDimensions().width).catch(() => {});
		await Promise.all([session.texturesReady, bgLoad]);
		this.layout();
		requestAnimationFrame(t => this.frame(t));
		this.syncHouseHigh();
		this.setState('home');
	}

	private async findTable(): Promise<TableInfo | null> {
		for (let attempt = 0; ; attempt++) {
			let body: any;
			try {
				const res = await fetch('api/tables', { cache: 'no-store' });
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				body = await res.json();
			} catch {
				// No server API (static hosting): look for a pack next to the page.
				const res = await fetch('pack/manifest.json', { cache: 'no-store' }).catch(() => null);
				if (res && res.ok) {
					return { id: 'local', name: 'Totem', gameName: 'totem', status: 'ready', pack: 'pack/' };
				}
				this.fail('The game server is not answering', '<p>Check that the Totem container is running, then try again.</p>');
				return null;
			}
			this.scores.serverAvailable = !!body.leaderboard;
			const tables: TableInfo[] = body.tables || [];
			const table = tables.find(t => t.gameName === 'totem') || tables[0];
			if (!table) {
				this.fail('The table files are missing', `
					<p>Put <b>Totem (Gottlieb 1979).vpx</b> and, for the backglass, <b>Totem (Gottlieb 1979).directb2s</b> in the folder mounted at <code>/data</code>, then try again.</p>
					<p>The table is converted for the web the first time it is found.</p>`);
				return null;
			}
			if (table.status === 'ready' && table.pack) {
				return table;
			}
			if (table.status === 'error') {
				this.fail('The table could not be read', `<p>${escapeHtml(table.error || 'Unknown error.')}</p><p>Check that the .vpx file is complete and not open in another program.</p>`);
				return null;
			}
			$('#boot-text').textContent = 'Preparing the table for the web. This happens once and takes a few seconds…';
			$('#boot-bar').style.width = Math.round((table.progress || 0) * 100) + '%';
			await new Promise(r => setTimeout(r, attempt < 10 ? 700 : 1500));
		}
	}

	private fail(title: string, html: string): void {
		$('#error-title').textContent = title;
		$('#error-text').innerHTML = html;
		this.setState('error');
	}

	private get highQuality(): boolean {
		const q = this.settings.get<string>('display.quality');
		if (q !== 'auto') {
			return q === 'high';
		}
		const mem = (navigator as any).deviceMemory;
		return mem === undefined || mem >= 4;
	}

	private pickQuality(): Quality {
		return this.highQuality ? 'hd' : 'sd';
	}

	private rulesSettings(): RulesSettings {
		return {
			...DEFAULT_RULES,
			ballsPerGame: this.settings.get<number>('game.balls') === 3 ? 3 : 5,
			match: !!this.settings.get('game.match'),
		};
	}

	/** Shows the instruction and replay cards that match the settings on the apron. */
	private applyCards(): void {
		if (!this.session || !this.pack) {
			return;
		}
		const balls = this.settings.get<number>('game.balls') === 3 ? 3 : 5;
		const card = balls === 3 ? 'InstCard3balls' : 'InstCard5balls';
		this.session.view.setItemTexture('instcard', card);
		this.session.view.setItemTexture('repcard', 'RepCardHSTD');
		const tex = this.pack.texture(card);
		if (tex) {
			$<HTMLImageElement>('#help-instructions').src = this.pack.url(this.pack.quality === 'hd' ? tex.hd : tex.sd);
		}
	}

	// --- persistence -----------------------------------------------------------

	private loadMachine(): PersistentState {
		try {
			const s = JSON.parse(localStorage.getItem(MACHINE_KEY) || 'null');
			if (s && typeof s.hstd === 'number') {
				return { credits: s.credits | 0, hstd: s.hstd, lastScores: Array.isArray(s.lastScores) ? s.lastScores : [] };
			}
		} catch {
			// ignore
		}
		return { credits: 0, hstd: 0, lastScores: [] };
	}

	private saveMachine(p: PersistentState): void {
		try {
			localStorage.setItem(MACHINE_KEY, JSON.stringify(p));
		} catch {
			// quota
		}
	}

	/** The backglass "high game to date" shows the best score anyone in the house has posted. */
	private async syncHouseHigh(): Promise<void> {
		const best = await this.scores.best();
		const top = best.list[0]?.score || 0;
		if (top > this.persistent.hstd) {
			this.persistent.hstd = top;
			this.saveMachine(this.persistent);
		}
		this.renderHomeScores();
	}

	// --- state & panels --------------------------------------------------------

	private setState(s: State): void {
		if (s !== this.state && (this.state === 'home' || this.state === 'playing' || this.state === 'paused' || this.state === 'over')) {
			this.prevState = this.state;
		}
		this.state = s;
		const panel = { boot: 'boot', error: 'error', home: 'home', help: 'help', playing: null, paused: 'pause', over: 'over' }[s];
		for (const p of $$('[data-panel]')) {
			p.hidden = p.dataset.panel !== panel;
		}
		$('#panels').classList.toggle('center', s === 'boot' || s === 'error');
		// Paused keeps the score strip in view; the play controls go away.
		$('#hud').hidden = s !== 'playing' && s !== 'paused';
		$('#hud').classList.toggle('paused', s === 'paused');
		this.input.setMode(s === 'playing' ? 'game' : 'menu');
		this.audio.setMuted(false);
		if (s === 'playing') {
			this.session?.resume();
			this.requestWakeLock();
			(document.activeElement as HTMLElement | null)?.blur?.();
		} else if (s === 'paused' || s === 'help' && this.prevState === 'paused') {
			this.session?.pause();
		}
		if (s !== 'playing') {
			this.releaseWakeLock();
		}
		if (s === 'home') {
			this.renderHomeScores();
			this.updatePlayersSeg();
			setTimeout(() => $('#play-btn')?.focus({ preventScroll: true }), 50);
		}
		if (s === 'help') {
			this.renderHelp();
		}
		this.layout();
	}

	private autoPause(): void {
		if (this.state === 'playing') {
			this.pauseGame();
		}
	}

	private pauseGame(): void {
		if (!this.session) {
			return;
		}
		const v = this.session.rules.view;
		const who = v.players.length > 1 ? `Player ${v.current + 1}, ball` : 'Ball';
		$('#pause-score').textContent = v.mode === 'game' ? `${who} ${v.ball} of ${this.session.rules.settings.ballsPerGame}, score ${formatScore(v.players[v.current] || 0)}` : '';
		this.setState('paused');
	}

	// --- UI wiring -------------------------------------------------------------

	private bindUi(): void {
		document.addEventListener('click', e => {
			const el = (e.target as HTMLElement).closest('[data-cmd]') as HTMLElement | null;
			if (el) {
				this.command(el.dataset.cmd!);
			}
		});
		for (const b of $$('#players-seg [data-players]')) {
			b.addEventListener('click', () => {
				this.settings.set('game.players', Number(b.dataset.players));
				this.updatePlayersSeg();
			});
		}
		for (const b of $$('#scores-scope [data-scope]')) {
			b.addEventListener('click', () => this.renderHomeScores(b.dataset.scope as 'shared' | 'local'));
		}
		$<HTMLFormElement>('#over-entry').addEventListener('submit', e => {
			e.preventDefault();
			this.submitEntry();
		});
		this.buildSettings();
		window.addEventListener('keydown', e => {
			if (this.state === 'home' && (e.code === 'Digit1' || e.code === 'KeyS') && !(e.target as HTMLElement).closest('input')) {
				e.preventDefault();
				this.command('play');
			}
		});
		if (!document.fullscreenEnabled) {
			for (const b of $$('[data-cmd="fullscreen"]')) {
				b.hidden = true;
			}
		}
	}

	private command(cmd: string): void {
		switch (cmd) {
			case 'play':
				this.startGame(this.settings.get<number>('game.players'));
				break;
			case 'again':
				this.startGame(this.lastPlayers);
				break;
			case 'resume':
				this.setState('playing');
				break;
			case 'restart':
				this.session?.rules.abort();
				this.startGame(this.lastPlayers);
				break;
			case 'quit':
				this.session?.rules.abort();
				this.session?.resume();
				this.setState('home');
				break;
			case 'help':
				this.setState('help');
				break;
			case 'back':
				this.onCommand('back');
				break;
			case 'settings':
				this.openSettings();
				break;
			case 'fullscreen':
				this.toggleFullscreen();
				break;
			case 'reload':
				location.reload();
				break;
		}
	}

	private startGame(players: number): void {
		if (!this.session) {
			return;
		}
		this.audio.ctx.resume().catch(() => {});
		const rules = this.session.rules;
		rules.settings = this.rulesSettings();
		this.session.tiltSensitivity = this.settings.get<number>('game.tilt');
		if (rules.mode !== 'attract') {
			rules.abort();
		}
		this.lastPlayers = players;
		this.highlight = undefined;
		this.session.resume();
		rules.start(players);
		this.setState('playing');
		if (!this.settings.get('player.seenHelp')) {
			this.settings.set('player.seenHelp', true);
			this.callout(this.isTouch ? 'Tap left or right to flip' : 'Shift keys flip, Space launches');
		}
	}

	private onGameStart(players: number): void {
		this.strip.players = players;
		this.strip.current = 0;
	}

	private onGameOver(scores: number[], hstdBeaten: boolean): void {
		this.lastGameScores = scores;
		this.backglass.setBlink(-1, false);
		this.strip.players = scores.length;
		setTimeout(() => this.showGameOver(scores, hstdBeaten), 600);
	}

	private async showGameOver(scores: number[], hstdBeaten: boolean): Promise<void> {
		if (this.state !== 'playing' && this.state !== 'paused') {
			return;
		}
		const list = $('#over-scores');
		list.innerHTML = '';
		scores.forEach((s, i) => {
			const li = document.createElement('li');
			li.innerHTML = `<span>${scores.length > 1 ? 'Player ' + (i + 1) : 'Your score'}</span><span class="s">${formatScore(s)}</span>`;
			list.appendChild(li);
		});
		$('#over-note').textContent = hstdBeaten ? 'New high game to date!' : '';
		this.pendingEntries = [];
		const order = scores.map((score, player) => ({ player, score })).sort((a, b) => b.score - a.score);
		for (const e of order) {
			if (await this.scores.qualifies(e.score)) {
				this.pendingEntries.push(e);
			}
		}
		this.setState('over');
		this.nextEntry();
	}

	private nextEntry(): void {
		const form = $('#over-entry');
		const e = this.pendingEntries[0];
		if (!e) {
			form.hidden = true;
			$('#over-actions').hidden = false;
			setTimeout(() => $('[data-cmd="again"]')?.focus({ preventScroll: true }), 50);
			return;
		}
		form.hidden = false;
		$('#over-actions').hidden = true;
		$('#over-entry-label').textContent = this.lastGameScores.length > 1
			? `High score for player ${e.player + 1}: ${formatScore(e.score)}`
			: `New high score: ${formatScore(e.score)}`;
		const input = $<HTMLInputElement>('#over-name');
		input.value = this.settings.get('player.name') || '';
		if (!this.isTouch) {
			setTimeout(() => input.focus(), 60);
		}
	}

	private async submitEntry(): Promise<void> {
		const e = this.pendingEntries.shift();
		const name = $<HTMLInputElement>('#over-name').value.trim();
		if (e && name) {
			this.settings.set('player.name', name);
			this.highlight = { name, score: e.score };
			await this.scores.submit({ name, score: e.score, players: this.lastGameScores.length });
			this.toast('Score saved');
		}
		this.nextEntry();
	}

	private async renderHomeScores(scope?: 'shared' | 'local'): Promise<void> {
		const el = $('#home-scores');
		const scopeSeg = $('#scores-scope');
		scopeSeg.hidden = !this.scores.serverAvailable;
		let list;
		let shared = false;
		if (scope === 'local' || !this.scores.serverAvailable) {
			list = this.scores.local();
		} else {
			const b = await this.scores.best();
			list = b.list;
			shared = b.shared;
		}
		for (const b of $$('#scores-scope [data-scope]')) {
			b.setAttribute('aria-selected', String((b.dataset.scope === 'shared') === shared));
		}
		el.innerHTML = '';
		if (!list.length) {
			el.innerHTML = '<li><span class="empty">No scores yet. Yours could be the first.</span></li>';
			return;
		}
		list.slice(0, 5).forEach((s, i) => {
			const li = document.createElement('li');
			if (this.highlight && s.name === this.highlight.name && s.score === this.highlight.score) {
				li.className = 'me';
			}
			li.innerHTML = `<span class="n">${i + 1}</span><span>${escapeHtml(s.name)}</span><span class="s">${formatScore(s.score)}</span>`;
			el.appendChild(li);
		});
	}

	private updatePlayersSeg(): void {
		const n = this.settings.get<number>('game.players');
		for (const b of $$('#players-seg [data-players]')) {
			b.setAttribute('aria-checked', String(Number(b.dataset.players) === n));
		}
	}

	private renderHelp(): void {
		const touch = this.isTouch;
		const keys = this.settings.get<{ [a: string]: string[] }>('controls.keys');
		const k = (a: ActionId) => (keys[a] || []).slice(0, 2).map(keyName).join(' or ');
		$('#help-controls').innerHTML = touch
			? `<dl>
				<dt>Flippers</dt><dd>Tap and hold the left or right side of the screen.</dd>
				<dt>Launch</dt><dd>Hold the red Launch button, then let go. Hold longer for a stronger shot.</dd>
				<dt>Nudge</dt><dd>The Nudge button at the top right bumps the cabinet. Bump too often and it tilts.</dd>
				<dt>Pause</dt><dd>The menu button at the top left.</dd>
			</dl>`
			: `<dl>
				<dt>Flippers</dt><dd>${k('left')} and ${k('right')}</dd>
				<dt>Launch</dt><dd>Hold ${k('plunger')}, then let go</dd>
				<dt>Nudge</dt><dd>${k('nudgeUp')}, ${k('nudgeLeft')}, ${k('nudgeRight')}</dd>
				<dt>Add player</dt><dd>${k('start')} during the first ball</dd>
				<dt>Pause</dt><dd>Esc</dd>
			</dl>`;
	}

	// --- input -----------------------------------------------------------------

	private isTouch = matchMedia('(pointer: coarse)').matches;

	private onDevice(kind: string): void {
		const touch = kind === 'touch';
		if (touch !== this.isTouch) {
			this.isTouch = touch;
			this.layout();
		}
	}

	private onAction(a: ActionId, down: boolean, t: number): void {
		const s = this.session;
		if (!s || this.state !== 'playing') {
			return;
		}
		switch (a) {
			case 'left':
			case 'right':
				s.flipper(a, down, t);
				break;
			case 'plunger':
				s.plunger(down, t);
				break;
			case 'start':
				if (down && s.start(1)) {
					this.strip.players = s.rules.playerCount;
					this.callout(`Player ${s.rules.playerCount} added`);
				}
				break;
			case 'nudgeUp':
			case 'nudgeLeft':
			case 'nudgeRight':
				if (down) {
					const dir: NudgeDir = a === 'nudgeUp' ? 'up' : a === 'nudgeLeft' ? 'left' : 'right';
					s.nudge(dir, t);
				}
				break;
		}
	}

	private onCommand(c: Command): void {
		if (c === 'fullscreen') {
			this.toggleFullscreen();
			return;
		}
		if (c === 'menu') {
			if (this.state === 'playing') {
				this.pauseGame();
			}
			return;
		}
		if (c === 'back') {
			const dlg = $<HTMLDialogElement>('#settings');
			if (dlg.open) {
				dlg.close();
				return;
			}
			if (this.state === 'paused') {
				this.setState('playing');
			} else if (this.state === 'help') {
				this.setState(this.prevState === 'paused' ? 'paused' : 'home');
			} else if (this.state === 'over' && !this.pendingEntries.length) {
				this.setState('home');
			}
			return;
		}
		if (c === 'activate') {
			(document.activeElement as HTMLElement | null)?.click?.();
			return;
		}
		if (c.startsWith('nav:')) {
			this.navFocus(c.slice(4) as 'up' | 'down' | 'left' | 'right');
		}
	}

	private navFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
		const visible = $$('#panels .card:not([hidden]) button:not([hidden]), #panels .card:not([hidden]) input').filter(b => b.offsetParent);
		if (!visible.length) {
			return;
		}
		const cur = document.activeElement as HTMLElement;
		let i = visible.indexOf(cur);
		if (i < 0) {
			visible[0].focus();
			return;
		}
		i = (dir === 'up' || dir === 'left') ? Math.max(0, i - 1) : Math.min(visible.length - 1, i + 1);
		visible[i].focus();
	}

	// --- frame loop -------------------------------------------------------------

	private lastRender = 0;

	private frame(now: number): void {
		requestAnimationFrame(t => this.frame(t));
		const s = this.session;
		if (!s || document.hidden) {
			return;
		}
		this.input.poll(now);
		// Menus only need the attract lamp show (about 20 fps); a paused table
		// doesn't change at all. Sparing the GPU there saves phone batteries.
		if (this.state !== 'playing') {
			const interval = s.paused ? 500 : 48;
			if (now - this.lastRender < interval) {
				return;
			}
		}
		this.lastRender = now;
		s.frame(now);
		this.backglass.draw();
		if (!this.showBackglass) {
			this.strip.draw();
		}
		if (this.state === 'playing') {
			this.updateHud();
		}
		this.frames++;
		if (now - this.fpsT > 1000) {
			if (this.settings.get('display.fps')) {
				const info = this.renderer!.info.render;
				$('#fps').textContent = `${Math.round(this.frames * 1000 / (now - this.fpsT))} fps · ${info.calls} calls`;
			}
			this.frames = 0;
			this.fpsT = now;
		}
	}

	private updateHud(): void {
		const s = this.session!;
		const r = s.rules;
		const launch = $('#launch');
		const showLaunch = r.isPlaying && s.table.ballInShooterLane && !r.tilted;
		if (launch.hidden === showLaunch) {
			launch.hidden = !showLaunch;
		}
		const add = $('#add-player');
		const canAdd = r.isPlaying && r.ball === 1 && r.current === 0 && r.playerCount < 4 && this.backglass.lamp(LAMP_BALL_IN_PLAY) === 1 && s.table.ballInShooterLane;
		if (add.hidden === canAdd) {
			add.hidden = !canAdd;
		}
		if (this.settings.get('display.tiltMeter')) {
			const d = s.tiltDanger;
			const meter = $('#tilt-meter');
			meter.classList.toggle('show', d > 0.02);
			(meter.firstElementChild as HTMLElement).style.height = Math.round(d * 100) + '%';
		}
		if (r.isPlaying && !s.table.ballInShooterLane) {
			this.backglass.setBlink(-1, false);
		}
	}

	// --- layout -------------------------------------------------------------------

	private layout(): void {
		this.lastRender = 0; // redraw on the next frame, even when paused
		const vw = window.innerWidth, vh = window.innerHeight;
		const dpr = Math.min(window.devicePixelRatio || 1, this.highQuality ? 2 : 1.5);
		const bgAspect = this.backglass.aspect;
		const pref = this.settings.get<string>('display.backglass');
		const portrait = vh >= vw;
		let bgRect = { x: 0, y: 0, w: 0, h: 0 };
		let tRect = { x: 0, y: 0, w: vw, h: vh };
		const menu = this.state !== 'playing' && this.state !== 'paused';
		if (this.backglass.available && pref !== 'hide') {
			if (portrait) {
				const fullH = vw / bgAspect;
				let h: number;
				if (pref === 'show') {
					h = Math.min(fullH, vh * 0.42);
				} else if (menu) {
					// Menus: the backglass art above, the card over the table.
					h = Math.min(fullH, vh * 0.36);
				} else {
					// Playing: only when the table still gets most of a tall screen.
					h = Math.min(fullH, vh - vw * 1.85);
				}
				if (h >= (menu ? 110 : 160)) {
					const w = h * bgAspect;
					bgRect = { x: (vw - w) / 2, y: 0, w, h };
					tRect = { x: 0, y: h, w: vw, h: vh - h };
				}
			} else {
				// Landscape: the table on the left, as tall as the screen; the
				// backglass gets the width that is left, on the right.
				const fullW = vh * bgAspect;
				const tableW = Math.min(vw * 0.7, vh * this.tableAspect(vw, vh));
				const room = vw - tableW;
				const w = pref === 'show' ? Math.min(fullW, Math.max(room, vw * 0.5)) : Math.min(fullW, room);
				if (w >= 160) {
					const h = w / bgAspect;
					const tw = Math.min(tableW, vw - w);
					bgRect = { x: tw + (vw - tw - w) / 2, y: (vh - h) / 2, w, h };
					tRect = { x: 0, y: 0, w: tw, h: vh };
				}
			}
		}
		this.showBackglass = bgRect.w > 0;
		const bgBox = $('#bg-box');
		bgBox.hidden = !this.showBackglass;
		Object.assign(bgBox.style, { left: bgRect.x + 'px', top: bgRect.y + 'px', width: bgRect.w + 'px', height: bgRect.h + 'px' });
		if (this.showBackglass) {
			this.backglass.resize(bgRect.w, bgRect.h, dpr);
			this.backglass.draw(true);
		}
		const root = document.documentElement.style;
		root.setProperty('--tx', tRect.x + 'px');
		root.setProperty('--ty', tRect.y + 'px');
		root.setProperty('--tw', tRect.w + 'px');
		root.setProperty('--th', tRect.h + 'px');
		// The play controls: over the table, except beside a landscape table,
		// where they use the whole screen so Launch sits clear of the plunger.
		const hRect = this.showBackglass && !portrait ? { x: 0, y: 0, w: vw, h: vh } : tRect;
		root.setProperty('--hx', hRect.x + 'px');
		root.setProperty('--hy', hRect.y + 'px');
		root.setProperty('--hw', hRect.w + 'px');
		root.setProperty('--hh', hRect.h + 'px');
		$('#strip').hidden = this.showBackglass;
		if (!this.showBackglass) {
			requestAnimationFrame(() => this.strip.resize(dpr));
		}
		if (this.renderer && this.session) {
			this.renderer.setPixelRatio(dpr);
			this.renderer.setSize(tRect.w, tRect.h, false);
			this.session.setView(this.viewSpec(tRect.w, tRect.h), tRect.w, tRect.h);
		}
	}

	/** On-screen width / height of the table for the view a landscape screen gets. */
	private tableAspect(vw: number, vh: number): number {
		const spec = this.baseViewSpec(vw * 0.6, vh, true);
		const key = JSON.stringify(spec);
		if (key !== this.aspectKey) {
			const dim = this.pack?.table.getDimensions();
			this.aspectCache = dim ? projectedAspect(dim.width, dim.height, spec) : 0.8;
			this.aspectKey = dim ? key : '';
		}
		return this.aspectCache;
	}

	private aspectKey = '';
	private aspectCache = 0.8;

	private baseViewSpec(w: number, h: number, landscape: boolean): ViewSpec {
		const v = this.settings.get<string>('display.view');
		if (v !== 'auto' && VIEWS[v]) {
			return { ...VIEWS[v] };
		}
		if (landscape) {
			return { ...VIEWS.wide };
		}
		return { ...(w / h < 0.58 ? VIEWS.high : VIEWS.cabinet) };
	}

	private viewSpec(w: number, h: number): ViewSpec {
		const spec = this.baseViewSpec(w, h, window.innerWidth > window.innerHeight);
		// Leave room for the score strip and the menu button.
		if (!this.showBackglass) {
			spec.margin = Math.max(spec.margin, 0.02);
			spec.offsetY = -0.05;
		}
		return spec;
	}

	// --- settings -------------------------------------------------------------------

	/** Table exposure: a slightly dim cabinet by default, adjustable in Display settings. */
	private tableExposure(): number {
		const b = Number(this.settings.get('display.brightness'));
		return TABLE_EXPOSURE * (Number.isFinite(b) && b > 0 ? b : 1);
	}

	private applySettings(): void {
		const s = this.settings;
		if (this.renderer) {
			this.renderer.toneMappingExposure = this.tableExposure();
		}
		this.input.setKeys(s.get('controls.keys'));
		this.input.haptics = !!s.get('controls.haptics');
		this.input.mouse = !!s.get('controls.mouse');
		this.audio.setLevels({ master: s.get('audio.master'), effects: s.get('audio.effects'), machine: s.get('audio.machine'), stereo: !!s.get('audio.stereo') });
		this.audio.setToneStyle(s.get('audio.tones'));
		$('#fps').hidden = !s.get('display.fps');
		if (this.session) {
			this.session.tiltSensitivity = s.get<number>('game.tilt');
			if (this.session.rules.mode === 'attract') {
				this.session.rules.settings = this.rulesSettings();
			}
			this.applyCards();
		}
		this.layout();
	}

	private openSettings(tab = 'game'): void {
		const dlg = $<HTMLDialogElement>('#settings');
		this.renderSettingsTab(tab);
		dlg.showModal();
	}

	private buildSettings(): void {
		for (const t of $$('#settings [data-tab]')) {
			t.addEventListener('click', () => this.renderSettingsTab(t.dataset.tab!));
		}
		$<HTMLDialogElement>('#settings').addEventListener('close', () => {
			this.input.setMode(this.state === 'playing' ? 'game' : 'menu');
		});
	}

	private renderSettingsTab(tab: string): void {
		for (const t of $$('#settings [data-tab]')) {
			t.setAttribute('aria-selected', String(t.dataset.tab === tab));
		}
		const body = $('#settings-body');
		body.innerHTML = '';
		const s = this.settings;
		const seg = (label: string, path: string, options: Array<[string | number, string]>, hint?: string) => {
			const f = document.createElement('div');
			f.className = 'field';
			f.innerHTML = `<span class="label">${label}</span><div class="seg" role="radiogroup"></div>${hint ? `<span class="hint">${hint}</span>` : ''}`;
			const g = f.querySelector('.seg')!;
			for (const [value, text] of options) {
				const b = document.createElement('button');
				b.type = 'button';
				b.setAttribute('role', 'radio');
				b.textContent = text;
				b.setAttribute('aria-checked', String(s.get(path) === value));
				b.addEventListener('click', () => {
					s.set(path, value);
					for (const x of g.querySelectorAll('button')) {
						x.setAttribute('aria-checked', String(x === b));
					}
				});
				g.appendChild(b);
			}
			body.appendChild(f);
		};
		const check = (label: string, path: string, hint?: string) => {
			const f = document.createElement('label');
			f.className = 'field';
			f.innerHTML = `<span class="check"><input type="checkbox">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`;
			const input = f.querySelector('input')!;
			input.checked = !!s.get(path);
			input.addEventListener('change', () => s.set(path, input.checked));
			body.appendChild(f);
		};
		const slider = (label: string, path: string, range = { min: 0, max: 1, step: 0.05 }) => {
			const f = document.createElement('label');
			f.className = 'field';
			f.innerHTML = `<span class="label">${label}</span><input type="range" min="${range.min}" max="${range.max}" step="${range.step}">`;
			const input = f.querySelector('input')!;
			input.value = String(s.get(path));
			input.addEventListener('input', () => s.set(path, Number(input.value)));
			body.appendChild(f);
		};
		if (tab === 'game') {
			seg('Balls per game', 'game.balls', [[3, '3 balls'], [5, '5 balls']], 'Takes effect from the next game. The instruction card on the apron changes to match.');
			seg('Tilt', 'game.tilt', [[0, 'Off'], [0.7, 'Forgiving'], [1, 'Normal'], [1.5, 'Strict']], 'How many quick nudges the cabinet takes before it tilts.');
			check('Match at game over', 'game.match', 'A matching number on the backglass wins a free game.');
			check('Pause when switching apps', 'game.pauseOnBlur');
		} else if (tab === 'display') {
			seg('Camera', 'display.view', [['auto', 'Auto'], ['cabinet', 'Cabinet'], ['high', 'Raised'], ['overhead', 'Overhead']], 'Auto picks the best angle for the screen shape.');
			slider('Table brightness', 'display.brightness', { min: 0.6, max: 1.4, step: 0.05 });
			seg('Backglass', 'display.backglass', [['auto', 'Auto'], ['show', 'Show'], ['hide', 'Hide']], 'Auto shows the backglass when the table still fits; otherwise scores appear in a strip above the table.');
			seg('Quality', 'display.quality', [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']], 'Low uses smaller textures and fewer pixels, for older phones. Reload to apply.');
			check('Tilt meter', 'display.tiltMeter');
			check('Frame rate', 'display.fps');
		} else if (tab === 'sound') {
			slider('Volume', 'audio.master');
			slider('Table sounds', 'audio.effects');
			slider('Machine sounds', 'audio.machine');
			seg('Scoring sounds', 'audio.tones', [['sounds', 'Sound effects'], ['chimes', 'Chime tones']], "Totem's sound board could be set to either.");
			check('Stereo', 'audio.stereo');
		} else if (tab === 'controls') {
			check('Vibrate on touch', 'controls.haptics');
			check('Mouse buttons flip', 'controls.mouse', 'Left and right click work the flippers, middle click launches.');
			this.renderKeys(body);
		}
	}

	private renderKeys(body: HTMLElement): void {
		const s = this.settings;
		const wrap = document.createElement('div');
		wrap.className = 'field';
		wrap.innerHTML = '<span class="label">Keys</span><div class="keys-grid"></div><button type="button" class="btn">Reset keys</button>';
		const grid = wrap.querySelector('.keys-grid')!;
		const draw = () => {
			grid.innerHTML = '';
			const keys = s.get<{ [a: string]: string[] }>('controls.keys');
			for (const a of ACTIONS) {
				const name = document.createElement('span');
				name.textContent = a.label;
				const box = document.createElement('span');
				box.className = 'keys';
				for (const code of keys[a.id] || []) {
					const cap = document.createElement('button');
					cap.type = 'button';
					cap.className = 'keycap';
					cap.textContent = keyName(code);
					cap.title = 'Remove';
					cap.addEventListener('click', () => {
						const next = { ...keys, [a.id]: keys[a.id].filter(c => c !== code) };
						s.set('controls.keys', next);
						draw();
					});
					box.appendChild(cap);
				}
				if ((keys[a.id] || []).length < 3) {
					const add = document.createElement('button');
					add.type = 'button';
					add.className = 'keycap add';
					add.textContent = 'Add';
					add.addEventListener('click', () => {
						add.textContent = 'Press a key';
						add.classList.add('listening');
						this.input.captureKey(code => {
							if (code) {
								const cur = s.get<{ [a: string]: string[] }>('controls.keys');
								const next: { [a: string]: string[] } = {};
								for (const [k, v] of Object.entries(cur)) {
									next[k] = v.filter(c => c !== code);
								}
								next[a.id] = [...next[a.id], code];
								s.set('controls.keys', next);
							}
							draw();
						});
					});
					box.appendChild(add);
				}
				grid.append(name, box);
			}
		};
		draw();
		wrap.querySelector('.btn')!.addEventListener('click', () => {
			s.set('controls.keys', structuredClone(DEFAULT_KEYS));
			draw();
		});
		body.appendChild(wrap);
	}

	// --- misc -------------------------------------------------------------------------

	private callout(text: string): void {
		const box = $('#callout');
		const span = document.createElement('span');
		span.textContent = text;
		box.appendChild(span);
		while (box.children.length > 2) {
			box.firstElementChild!.remove();
		}
		setTimeout(() => span.remove(), 2300);
	}

	private toast(text: string): void {
		const el = document.createElement('div');
		el.className = 'toast';
		el.textContent = text;
		$('#toasts').appendChild(el);
		setTimeout(() => el.remove(), 2600);
	}

	private async toggleFullscreen(): Promise<void> {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await document.documentElement.requestFullscreen({ navigationUI: 'hide' } as any);
			}
		} catch {
			// not allowed
		}
	}

	private updateFullscreenButtons(): void {
		const full = !!document.fullscreenElement;
		for (const b of $$('[data-fullscreen] use')) {
			b.setAttribute('href', full ? '#i-exit-full' : '#i-full');
		}
		setTimeout(() => this.layout(), 50);
	}

	private async requestWakeLock(): Promise<void> {
		try {
			if ('wakeLock' in navigator && !this.wakeLock) {
				this.wakeLock = await (navigator as any).wakeLock.request('screen');
				this.wakeLock.addEventListener?.('release', () => this.wakeLock = null);
			}
		} catch {
			// not granted
		}
	}

	private releaseWakeLock(): void {
		this.wakeLock?.release?.().catch(() => {});
		this.wakeLock = null;
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const app = new App();
(window as any).__app = app;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
	addEventListener('load', () => {
		navigator.serviceWorker.register('sw.js').catch(() => {});
	});
}
