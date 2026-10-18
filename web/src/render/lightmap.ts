/*
 * The playfield light map: every lamp insert and GI bulb is drawn, with its
 * VPX falloff, into a small floating-point texture laid over the table. All
 * table materials sample it, so lamps light the playfield art, plastics,
 * posts and rubbers around them at the cost of one texture fetch, no matter
 * how many lamps there are.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
	AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, HalfFloatType, LinearFilter, Mesh, OrthographicCamera,
	PlaneGeometry, Scene, ShaderMaterial, ShapeUtils, UnsignedByteType, Vector2, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { SplineVertex } from '../vpx/math/spline-vertex';
import { Light } from '../vpx/vpt/light/light';
import { Table } from '../vpx/vpt/table/table';
import { LightmapUniforms } from './materials';

const vertexShader = /* glsl */`
	attribute vec2 vpos;
	varying vec2 vPos;
	void main() {
		vPos = vpos;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const fragmentShader = /* glsl */`
	uniform vec2 center;
	uniform float invFalloff;
	uniform float falloffPower;
	uniform vec3 color;
	uniform vec3 color2;
	uniform float strength;
	varying vec2 vPos;
	void main() {
		float d = clamp( length( vPos - center ) * invFalloff, 0.0, 1.0 );
		float atten = pow( 1.0 - d, falloffPower );
		vec3 c = mix( color2, color, sqrt( d ) );
		gl_FragColor = vec4( c * ( atten * strength ), 1.0 );
	}
