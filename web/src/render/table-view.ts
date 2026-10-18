/*
 * Builds the three.js scene for a VPX table and keeps its moving parts in
 * sync with the physics.
 *
 * Coordinates: meshes come from the vpx-js generators in "render space"
 * (x right, y towards the player, z = -height). The table root rotates that
 * into three.js world space: X right, Y up, Z towards the player.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
	BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, HemisphereLight, Material as ThreeMaterial,
	Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LoadedPack } from '../engine/pack';
import { Player } from '../vpx/game/player';
import { ItemState } from '../vpx/vpt/item-state';
import { Ball } from '../vpx/vpt/ball/ball';
import { Bumper } from '../vpx/vpt/bumper/bumper';
import { Flipper } from '../vpx/vpt/flipper/flipper';
import { Gate } from '../vpx/vpt/gate/gate';
import { HitTarget } from '../vpx/vpt/hit-target/hit-target';
import { Kicker } from '../vpx/vpt/kicker/kicker';
import { Light } from '../vpx/vpt/light/light';
import { Plunger } from '../vpx/vpt/plunger/plunger';
import { Primitive } from '../vpx/vpt/primitive/primitive';
import { PrimitiveState } from '../vpx/vpt/primitive/primitive-state';
import { Ramp } from '../vpx/vpt/ramp/ramp';
import { Rubber } from '../vpx/vpt/rubber/rubber';
import { Spinner } from '../vpx/vpt/spinner/spinner';
import { Surface } from '../vpx/vpt/surface/surface';
import { Trigger } from '../vpx/vpt/trigger/trigger';
import { Table } from '../vpx/vpt/table/table';
import { createBallMaterial, createBallShadow } from './ball';
import { decimate, meshToGeometry } from './geometry';
import { Lightmap } from './lightmap';
import { MaterialFactory } from './materials';
import { Placement, PrimitiveTransform } from './primitive-transform';
import { TextureStore } from './textures';
import { UpdaterApi } from './updater-api';

export interface TableViewOptions {
	/** Items the game logic moves or hides (primitives, rubbers, walls). */
	dynamicItems?: Iterable<string>;
	/** Items never drawn (e.g. desktop-only backdrop parts). */
	hiddenItems?: Iterable<string>;
	lightmapDensity?: number;
}

interface DynamicItem {
	name: string;
	item: any;
	node: Group;
	prev?: ItemState;
	/** Animated primitives are placed by us rather than vpx-js's updater. */
	transform?: PrimitiveTransform;
}

interface BallView {
	ball: Ball;
	mesh: Mesh;
	shadow: Mesh;
}

const DYNAMIC_TYPES = [Flipper, Gate, Spinner, Bumper, HitTarget, Trigger, Plunger];

export class TableView {

	public readonly scene = new Scene();
	public readonly root = new Group();
	public readonly table: Table;
	public readonly textures: TextureStore;
	public readonly lightmap: Lightmap;
	public readonly materials: MaterialFactory;
	public readonly dynamics = new Map<string, DynamicItem>();
	private readonly balls = new Map<number, BallView>();
	private readonly api = new UpdaterApi();
	private readonly ballGeometry = new SphereGeometry(1, 48, 32);
	private ballMaterial!: ShaderMaterial;
	private player?: Player;
	public drawCalls = 0;
	public readonly hemi: HemisphereLight;
	public readonly key: DirectionalLight;
	public playfieldMaterial!: MeshStandardMaterial;

