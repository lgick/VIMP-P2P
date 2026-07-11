# Client Modules and Systems

The client is a browser app built on PixiJS (Vite build, Pug templates in
[src/client/views/](../../src/client/views/)). The entry point is
[src/client/main.js](../../src/client/main.js).

## main.js — bootstrap, dispatcher, and render loop

- **Bootstrap**: creates `SignalingClient`, connects to the master; on
  `welcome` it brings up the lobby (`initLobby`). Picking a server →
  `connectToHost` creates a `WebRtcManager`, establishes P2P, and remembers
  `currentHostId` (for `/ban`).
- **`/ban` social moderation**: outgoing chat goes through `handleChatSend`
  — it intercepts `/ban <reason>` and, instead of sending it to the host
  (port `CHAT_DATA`), sends the report straight to the master
  (`signaling.reportHost(currentHostId, reason)`), bypassing the cheating
  host. A reason is required, available only to guests (`currentHostId` is
  set); for the host player the command shows a local hint; a dropped
  signaling WS shows a plain error message (the report wasn't sent). The
  master additionally only accepts reports from a session that actually
  connected to the room — see [master.md](master.md#ban-social-moderation).
  The rest of chat goes to the host as usual.
- Branches incoming host packets (`handleMessage`) by data type: a string →
  the JSON dispatcher `[portId, payload]` → `socketMethods[portId]`; an
  `ArrayBuffer` → `clientCore.push_frame` (decoding, seq insertion into the
  buffer, and predictor reconciliation all happen in the core; a version
  mismatch drops the frame).
- On `CONFIG_DATA` (port 0) it initializes every module: the PixiJS
  `Application`s, the MVC components, `BakingProvider` (texture baking),
  `SoundManager`, and the **client core** (`await init()` for WASM + `new
  ClientCore(...)`, its config is assembled by
  [src/lib/clientCoreConfig.js](../../src/lib/clientCoreConfig.js) from the
  `prediction`/`interpolation` sections of CONFIG_DATA); it replies
  `CONFIG_READY`.
- The first frame (`FIRST_SHOT_DATA`, port 4) is applied immediately
  (`applyShot`), bypassing the core.
- **The render loop** `renderTick` on `Ticker.shared` (rAF):
  `clientCore.sample(now)` → reading the flat hot buffer zero-copy from
  WASM memory (tanks/dynamics/camera/predicted tank) + `take_frames()` for
  rare event frames → applied through the previous `parse` pipeline (see
  "Client Core" below).
- Resets: a map change (`MAP_DATA` → `set_map`) and `CLEAR` (→ `reset`)
  clear the frame buffer and the predictor in the core.
- **P2P drop** (`handleDisconnect`): the host leaving kills the room (no
  host migration) — stops the render tick and the `Application`s, shows a
  placeholder, and returns to the lobby by reloading. A terminal close
  reason already shown by the tech informer (a kick, a full room — any code
  but `loading`) isn't overwritten by the generic "Host left…" message; the
  reason is delivered by the host's Worker as a `TECH_INFORM_DATA` message
  right before the channel closes (see
  [network.md](network.md#rtt-pingpong-and-kicks)). `techInformList` has a
  bundle default (`src/config/client.js`) — a full-room refusal arrives
  before `CONFIG_DATA`.
- **WebRTC unavailable** (`ensureWebRtcAvailable`): if `RTCPeerConnection`
  is unavailable (Firefox with `media.peerconnection.enabled = false`,
  resist fingerprinting, etc.), `connectToHost`/`connectAsHost` show a
  plain message and stay in the lobby instead of failing with a black
  screen.
- **The host role**: before starting the Worker, `connectAsHost` fetches
  the master's map catalog (falls back to the bundle), registers the room
  and starts a heartbeat once `ready` fires; the host's signaling WS
  reconnects with backoff on a drop
  (`lobbyConfig.reconnect`) and re-registers the room (a fresh `welcome`
  doesn't recreate the lobby — a guard in `initLobby`). A Worker init
  failure (`error`) tears down the room with a message and returns to the
  lobby.

## Network layer (src/client/network/)

The game transport is WebRTC, not WebSocket (channel details —
[network.md](network.md#transport-webrtc)):

- **`SignalingClient`** — a thin wrapper around the master's signaling
  WebSocket: `connect()`, caching `id`/`iceServers` from `welcome`,
  relaying incoming messages to subscribers by `type` (via `Publisher`),
  methods `sendOffer`/`sendIceCandidate`/`pingHost`/`reportHost`. The
  transport is injected by a factory for tests.
- **`WebRtcManager`** — the P2P connection to the host: `RTCPeerConnection`
  + the `meta` (reliable-ordered) and `state` (unreliable-unordered)
  channels. The client is the offerer: it creates the channels/offer,
  exchanges SDP/ICE through `SignalingClient`. `Publisher` events: `open`
  (both channels open), `message` (data from either channel in a single
  stream), `close` (a drop). `RTCPeerConnection` is injected by a factory
  for tests.

The client's role is picked in the lobby (`src/client/main.js`): **joining**
(`connectToHost` → `WebRtcManager`, offerer) or **hosting** (`connectAsHost`
→ a browser host in the same tab). For a host, the game transport is
**`LoopbackTransport`**: the same interface as `WebRtcManager` (`publisher`
with `message`/`close`, `send`/`close`), but data travels through
`HostController` → the Web Worker as postMessages, bypassing WebRTC. Client
code is identical either way — the transport is transparent.

A host tab additionally brings up main-thread routing infrastructure (the
main thread, not the Worker): **`HostController`** spawns the Worker with
the core and bridges it to the transports; **`HostConnectionManager`** is
the **WebRTC answerer** for remote clients (a mirror of `WebRtcManager`):
listens for `webrtc_offer` via `SignalingClient`, creates a
`RTCPeerConnection` per client, catches the `meta`/`state` channels in
`ondatachannel`, sends `webrtc_answer`+ICE, registers the room with the
master (`register_host`/heartbeat), and answers the lobby ping
(`ping_host`). Remote clients' data flows into the same Worker as the host
player's loopback. Details — [host.md](host.md).

## MVC components (src/client/components/)

Nine `model/` + `view/` + `controller/` triplets: **Auth**, **Lobby**,
**CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**, **Stat**,
**Vote**.

**Lobby** — the server-selection screen BEFORE connecting to a host:

- **model** — the server registry (responses from the master's
  `GET /servers`), pagination, search, smart pinging. Does no I/O of its
  own: it publishes `fetch` (request the REST endpoint), `ping-request` (a
  signaling ping), `join` (a server was picked), `list`/`ping-update` (for
  the view). `latency` lives separately from the list and survives a
  refresh/pagination.
- **view** — renders cards, search, "Load more"; **smart pinging** through
  `IntersectionObserver`: a card entering the visible area → `visible` →
  the controller sends `ping_host`; `pong` updates latency and re-sorts
  cards ascending. `IntersectionObserver` is injected for tests.
- **controller** — proxies view events to the model; ping throttling lives
  in the model (`pingHost` returns `false` if the server was pinged
  recently, interval `pingInterval`).

Config — [src/config/lobby.js](../../src/config/lobby.js) (bundled into the
build, since the lobby happens before connecting to a host). The ping
measurement is **approximate** (client→master→host, not P2P RTT) and shown
as such in the UI.

The Publisher pattern within a triplet:

- `main.js` or the `view` → calls the `controller`'s methods **directly**;
- the `controller` → calls the `model`'s methods **directly**;
- the `model` → the `view` — **through `Publisher`**
  ([src/lib/Publisher.js](../../src/lib/Publisher.js)): the model publishes
  an event, the view is subscribed; external subscribers can listen to a
  model too.

What each component does:

- **Auth** — the login form (name, model), client-side validation
  (`validators.js`), localStorage.
- **CanvasManager** — manages several PixiJS `Application`s at once:
  `vimp` (the main game canvas) and `radar` (the mini-map). Adaptive
  scaling (a 1920px reference width), `aspectRatio`/`fixSize`/`baseScale`,
  a dynamic camera (look-ahead, speed-based zoom), and shake — parameters
  in [configuration.md](configuration.md#modulescanvasmanager--canvases-and-camera).
- **Controls** — keyboard capture (`InputListener`), the active key set
  dictated by the server (port 17), `chat`/`vote`/`stat` modes, input sent
  as `"seq:action:name"`.
- **Game** — the rendering core: `GameCtrl.parse(name, data)` creates/
  updates/removes entity instances from snapshot data through `Factory`.
- **Chat** — message output (row/lifetime limits), the command line;
  escaping happens on output (`textContent`).
- **Panel** — the HUD: round time, health, ammo, active weapon (from
  `'key:value'` strings).
- **Stat** — sortable scoreboard tables (`sortList`), shown on Tab.
- **Vote** — vote windows built from templates, pagination, a lifetime
  timer.

## Client Core (ClientCore)

Client-side math — snapshot interpolation, the local tank's prediction,
visual shot spawning, and v3 frame decoding — lives in the Rust core
(`core/src/client/`, the wasm-bindgen class `ClientCore` from the same WASM
binary as the host's `GameCore`). The JS shell (`main.js`) only forwards
data and applies the result to rendering; ABI and layouts —
[core.md](core.md#clientcore--the-cores-client-mode).

Data flow:

- **Input**: `handleMessage` hands a binary frame to `push_frame(bytes,
  now)` — the core decodes it (a version mismatch drops the frame),
  inserts it into the buffer by `seq` with deduplication, and, if the frame
  carries a player block, reconciles the predictor. Ports
  `MAP_DATA`/`PANEL_DATA`/`KEYSET_DATA`/`CLEAR` mirror into
  `set_map`/`sync_panel`/`set_active`/`reset`; the tank model — `set_model`
  on auth.
- **Render tick**: `sample(now)` returns the length of the flat **hot
  buffer** — `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` read
  zero-copy (the view is recreated every tick: WASM memory growth detaches
  the buffer). The buffer carries flags, the camera (already resolved:
  predicted position or interpolated), interpolated tank/dynamic records,
  and the local tank's predicted record last. The `reconstructHot` adapter
  (~40 lines in `main.js`) assembles the previous shape
  `{ m1: { id: [...] }, c1: {...} }` from it and feeds the existing
  `applyGameData` — GameCtrl/parts were never touched; the predicted record
  overrides the local tank through the same pipeline.
- **Event frames** (the `hasFrames` flag): `take_frames()` returns a JSON
  array `[{ game, camera }, …]` — every crossed `renderTime` frame emitted
  exactly once (events `w1`/`w2e`, creations/removals, camera reset/shake),
  already with duplicate own shots suppressed; applied through the previous
  `applyShot`. Sound and effects trigger as before, from the parts
  themselves on entity creation — there's no separate eventId dispatcher.
- **Input**: `apply_input(action, name, now)` records predictor history; on
  `down` `fire` — `try_fire(now)` (cooldown/ammo/pending-bomb/alive gates
  are internal to the core) returns spawn JSON for `applyGameData`;
  `nextWeapon`/`prevWeapon` — `cycle_weapon`. Sending `"seq:action:name"` to
  the host is unchanged.

Internally the core implements the following algorithms:

- **interpolation** (`client/interpolator.rs`): an EMA offset of server
  time, `renderTime = serverNow − delay` (config `interpolation.delay: 100`
  ms), lerp for tanks/dynamics/camera (angles by shortest path), discrete
  fields taken from the reference frame, hold with no extrapolation,
  seq-based insertion + immediate emission of late-frame events;
- **prediction** (`client/predictor.rs`): a replica of the authoritative
  motion without Rapier collisions, at a fixed `timeStep`; tick formulas
  are **shared** with `Tank::update` (`core/src/motion.rs`) — the replica
  can't diverge from the authoritative path on formulas, integration
  parity (manual vs. Rapier) is locked in by the `client_parity` cargo
  tests; input history, replay from the frame's `serverTime`,
  `visualError` with exponential decay and a snap, freeze at `condition
  0`, resets on a camera forceReset/map change/keySet;
- **shot spawning** (`client/shot.rs` + `client/raycast.rs`): a replica of
  the authoritative gate and muzzle formulas, DDA raycasting over wall
  tiles + an OBB test against dynamics and tanks, a single pending-bomb
  gate, RTT-compensated bomb position, suppressing authoritative
  duplicates by author id (`tracers[7]`, `bombs[5]`, a FIFO queue with a
  2 s timeout, local keys `L<n>`). Tracer spread uses a client-side PRNG,
  not synced with the host — a purely visual effect, the authoritative
  tracer arrives in a frame.

## Rendering

### parts/ — entities

[src/client/parts/](../../src/client/parts/) — classes rendered on the
PixiJS canvases: `Tank` (one class for both your own tank and others'),
`TankRadar`, `Map`, `MapRadar`, `Bomb`, `Smoke`, `Tracks` (+`TrackMark`),
`ParticlePool`. Effects live in `parts/effects/` (`BaseEffect`,
`explosion/` — explosion/crater/smoke, `shot/` — tracer/impact), animated
on `Ticker.shared`.

Mapping snapshot keys to classes, and their canvas assignment, is
`gameSets`/`entitiesOnCanvas` in `client.js`. There's no fixed contract for
a part — use the existing ones as a template when creating a new one.

### Factory

[src/lib/factory.js](../../src/lib/factory.js) — an entity-name → class
registry. `GameCtrl.parse(name, data)` creates an instance from incoming
data, calls `update(data)` on an existing one, or removes it (`null`).

### Providers

- **`BakingProvider`**
  ([providers/BakingProvider.js](../../src/client/providers/BakingProvider.js))
  — one-time procedural texture generation at startup from the
  `bakedAssets` config; baking functions live in
  [providers/bakers/](../../src/client/providers/bakers/) (no fixed
  interface, follow the existing ones).
- **`DependencyProvider`** — injects services (`renderer`, `soundManager`)
  into components via the `componentDependencies` map.

## SoundManager

[src/client/SoundManager.js](../../src/client/SoundManager.js) (built on
Howler.js). Sounds are described in `src/config/sounds.js`.

- **UI/system** (no position): `playSystemSound(name)` — plays instantly,
  bypassing priorities (also used for port 6 sounds).
- **Spatial** (positioned in the world): `registerSound(name, { position
  })` → `processAudibility()` → `updateActiveSounds()` — the manager
  decides what's audible on its own, honoring a voice limit
  (`WORLD_VOICE_LIMIT = 30`) and priorities from the config.

## InputListener

[src/client/InputListener.js](../../src/client/InputListener.js) — low-level
keydown/keyup capture for Controls; `modes`/`cmds` take priority over the
game key set.

## UI hierarchy (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) →
`game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9).
The lobby (`#lobby`, z-index 8) is the starting server-selection screen,
shown before connecting to a host and hidden once the game starts.

---

[← Previous: Rust Core](core.md) · [Next: Network Protocol →](network.md)
