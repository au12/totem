/*
 * The boundary between the game rules (a stand-in for the original
 * Gottlieb System 1 ROM) and the table: switches in, lamps, displays,
 * solenoids and sounds out.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export type Solenoid = 'outhole' | 'hole' | 'dropReset' | 'variReset' | 'knocker';

export type SoundCue =
	| 'tone10' | 'tone100' | 'tone1000' | 'bonusTick' | 'multiplier' | 'extraBall' | 'special'
	| 'tilt' | 'gameStart' | 'playerAdd' | 'gameOver' | 'match' | 'ballStart' | 'bigScore' | 'targetsComplete'
	| 'holeAward' | 'variMax' | 'replay';

export type LampState = 0 | 1 | 2; // off, on, blinking

export interface Hardware {
	/** Game clock, ms. */
	now(): number;
	after(ms: number, fn: () => void): number;
	every(ms: number, fn: () => void): number;
	cancel(id: number | undefined): void;

	setLamp(lamp: number, state: LampState): void;
	/** Player score displays (0-3); null blanks the display. */
	setScore(player: number, value: number | null): void;
	/** The status display: credits (left) and ball in play / match (right). */
	setStatus(credits: number | null, ball: number | null): void;
	fire(sol: Solenoid): void;
	setFlippers(enabled: boolean): void;
	sound(cue: SoundCue): void;
	/** Balls currently on the playfield, in the shooter lane or held in the hole. */
	ballsOnTable(): number;
	/** Takes every ball off the table (the game in progress was abandoned). */
	clearTable(): void;
}

/** Backglass lamps (numbering follows the original lamp list). */
export const LAMP_GAME_OVER = 1;
export const LAMP_TILT = 2;
export const LAMP_HSTD = 3;
export const LAMP_SHOOT_AGAIN = 4;
/** Virtual lamps for the backglass (not on the playfield). */
export const LAMP_BALL_IN_PLAY = 101;
export const LAMP_MATCH = 102;
