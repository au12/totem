/*
 * Persistent user settings (localStorage), with defaults and change events.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const ACTIONS = [
	{ id: 'left', label: 'Left flipper' },
	{ id: 'right', label: 'Right flipper' },
	{ id: 'plunger', label: 'Launch ball' },
	{ id: 'start', label: 'Start / add player' },
	{ id: 'nudgeUp', label: 'Nudge forward' },
	{ id: 'nudgeLeft', label: 'Nudge from left' },
	{ id: 'nudgeRight', label: 'Nudge from right' },
] as const;

export type ActionId = typeof ACTIONS[number]['id'];

export const DEFAULT_KEYS: { [a in ActionId]: string[] } = {
	left: ['ShiftLeft', 'KeyZ'],
	right: ['ShiftRight', 'Slash'],
	plunger: ['Space', 'ArrowDown', 'Enter'],
	start: ['Digit1', 'KeyS'],
	nudgeUp: ['KeyT', 'ArrowUp'],
	nudgeLeft: ['KeyX', 'ArrowLeft'],
	nudgeRight: ['Period', 'ArrowRight'],
};

const DEFAULTS = {
	version: 1,
	display: {
		view: 'auto',        // auto | cabinet | high | overhead
		backglass: 'auto',   // auto | show | hide
		quality: 'auto',     // auto | high | low
		fps: false,
		tiltMeter: true,
		brightness: 1,       // multiplies the table's exposure
	},
	audio: {
		master: 0.85,
		effects: 0.9,
		machine: 0.8,
		tones: 'sounds',     // sounds | chimes
		stereo: true,
	},
	game: {
		players: 1,
		balls: 5,
		tilt: 1,             // 0 off, 0.7 forgiving, 1 normal, 1.5 strict
		match: true,
		pauseOnBlur: true,
	},
	controls: {
		keys: DEFAULT_KEYS,
		haptics: true,
		mouse: true,
	},
	player: {
		name: '',
		seenHelp: false,
	},
};

export type SettingsData = typeof DEFAULTS;

const KEY = 'totem.settings';

function merge(base: any, over: any): any {
	if (Array.isArray(base)) {
		return Array.isArray(over) ? over.slice() : base.slice();
	}
	if (base && typeof base === 'object') {
		const out: any = {};
		for (const k of Object.keys(base)) {
			out[k] = merge(base[k], over?.[k]);
		}
		return out;
	}
	return over === undefined || typeof over !== typeof base ? base : over;
}

export class Settings extends EventTarget {

	public data: SettingsData;

	constructor() {
		super();
		let stored = null;
		try {
			stored = JSON.parse(localStorage.getItem(KEY) || 'null');
		} catch {
			// private mode
		}
		this.data = merge(DEFAULTS, stored);
	}

	public get<T = any>(path: string): T {
		return path.split('.').reduce((o: any, k) => o?.[k], this.data) as T;
	}

	public set(path: string, value: unknown): void {
		const keys = path.split('.');
		let o: any = this.data;
		for (const k of keys.slice(0, -1)) {
			o = o[k];
		}
		const last = keys[keys.length - 1];
		if (JSON.stringify(o[last]) === JSON.stringify(value)) {
			return;
		}
		o[last] = value;
		this.save();
		this.dispatchEvent(new CustomEvent('change', { detail: { path, value } }));
	}

	public reset(path: string): void {
		this.set(path, structuredClone(path.split('.').reduce((o: any, k) => o?.[k], DEFAULTS)));
	}

	private save(): void {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.data));
		} catch {
			// quota or private mode
		}
	}
}
