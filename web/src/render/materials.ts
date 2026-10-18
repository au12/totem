/*
 * VPX materials to three.js materials, plus the playfield light map hook that
 * lets every surface pick up the colour of nearby lamps and GI bulbs.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
	Color, DoubleSide, FrontSide, IUniform, Material as ThreeMaterial, MeshStandardMaterial, Texture, Vector2,
} from 'three';
import { Material } from '../vpx/vpt/material';
import { Table } from '../vpx/vpt/table/table';
import { TableTexture, TextureStore } from './textures';

/** Uniforms shared by every material that samples the light map. */
export interface LightmapUniforms {
	tLightmap: IUniform<Texture | null>;
	tInsertmap: IUniform<Texture | null>;
	lmScale: IUniform<Vector2>;
	lmGain: IUniform<number>;
}

export interface MaterialOptions {
	transparent?: boolean;
	doubleSide?: boolean;
	/** Light-map gain for GI bulbs. */
	lightmapGain?: number;
	/** How strongly lamp inserts light this surface (the playfield glows, objects catch spill). */
	insertGain?: number;
	/** Inserts also add their glow on top (the lit plastic insert itself). */
	insertGlow?: number;
	/** VPX "disable lighting": draw the texture unlit (0..1). */
	unlit?: number;
	depthBias?: number;
}

export function injectLightmap(mat: ThreeMaterial, uniforms: LightmapUniforms, gain = 1, unlit = 0, insertGain = 0.35, insertGlow = 0): void {
	const defs = `const float lmLocalGain = ${gain.toFixed(3)};\nconst float lmUnlit = ${unlit.toFixed(3)};\nconst float lmInsertGain = ${insertGain.toFixed(3)};\nconst float lmInsertGlow = ${insertGlow.toFixed(3)};`;
	mat.onBeforeCompile = shader => {
		shader.uniforms.tLightmap = uniforms.tLightmap;
		shader.uniforms.tInsertmap = uniforms.tInsertmap;
		shader.uniforms.lmScale = uniforms.lmScale;
		shader.uniforms.lmGain = uniforms.lmGain;
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nuniform vec2 lmScale;\nvarying vec2 vLmUv;')
			.replace('#include <project_vertex>', '#include <project_vertex>\n{ vec4 lmW = modelMatrix * vec4( transformed, 1.0 ); vLmUv = lmW.xz * lmScale; }');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\nuniform sampler2D tLightmap;\nuniform sampler2D tInsertmap;\nuniform float lmGain;\nvarying vec2 vLmUv;\n${defs}`)
			.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	{
		vec3 gi = texture2D( tLightmap, vLmUv ).rgb * lmGain * lmLocalGain;
		vec3 ins = texture2D( tInsertmap, vLmUv ).rgb * lmGain;
		reflectedLight.directDiffuse += ( gi + ins * lmInsertGain ) * material.diffuseColor;
		totalEmissiveRadiance += ins * lmInsertGlow * ( 0.35 + diffuseColor.rgb );
	}`)
			.replace('#include <opaque_fragment>', `
	outgoingLight = mix( outgoingLight, diffuseColor.rgb, lmUnlit );
	#include <opaque_fragment>`);
	};
	mat.customProgramCacheKey = () => `lm:${gain.toFixed(3)}:${unlit.toFixed(3)}:${insertGain.toFixed(3)}:${insertGlow.toFixed(3)}`;
}

/**
 * Maps VPX's material model (base colour, glossy layer with a 0..1
 * "roughness" that is really shininess, clearcoat, metal flag) onto
 * MeshStandardMaterial.
 */
export class MaterialFactory {

	private readonly cache = new Map<string, MeshStandardMaterial>();

	constructor(private readonly table: Table, private readonly textures: TextureStore, private readonly lm: LightmapUniforms) {}

	public get(materialName: string | undefined, mapName: string | undefined, opts: MaterialOptions = {}): MeshStandardMaterial {
		const vpx = materialName ? this.table.getMaterial(materialName) : undefined;
		const tex = this.textures.get(mapName);
		const key = [vpx ? vpx.name : '-', tex ? tex.info.name : '-', opts.transparent ? 1 : 0, opts.doubleSide ? 1 : 0,
			opts.lightmapGain ?? 1, opts.unlit ?? 0, opts.insertGain ?? 0.35, opts.insertGlow ?? 0].join('|');
		let m = this.cache.get(key);
		if (!m) {
			m = this.create(vpx, tex, opts);
			this.cache.set(key, m);
		}
		return m;
	}

	private create(vpx: Material | undefined, tex: TableTexture | undefined, opts: MaterialOptions): MeshStandardMaterial {
		const m = new MeshStandardMaterial();
		m.name = `${vpx ? vpx.name : 'default'}${tex ? ':' + tex.info.name : ''}`;
		if (vpx) {
			applyVpxMaterial(m, vpx);
		} else {
			m.color.set(0xcccccc);
			m.roughness = 0.6;
		}
		if (tex) {
			m.map = tex.map;
			m.color.set(0xffffff);
			if (tex.hasAlpha) {
				if (tex.alphaMap) {
					m.alphaMap = tex.alphaMap;
				}
				m.alphaTest = 0.5;
				m.alphaToCoverage = true;
			}
		}
		if (vpx && vpx.isOpacityActive && vpx.opacity < 0.999) {
			m.transparent = true;
			m.opacity = Math.max(0.05, vpx.opacity);
			m.depthWrite = false;
		}
		if (opts.transparent && !m.transparent && !(tex && tex.hasAlpha)) {
			m.transparent = true;
			m.depthWrite = false;
		}
		m.side = opts.doubleSide ? DoubleSide : FrontSide;
		if (opts.depthBias) {
			m.polygonOffset = true;
			m.polygonOffsetFactor = -1;
			m.polygonOffsetUnits = -Math.max(1, Math.min(8, opts.depthBias / 10));
		}
		injectLightmap(m, this.lm, opts.lightmapGain ?? 1, opts.unlit ?? 0, opts.insertGain ?? 0.35, opts.insertGlow ?? 0);
		return m;
	}

	public all(): MeshStandardMaterial[] {
		return [...this.cache.values()];
	}
}

export function applyVpxMaterial(m: MeshStandardMaterial, vpx: Material): void {
	m.color = new Color(vpx.baseColor);
	const glossy = new Color(vpx.glossiness);
	const glossAmount = Math.max(glossy.r, glossy.g, glossy.b);
	// VPX "roughness" is shininess: 1 = mirror-like, 0 = matte.
	const shine = Math.min(1, Math.max(0, vpx.roughness));
	if (vpx.isMetal) {
		m.metalness = 1;
		m.roughness = Math.max(0.08, 0.6 - 0.55 * shine);
		m.envMapIntensity = 1.0;
	} else {
		m.metalness = 0;
		m.roughness = glossAmount > 0.05 ? Math.max(0.15, 0.85 - 0.6 * shine * glossAmount) : 0.85;
		const clear = new Color(vpx.clearCoat);
		m.envMapIntensity = 0.25 + 0.5 * Math.max(clear.r, clear.g, clear.b);
	}
}
