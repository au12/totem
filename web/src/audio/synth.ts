/*
 * The machine's own voice. Totem shipped with Gottlieb's "Multi-Mode" sound
 * board, which an operator could set to electronic sound effects or to
 * chime-like tones. Neither ROM is available, so both are synthesized here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { SoundCue } from '../game/hardware';

export type ToneStyle = 'sounds' | 'chimes';

export class MachineSynth {

	private readonly out: GainNode;
	private noise?: AudioBuffer;
	private lastAt: { [cue: string]: number } = {};
	public style: ToneStyle = 'sounds';

	constructor(private readonly ctx: AudioContext, dest: AudioNode) {
		this.out = ctx.createGain();
		this.out.gain.value = 0.55;
		// A gentle low-pass takes the edge off raw oscillators, like the
		// little speaker in the cabinet.
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 5200;
		lp.Q.value = 0.4;
		this.out.connect(lp).connect(dest);
	}

	public play(cue: SoundCue): void {
		const ctx = this.ctx;
		if (ctx.state !== 'running') {
			return;
		}
		const t = ctx.currentTime + 0.005;
		// Rapid repeats of the same cue would pile up: keep a minimum gap.
		const last = this.lastAt[cue] ?? -1;
		if (t - last < 0.03) {
			return;
		}
		this.lastAt[cue] = t;
		const chimes = this.style === 'chimes';
		switch (cue) {
			case 'tone10': chimes ? this.chime(t, 1568, 0.9) : this.blip(t, 2093, 0.05, 'square', 0.18); break;
			case 'tone100': chimes ? this.chime(t, 1175, 1.0) : this.blip(t, 1047, 0.075, 'square', 0.2, 0.85); break;
			case 'tone1000': chimes ? this.chime(t, 784, 1.2) : this.blip(t, 523, 0.11, 'square', 0.22, 0.75); break;
			case 'bonusTick': chimes ? this.chime(t, 784, 0.8) : this.blip(t, 392, 0.07, 'square', 0.2, 0.9); break;
			case 'ballStart': this.arp(t, [392, 523, 659], 0.07, 'triangle', 0.25); break;
			case 'playerAdd': this.arp(t, [659, 784], 0.06, 'square', 0.18); break;
			case 'multiplier': this.arp(t, [523, 659, 784, 1047], 0.06, 'square', 0.2); break;
			case 'targetsComplete': this.sweep(t, 300, 1500, 0.35, 'sawtooth', 0.16); break;
			case 'variMax': this.sweep(t, 200, 1200, 0.3, 'square', 0.16); break;
			case 'holeAward': this.sweep(t, 1500, 400, 0.4, 'triangle', 0.25); break;
			case 'extraBall': this.arp(t, [523, 659, 784, 1047, 784, 1047], 0.09, 'square', 0.22); break;
			case 'special':
			case 'replay': this.arp(t, [784, 1047, 1319, 1568], 0.08, 'triangle', 0.25); break;
			case 'match': this.arp(t, [1047, 1319], 0.1, 'triangle', 0.25); break;
			case 'tilt': this.buzz(t, 0.9); break;
			case 'gameStart': this.startTune(t); break;
			case 'gameOver': this.arp(t, [659, 523, 440, 330], 0.16, 'triangle', 0.25); break;
		}
	}

	private env(t: number, peak: number, attack: number, decay: number): GainNode {
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(peak, t + attack);
		g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
		g.connect(this.out);
		return g;
	}

	private osc(type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode): OscillatorNode {
		const o = this.ctx.createOscillator();
		o.type = type;
		o.frequency.setValueAtTime(f, t);
		o.connect(dest);
		o.start(t);
		o.stop(t + dur + 0.05);
		return o;
	}

	/** A short electronic tone with a slight pitch drop. */
	private blip(t: number, f: number, dur: number, type: OscillatorType, vol: number, drop = 0.92): void {
		const g = this.env(t, vol, 0.003, dur);
		const o = this.osc(type, f, t, dur, g);
		o.frequency.exponentialRampToValueAtTime(f * drop, t + dur);
	}

	/** Struck-bell chime: inharmonic partials with long decays. */
	private chime(t: number, f: number, len: number): void {
		const partials: Array<[number, number, number]> = [[1, 0.5, len], [2.76, 0.18, len * 0.45], [5.4, 0.08, len * 0.25], [8.93, 0.04, len * 0.15]];
		for (const [ratio, vol, decay] of partials) {
			const g = this.env(t, vol * 0.6, 0.002, decay);
			this.osc('sine', f * ratio, t, decay, g);
		}
	}

	private arp(t: number, notes: number[], step: number, type: OscillatorType, vol: number): void {
		notes.forEach((f, i) => this.blip(t + i * step, f, step * 1.3, type, vol, 0.98));
	}

	private sweep(t: number, from: number, to: number, dur: number, type: OscillatorType, vol: number): void {
		const g = this.env(t, vol, 0.01, dur);
		const o = this.osc(type, from, t, dur, g);
		o.frequency.exponentialRampToValueAtTime(to, t + dur);
	}

	private buzz(t: number, dur: number): void {
		const g = this.env(t, 0.25, 0.01, dur);
		const o = this.osc('sawtooth', 70, t, dur, g);
		o.frequency.linearRampToValueAtTime(55, t + dur);
		const o2 = this.osc('square', 73, t, dur, g);
		o2.frequency.linearRampToValueAtTime(58, t + dur);
	}

	/** Tom-tom and a pentatonic call: a little Totem theme for game start. */
	private startTune(t: number): void {
		const beat = 0.15;
		const drums = [0, 2, 3, 4, 6, 7];
		for (const b of drums) {
			this.drum(t + b * beat, b % 4 === 0 ? 1 : 0.7);
		}
		const melody: Array<[number, number, number]> = [[0, 440, 2], [2, 523, 1], [3, 587, 1], [4, 659, 2], [6, 587, 1], [7, 880, 3]];
		for (const [b, f, len] of melody) {
			this.blip(t + b * beat, f, beat * len * 0.9, 'square', 0.13, 0.99);
		}
	}

	private drum(t: number, vol: number): void {
		const g = this.env(t, 0.5 * vol, 0.002, 0.22);
		const o = this.osc('sine', 150, t, 0.25, g);
		o.frequency.exponentialRampToValueAtTime(60, t + 0.2);
		// A touch of noise for the skin.
		const n = this.ctx.createBufferSource();
		n.buffer = this.noiseBuffer();
		const ng = this.env(t, 0.12 * vol, 0.001, 0.05);
		const bp = this.ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = 900;
		n.connect(bp).connect(ng);
		n.start(t);
		n.stop(t + 0.08);
	}

	private noiseBuffer(): AudioBuffer {
		if (!this.noise) {
			const len = Math.floor(this.ctx.sampleRate * 0.2);
			this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
			const d = this.noise.getChannelData(0);
			for (let i = 0; i < len; i++) {
				d[i] = Math.random() * 2 - 1;
			}
		}
		return this.noise;
	}
}