`;

interface LightEntry {
	light: Light;
	mesh: Mesh;
	material: ShaderMaterial;
	insert: boolean;
	last: number;
	/** Strength per unit of VPX intensity. */
	scale: number;
}

export interface LightmapOptions {
	/** Texels per VPX unit for GI bulbs (soft, low resolution). */
	giDensity: number;
	/** Texels per VPX unit for lamp inserts (sharper). */
	insertDensity: number;
	insertGain: number;
	giGain: number;
}

class Layer {
	public readonly scene = new Scene();
	public readonly target: WebGLRenderTarget;
	public dirty = true;
	constructor(width: number, height: number, density: number, halfFloat: boolean) {
		this.target = new WebGLRenderTarget(
			Math.max(64, Math.round(width * density)),
			Math.max(64, Math.round(height * density)),
			{ type: halfFloat ? HalfFloatType : UnsignedByteType, magFilter: LinearFilter, minFilter: LinearFilter, depthBuffer: false },
		);
	}
}

export class Lightmap {

	public readonly uniforms: LightmapUniforms;
	private readonly gi: Layer;
	private readonly inserts: Layer;
	private readonly camera: OrthographicCamera;
	private readonly entries: LightEntry[] = [];
	public readonly width: number;
	public readonly height: number;

	constructor(table: Table, renderer: WebGLRenderer, private readonly opts: LightmapOptions) {
		const dim = table.getDimensions();
		this.width = dim.width;
		this.height = dim.height;
		const halfFloat = !!renderer.extensions.get('EXT_color_buffer_float') || !!renderer.extensions.get('EXT_color_buffer_half_float');
		this.gi = new Layer(dim.width, dim.height, opts.giDensity, halfFloat);
		this.inserts = new Layer(dim.width, dim.height, opts.insertDensity, halfFloat);
		this.gi.target.texture.name = 'lightmap:gi';
		this.inserts.target.texture.name = 'lightmap:inserts';
		// Table x maps to u and table y to v (v = 0 is the target's first row).
		this.camera = new OrthographicCamera(0, dim.width, dim.height, 0, -10, 10);
		this.camera.position.z = 1;
		this.uniforms = {
			tLightmap: { value: this.gi.target.texture },
			tInsertmap: { value: this.inserts.target.texture },
			lmScale: { value: new Vector2(1 / dim.width, 1 / dim.height) },
			lmGain: { value: halfFloat ? 1 : 4 },
		};
		this.halfFloat = halfFloat;
		for (const light of Object.values(table.lights)) {
			if (light.data.isBackglass || !light.data.isVisible) {
				continue;
			}
			this.add(light, table);
		}
	}

	private readonly halfFloat: boolean;

	private add(light: Light, table: Table): void {
		const d = light.data;
		const insert = !d.bulbLight;
		let geometry: BufferGeometry;
		if (insert) {
			const curve = SplineVertex.getCentralCurve(d.dragPoints, table.getDetailLevel(), -1);
			const pts = curve.map(v => new Vector2(v.x, v.y));
			if (pts.length < 3) {
				return;
			}
			const tris = ShapeUtils.triangulateShape(pts, []);
			const pos: number[] = [];
			const vpos: number[] = [];
			for (const t of tris) {
				for (const i of t) {
					pos.push(pts[i].x, pts[i].y, 0);
					vpos.push(pts[i].x, pts[i].y);
				}
			}
			geometry = new BufferGeometry();
			geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
			geometry.setAttribute('vpos', new Float32BufferAttribute(vpos, 2));
		} else {
			const r = Math.max(4, d.falloff);
			geometry = new PlaneGeometry(2 * r, 2 * r);
			geometry.translate(d.center.x, d.center.y, 0);
			const p = geometry.attributes.position;
			const vpos = new Float32Array(p.count * 2);
			for (let i = 0; i < p.count; i++) {
				vpos[i * 2] = p.getX(i);
				vpos[i * 2 + 1] = p.getY(i);
			}
			geometry.setAttribute('vpos', new Float32BufferAttribute(vpos, 2));
		}
		const material = new ShaderMaterial({
			vertexShader,
			fragmentShader,
			blending: AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true,
			side: DoubleSide,
			uniforms: {
				center: { value: new Vector2(d.center.x, d.center.y) },
				invFalloff: { value: 1 / Math.max(1, d.falloff) },
				falloffPower: { value: Math.max(0.1, d.falloffPower) },
				color: { value: new Color(d.color) },
				color2: { value: new Color(d.color2) },
				strength: { value: 0 },
			},
		});
		const mesh = new Mesh(geometry, material);
		mesh.frustumCulled = false;
		mesh.visible = false;
		(insert ? this.inserts : this.gi).scene.add(mesh);
		this.entries.push({ light, mesh, material, insert, last: -1, scale: insert ? this.opts.insertGain : this.opts.giGain });
	}

	/** Re-renders the maps whose lamps changed brightness. */
	public update(renderer: WebGLRenderer, force = false): void {
		for (const e of this.entries) {
			const intensity = e.light.getState().intensity;
			if (intensity !== e.last) {
				e.last = intensity;
				e.material.uniforms.strength.value = intensity * e.scale * (this.halfFloat ? 1 : 0.25);
				e.mesh.visible = intensity > 0.001;
				(e.insert ? this.inserts : this.gi).dirty = true;
			}
		}
		for (const layer of [this.gi, this.inserts]) {
			if (!layer.dirty && !force) {
				continue;
			}
			layer.dirty = false;
			const prevTarget = renderer.getRenderTarget();
			const prevClear = renderer.getClearColor(new Color());
			const prevAlpha = renderer.getClearAlpha();
			const prevAuto = renderer.autoClear;
			renderer.setRenderTarget(layer.target);
			renderer.setClearColor(0x000000, 1);
			renderer.autoClear = true;
			renderer.render(layer.scene, this.camera);
			renderer.setRenderTarget(prevTarget);
			renderer.setClearColor(prevClear, prevAlpha);
			renderer.autoClear = prevAuto;
		}
	}

	public dispose(): void {
		this.gi.target.dispose();
		this.inserts.target.dispose();
		for (const e of this.entries) {
			e.mesh.geometry.dispose();
			e.material.dispose();
		}
	}
}
