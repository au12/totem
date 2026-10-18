/*
 * Totem web: the vpx-js OLE reader is replaced by server-side extraction
 * (see io/mem-storage.ts). Only the storage interface the item loaders use
 * is kept here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface ReadResult {
	data: Buffer;
	storageOffset: number;
}

export interface Storage {
	read(name: string, offset?: number, bytesToRead?: number): Promise<Buffer>;
	streamFiltered(name: string, offset: number, next: (data: ReadResult) => Promise<number | null>): Promise<void>;
	getStreams(): string[];
}
