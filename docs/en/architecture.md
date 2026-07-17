# Architecture

VIMP P2P Tank Battle is a real-time multiplayer 2D game built on a **P2P
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

```
src/
  master/        — master server (entry point): room registry, REST,
                   signaling, map catalog (docs/master.md)
  host/          — browser host (docs/host.md)
    host.worker.js — Web Worker: WASM core + meta + port state machine + ~120 Hz loop
    HostGame.js  — host facade: wires meta modules, drives the core tick
    GameCoreAdapter.js — physics/bots/packing surface over GameCore
    HostBotManager.js  — thin bot registry (AI lives in the core)
    meta/        — JS meta running in the Worker: core/ (RoundManager, CommandProcessor,
                   VoteCoordinator), modules/ (Panel, Stat, Vote, chat/,
                   TimerManager, RTTManager), player/ (Participant/Human/Bot +
                   ParticipantManager), SocketManager
  client/        — browser client
    main.js      — port dispatcher, lobby/role selection, module init, render loop
    network/     — SignalingClient, WebRtcManager (offerer), HostController,
                   LoopbackTransport, HostConnectionManager (answerer)
    components/  — MVC triplets (Auth, Lobby, CanvasManager, Controls, Game,
                   Chat, Panel, Stat, Vote)
    parts/       — PixiJS entities and effects
    providers/   — BakingProvider (textures), DependencyProvider
    SoundManager.js / InputListener.js
  config/        — shared config (game, client, auth, sounds, wsports, opcodes,
                   lobby, master)
  data/          — static data: maps/, models.js, weapons.js
  lib/           — shared utilities: Publisher, factory, math, validators,
                   sanitizers, security, config, clientCoreConfig, …
core/            — Rust simulation core → WASM: physics, tanks, weapons, bots,
                   the snapshot codec, and client-side math — interpolation,
                   prediction, shot spawning (a client submodule, docs/core.md)
tests/           — Vitest (tests/host — host and meta; tests/core — JS↔WASM
                   core harness; tests/master, tests/client, tests/lib)
public/          — static assets (sounds)
scripts/         — helper scripts (audio processing, map export to JSON)
.github/         — CI/CD (test.yml, deploy.yml) and deployment scripts
```

`src/config/`, `src/data/`, and `src/lib/` form a **shared layer**: imported
by the master (Node.js), the host Worker, and the client (Vite bundle). This
guarantees the snapshot codec, math, validators, and model parameters stay
identical on every side.

The project originally revolved around an authoritative WS server; the
current P2P architecture (browser host + master server) is the result of a
completed migration — the legacy server has been fully removed.

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
    ├─ GameCore (WASM, core/)    — physics, weapons, bots
    ├─ GameCoreAdapter           — physics/bots/packing surface over the core
    └─ HostGame facade + meta     — RoundManager, ParticipantManager, Chat, Vote,
                                    Stat, Panel, TimerManager… (src/host/meta/)
```

**`HostGame`** is the facade: it wires the modules, drives the connection
lifecycle, and delegates the tick. Ownership tree:

```
HostGame (facade/wiring + core-driven tick)
 ├─ ParticipantManager   — the single registry of players and bots (source of truth)
 ├─ RoundManager         — rounds, team wipe, map changes, spectator↔active
 ├─ CommandProcessor     — chat commands (/name, /bot, /nr, /timeleft, /mapname)
 ├─ VoteCoordinator      — vote creation/cooldown/reset
 ├─ GameCoreAdapter      — the core: physics, Tank/Bomb/Hitscan, bots, packBody/packFrame
 ├─ Cold path: Panel, Stat, Chat, Vote (JSON, on change)
 ├─ TimerManager         — all timers  /  RTTManager — pings and kicks
 └─ HostBotManager       — bot participant registry (AI lives in the core)
```

**The core's boundary is simulation, not meta**: physics, tanks, both weapon
types, bots, and binary frame packing live in the core; health/ammo live
there too, and the panel is a projection of its events (`take_events()`:
kill/health/ammo/activeWeapon/shake). Meta (chat, votes, stats, rounds, the
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

- **Interpolation** (`core/src/client/interpolator.rs`): frames are buffered, the world renders in the past (`serverNow − 100 ms`); events are emitted exactly once, positions are interpolated.
- **Prediction** (`core/src/client/predictor.rs`): the local tank is simulated by a replica of the authoritative motion model (formulas shared with the core — `motion.rs`); the host confirms input (`lastInputSeq`), reconciliation replays unconfirmed input, and the discrepancy decays smoothly.
- **Client-side shot spawning** (`core/src/client/shot.rs`): a shot is seen and heard instantly; duplicates from the host are suppressed by author id.

The JS shell reads the render-tick result as a zero-copy flat Float32 buffer
from WASM memory (hot positions) and as a JSON string (rare event frames),
feeding both into the previous parse pipeline.

Rendering is built from MVC components + PixiJS entities (`parts/`) on two
canvases (`vimp`, `radar`); procedural textures are baked at startup.

## Key invariants

- **Source of truth for ports** — `src/config/wsports.js`; for snapshot keys and the binary format version — `src/config/opcodes.js`.
- **Motion replica parity**: authoritative motion (Rapier) and the client prediction replica share the tick formulas (`core/src/motion.rs`); integration parity is locked in by cargo tests (`client::predictor::parity`) — any edit to motion in the core or the `models.js` coefficients requires running `npm run core:test`.
- **A single numeric id space** for humans and bots; distinguished via `isBot`/`isNetworked`. The core operates on numeric ids, meta keys by string — the conversion happens at the `GameCoreAdapter` boundary.
- Every send to a client goes only through `SocketManager`.

---

[← Previous: Local Setup](getting-started.md) · [Next: Gameplay →](gameplay.md)
