/*
 * Minimal synchronous WAV (RIFF PCM) parser, so table sounds are playable
 * the moment they arrive (decodeAudioData is async and slow on phones).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface PcmData {
	rate: number;
	channels: Float32Array[];
	frames: number;
}

export function parseWav(bytes: Uint8Array): PcmData | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
	if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
		return null;
	}
	let fmt: { format: number, channels: number, rate: number, bits: number } | null = null;
	let data: { offset: number, size: number } | null = null;
	for (let o = 12; o + 8 <= bytes.length;) {
		const id = tag(o);
		const size = v.getUint32(o + 4, true);
		const body = o + 8;
		if (id === 'fmt ') {
			fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
		} else if (id === 'data') {
			data = { offset: body, size: Math.min(size, bytes.length - body) };
		}
		o = body + size + (size & 1);
	}
	if (!fmt || !data || fmt.format !== 1 || ![8, 16, 24].includes(fmt.bits) || fmt.channels < 1) {
		return null;
	}
	const bps = fmt.bits / 8;
	const frames = Math.floor(data.size / (bps * fmt.channels));
	const ch: Float32Array[] = [];
	for (let c = 0; c < fmt.channels; c++) {
		ch.push(new Float32Array(frames));
	}
	for (let i = 0, o = data.offset; i < frames; i++) {
		for (let c = 0; c < fmt.channels; c++, o += bps) {
			if (fmt.bits === 8) {
				ch[c][i] = (v.getUint8(o) - 128) / 128;
			} else if (fmt.bits === 16) {
				ch[c][i] = v.getInt16(o, true) / 32768;
			} else {
				const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16);
				ch[c][i] = x / 8388608;
			}
		}
	}
	return { rate: fmt.rate, channels: ch, frames };
}
