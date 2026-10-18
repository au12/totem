/*
 * Loads a table pack produced by the server (see server/vpx.go).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { MemStorage, parseStreamBundle } from '../vpx/io/mem-storage';
import { Table } from '../vpx/vpt/table/table';
import { Texture } from '../vpx/vpt/texture';

export type Quality = 'hd' | 'sd';

export interface PackTexture {
	name: string;
	w: number;
	h: number;
	alphaTest: number;
	alpha: boolean;
	hd: string;
	hdMask?: string;
	sd: string;
	sdMask?: string;
}

export interface PackSound {
	name: string;
	url: string;
}

export interface BackglassScore {
	id: number;
	x: number;
	y: number;
	w: number;
	h: number;
	digits: number;
	lit?: string;
}

export interface BackglassLamp {
	id: number;
	name?: string;
	text?: string;
	romId: number;
	romType: number;
	inverted: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	image: { hd: string, sd: string };
}

export interface PackBackglass {
	w: number;
	h: number;
	off: { hd: string, sd: string };
	on: { hd: string, sd: string };
	scores: BackglassScore[];
	lamps: BackglassLamp[];
}

export interface PackManifest {
	format: number;
	id: string;
	name: string;
	gameName: string;
	info: { [key: string]: string };
	streams: string;
	textures: PackTexture[];
	sounds: PackSound[];
	backglass?: PackBackglass;
	bytes: { [tier: string]: number };
}

export interface LoadedPack {
	base: string;
	manifest: PackManifest;
	table: Table;
	quality: Quality;
	/** Absolute URL of a pack-relative path. */
	url(path: string): string;
	texture(name: string | undefined): PackTexture | undefined;
}

export type Fetcher = (url: string) => Promise<ArrayBuffer>;

export const defaultFetcher: Fetcher = async url => {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	return res.arrayBuffer();
};

export async function loadPack(base: string, quality: Quality, fetcher: Fetcher = defaultFetcher): Promise<LoadedPack> {
	const join = (p: string) => base.replace(/\/?$/, '/') + p;
	const manifest = JSON.parse(new TextDecoder().decode(await fetcher(join('manifest.json')))) as PackManifest;
	const streams = parseStreamBundle(await fetcher(join(manifest.streams)));
	const textures = manifest.textures.map(t => Texture.fromPack(t.name, t.w, t.h, t.alphaTest, quality === 'hd' ? t.hd : t.sd));
	const table = await Table.loadFromMemory(new MemStorage(streams), textures, manifest.info, {
		tableDataOnly: false,
		tableInfoOnly: false,
		loadInvisibleItems: true,
		loadTableScript: false,
	});
	const byName = new Map(manifest.textures.map(t => [t.name.toLowerCase(), t]));
	return {
		base,
		manifest,
		table,
		quality,
		url: join,
		texture: name => name ? byName.get(name.toLowerCase()) : undefined,
	};
}
