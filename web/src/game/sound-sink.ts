/*
 * What the table and the rules need from the audio engine.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { SoundCue } from './hardware';

export interface SampleOptions {
	/** Table position, VPX units (for stereo placement). */
	x?: number;
	y?: number;
	volume?: number;
	/** Playback rate multiplier. */
	rate?: number;
}

export interface SoundSink {
	/** Plays one of the table's own samples (by VPX sound name). */
	sample(name: string, opts?: SampleOptions): void;
	/** Starts, updates or (volume 0) stops a looping sample. */
	loop(key: string, name: string, opts: SampleOptions): void;
	/** Machine sounds (the System 1 sound board). */
	cue(cue: SoundCue): void;
}

export const silentSink: SoundSink = {
	sample() {},
	loop() {},
	cue() {},
};
