/*
 * Keyboard, mouse, gamepad and touch input mapped to game actions.
 *
 * Every physical source (a key, a mouse button, a finger, a pad button) is
 * tracked separately; an action is held while any of its sources is held.
 * Events carry their timestamps so the physics can apply a flip at the
 * moment it happened rather than at the next frame.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { ActionId } from './settings';

export type InputMode = 'off' | 'game' | 'menu' | 'capture';
export type Command = 'menu' | 'back' | 'activate' | 'fullscreen' | `nav:${'up' | 'down' | 'left' | 'right'}`;

export interface InputHandlers {
	onAction(action: ActionId, down: boolean, time: number): void;
	onCommand(cmd: Command): void;
	onDevice?(kind: 'touch' | 'gamepad' | 'keyboard' | 'mouse'): void;
}

const SWALLOW = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash', 'Quote', 'Backspace', 'Enter']);

const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS: Array<[number, ActionId]> = [
	[PAD.LB, 'left'], [PAD.LT, 'left'],
	[PAD.RB, 'right'], [PAD.RT, 'right'],
	[PAD.A, 'plunger'], [PAD.DOWN, 'plunger'],
	[PAD.X, 'start'],
	[PAD.Y, 'nudgeUp'], [PAD.UP, 'nudgeUp'],
	[PAD.LEFT, 'nudgeLeft'], [PAD.RIGHT, 'nudgeRight'],
];

export const KEY_NAMES: { [code: string]: string } = {
	ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
	AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left ⌘', MetaRight: 'Right ⌘',
	Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
	ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
	Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
	BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
	NumpadEnter: 'Num Enter', CapsLock: 'Caps Lock',
};

export function keyName(code: string): string {
	if (KEY_NAMES[code]) {
		return KEY_NAMES[code];
	}
	if (code.startsWith('Key')) {
		return code.slice(3);
	}
	if (code.startsWith('Digit')) {
		return code.slice(5);
	}
	if (code.startsWith('Numpad')) {
		return 'Num ' + code.slice(6);
	}
	return code;
}

export class Input {

	public mode: InputMode = 'off';
	private readonly held = new Map<ActionId, Set<string>>();
	private readonly keyMap = new Map<string, ActionId>();
	public mouse = true;
	public haptics = true;
	private padState: boolean[][] = [];
	private readonly padMenu = { held: new Set<string>(), repeatAt: 0 };
	private captureCb: ((code: string | null) => void) | null = null;
	private prevMode: InputMode = 'menu';

	constructor(private readonly stage: HTMLElement, private readonly h: InputHandlers) {
		this.bind();
	}

	public setKeys(keys: { [a: string]: string[] }): void {
		this.keyMap.clear();
		for (const [action, codes] of Object.entries(keys)) {
			for (const code of codes) {
				this.keyMap.set(code, action as ActionId);
			}
		}
	}

	public setMode(mode: InputMode): void {
		if (mode === this.mode) {
			return;
		}
		if (this.mode === 'game') {
			this.releaseAll();
		}
		this.mode = mode;
	}

	public captureKey(cb: (code: string | null) => void): void {
		this.prevMode = this.mode;
		this.mode = 'capture';
		this.captureCb = cb;
	}

	public isHeld(action: ActionId): boolean {
		return (this.held.get(action)?.size || 0) > 0;
	}

	private press(action: ActionId, source: string, time: number): void {
		let set = this.held.get(action);
		if (!set) {
			this.held.set(action, set = new Set());
		}
		if (set.has(source)) {
			return;
		}
		set.add(source);
		if (set.size === 1) {
			this.h.onAction(action, true, time);
		}
	}

	private release(action: ActionId, source: string, time: number): void {
		const set = this.held.get(action);
		if (!set || !set.delete(source)) {
			return;
		}
		if (set.size === 0) {
			this.h.onAction(action, false, time);
		}
	}

	private releaseSource(prefix: string): void {
		for (const [action, set] of this.held) {
			for (const s of [...set]) {
				if (s.startsWith(prefix)) {
					this.release(action, s, performance.now());
				}
			}
		}
	}

	public releaseAll(): void {
		for (const [action, set] of this.held) {
			if (set.size) {
				set.clear();
				this.h.onAction(action, false, performance.now());
			}
		}
	}

	private bind(): void {
		window.addEventListener('keydown', e => this.key(e, true), { capture: true });
		window.addEventListener('keyup', e => this.key(e, false), { capture: true });
		window.addEventListener('blur', () => this.releaseAll());
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				this.releaseAll();
			}
		});
		const st = this.stage;
		st.addEventListener('contextmenu', e => {
			if (this.mode === 'game') {
				e.preventDefault();
			}
		});
		st.addEventListener('pointerdown', e => this.pointer(e, true));
		st.addEventListener('pointerup', e => this.pointer(e, false));
		st.addEventListener('pointercancel', e => this.pointer(e, false));
		for (const ev of ['mouseup', 'auxclick']) {
			st.addEventListener(ev, e => {
				if (this.mode === 'game' && (e as MouseEvent).button >= 3) {
					e.preventDefault();
				}
			});
		}
		window.addEventListener('gamepadconnected', () => this.h.onDevice?.('gamepad'));
	}

	private key(e: KeyboardEvent, down: boolean): void {
		if (this.mode === 'capture') {
			if (!down) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const cb = this.captureCb;
			this.mode = this.prevMode || 'menu';
			this.captureCb = null;
			cb?.(e.code === 'Escape' ? null : e.code);
			return;
		}
		const target = e.target as HTMLElement | null;
		const typing = !!target?.closest?.('input, textarea, [contenteditable]');
		if (down && !e.isComposing && e.keyCode !== 229 && e.key !== 'Unidentified' && !typing) {
			this.h.onDevice?.('keyboard');
		}
		// Windows can drop the keyup of one Shift while the other is held.
		if (!e.getModifierState?.('Shift')) {
			this.releaseSource('kb:ShiftLeft');
			this.releaseSource('kb:ShiftRight');
		}
		if (this.mode !== 'game') {
			if (typing) {
				return;
			}
			if (down && e.code === 'Escape') {
				e.preventDefault();
				this.h.onCommand('back');
			} else if (down && e.code === 'F4') {
				e.preventDefault();
				this.h.onCommand('fullscreen');
			}
			return;
		}
		if (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'F3') {
			e.preventDefault();
			if (down && !e.repeat) {
				this.h.onCommand('menu');
			}
			return;
		}
		if (e.code === 'F4') {
			e.preventDefault();
			if (down && !e.repeat) {
				this.h.onCommand('fullscreen');
			}
			return;
		}
		if (e.ctrlKey || e.metaKey || (e.altKey && !this.keyMap.has(e.code))) {
			return;
		}
		const action = this.keyMap.get(e.code);
		if (action || SWALLOW.has(e.code)) {
			e.preventDefault();
		}
		if (action && !(down && e.repeat)) {
			if (down) {
				this.press(action, 'kb:' + e.code, e.timeStamp);
			} else {
				this.release(action, 'kb:' + e.code, e.timeStamp);
			}
		}
	}

	private pointer(e: PointerEvent, down: boolean): void {
		if (this.mode !== 'game' || e.pointerType === 'touch') {
			return; // touch is handled by the touch layer
		}
		const target = e.target as HTMLElement;
		if (!this.mouse || target.closest('button, a, input, [data-ui]')) {
			return;
		}
		const map: { [b: number]: ActionId } = { 0: 'left', 2: 'right', 1: 'plunger', 3: 'nudgeLeft', 4: 'nudgeRight' };
		const action = map[e.button];
		if (!action) {
			return;
		}
		e.preventDefault();
		const src = 'mouse:' + e.button;
		if (down) {
			this.stage.setPointerCapture?.(e.pointerId);
			this.press(action, src, e.timeStamp);
			this.h.onDevice?.('mouse');
		} else {
			this.release(action, src, e.timeStamp);
		}
	}

	/**
	 * Touch: the left and right halves of the screen are the flipper
	 * buttons; on-screen buttons carry a data-action.
	 */
	public attachTouch(layer: HTMLElement): void {
		const fingers = new Map<number, ActionId>();
		const down = (e: PointerEvent) => {
			if (e.pointerType !== 'touch') {
				return;
			}
			this.h.onDevice?.('touch');
			if (this.mode !== 'game') {
				return;
			}
			const target = e.target as HTMLElement;
			const btn = target.closest('[data-action]') as HTMLElement | null;
			if (!btn && target.closest('button, a, input, dialog, [data-ui]')) {
				return;
			}
			e.preventDefault();
			const action = (btn ? btn.dataset.action : e.clientX < window.innerWidth / 2 ? 'left' : 'right') as ActionId | 'menu';
			if (action === 'menu') {
				this.h.onCommand('menu');
				return;
			}
			fingers.set(e.pointerId, action);
			btn?.classList.add('is-held');
			try {
				layer.setPointerCapture?.(e.pointerId);
			} catch {
				// pointer already gone
			}
			this.press(action, 'touch:' + e.pointerId, e.timeStamp);
			if (this.haptics && navigator.vibrate) {
				navigator.vibrate(action.startsWith('nudge') ? 25 : 6);
			}
		};
		const up = (e: PointerEvent) => {
			const action = fingers.get(e.pointerId);
			if (!action) {
				return;
			}
			fingers.delete(e.pointerId);
			layer.querySelector(`[data-action="${action}"]`)?.classList.remove('is-held');
			this.release(action, 'touch:' + e.pointerId, e.timeStamp);
		};
		layer.addEventListener('pointerdown', down);
		layer.addEventListener('pointerup', up);
		layer.addEventListener('pointercancel', up);
		layer.addEventListener('contextmenu', e => e.preventDefault());
		// iOS: stop double-tap zoom and long-press callouts while playing.
		layer.addEventListener('touchstart', e => {
			if (this.mode === 'game') {
				e.preventDefault();
			}
		}, { passive: false });
	}

	/** Polls connected gamepads; call once per animation frame. */
	public poll(now: number): void {
		if (!navigator.getGamepads) {
			return;
		}
		const pads = navigator.getGamepads();
		for (let i = 0; i < pads.length; i++) {
			const pad = pads[i];
			const prev = this.padState[i] || (this.padState[i] = []);
			if (!pad || !pad.connected) {
				if (prev.length) {
					this.releaseSource(`pad:${i}:`);
					prev.length = 0;
				}
				continue;
			}
			const pressed = (b: number) => {
				const btn = pad.buttons[b];
				if (!btn) {
					return false;
				}
				const v = (b === PAD.LT || b === PAD.RT) ? btn.value : btn.pressed ? 1 : 0;
				return prev[b] ? v > 0.25 : v > 0.45;
			};
			const cur: boolean[] = [];
			for (let b = 0; b < Math.max(16, pad.buttons.length); b++) {
				cur[b] = pressed(b);
			}
			const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
			const stick = { up: ay < -0.6, down: ay > 0.6, left: ax < -0.6, right: ax > 0.6 };
			if (this.mode === 'game') {
				for (const [b, action] of PAD_ACTIONS) {
					const src = `pad:${i}:${b}`;
					if (cur[b] && !prev[b]) {
						this.press(action, src, now);
					} else if (!cur[b] && prev[b]) {
						this.release(action, src, now);
					}
				}
				if ((cur[PAD.START] && !prev[PAD.START]) || (cur[PAD.BACK] && !prev[PAD.BACK])) {
					this.h.onCommand('menu');
				}
			} else if (this.mode === 'menu') {
				this.padMenuNav(cur, prev, stick, now);
			}
			for (let b = 0; b < cur.length; b++) {
				prev[b] = cur[b];
			}
		}
	}

	private padMenuNav(cur: boolean[], prev: boolean[], stick: { [k: string]: boolean }, now: number): void {
		const edge = (b: number) => cur[b] && !prev[b];
		if (edge(PAD.A)) {
			this.h.onCommand('activate');
		}
		if (edge(PAD.B) || edge(PAD.BACK) || edge(PAD.START)) {
			this.h.onCommand('back');
		}
		const dirs: { [d: string]: boolean } = {
			up: cur[PAD.UP] || stick.up, down: cur[PAD.DOWN] || stick.down,
			left: cur[PAD.LEFT] || stick.left, right: cur[PAD.RIGHT] || stick.right,
		};
		const m = this.padMenu;
		for (const [dir, on] of Object.entries(dirs)) {
			if (on && !m.held.has(dir)) {
				m.held.add(dir);
				m.repeatAt = now + 380;
				this.h.onCommand(('nav:' + dir) as Command);
			} else if (on && now >= m.repeatAt) {
				m.repeatAt = now + 110;
				this.h.onCommand(('nav:' + dir) as Command);
			} else if (!on) {
				m.held.delete(dir);
			}
		}
	}

	public get hasGamepad(): boolean {
		return !!navigator.getGamepads && [...navigator.getGamepads()].some(p => p && p.connected);
	}
}
