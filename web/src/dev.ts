// Development harness: renders the table with physics and keyboard controls.
import { PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, SRGBColorSpace } from 'three';
import { Logger, Progress } from './vpx/util/logger';
import { loadPack, Quality } from './engine/pack';
import { Player } from './vpx/game/player';
import { Vertex3D } from './vpx/math/vertex3d';
import { TableView } from './render/table-view';
import { frameTable, VIEWS } from './render/camera';

const noop = () => {};
Logger.setLogger({ debug: noop, error: console.error, info: noop, verbose: noop, warn: console.warn, wtf: console.error } as any);
Progress.setProgress({ details: noop, end: noop, show: noop, start: noop } as any);

const qs = new URLSearchParams(location.search);
const info = document.getElementById('info')!;

async function main() {
	const canvas = document.getElementById('c') as HTMLCanvasElement;
	const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(2, devicePixelRatio));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = Number(qs.get('exposure') || 1.0);
	const t0 = performance.now();
	const pack = await loadPack(qs.get('pack') || '/pack/', (qs.get('q') as Quality) || 'hd');
	const t1 = performance.now();
	const view = new TableView(pack, renderer, {
		dynamicItems: ['lflipb', 'lflipr', 'rflipb', 'rflipr', 'FlipperLSh', 'FlipperRSh', 'VariTargetP', 'Pkickarm', 'SLING1', 'Pgate', 'RSling', 'RSling1', 'RSling2',
			'BallShadow1', 'BallShadow2', 'BallShadow3', 'BallShadow4', 'BallShadow5'],
	});
	await view.textures.whenLoaded();
	const t2 = performance.now();
	const table: any = pack.table;
	const player = new Player(table).init();
	view.attach(player);
	for (const name of Object.keys(table.lights)) {
		const l = table.lights[name];
		if (!l.data.isBackglass && (name.startsWith('GI') || name.startsWith('Light') || qs.has('lamps'))) {
			l.getApi().State = 1;
		}
	}
	const camera = new PerspectiveCamera();
	(window as any).__frame = true;
	const dim = table.getDimensions();
	const resize = () => {
		renderer.setSize(innerWidth, innerHeight, false);
		if ((window as any).__frame) frameTable(camera, dim.width, dim.height, innerWidth / innerHeight, VIEWS[qs.get('view') || 'cabinet'], { minY: 0, maxY: 60 });
	};
	addEventListener('resize', resize);
	resize();

	const kick = table.kickers.BallRelease.getApi();
	if (qs.has('ballAt')) {
		const [bx, by, bz] = qs.get('ballAt')!.split(',').map(Number);
		(player as any).createBall({ getBallCreationPosition: () => new Vertex3D(bx, by, bz || 0), getBallCreationVelocity: () => new Vertex3D(0, 0, 0), onBallCreated() {} });
	} else if (!qs.has('noball')) {
		kick.CreateBall(); kick.Kick(90, 6);
	}
	const keys: { [k: string]: () => void } = {};
	addEventListener('keydown', e => {
		if (e.repeat) return;
		if (e.code === 'ShiftLeft' || e.code === 'KeyZ') table.flippers.LeftFlipper.getApi().RotateToEnd();
		if (e.code === 'ShiftRight' || e.code === 'Slash') table.flippers.RightFlipper.getApi().RotateToEnd();
		if (e.code === 'Space' || e.code === 'Enter') table.plungers.Plunger.getApi().PullBack();
		if (e.code === 'KeyB') { kick.CreateBall(); kick.Kick(90, 6); }
	});
	addEventListener('keyup', e => {
		if (e.code === 'ShiftLeft' || e.code === 'KeyZ') table.flippers.LeftFlipper.getApi().RotateToStart();
		if (e.code === 'ShiftRight' || e.code === 'Slash') table.flippers.RightFlipper.getApi().RotateToStart();
		if (e.code === 'Space' || e.code === 'Enter') table.plungers.Plunger.getApi().Fire();
	});
	let last = performance.now();
	let frames = 0, fpsT = last, fps = 0;
	const physStart = performance.now();
	(window as any).__dev = { player, table, view, renderer, camera, keys };
	const num = (k: string, d: number) => qs.has(k) ? Number(qs.get(k)) : d;
	(view.scene as any).environmentIntensity = num('env', 0.35);
	view.hemi.intensity = num('hemi', 0.45);
	view.key.intensity = num('key', 0.55);
	renderer.toneMapping = qs.get('tm') === 'aces' ? ACESFilmicToneMapping : qs.get('tm') === 'agx' ? AgXToneMapping : NeutralToneMapping;
	renderer.toneMappingExposure = num('exposure', 1);
	view.lightmap.uniforms.lmGain.value = num('lm', 1);
	if (qs.has('zx')) { (window as any).__frame = false; (0, eval)((window as any).__zoom || ''); }
	const frame = (now: number) => {
		player.updatePhysics(now - physStart);
		player.updateAnimations(now - physStart);
		syncPrimitives(table, view);
		view.sync();
		renderer.render(view.scene, camera);
		frames++;
		if (now - fpsT > 1000) { fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
		info.textContent = `pack ${(t1 - t0).toFixed(0)}ms  tex ${(t2 - t1).toFixed(0)}ms  fps ${fps.toFixed(0)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
		last = now;
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
	(window as any).__ready = true;
}

function syncPrimitives(table: any, view: TableView) {
	const lf = table.flippers.LeftFlipper.getApi().CurrentAngle;
	const rf = table.flippers.RightFlipper.getApi().CurrentAngle;
	for (const [n, a] of [['lflipb', lf], ['lflipr', lf], ['FlipperLSh', lf], ['rflipb', rf], ['rflipr', rf], ['FlipperRSh', rf]] as Array<[string, number]>) {
		const p = table.primitives[n];
		if (p) p.getApi().RotZ = a;
	}
}

main().catch(e => { info.textContent = String(e && e.stack || e); console.error(e); });
