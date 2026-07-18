# Configuration

The project's configuration splits into three layers:

1. **Environment variables** (`.env`) — parameters for a master server
   instance (domain, port). Only apply in production.
2. **`src/config/`** — shared config used by the master (Node.js), the
   browser host's Worker, and the client (Vite bundle).
3. **`games/tanks/src/data/`** — static game data: maps, models, weapons.

The master collects its config into a single store,
`src/lib/config.js` (accessed via colon-separated paths), inside
[src/master/main.js](../../src/master/main.js); the host Worker imports
`game`/`client`/`auth`/`wsports` directly
([src/host/host.worker.js](../../src/host/host.worker.js)) and layers the
room's settings on top. The client receives its config (`client`) from
the host on connect (port `0`).

## Environment variables (.env)

Read in [src/master/main.js](../../src/master/main.js) when
`NODE_ENV=production` (`npm start` uses `node --env-file .env`). Ignored in
development — values from `src/config/master.js` apply instead.

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | The master's domain. **Required** in production (the process exits with an error otherwise) | `localhost` |
| `VIMP_MASTER_PORT` | The master server's port | `3002` |

Game parameters (map, player limit, timers, friendly fire) aren't set
through environment variables: the room's creator picks them in the lobby,
and defaults live in `src/config/game.js`.

## src/config/game.js — server-side game parameters

Source: [src/config/game.js](../../src/config/game.js). Imports maps,
models, and weapons from `games/tanks/src/data/`.

### Core parameters

| Parameter | Value | Description |
| --- | --- | --- |
| `maxPlayers` | `30` | The default participant limit; a host's room clamps it to the creator's setting (≤ 8), counted by humans |
| `chatMaxLength` | `60` | The max chat message length (authoritative on the host; must match the `maxlength` of the input in `chat.pug`) |
| `parts.friendlyFire` | `false` | Damage to your own team |
| `parts.mapConstructor` | `'Map'` | The map constructor's name |
| `parts.hitscanService` | `'HitscanService'` | The hitscan-shot calculation service |
| `mapScale` | `0.3` | Map scale |
| `currentMap` | `'pool mini'` | The default map |
| `mapsInVote` | `4` | How many maps show up in a vote |
| `mapSetId` | `'c1'` | The default snapshot key for the map constructor |
| `soundCues` | `roundStart, victory, defeat, frag, death: 'gameOver'` | Maps engine events to the game's sound names (`SocketManager.sendSoundCue`) |
| `initialVote` | `'teamChange'` | The vote sent to a player right after the first frame |
| `spectatorTeam` | `'spectators'` | The spectator team's name |
| `teams` | `team1: 1, team2: 2, spectators: 3` | Teams and their ids |

### Timers (`timers`, ms)

| Parameter | Value | Description |
| --- | --- | --- |
| `timeStep` | `1000/120` | The core's physics tick step (~120 Hz) |
| `networkSendRate` | `4` | A snapshot is sent every Nth tick (4 → 30 packets/sec) |
| `roundTime` | `120000` | Round duration |
| `mapTime` | `600000` | Map duration |
| `voteTime` | `10000` | How long a vote window stays open |
| `timeBlockedVote` | `30000` | Cooldown between votes on the same topic |
| `teamChangeGracePeriod` | `10000` | The team-change window at round start |
| `roundRestartDelay` | `5000` | Pause between rounds |
| `mapChangeDelay` | `2000` | Pause before a map switch after a vote |
| `rttPingInterval` | `3000` | RTT ping interval |
| `idleCheckInterval` | `30000` | How often idleness is checked |

### Kicks (`rtt`, `idleKickTimeout`)

- `rtt.maxMissedPings: 5` — consecutive missed pong replies before a kick;
- `rtt.maxLatency: 1000` — smoothed (EMA) latency (ms) above which a
  player is kicked; the threshold is sized for P2P hosting over home
  connections (a real RTT of 200–300 ms and spikes at a map change are
  normal);
- `idleKickTimeout.player: 120000` — kicks an idle player (2 minutes);
- `idleKickTimeout.spectator: null` — `null` disables the kick (spectators
  are never kicked).

### Stats (`stat`)

Describes the scoreboard columns. Per parameter:

