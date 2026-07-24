# Architecture

VIMP engine Tank Battle is a real-time multiplayer 2D game built on a **P2P
architecture**. **The host is authoritative**: all physics (Rapier 2D in the
Rust core, WASM), damage, and rules are computed in the Web Worker of the room
creator's tab; clients render the world (PixiJS) and mask network latency
with interpolation and prediction. The master server (Node.js) carries no
game logic: lobby, WebRTC signaling, map catalog, social moderation.

```
┌──────────────────┐  signaling WS (SDP/ICE, ping, /ban)   ┌──────────────────┐
│   Master server  │ ◄───────────────────────────────────► │      Client      │
│ Node.js: lobby,  │                                       │ PixiJS + Howler  │
│ GET /servers,    │ ◄───────────┐                         │ interpolation    │
│ map catalog      │             │ register_host,          │ (−100 ms),       │
└──────────────────┘             │ heartbeat               │ prediction       │
                                 │                         └────────┬─────────┘
                        ┌────────┴─────────┐   WebRTC DataChannels  │
                        │    Host tab      │  meta (reliable): JSON │
                        │ Worker: core+meta│  [port, payload] + ev- │
                        │ simulation ~120Hz│  ent frames             │
                        │ snapshots 30/sec │ ◄──────────────────────┘
                        └──────────────────┘  state (unreliable):
                                              positional frames (5);
                                              input "seq:action:name"
```

## Repository layout

