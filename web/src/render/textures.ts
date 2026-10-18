/*
 * Loads table textures from the pack: colour images (sRGB) and, for large
 * cut-out art, a separate grey alpha mask.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
	ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace,
	Texture, WebGLRenderer,
} from 'three';
import { LoadedPack, PackTexture } from '../engine/pack';
import { builtinMap } from './builtin-maps';

export interface TableTexture {
	info: PackTexture;
	map: Texture;
	alphaMap?: Texture;
	/** True when the image (or its mask) has transparent pixels. */
	hasAlpha: boolean;
	ready: Promise<void>;
}

export type BitmapFetcher = (url: string) => Promise<ImageBitmap>;

export const fetchBitmap: BitmapFetcher = async url => {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	const blob = await res.blob();
	return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};

export class TextureStore {

	private readonly pack: LoadedPack;
	private readonly cache = new Map<string, TableTexture>();
	private readonly anisotropy: number;
	private readonly fetcher: BitmapFetcher;
	private pending: Array<Promise<void>> = [];
	public bytesLoaded = 0;

	constructor(pack: LoadedPack, renderer: WebGLRenderer, fetcher: BitmapFetcher = fetchBitmap) {
		this.pack = pack;
		this.fetcher = fetcher;
		this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
	}

	public get(name: string | undefined): TableTexture | undefined {
		if (!name) {
			return undefined;
		}
		const key = name.toLowerCase();
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}
		const builtin = builtinMap(name);
		const info = this.pack.texture(name)
			?? (builtin ? { name, w: 512, h: 512, alphaTest: -1, alpha: false, hd: builtin, sd: builtin } : undefined);
		if (!info) {
			return undefined;
		}
		const hd = this.pack.quality === 'hd';
		const map = this.makeTexture(SRGBColorSpace);
		map.name = info.name;
		const maskUrl = hd ? info.hdMask : info.sdMask;
		const alphaMap = maskUrl ? this.makeTexture(NoColorSpace) : undefined;
		const loads: Array<Promise<void>> = [this.load(map, hd ? info.hd : info.sd)];
		if (alphaMap && maskUrl) {
			alphaMap.name = info.name + ':mask';
			loads.push(this.load(alphaMap, maskUrl));
		}
		const ready = Promise.all(loads).then(() => undefined);
		this.pending.push(ready);
		const tex: TableTexture = { info, map, alphaMap, hasAlpha: info.alpha, ready };
		this.cache.set(key, tex);
		return tex;
	}

	/** Resolves when every texture requested so far has loaded. */
	public async whenLoaded(): Promise<void> {
		while (this.pending.length) {
			const p = this.pending;
			this.pending = [];
			await Promise.all(p);
		}
	}

	private makeTexture(colorSpace: string): Texture {
		const t = new Texture();
		t.flipY = false; // VPX uv origin is the top-left of the image
		t.colorSpace = colorSpace;
		t.wrapS = RepeatWrapping;
		t.wrapT = RepeatWrapping;
		t.magFilter = LinearFilter;
		t.minFilter = LinearMipmapLinearFilter;
		t.generateMipmaps = true;
		t.anisotropy = this.anisotropy;
		return t;
	}

	private async load(t: Texture, path: string): Promise<void> {
		try {
			const bmp = await this.fetcher(/^[a-z][a-z0-9+.-]*:/i.test(path) ? path : this.pack.url(path));
			t.image = bmp;
			t.needsUpdate = true;
		} catch (err) {
			console.warn('texture', path, err);
		}
	}

	public dispose(): void {
		for (const t of this.cache.values()) {
			t.map.dispose();
			t.alphaMap?.dispose();
			const img = t.map.image as ImageBitmap | undefined;
			img?.close?.();
		}
		this.cache.clear();
	}
}

export function clampTexture(t: Texture): Texture {
	t.wrapS = ClampToEdgeWrapping;
	t.wrapT = ClampToEdgeWrapping;
	return t;
}