- `key` — the cell's index within a row;
- `bodyMethod` — how the table body updates (`=` — replace, `+` — add);
- `bodyValue` — the default value;
- `headSync` — sync the head with the body;
- `headMethod` — how the header updates (`#` — count of values, `=` —
  replace, `+` — add);
- `headValue` — the default value in the header.

Current columns: `name` (0), `status` (1), `score` (2), `deaths` (3),
`latency` (4).

### HUD panel (`panel`)

String keys and default player resource values (reset every round):

- `health` → key `h`, value `100`;
- `w1` → key `w1`, `200` ammo;
- `w2` → key `w2`, `100` bombs.

The client-side mapping of keys to DOM elements is in `client.js`
(`modules.panel.keys`, including `t` — time and `wa` — active weapon).

### Keys (`spectatorKeys`, `playerKeys`)

`spectatorKeys` — a spectator's commands (`nextPlayer`/`prevPlayer`).

`playerKeys` — a player's commands. Each key has a bitmask `key` (`1 <<
n`, used by the predictor and the core in the input history) and an
optional `type`:

- `type: 0` (default) — a repeatable action: starts on keyDown, ends on
  keyUp (movement, turret rotation);
- `type: 1` — fires once on keyDown (`gunCenter`, `fire`, `nextWeapon`,
  `prevWeapon`).

The keyCode → command mapping is set on the client (`client.js` →
`modules.controls.keySetList`).

## src/config/client.js — the client config

Source: [src/config/client.js](../../src/config/client.js). Sent to the
client on connect. Before sending, the host appends:

- `modules.vote.params.time` = `game:timers:voteTime`;
- `prediction` — data for the client-side motion and shooting replica
  (`timeStep`, `playerKeys`, `models`, `weapons`) — assembled by
  [src/lib/buildClientConfig.js](../../src/lib/buildClientConfig.js).

### `parts` — game entities

- **`gameSets`** — mapping snapshot keys to rendering classes:

  ```js
  gameSets: {
    c1: ['Map', 'MapRadar'],
    c2: ['Map'],
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  }
  ```

  A single key can create several entities (a tank is drawn on the main
  canvas and the radar, plus smoke and tank tracks).

- **`entitiesOnCanvas`** — which canvas (`vimp` or `radar`) each class
  renders on. Entities can be subclassed and shown on different canvases
  (e.g. `MapRadar` — a simplified map for the radar).

- **`bakedAssets`** — procedural textures "baked" once at startup
  (`BakingProvider`): explosions, particles, smoke, the tank, the bomb,
  track marks, radar blips. Each entry: `name` (texture id), `component`
  (who owns it), `params` (generation parameters).

- **`componentDependencies`** — which services get injected into which
  components (`renderer` → Map; `soundManager` → ExplosionEffect,
  ShotEffect, Bomb, Tank).

### `interpolation` — snapshot interpolation

- `delay: 100` — ms; the world renders in the past
  (`renderTime = serverNow − delay`), ~3 frames at 30 packets/sec;
- `maxFrameAge: 1000` — a safety cleanup of stale buffered frames.

### `modules.canvasManager` — canvases and camera

`canvases` — keys match HTML canvas element ids:

| Parameter | Description |
| --- | --- |
| `aspectRatio` | The aspect ratio (`'16:9'`). The canvas fills the window while keeping the ratio. Without it — 100% of the window |
| `fixSize` | A fixed size in px (`'150'` — a square, `'200:100'` — a rectangle). Disables `aspectRatio` and adaptive scaling |
| `baseScale` | The base zoom (`'numerator:denominator'`). For adaptive canvases — the scale at a reference width of 1920px (`result = width/1920 × baseScale`); for fixed ones — a constant multiplier |
| `dynamicCamera` | Enables the dynamic camera (look-ahead + speed-based zoom) |
| `shakeCamera` | Allows camera shake |

Adaptive scaling guarantees the same field of view on any monitor
(reference: Full HD, 1920px).

`dynamicCamera` (common parameters): `lookAheadFactor` (camera offset
ahead of motion), `zoomOutFactor`/`maxZoomOut` (zooming out with speed),
`smoothnessPosition`/`smoothnessZoom`/`smoothnessVelocity` (smoothing).

Current canvases: `vimp` (16:9, 5:1 zoom, dynamic camera, shake) and
`radar` (150×150px, 1:8 scale).

### `modules.controls` — controls

- **`keySetList`** — an array of two `keyCode: 'command'` sets: `[0]` —
  spectator (`n`/`p` — switch the watched player), `[1]` — player
  (`w/s/a/d` — movement, `k/l/u` — turret, `j` — fire, `n/p` — weapon
  switch). Which set is active is dictated by the host over port `17`
  (KEYSET_DATA).
- **`modes`** — UI modes: `c` — chat, `m` — vote, `tab` — stats.
- **`cmds`** — service keys (`escape`, `enter`), with top priority, used
  within modes.

### Other modules

- **`chat`** — DOM element ids, output limits (`listLimit: 5` lines,
  `lineTime: 15000` ms), a cache, and **system message templates**
  (`messages`): groups `s` (status/commands), `v` (votes), `m` (maps),
  `c` (teams), `n` (names), `b` (bots). The host only sends
  `'group:number:params'`, the client assembles the text.
- **`panel`** — panel element ids and the mapping from server keys (`t`,
  `h`, `wa`, `w1`, `w2`) to elements.
- **`stat`** — head/body table ids (`heads`, `bodies`) and `sortList` —
  sort parameters: an array of `[cell index, descending?]` pairs; on a
  tie, comparison moves to the next pair.
- **`vote`** — DOM ids/classes and **vote templates** (`templates`):
  `[a title with {0} placeholders, options (an array — static, a string —
  request the list from the host), timeOff]`. `menu` — the main vote
  menu's items.
- **`gameInform`** / **`techInformList`** — templates for on-screen game
  messages (victory, round start) and technical screens (room full,
  idle/latency kicks, etc.).

## src/config/master.js

The master server's config (see [master.md](master.md)); read by
`src/master/main.js` (and `vite.config.js` — `httpsOptions` for dev HMR):

- `protocol`, `domain`, `port` — the address; the default port is `3002`
  (`3001` — Vite HMR). In production the domain is overridden by
  `VIMP_DOMAIN`, the port by `VIMP_MASTER_PORT`;
- `httpsOptions` — paths to local certificates
  `.certs/key.pem`/`cert.pem` (dev only; production HTTPS terminates at
  Nginx);
- `servers` — `GET /servers` parameters: `regionThreshold: 15` (at or
  below this many rooms, the regional filter and pagination are disabled),
  `defaultLimit: 10`, `maxLimit: 50`;
- `host` — room constraints: `maxNameLength: 30`, `maxPlayersLimit: 8`,
  `heartbeatTimeout: 30000` (a room without a heartbeat for longer is
  removed), `sweepInterval: 10000`; `/ban` social moderation:
  `banThreshold: 5` (unique per-IP reports needed for a ban),
  `reportWindowMs: 3600000` (the report/ban window, 1 h);
- `regionHeader: 'x-region'` — the header carrying a host's region from
  Nginx/CDN;
- `pingRateLimit` — the limit on signaling `ping_host` requests per IP
  (`limit: 10` over `windowMs: 1000`);
- `security` (environment hygiene) — `csp` (the Content-Security-Policy
  string: the single source of truth for the policy, set by the master on
  its own responses in production, authoritatively on static assets/
  `.wasm` — Nginx, see [deployment.md](deployment.md)) and
  `referrerPolicy: 'no-referrer'`; the master always sends
  `nosniff`/`X-Frame-Options`/`Referrer-Policy`, CSP only in production
  (it would break Vite HMR in dev);
- `iceServers` — ICE config for clients and hosts (STUN; TURN optional).

## src/config/lobby.js

The client lobby's config (see
[client.md](client.md#mvc-components-srcclientcomponents)). Unlike
`client.js`, it's **bundled into the build** rather than delivered by the
host: the lobby happens before connecting to a host.

- `serversUrl: '/servers'` — the master's server-list REST endpoint;
- `maps` — the master's map catalog: `manifestUrl: '/maps/manifest.json'`,
  `baseUrl: '/maps'` — a host's room starts on current maps (falls back to
  the bundle if unavailable);
- `worker` — the master's worker bundle manifest:
  `manifestUrl: '/worker/manifest.json'` — the room's Worker is created
  from the `url` in the manifest, a `codeVersion` mismatch on re-register
  triggers a Worker handoff (falls back to the bundled URL with no code
  updates — dev/unavailability);
- `reconnect` — the host's signaling WS reconnect: exponential backoff
  from `baseDelay: 1000` to `maxDelay: 30000` (ms);
- `pageSize: 10` — the page size for "Load more" (`offset`/`limit`);
- `pingInterval: 5000` — the minimum interval between repeated
  `ping_host` calls for one server (anti-spam while scrolling/redrawing);
- `elems` — lobby DOM element ids (from `lobby.pug`), including
  `nameId`/`hostBtnId` — the name field and the "create server" button
  (the browser host, [host.md](host.md));
- `create` — room creation settings: `defaultName`, `maxPlayers` (≤ 8),
  `heartbeatInterval` (the master's `update_host` period),
  `hostSocketId: 'local'` — the loopback socketId of the host player (the
  Worker uses it to exclude the host from kick policies).

## src/config/auth.js

The auth form: DOM element ids (`elems`) and form parameters (`params`).
Each parameter: `name`, a default value, `validator` (a function from
[src/lib/validators.js](../../src/lib/validators.js): `isValidName`,
`isValidModel`), and a `storage` key for localStorage. Validation runs on
the client and is repeated by the host (Worker).

## games/tanks/src/config/sounds.js

The sound catalog. Each sound: `file` (the filename without an extension
in `public/sounds/`), `priority` (higher wins when voices compete),
`volume`, optionally `loop: true`. `codecList: ['webm', 'mp3']` — files
must exist in both formats. More on playback — [client.md](client.md#soundmanager).

## src/config/wsports.js and src/config/opcodes.js

- **`wsports.js`** — the numeric port registry for the game protocol
  (the source of truth). Full tables — [network.md](network.md#ports).
- **`opcodes.js`** — the binary snapshot format version
  (`SNAPSHOT_FORMAT_VERSION = 3`) and the `SNAPSHOT_KEYS` registry
  (`m1`, `w1`, `w2`, `w2e`, `c1`, `c2` → a numeric id + `kind`, which
  drives the block's byte layout). An unregistered key breaks frame
  packing. Details — [network.md](network.md#binary-snapshot-frame-port-5).

## games/tanks/src/data/ — game data

### models.js

The only model — the `m1` tank
([games/tanks/src/data/models.js](../../games/tanks/src/data/models.js)): the `Tank` constructor,
starting weapon `w1`, size (`size: 2`, dimensions `size×4 : size×3`),
motion parameters (acceleration/braking, `maxForwardSpeed: 260`,
`maxReverseSpeed: −130`, turn torque, damping, lateral grip), physics
(`density`, `friction`, `restitution`), "driving feel" (throttle/turn
thresholds and rates), and the turret (`maxGunAngle: 1.4` rad,
rotation/centering rates).

> ⚠️ The `models.js` coefficients are used both by the core's
> authoritative path and by the client prediction replica
> (`core/src/client/predictor.rs`, formulas shared through
> `core/src/motion.rs`). Changing them requires the cargo parity check:
> `npm run core:test`.

### weapons.js

Two architecturally different weapon types
([games/tanks/src/data/weapons.js](../../games/tanks/src/data/weapons.js)):

| | `w1` (bullet) | `w2` (bomb) |
| --- | --- | --- |
| Type | `hitscan` — an instant ray, no physical projectile | `explosive` — a physical `Bomb` projectile in the Rapier world |
| Damage | 40 | 70 at the epicenter, 50 blast radius |
| Range | 1500 units | — (detonates on a `time: 300` ms timer) |
| Cooldown | 0.01 s | 0.1 s |
| Other | `spread: 0`, costs 1 ammo | `size: 8`, explosion impulse `2000000`, effect `w2e` |
| Camera shake | 20px / 200ms | 30px / 400ms |

### maps/

Three maps: `pool mini` (small), `canopy`, `garden`. Each describes tile
layers (`layers`, `tiles`), respawn points (`respawns`), static
(`physicsStatic`) and dynamic (`physicsDynamic`) physics. Registration —
[games/tanks/src/data/maps/index.js](../../games/tanks/src/data/maps/index.js). How to add a map
— see [extending.md](extending.md#new-map).

---

[← Previous: Network Protocol](network.md) · [Next: Extending the Game →](extending.md)
