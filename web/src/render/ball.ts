/*
 * The steel ball: a mirror that reflects the playfield art beneath it (and
 * the cabinet's environment above), which is what makes a pinball read as a
 * ball rather than a grey dot. Plus its soft contact shadow.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
	CanvasTexture, Color, DoubleSide, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, SRGBColorSpace,
	Texture, Vector2, Vector3,
} from 'three';
import { LightmapUniforms } from './materials';

const vertexShader = /* glsl */`
	varying vec3 vPosW;
	varying vec3 vNormalW;
	varying vec3 vCenter;
	void main() {
		vec4 w = modelMatrix * vec4( position, 1.0 );
		vPosW = w.xyz;
		vCenter = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
		vNormalW = normalize( w.xyz - vCenter );
		gl_Position = projectionMatrix * viewMatrix * w;
	}
`;

const fragmentShader = /* glsl */`
	uniform sampler2D tPlayfield;
	uniform sampler2D tEnv;
	uniform sampler2D tLightmap;
	uniform sampler2D tInsertmap;
	uniform vec2 tableSize;
	uniform float lmGain;
	uniform vec3 lightDir;
	uniform float envStrength;
	uniform float playfieldStrength;
	uniform bool hasEnv;
	varying vec3 vPosW;
	varying vec3 vNormalW;
	varying vec3 vCenter;

	vec3 envColor( vec3 r ) {
		if ( !hasEnv ) {
			// Dim cabinet interior with a bright band where the lights hang.
			float band = smoothstep( 0.1, 0.6, r.y ) * ( 0.6 + 0.4 * r.z );
			return mix( vec3( 0.05, 0.045, 0.04 ), vec3( 1.0, 0.92, 0.8 ), band );
		}
		vec2 uv = vec2( atan( r.z, r.x ) * 0.15915494 + 0.5, acos( clamp( r.y, -1.0, 1.0 ) ) * 0.31830989 );
		return texture2D( tEnv, uv ).rgb;
	}

	void main() {
		vec3 N = normalize( vNormalW );
		vec3 V = normalize( cameraPosition - vPosW );
		vec3 R = reflect( -V, N );
		// Where the reflected ray meets the playfield (y = 0).
		vec3 floorCol = vec3( 0.0 );
		float toFloor = smoothstep( 0.02, -0.12, R.y );
		if ( toFloor > 0.0 ) {
			float t = vPosW.y / max( 1e-3, -R.y );
			vec3 P = vPosW + R * min( t, 4000.0 );
			vec2 uv = P.xz / tableSize;
			vec3 albedo = texture2D( tPlayfield, uv ).rgb;
			vec3 lit = vec3( 0.32 ) + ( texture2D( tLightmap, uv ).rgb + texture2D( tInsertmap, uv ).rgb ) * lmGain;
			float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
			floorCol = mix( vec3( 0.03 ), albedo * lit, inside ) * playfieldStrength;
		}
		vec3 skyCol = envColor( R ) * envStrength + vec3( 0.10, 0.095, 0.09 );
		vec3 col = mix( skyCol, floorCol, toFloor );
		// Steel: fairly dark at the centre, brighter towards the rim (Fresnel).
		float ndv = clamp( dot( N, V ), 0.0, 1.0 );
		float fres = 0.7 + 0.3 * pow( 1.0 - ndv, 3.0 );
		col *= fres;
		// Hot specular highlight from the cabinet lights.
		float spec = pow( max( dot( R, normalize( lightDir ) ), 0.0 ), 180.0 );
		col += vec3( 1.0, 0.97, 0.9 ) * spec * 3.0;
		col += vec3( 1.0, 0.95, 0.85 ) * pow( max( dot( R, normalize( lightDir * vec3( -1.0, 1.0, 1.0 ) + vec3( 0.0, 0.0, -0.4 ) ) ), 0.0 ), 90.0 ) * 0.8;
		gl_FragColor = vec4( col, 1.0 );
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}
`;

export function createBallMaterial(playfield: Texture | null, env: Texture | null, lm: LightmapUniforms, tableW: number, tableH: number): ShaderMaterial {
	return new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: {
			tPlayfield: { value: playfield },
			tEnv: { value: env },
			hasEnv: { value: !!env },
			tLightmap: lm.tLightmap,
			tInsertmap: lm.tInsertmap,
			lmGain: lm.lmGain,
			tableSize: { value: new Vector2(tableW, tableH) },
			lightDir: { value: new Vector3(0.1, 1.0, 0.55) },
			envStrength: { value: 1.7 },
			playfieldStrength: { value: 1.25 },
		},
	});
}

let shadowTexture: Texture | undefined;

function getShadowTexture(): Texture {
	if (!shadowTexture) {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const g = c.getContext('2d')!;
		const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
		grad.addColorStop(0, 'rgba(0,0,0,0.75)');
		grad.addColorStop(0.45, 'rgba(0,0,0,0.45)');
		grad.addColorStop(1, 'rgba(0,0,0,0)');
		g.fillStyle = grad;
		g.fillRect(0, 0, 64, 64);
		shadowTexture = new CanvasTexture(c);
		shadowTexture.colorSpace = SRGBColorSpace;
		shadowTexture.minFilter = LinearFilter;
	}
	return shadowTexture;
}

export function createBallShadow(): Mesh {
	const geo = new PlaneGeometry(1, 1);
	geo.rotateX(-Math.PI / 2);
	const mat = new MeshBasicMaterial({ map: getShadowTexture(), transparent: true, depthWrite: false, color: new Color(0xffffff), side: DoubleSide });
	const mesh = new Mesh(geo, mat);
	mesh.renderOrder = 1;
	mesh.matrixAutoUpdate = false;
	return mesh;
}
