# Vendored vpx-js

This folder is a copy of the `lib/` and `res/` folders of [vpx-js](https://github.com/vpdb/vpx-js) v1.3.4 (commit `e8a6d6fa52262a757d38b2317d845043e5fe1c95`), Copyright (C) 2019 freezy and contributors, licensed under the GNU General Public License version 2 or later (see `LICENSE`). vpx-js ports the Visual Pinball player to TypeScript.

Changed for Totem Web in October 2026:

| File | Change |
| --- | --- |
| `io/mem-storage.ts` | New: reads table records from the server's stream bundle instead of an OLE file |
| `io/ole-doc.ts` | Reduced to the storage interface (the OLE reader is not shipped) |
| `io/biff-parser.ts` | zlib via fflate instead of Node's zlib |
| `vpt/table/table.ts`, `table-loader.ts` | Load from memory; textures come from the pack manifest; the VBScript transpiler is not used |
| `vpt/texture.ts` | Textures described by the pack (name, size, URL) instead of embedded images |
| `game/player-physics.ts` | `onStep` hook at the start of each 1 ms physics step; `onCollide` hook for collision sounds |
| `game/event-proxy.ts`, `physics/hit-object.ts` | Small accessors (`playable`, `getType()`) |
| `vpt/primitive/primitive-api.ts` | Fix: setting a moving primitive's rotation, translation or size from the game changes only its state, not its original placement, so the change is drawn (flippers, gates and other toys now move on screen) |
| `vpt/rubber/rubber-mesh-generator.ts` | Fix: the hit shape is built at the rubber's hit height, not its render height, so balls no longer pass through rubbers that sit above the playfield |
| `vpt/*/…-mesh-generator.ts`, `vpt/kicker/kicker-hit.ts`, `vpt/enums.ts`, `vpt/table/table-api.ts`, `vpt/flipper/flipper-mesh.ts`, `vpt/ball/ball-mesh-generator.ts` | Import paths only (the resources in `res/` and the moved modules below) |
| `vpt/vbs-api.ts`, `vpt/lzw-reader.ts`, `version.ts` | Moved here from other upstream folders (`scripting/`, `gltf/`, the package index) |

Only the bumper images from `res/maps` and the meshes in `res/meshes` are kept.
