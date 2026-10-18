/*
 * WebAudio output: the table's recorded sounds (from the VPX file), placed
 * in stereo by where on the playfield they happen, plus the synthesized
 * machine sounds.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { SoundCue } from '../game/hardware';
import { SampleOptions, SoundSink } from '../game/sound-sink';
import { MachineSynth, ToneStyle } from './synth';
import { parseWav } from './wav';

interface Loop {
	src: AudioBufferSourceNode;
	gain: GainNode;
	pan?: StereoPannerNode;
	name: string;
}

export interface AudioLevels {
	master: number;
	effects: number;
	machine: number;
	stereo: boolean;
}

export class AudioEngine implements SoundSink {

	public readonly ctx: AudioContext;
	private readonly master: GainNode;
	private readonly fx: GainNode;
	private readonly machineBus: GainNode;
	private readonly synth: MachineSynth;
	private readonly buffers = new Map<string, AudioBuffer | null>();
	private readonly urls = new Map<string, string>();
	private readonly loops = new Map<string, Loop>();
	private voices = 0;
	private tableWidth = 952;
	private stereo = true;
	private muted = false;

	constructor() {
		const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
		this.ctx = new Ctx({ latencyHint: 'interactive' });
		this.master = this.ctx.createGain();
		this.master.connect(this.ctx.destination);
		this.fx = this.ctx.createGain();
		this.fx.connect(this.master);
		this.machineBus = this.ctx.createGain();
		this.machineBus.connect(this.master);
		this.synth = new MachineSynth(this.ctx, this.machineBus);
		const unlock = () => {
			if (this.ctx.state !== 'running') {
				this.ctx.resume().catch(() => {});
			}
		};
		for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) {
			window.addEventListener(ev, unlock, { capture: true, passive: true });
		}
	}

	public get running(): boolean {
		return this.ctx.state === 'running';
	}

	public setLevels(l: AudioLevels): void {
		const t = this.ctx.currentTime;
		this.master.gain.setTargetAtTime(this.muted ? 0 : l.master * l.master, t, 0.02);
		this.fx.gain.setTargetAtTime(l.effects * l.effects, t, 0.02);
		this.machineBus.gain.setTargetAtTime(l.machine * l.machine, t, 0.02);
		this.stereo = l.stereo;
		this.levels = l;
	}

	private levels?: AudioLevels;

	public setMuted(muted: boolean): void {
		this.muted = muted;
		if (this.levels) {
			this.setLevels(this.levels);
		}
	}

	public setToneStyle(style: ToneStyle): void {
		this.synth.style = style;
	}

	/** Registers the pack's sounds; they are fetched in the background. */
	public async loadSounds(sounds: Array<{ name: string, url: string }>, fetcher: (url: string) => Promise<ArrayBuffer>, tableWidth: number): Promise<void> {
		this.tableWidth = tableWidth;
		const byUrl = new Map<string, Promise<AudioBuffer | null>>();
		await Promise.all(sounds.map(async s => {
			const key = s.name.toLowerCase();
			this.urls.set(key, s.url);
			let p = byUrl.get(s.url);
			if (!p) {
				p = fetcher(s.url).then(buf => this.decode(new Uint8Array(buf))).catch(() => null);
				byUrl.set(s.url, p);
			}
			this.buffers.set(key, await p);
		}));
	}

	private async decode(bytes: Uint8Array): Promise<AudioBuffer | null> {
		const wav = parseWav(bytes);
		if (wav) {
			const buf = this.ctx.createBuffer(wav.channels.length, Math.max(1, wav.frames), wav.rate);
			wav.channels.forEach((data, c) => buf.copyToChannel(data as Float32Array<ArrayBuffer>, c));
			return buf;
		}
		try {
			return await this.ctx.decodeAudioData(bytes.slice().buffer);
		} catch {
			return null;
		}
	}

	private panFor(x: number | undefined): number {
		if (!this.stereo || x === undefined) {
			return 0;
		}
		// Like the VPX tables' AudioPan: a steep curve, mostly centred.
		const tmp = Math.max(-1, Math.min(1, x * 2 / this.tableWidth - 1));
		return Math.sign(tmp) * Math.pow(Math.abs(tmp), 3) * 0.8;
	}

	public sample(name: string, opts: SampleOptions = {}): void {
		if (!this.running || this.muted) {
			return;
		}
		const buf = this.buffers.get(name.toLowerCase());
		if (!buf || this.voices > 24) {
			return;
		}
		const ctx = this.ctx;
		const src = ctx.createBufferSource();
		src.buffer = buf;
		if (opts.rate) {
			src.playbackRate.value = opts.rate;
		}
		const gain = ctx.createGain();
		gain.gain.value = Math.max(0, Math.min(1.5, opts.volume ?? 1));
		src.connect(gain);
		const panValue = this.panFor(opts.x);
		if (panValue !== 0 && ctx.createStereoPanner) {
			const pan = ctx.createStereoPanner();
			pan.pan.value = panValue;
			gain.connect(pan).connect(this.fx);
		} else {
			gain.connect(this.fx);
		}
		this.voices++;
		src.onended = () => {
			this.voices--;
			src.disconnect();
			gain.disconnect();
		};
		src.start();
	}

	public loop(key: string, name: string, opts: SampleOptions): void {
		const vol = opts.volume ?? 0;
		let l = this.loops.get(key);
		if (vol <= 0.001 || !this.running) {
			if (l) {
				const t = this.ctx.currentTime;
				l.gain.gain.setTargetAtTime(0, t, 0.03);
			}
			return;
		}
		if (!l) {
			const buf = this.buffers.get(name.toLowerCase());
			if (!buf) {
				return;
			}
			const src = this.ctx.createBufferSource();
			src.buffer = buf;
			src.loop = true;
			const gain = this.ctx.createGain();
			gain.gain.value = 0;
			src.connect(gain);
			let pan: StereoPannerNode | undefined;
			if (this.ctx.createStereoPanner) {
				pan = this.ctx.createStereoPanner();
				gain.connect(pan).connect(this.fx);
			} else {
				gain.connect(this.fx);
			}
			src.start();
			l = { src, gain, pan, name };
			this.loops.set(key, l);
		}
		const t = this.ctx.currentTime;
		l.gain.gain.setTargetAtTime(vol, t, 0.03);
		if (opts.rate) {
			l.src.playbackRate.setTargetAtTime(opts.rate, t, 0.03);
		}
		if (l.pan) {
			l.pan.pan.setTargetAtTime(this.panFor(opts.x), t, 0.05);
		}
	}

	public stopLoops(): void {
		for (const l of this.loops.values()) {
			l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
		}
	}

	public cue(cue: SoundCue): void {
		if (this.muted) {
			return;
		}
		this.synth.play(cue);
	}
}