This repository holds the **engine only** — the game (currently tanks) is a
separately published, dynamically loaded plugin package that lives in its
own repository (e.g. `vimp-tanks`) and is installed here as `@vimp/tanks`
under `node_modules/`; the engine never imports it statically (ESLint
`no-restricted-imports` enforces the boundary). See
[vimp-tanks/docs/en/architecture.md](https://github.com/lgick/vimp-tanks/blob/main/docs/en/architecture.md) for its own layout.

```
packages/engine/ — @vimp/engine: the engine application (npm workspace)
  index.html / vite.config.js — the engine's Vite root
  public/        — static assets (sounds, favicon)
  src/
    master/      — master server (entry point): room registry, REST,
                   signaling, map/game catalog (docs/master.md)
    host/        — browser host (docs/host.md)
      host.worker.js — Web Worker: dynamically loaded game core + meta + port
                   state machine + ~120 Hz loop
      HostGame.js — host facade: wires meta modules, drives the core tick
      GameCoreAdapter.js — physics/bots/packing surface over the game's core
      meta/      — JS meta running in the Worker: core/ (RoundManager, CommandProcessor,
                   VoteCoordinator), modules/ (Panel, Stat, Vote, chat/,
                   TimerManager, RTTManager), player/ (Participant/Human/Bot +
                   ParticipantManager), SocketManager
    client/      — browser client
      main.js    — port dispatcher, lobby/role selection, module init, render loop
      network/   — SignalingClient, WebRtcManager (offerer), HostController,
                   LoopbackTransport, HostConnectionManager (answerer)
      components/ — MVC triplets (Auth, Lobby, CanvasManager, Controls, Game,
                   Chat, Panel, Stat, Vote)
      providers/ — BakingProvider (bakers come from the game's ClientPlugin),
                   DependencyProvider
      SoundManager.js / InputListener.js
    config/      — engine config (hostDefaults, clientDefaults, wsports,
                   opcodes, lobby, master)
    lib/         — shared utilities: Publisher, factory, math, validators,
                   sanitizers, security, config, clientCoreConfig, …
  core/          — vimp-engine-core (Rust rlib): physics, the snapshot codec,
                   interpolation, frame unpacking, ABI macros (docs/core.md)
tests/           — Vitest projects: engine-node, engine-client,
                   integration (tests/host/HostGame.test.js + tests/core,
                   skipped unless a game plugin's WASM core is built/linked)
scripts/         — helper scripts (map export to JSON, etc.)
.github/         — CI/CD (test.yml, deploy.yml) and deployment scripts
```

`packages/engine/src/config/` and `packages/engine/src/lib/` form a **shared
layer**: imported by the master (Node.js), the host Worker, and the client
(Vite bundle). This guarantees the snapshot codec, math, validators, and
merge logic stay identical on every side; the game plugin supplies its own
data (models, weapons, maps) through the plugin contract, see
[plugin-api.md](plugin-api.md).

The project originally revolved around an authoritative WS server; the
current P2P architecture (browser host + master server) is the result of a
completed migration — the legacy server has been fully removed. The game
itself (formerly `games/tanks/` in this repo) was later split into its own
repository along the plugin-contract boundary described below.

## The host tab

The authoritative part of the match lives in a Web Worker (its timers aren't
throttled in a background tab); `RTCPeerConnection` lives in the main thread
(it can't be created inside a Worker), which acts as the packet router. The
host-player plays in the same tab through a postMessage loopback. This split
lets the Worker be replaced without dropping P2P connections — the basis for
**Worker handoff**: on deploy, a room migrates to a new worker bundle at a
round boundary, carrying its participants and score along.
See [host.md](host.md), the "Worker handoff" section, for details.

```
Host tab
├─ Main thread (client + router)
│   ├─ client (main.js)          — render, prediction, sound (a regular client)
│   ├─ HostController            — spawns the Worker, bridges Worker↔transport
│   ├─ LoopbackTransport         — host-player transport over postMessage
│   └─ HostConnectionManager     — WebRTC answerer for remote clients + backpressure
└─ Web Worker (host.worker.js)   — authoritative simulation ~120 Hz
    ├─ GameCore (WASM, from the game plugin, e.g. @vimp/tanks/core) — physics, weapons, bots
    ├─ GameCoreAdapter           — physics/bots/packing surface over the core
    └─ HostGame facade + meta     — RoundManager, ParticipantManager, Chat, Vote,
                                    Stat, Panel, TimerManager… (packages/engine/src/host/meta/)
```

**`HostGame`** is the facade: it wires the modules, drives the connection
lifecycle, and delegates the tick. Ownership tree:

```
HostGame (facade/wiring + core-driven tick)
 ├─ ParticipantManager   — the single registry of players and bots (source of truth)
 ├─ RoundManager         — rounds, team wipe, map changes, spectator↔active
 ├─ CommandProcessor     — chat commands (/name, /bot, /nr, /timeleft, /mapname)
 ├─ VoteCoordinator      — vote creation/cooldown/reset
 ├─ GameCoreAdapter      — the core: physics, game entities/weapons, bots, packBody/packFrame
 ├─ Cold path: Panel, Stat, Chat, Vote (JSON, on change)
 ├─ TimerManager         — all timers  /  RTTManager — pings and kicks
 └─ the game's scripted module (e.g. TanksBotManager, from the plugin; AI lives in the core)
```

**The core's boundary is simulation, not meta**: physics, tanks, both weapon
types, bots, and binary frame packing live in the core; health/ammo live
there too, and the panel is a projection of its events (`take_events()`'s
standard dictionary: panelSet/panelActive/death/shake/custom). Meta (chat, votes, stats, rounds, the
participant registry, auth) is JS running in the Worker.

### Game loop

`TimerManager` fires `onShotTick` at ~120 Hz (`timers.timeStep`). Per tick:

1. `GameCoreAdapter.updateData(dt)` — steps the core (physics + bots) and
   drains events into the meta layer (panel/reportKill/shake);
2. `SnapshotThrottle` — every `networkSendRate`-th tick (4 → **30 snapshots/sec**)
   a frame is sent, otherwise the tick ends here;
3. `packBody` (in the core) — the broadcast part of the frame is packed
   **once**;
4. for each user ready to play: `packFrame` (camera + the playing user's
   player block) → binary send (port 5; events → the `meta` channel, pure
   positions → `state`) + meta (panel/stat/chat/vote) over its own JSON
   channels **only on change**.

### Connection lifecycle

```
lobby → room selection → signaling (offer/answer/ICE) → meta+state channels
  → CONFIG → auth → createUser (spectator) → sendMap → mapReady
  → firstShotReady → joins the game loop
  → removeUser on disconnect (or a kick: idle / RTT; the host player is never kicked)
```

The host leaving kills the room (no host migration): clients return to the
lobby. Protocol and port details — [network.md](network.md).

## The client side

The client revolves around three network-smoothing mechanisms; all three
live in the client core — the `ClientCore` WASM class from the same Rust
binary (details — [client.md](client.md), ABI — [core.md](core.md#clientcore--the-cores-client-mode)):

- **Interpolation** (`packages/engine/core/src/client/interpolator.rs`): frames are buffered, the world renders in the past (`serverNow − 100 ms`); events are emitted exactly once, positions are interpolated.
- **Prediction** (game plugin core, e.g. `vimp-tanks`'s `core/src/client/predictor.rs`): the local entity is simulated by a replica of the authoritative motion model (formulas shared with the game's core); the host confirms input (`lastInputSeq`), reconciliation replays unconfirmed input, and the discrepancy decays smoothly.
- **Client-side shot spawning** (game plugin core, e.g. `vimp-tanks`'s `core/src/client/shot.rs`): a shot is seen and heard instantly; duplicates from the host are suppressed by author id.

The JS shell reads the render-tick result as a zero-copy flat Float32 buffer
from WASM memory (hot positions) and as a JSON string (rare event frames),
feeding both into the previous parse pipeline.

Rendering is built from MVC components + PixiJS entities (`parts/`) on two
canvases (`vimp`, `radar`); procedural textures are baked at startup.

## ADR: the engine is an application, the game is a dynamic plugin

**Status: accepted, migration complete.** The engine and the reference game
(tanks) now live in separate repositories, connected only through the
runtime plugin contract described in [plugin-api.md](plugin-api.md). A full
record of the migration stages lives in `plan/done/` (this repository) and
`plan/split_*.md`.

**Decision.** The project is split into an **engine** — an application
deployed once (master, P2P transport, Worker infrastructure and handoff,
meta *mechanisms*, client MVC framework, render/sound infrastructure, the
Rust framework crate) — and a **game** — a dynamic plugin (client/host JS
bundles, a WASM binary, assets) loaded by a manifest from the master.
Composition: this repository publishes `@vimp/engine` (npm) and
`vimp-engine-core` (Rust rlib crate); the game repository (e.g.
`vimp-tanks`) publishes `@vimp/tanks`, installed here as a regular
`node_modules` dependency, and its own `vimp-tanks-core` crate (cdylib +
wasm-bindgen wrappers), depending on `vimp-engine-core` and linked by traits
with static monomorphization. Engine meta modules
(Panel/Stat/Chat/Vote/Timer/RTT/Participant/Round/CommandProcessor) stay in
the engine, but **all their parameterization comes from the game config**.
The engine has no bots — only the neutral notion of a "scripted
participant".

**Rationale.** Other games can run on the same engine; one master can serve
several games; a game repository can ship on its own release cadence. A
dynamic plugin (rather than a build-time dependency) lets the engine deploy
once while games version independently (`codeVersion` is composite, a
mismatch triggers the Worker handoff).

For the historical per-file breakdown of what moved into the engine vs. the
game during the migration, see `plan/done/` in this repository's git
history — it's no longer reproduced here since the two trees have since
diverged independently.

## Key invariants

- **Source of truth for ports** — `packages/engine/src/config/wsports.js`; for the binary format version — `packages/engine/src/config/opcodes.js`; for snapshot keys — the game's own schema, supplied through `HostPlugin.gameConfig.snapshot` (see [plugin-api.md](plugin-api.md)).
- **Motion replica parity**: authoritative motion and the client prediction replica must share the tick formulas — this is a game-repository concern (e.g. `vimp-tanks`'s `core/src/motion.rs` + its cargo `client::predictor::parity` tests); the engine only provides the generic `Predictor<G>`/interpolation machinery.
- **A single numeric id space** for humans and scripted participants (bots); distinguished via `isScripted`/`isNetworked`. The core operates on numeric ids, meta keys by string — the conversion happens at the `GameCoreAdapter` boundary.
- Every send to a client goes only through `SocketManager`.

---

[← Previous: Local Setup](getting-started.md) · [Next: Master Server →](master.md)