	constructor(public readonly pack: LoadedPack, private readonly renderer: WebGLRenderer, opts: TableViewOptions = {}) {
		this.table = pack.table;
		this.textures = new TextureStore(pack, renderer);
		this.lightmap = new Lightmap(this.table, renderer, { giDensity: 0.2, insertDensity: opts.lightmapDensity ?? 0.5, insertGain: 0.12, giGain: 0.03 });
		this.materials = new MaterialFactory(this.table, this.textures, this.lightmap.uniforms);
		this.scene.background = new Color(0x050403);
		this.root.name = 'table';
		this.root.rotation.x = Math.PI / 2;
		this.scene.add(this.root);

		const pmrem = new PMREMGenerator(renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();

		const hemi = this.hemi = new HemisphereLight(0xfff1dd, 0x1a1410, 0.45);
		this.scene.add(hemi);
		const key = this.key = new DirectionalLight(0xfff4e6, 0.55);
		key.position.set(this.table.getDimensions().width * 0.5, 1800, this.table.getDimensions().height * 1.2);
		key.target.position.set(this.table.getDimensions().width * 0.5, 0, this.table.getDimensions().height * 0.45);
		this.scene.add(key, key.target);

		this.build(new Set(opts.dynamicItems ?? []), new Set(opts.hiddenItems ?? []));
	}

	private build(dynamicNames: Set<string>, hidden: Set<string>): void {
		const table = this.table;
		const buckets = new Map<ThreeMaterial, BufferGeometry[]>();
		const addStatic = (g: BufferGeometry, m: ThreeMaterial) => {
			let list = buckets.get(m);
			if (!list) {
				buckets.set(m, list = []);
			}
			list.push(g);
		};

		// Playfield
		const dim = table.getDimensions();
		const pf = new BufferGeometry();
		const z = -table.getTableHeight();
		pf.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, z, dim.width, 0, z, dim.width, dim.height, z, 0, dim.height, z]), 3));
		pf.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]), 3));
		pf.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
		pf.setIndex([0, 2, 1, 0, 3, 2]);
		const pfMat = this.materials.get(table.data!.szPlayfieldMaterial, table.data!.szImage, { lightmapGain: 1.0, insertGain: 2.5, insertGlow: 0.8 });
		this.playfieldMaterial = pfMat;
		const pfMesh = new Mesh(pf, pfMat);
		pfMesh.name = 'playfield';
		pfMesh.renderOrder = -1;
		this.root.add(pfMesh);

		// Everything below the playfield (seen through holes) is dark.
		const under = new Mesh(pf.clone().translate(0, 0, 60), new MeshStandardMaterial({ color: 0x080706, roughness: 1, side: DoubleSide }));
		under.name = 'under-playfield';
		this.root.add(under);

		for (const item of table.getRenderables() as any[]) {
			const name: string = item.getName();
			if (item instanceof Light || item === table || hidden.has(name)) {
				continue;
			}
			const isDynamic = DYNAMIC_TYPES.some(t => item instanceof t) || dynamicNames.has(name);
			let meshes: { [key: string]: any };
			try {
				meshes = item.getMeshes(table, this.api, {});
			} catch (err) {
				console.warn('mesh', name, err);
				continue;
			}
			let group: Group | undefined;
			for (const info of Object.values<any>(meshes)) {
				if (!info.mesh || !info.mesh.vertices.length) {
					continue;
				}
				if (!isDynamic && !info.isVisible) {
					continue;
				}
				let geometry = meshToGeometry(info.mesh);
				// Tiny but dense parts (screws, nuts) cost far more triangles
				// than the pixels they cover; simplify them.
				const tris = geometry.index!.count / 3;
				const radius = geometry.boundingSphere!.radius;
				if (!isDynamic && item instanceof Primitive && tris > 300 && radius < 22) {
					const simple = decimate(geometry, Math.max(0.6, radius / 6));
					if (simple.index!.count >= 36) {
						geometry.dispose();
						geometry = simple;
					}
				}
				// Primitive render flags live on its (protected) item data.
				const prim = item instanceof Primitive ? (item as unknown as { data: { backfacesEnabled?: boolean; disableLightingTop?: number; depthBias: number } }).data : undefined;
				const opts = {
					transparent: !!info.isTransparent,
					doubleSide: !!prim?.backfacesEnabled,
					unlit: prim ? Math.min(1, prim.disableLightingTop || 0) : 0,
					depthBias: prim ? prim.depthBias : 0,
				};
				const material = this.materials.get(info.material ? info.material.name : undefined, info.map ? info.map.getName() : undefined, opts);
				if (isDynamic) {
					if (!group) {
						group = new Group();
						group.name = name;
						group.matrixAutoUpdate = false;
						this.root.add(group);
						const transform = item instanceof Primitive
							? new PrimitiveTransform((item as unknown as { data: Placement }).data, this.table.getScaleZ())
							: undefined;
						this.dynamics.set(name, { name, item, node: group, transform });
					}
					const mesh = new Mesh(geometry, material);
					mesh.name = info.mesh.name;
					mesh.matrixAutoUpdate = false;
					mesh.visible = !!info.isVisible;
					mesh.userData.vpxMaterial = info.material ? info.material.name : undefined;
					mesh.userData.materialOptions = opts;
					group.add(mesh);
				} else {
					addStatic(geometry, material);
				}
			}
		}

		for (const [material, list] of buckets) {
			const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
			if (!merged) {
				continue;
			}
			const mesh = new Mesh(merged, material);
			mesh.name = `static:${material.name}`;
			mesh.matrixAutoUpdate = false;
			if ((material as any).transparent) {
				mesh.renderOrder = 2;
			}
			this.root.add(mesh);
			for (const g of list) {
				if (g !== merged) {
					g.dispose();
				}
			}
		}
		this.root.updateMatrixWorld(true);

		const env = this.textures.get(table.data!.szEnvImage);
		this.ballMaterial = createBallMaterial(pfMat.map, env ? env.map : null, this.lightmap.uniforms, dim.width, dim.height);
	}

	public attach(player: Player): void {
		this.player = player;
		for (const d of this.dynamics.values()) {
			d.prev = undefined;
		}
		for (const b of this.balls.values()) {
			this.root.remove(b.mesh);
			this.scene.remove(b.shadow);
		}
		this.balls.clear();
	}

	/** Pulls the latest physics state into the scene. */
	public sync(): void {
		for (const d of this.dynamics.values()) {
			const state = d.item.getState() as ItemState;
			if (d.prev && state.equals(d.prev)) {
				continue;
			}
			if (d.transform) {
				const p = state as unknown as PrimitiveState;
				d.node.visible = !!p.isVisible;
				d.transform.matrix({
					position: p.position,
					size: p.size,
					rotAndTra: [
						p.rotation.x, p.rotation.y, p.rotation.z,
						p.translation.x, p.translation.y, p.translation.z,
						p.objectRotation.x, p.objectRotation.y, p.objectRotation.z,
					],
				}, d.node.matrix);
				d.node.matrixWorldNeedsUpdate = true;
			} else {
				try {
					d.item.getUpdater().applyState(d.node, state, this.api, this.table);
				} catch (err) {
					// Updaters assume vpx-js's own node layout; ignore mismatches.
				}
			}
			d.prev?.release();
			d.prev = state.clone();
		}
		this.syncBalls();
		this.lightmap.update(this.renderer);
	}

	private syncBalls(): void {
		const balls = this.player ? this.player.getBalls() : [];
		const seen = new Set<number>();
		for (const ball of balls) {
			seen.add(ball.id);
			let view = this.balls.get(ball.id);
			if (!view) {
				const mesh = new Mesh(this.ballGeometry, this.ballMaterial);
				mesh.name = ball.getName();
				mesh.matrixAutoUpdate = false;
				this.root.add(mesh);
				const shadow = createBallShadow();
				this.scene.add(shadow);
				view = { ball, mesh, shadow };
				this.balls.set(ball.id, view);
			}
			const s = ball.getState();
			const r = ball.data.radius;
			// Render space is (x, y, -z). A plain chrome ball looks the same at
			// any orientation, so only position and size matter.
			view.mesh.matrix.set(
				r, 0, 0, s.pos.x,
				0, r, 0, s.pos.y,
				0, 0, r, -s.pos.z,
				0, 0, 0, 1,
			);
			view.mesh.matrixWorldNeedsUpdate = true;
			// Contact shadow on the playfield, fading as the ball leaves it.
			const h = Math.max(0, s.pos.z - r);
			const size = r * 2.3 * (1 + h / 120);
			const op = Math.max(0, 1 - h / 90);
			view.shadow.visible = op > 0.02 && s.pos.z > -r;
			view.shadow.matrix.makeScale(size, 1, size).setPosition(s.pos.x + 4, 0.6, s.pos.y + 7);
			(view.shadow.material as MeshBasicMaterial).opacity = op;
			view.shadow.matrixWorldNeedsUpdate = true;
		}
		for (const [id, view] of this.balls) {
			if (!seen.has(id)) {
				this.root.remove(view.mesh);
				this.scene.remove(view.shadow);
				view.shadow.geometry.dispose();
				this.balls.delete(id);
			}
		}
	}

	/** Swaps the image on a dynamic item (e.g. the apron's instruction card). */
	public setItemTexture(name: string, texture: string): void {
		const d = this.dynamics.get(name);
		if (!d || !this.pack.texture(texture)) {
			return;
		}
		for (const child of d.node.children) {
			const mesh = child as Mesh;
			if (!mesh.isMesh) {
				continue;
			}
			mesh.material = this.materials.get(mesh.userData.vpxMaterial, texture, mesh.userData.materialOptions || {});
		}
	}

	public node(name: string): Object3D | undefined {
		return this.dynamics.get(name)?.node;
	}

	public dispose(): void {
		this.scene.traverse(o => {
			const m = o as Mesh;
			if (m.isMesh) {
				m.geometry.dispose();
			}
		});
		for (const m of this.materials.all()) {
			m.dispose();
		}
		this.textures.dispose();
		this.lightmap.dispose();
		this.scene.environment?.dispose();
	}
}
