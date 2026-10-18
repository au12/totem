/*
 * Totem web — in-memory replacement for the OLE compound-document storage.
 *
 * The server unpacks the .vpx container once and ships the raw BIFF streams
 * (GameData, GameItemN, CollectionN) in one binary blob. This class gives the
 * vendored loaders the same read/streamFiltered interface they used on the
 * OLE file, without any of the sector bookkeeping.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { ReadResult } from './ole-doc';

export class MemStorage {

	private readonly streams: Map<string, Buffer>;

	constructor(streams: Map<string, Buffer>) {
		this.streams = streams;
	}

	public has(name: string): boolean {
		return this.streams.has(name);
	}

	public getStreams(): string[] {
		return [...this.streams.keys()];
	}

	private get(name: string): Buffer {
		const buf = this.streams.get(name);
		if (!buf) {
			throw new Error(`No such stream "${name}".`);
		}
		return buf;
	}

	public async read(name: string, offset: number = 0, bytesToRead: number = 0): Promise<Buffer> {
		const buf = this.get(name);
		const end = bytesToRead ? Math.min(buf.length, offset + bytesToRead) : buf.length;
		return buf.slice(offset, end);
	}

	/**
	 * Feeds the stream to a BIFF record handler. The handler returns how many
	 * bytes it consumed (null to stop). A negative value means "I need this many
	 * bytes in one piece", which cannot happen here since the whole stream is in
	 * memory, so it is answered by handing over the rest of the stream again.
	 */
	public async streamFiltered(name: string, offset: number, next: (data: ReadResult) => Promise<number | null>): Promise<void> {
		const buf = this.get(name);
		let pos = offset;
		while (pos < buf.length) {
			const result: ReadResult = { data: buf.slice(pos), storageOffset: pos };
			let len = await next(result);
			if (len !== null && len < 0) {
				len = await next(result);
			}
			if (len === null || len <= 0) {
				return;
			}
			pos += len;
		}
	}
}

/**
 * Parses the server's stream bundle: repeated [u16 name length][name][u32
 * data length][data], little endian.
 */
export function parseStreamBundle(data: ArrayBuffer): Map<string, Buffer> {
	const view = new DataView(data);
	const bytes = new Uint8Array(data);
	const decoder = new TextDecoder();
	const out = new Map<string, Buffer>();
	let pos = 0;
	while (pos + 6 <= data.byteLength) {
		const nameLen = view.getUint16(pos, true);
		pos += 2;
		const name = decoder.decode(bytes.subarray(pos, pos + nameLen));
		pos += nameLen;
		const len = view.getUint32(pos, true);
		pos += 4;
		out.set(name, Buffer.from(data, pos, len));
		pos += len;
	}
	return out;
}
