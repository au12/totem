# Totem Web

Gottlieb's **Totem** (1979) in the browser, packaged as one small Docker image. It is made for phones first: open the page, tap Play, and use the two halves of the screen as flipper buttons.

The table is the community's Visual Pinball X recreation. The server converts it once into a web-friendly bundle; the browser renders it in 3D with three.js and runs Visual Pinball's own physics (the [vpx-js](https://github.com/vpdb/vpx-js) port) in fixed 1 ms steps. The machine's rules are rebuilt from the instruction cards, because the original Gottlieb System 1 ROM isn't used.

## Quick start

```sh
mkdir -p data config
cp "Totem (Gottlieb 1979).vpx" "Totem (Gottlieb 1979).directb2s" data/
docker compose up -d --build
```

Open <http://localhost:8080>. The first start converts the table (about five seconds); after that it starts instantly. The image is `FROM scratch`: one static Go binary and the site, about 15 MB.

### Table files

The table's art, models and sounds are not included. Use the Visual Pinball X release of Totem (the `Totem_1_3.zip` download):

| File | Needed | |
| --- | --- | --- |
| `Totem (Gottlieb 1979).vpx` | yes | The table: playfield, models, sounds, physics |
| `Totem (Gottlieb 1979).directb2s` | recommended | The backglass art and score displays. Without it, scores show in a strip above the table |

Put them anywhere under the folder mounted at `/data` (subfolders are fine). The release's `Media` folder (wheel image, videos) isn't used. The backglass is matched by file name, or used if it's the only `.directb2s` in the table's folder.

The converted table goes to `/config/packs/` and is rebuilt automatically if the `.vpx` file changes. Converting peaks at about 400 MB of memory.

## Playing on a phone

- **Flippers**: touch and hold the left or right half of the screen.
- **Launch**: hold the red Launch button and let go; hold longer for a stronger shot.
- **Nudge**: the Nudge button at the top right. Bump too often and the machine tilts, which costs the ball in play (as on the real game).
- **Menu**: the button at the top left pauses.

The game keeps the screen awake while you play and pauses itself when you switch apps. Tall phones show the score in a display strip above the table; with room to spare (tablets, landscape, desktop) the full backglass is shown beside or above it.

Sound starts with the first tap. On an iPhone, web pages are silent while the ring/silent switch is set to silent.

Served over HTTPS (for example behind Nginx Proxy Manager), the site is installable: in Safari use **Share → Add to Home Screen**, in Chrome **Install app**. It then opens full screen without the browser bars, and the table is cached for offline play.

## Other controls

| Key | Action |
| --- | --- |
| Left Shift or Z | Left flipper |
| Right Shift or / | Right flipper |
| Space, ↓ or Enter (hold, release) | Launch |
| T or ↑ | Nudge forward |
| X or ← / . or → | Nudge from the left / right |
| 1 or S | Start; add a player during ball 1 |
| Esc or P | Pause menu |
| F4 | Full screen |

Keys are rebindable in **Settings → Controls**. Mouse: left and right buttons flip, middle button launches, side buttons nudge. Gamepads: bumpers or triggers flip, A launches, Y nudges, D-pad left/right nudge sideways, X adds a player, Start pauses.

## The game

Totem is a 1979 Gottlieb System 1 machine (game #429). Its instruction card is in **How to play**:

- A, B, C or D top lanes light the drop targets of that letter for 5,000.
- Both B (or both C) targets plus the matching lane advance the bonus multiplier (up to 5×).
- All six drop targets: 5,000, multiplier, lights the Extra Ball target, and the banks reset.
- A-B-C-D lanes plus all drop targets light the hole for Special (a replay).
- The hole scores the whole bonus when it reaches 20,000.
- Pop bumpers and rollover buttons score 100 (1,000 in 3-ball play).
- Matching the last two digits of your score at game over wins a replay; beating the high score to date wins three.

Scoring tallies the way System 1 did, in 10/100/1,000 steps with a tone each, and the end-of-ball bonus counts down on the ladder. The machine's sound board is synthesized; it can play either the System 1 sound effects or the chime tones (**Settings → Sound**). Table sounds (flippers, bumpers, rubbers, ball roll) come from the table file.

Where the cards and rule sheets are silent, the rules are a best reconstruction; those spots are marked "assumed" in `web/src/game/totem-rules.ts`. **Settings → Game** has 3 or 5 balls, tilt sensitivity (off to strict) and match on/off.

### High scores

The server keeps a shared high-score list in `/config/scores.json` (the top 25 are shown), and each browser keeps its own. The backglass's "high game to date" display uses the best of the two, and credits, the last game's scores and the high game persist per browser like the real machine's memory.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | Table files (read-only is fine) |
| `STATE_DIR` | `/config` | Converted table and high scores |
| `PUID` / `PGID` | `1000` / `1000` | User the server drops to after making `/config` writable. Unraid: `99` / `100` |
| `LEADERBOARD` | `true` | Shared high scores |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the score rate limit (set behind a reverse proxy) |
| `LOG_REQUESTS` | `false` | Access log |

### Unraid and Nginx Proxy Manager

`unraid/totem.xml` is a container template (port 8089, paths under `/mnt/user/appdata/totem`, PUID 99 / PGID 100). It pulls `ghcr.io/au12/totem`, which the included GitHub Actions workflow builds for amd64 and arm64 when the repository is pushed to GitHub; change the owner if yours differs. To install it, copy the file to `/boot/config/plugins/dockerMan/templates-user/my-totem.xml`, then **Docker → Add Container** and pick `totem` from the template list.

For `totem.yourdomain.com` in Nginx Proxy Manager: add a proxy host for that name pointing at `http://<unraid-ip>:8089`, request a Let's Encrypt certificate on the SSL tab and turn on Force SSL. No WebSockets or custom locations are needed. Keep `TRUST_PROXY=true` (the template's default) so the leaderboard's rate limit sees players' real addresses.

## How it works

```
browser                                              container
┌───────────────────────────────────────────┐       ┌───────────────────────────────┐
│ main.ts      menus, settings, layout      │       │ totem (Go, standard library)  │
│ session.ts   game clock, input, nudging   │       │  /            site, br/gzip   │
│ totem-rules  System 1 rules ◄─ switches   │       │  /api/tables  scans /data,    │
│ totem-table  solenoids, lamps, sounds     │       │               converts .vpx   │
│ vpx/         Visual Pinball physics (1 ms)│ ◄─────┤  /pack/<id>/  converted table │
│ render/      three.js scene, lightmaps    │       │  /api/scores  leaderboard     │
│ audio/       WebAudio samples + synth     │       └───────────────────────────────┘
└───────────────────────────────────────────┘
```

- **Conversion** (`server/vpx.go`, `b2s.go`): reads the `.vpx` (an OLE compound file of BIFF records) and the `.directb2s` (XML), re-encodes textures to JPEG/PNG in a full-size and a half-size set (large cut-out art becomes a JPEG plus a grey alpha mask), turns sounds into WAV, and splits the backglass into lit and unlit art, lamp overlays and score-window positions. The table records go into one gzip-compressed stream bundle. The full set is about 14 MB to download; phones with little memory get the half-size set (about 11 MB).
- **Physics** (`web/src/vpx/`): the vpx-js port of Visual Pinball's player, trimmed to load from the bundle. The table's VBScript isn't run; `totem-table.ts` does what it did (wiring switches, kickers, drop-target resets, slingshot animation) and `totem-rules.ts` stands in for the ROM.
- **Picture**: static parts merged per material; lamps and inserts light the playfield through two lightmaps rendered from the table's own light shapes; the ball reflects the playfield and the room.
- `web/` is bundled with esbuild; every asset is content-hashed and precompressed. `server/` uses only the Go standard library.

### Developing without Docker

```sh
cd web && npm ci && npm run build && npm test       # front end, rules tests
cd ../server && WEB_ROOT=../web/dist DATA_DIR=../data STATE_DIR=../config PUID=0 go run .
```

`npm run watch` rebuilds on change. `node tools/run-ts.mjs tools/play.ts <packDir> 5` plays games headlessly with an autopilot and logs the rules, and `TOTEM_VPX=… TOTEM_B2S=… TOTEM_OUT=… go test` in `server/` runs a conversion.

## Credits and license

- Table: Visual Pinball X recreation by 32assassin and Armyaviation, with flippers by Bord.
- Physics and table loading: [vpx-js](https://github.com/vpdb/vpx-js) by freezy and contributors (GPL-2.0), a port of [Visual Pinball](https://github.com/vpinball/vpinball). The vendored copy in `web/src/vpx/` is from v1.3.4 with changes for this project (loading from the bundle, per-step hooks, a rubber hit-height fix); see `web/src/vpx/README.md`.
- Rendering: [three.js](https://threejs.org) (MIT). Decompression: fflate (MIT).
- Fonts: Antonio and Jost (SIL Open Font License).
- Totem was made by D. Gottlieb & Co. in 1979; its name and artwork belong to their owners. This project ships none of the table's art or sounds.

Totem Web is licensed under the GNU General Public License, version 2 or later (see `LICENSE`), because it includes vpx-js. License texts for everything bundled are served at `/licenses/`.
