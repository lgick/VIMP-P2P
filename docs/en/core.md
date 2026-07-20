# Rust Simulation Core (packages/engine/core + games/tanks/core)

A cargo workspace of two crates: physics, the fixed-step tick, snapshot
framing, interpolation/predict/raycast primitives, and nav utilities are
generic engine code (`vimp-engine-core`, rlib, **no wasm-bindgen**); tanks,
weapons, bots, and the wasm-bindgen ABI (`GameCore`/`ClientCore`) live in the
game crate (`vimp-tanks-core`, cdylib+rlib), which depends on the engine
crate. The engine crate can't import anything game-specific — a second game
would add its own crate next to `games/tanks/core`, reusing
`vimp-engine-core` unchanged. The core runs on the browser host (`GameCore`,
[host.md](host.md)) **and on every client** (`ClientCore` — client-side
math: interpolation, prediction, visual shot spawning, frame decoding).

**The core's boundary is simulation, not meta**: chat, votes, stats, the
panel, round orchestration, the participant registry, and auth stay in JS.
Meta drives the core with commands and feeds on its events.

## Layout

```
Cargo.toml                        # workspace: packages/engine/core, games/tanks/core
packages/engine/core/             # vimp-engine-core — rlib, no wasm-bindgen
├── Cargo.toml                    # rapier2d (enhanced-determinism, serde) — no wasm-bindgen
├── src/
│   ├── lib.rs                    # pub mod declarations only
│   ├── sim.rs                    # GameDef/GameSim/SimCtx — the engine↔game trait boundary
│   ├── game.rs                   # EngineSim<G> — tick, contacts, destroy queue, handoff
│   ├── abi.rs                    # export_game_core_abi!/export_client_core_abi! — the
│   │                              #   wasm-bindgen boilerplate macros (see ABI sections below)
│   ├── map.rs                    # GameMap — static/dynamic bodies, map scaling
│   ├── snapshot.rs                # SnapshotPacker + Block — packs the v3 binary frame;
│   │                              #   Block is generic by shape (Indexed8/Indexed32/
│   │                              #   List16/IndexedNoNull8), not by game entity — the
│   │                              #   engine doesn't know "tank" or "bomb", only row shape
│   ├── events.rs                  # CoreEvent — the standard event dictionary for JS meta
│   ├── config.rs                  # EngineConfig/EngineClientConfig + snapshot schema types
│   │                              #   (BlockKind is a row-shape enum, not a game-entity enum)
│   ├── physics.rs                 # map-object body tag (encode_map_object/is_map_object),
│   │                              #   rounding, angles — game body tags (player/shot) live
│   │                              #   in games/tanks/core/src/body_tag.rs
│   ├── rng.rs                     # deterministic PRNG (SplitMix64)
│   ├── nav/                       # generic bot-adjacent utilities (no "bot" naming)
│   │   ├── navigation.rs         # nav grid + graph + line-of-sight (NavigationSystem)
│   │   ├── pathfinder.rs         # A*
│   │   └── spatial.rs            # spatial grid for target search
│   └── client/                    # generic client-side primitives + orchestration
│       ├── game.rs                # GameClientDef trait + generic ClientState<G> — the
│       │                          #   sample() pipeline, the hot buffer, frame queue;
│       │                          #   the game supplies prediction/shot-spawn via the trait
│       ├── unpack.rs              # the v3 frame decoder + JSON forms
│       ├── interpolator.rs        # the snapshot buffer, seq, lerp (schema-driven)
│       └── raycast.rs             # DDA over tiles + an OBB slab test
└── (no wasm ABI here — see games/tanks/core/src/lib.rs)

games/tanks/core/                 # vimp-tanks-core — cdylib+rlib, depends on vimp-engine-core
├── Cargo.toml                    # + wasm-bindgen, path-dep on ../../../packages/engine/core
├── src/
│   ├── lib.rs                    # the public ABI (wasm-bindgen): GameCore + ClientCore
│   ├── body_tag.rs                # BodyTag (Player/Shot body user_data) — game-only;
│   │                              #   reserves tag byte 1 for the engine's map-object tag
│   ├── tanks.rs                   # TanksSim (impl GameSim), TanksGame, GameState alias
│   ├── tank.rs                    # Tank — movement, turret, health/ammo/cooldowns
│   ├── motion.rs                  # shared mass-free motion formulas: one code path for
│   │                              #   the authoritative side (Rapier impulses) and the predictor replica
│   ├── bomb.rs                    # Bomb — the projectile body (detonation lives in tanks.rs)
│   ├── config.rs                  # ModelConfig/WeaponConfig/TanksConfig/TanksClientConfig
│   ├── bots/
│   │   └── controller.rs         # BotBrain — bot AI (input is generated inside the core)
│   └── client/                    # the core's client mode: TanksClient (impl GameClientDef)
│       ├── mod.rs                 # TanksClient — wires Predictor/ShotPredictor into the
│       │                          #   engine's generic ClientState<TanksClient>
│       ├── predictor.rs           # the motion replica built on motion.rs
│       └── shot.rs                # gates, dedup, the raycast world
├── tests/
│   └── sim.rs                     # integration simulation scenarios (cargo test)
├── pkg-web/                       # the browser/Worker build (generated, not in git)
└── pkg-node/                      # the Node.js/Vitest build (generated, not in git)
```

## Build

Requires the Rust toolchain (see [getting-started.md](getting-started.md#rust-toolchain-the-core-core)):

```bash
npm run core:build        # both targets (web + nodejs)
npm run core:build:web    # browser/Worker → games/tanks/core/pkg-web/
npm run core:build:node   # Node.js (tests) → games/tanks/core/pkg-node/
npm run core:test         # cargo test --workspace (both crates)
```

`npm run build` includes `core:build:web`: the WASM binary is needed by both
the host's Worker and the client (a single asset in the Vite build).

## ABI: commands, events, frames

Two classes are exported: **`GameCore`** (the host's authoritative
simulation) and **`ClientCore`** (client mode, see below). Init data is
passed as JSON strings, shaped `{engine: {...}, game: {...}}` — the engine
half (`vimp_engine_core::config::EngineConfig`) is generic, the game half
(`TanksConfig`) is parsed by the game crate. The `GameCore` config is
assembled by `packages/engine/src/lib/coreConfig.js` (`buildCoreConfig()`),
and maps are exported to JSON via the `npm run maps:export` script (a step
shared with serving maps without a client rebuild).

The wasm-bindgen boilerplate for both classes (mechanical 1:1 delegations
into the generic `EngineSim<G>`/`ClientState<G>`) is generated by two
macros in `packages/engine/core/src/abi.rs` — `export_game_core_abi!` and
`export_client_core_abi!` — the single source of truth for the required
method set, so the game crate can't silently drift from it. The game crate
calls each macro next to its own additional methods (`try_fire`,
`set_model`, `sync_panel`, `spawn_actor`'s custom args); `new` (config
parsing) and non-`#[wasm_bindgen]` test accessors stay hand-written.

```js
import { buildCoreConfig } from '../packages/engine/src/lib/coreConfig.js';
const { GameCore } = require('../games/tanks/core/pkg-node/vimp_tanks_core.js'); // nodejs target

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // scaling happens inside the core
```

### Commands

| Method | Purpose |
| --- | --- |
| `new GameCore(config_json)` | the Rapier world, weapons, models, keys, the snapshot-key registry |
| `load_map(map_json)` | map bodies + bots' nav graph; scale — the map's `scale` or the config's `mapScale` |
| `map_info()` | JSON: `setId`, `step`, dimensions, scaled `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | a tank; emits `panelActive` + `panelSet(health)` |
| `remove_actor(id)` | removal + a null marker in the next frame |
| `reset_actor(id, teamId, x, y, angle°)` | respawn/team change (keys/throttle reset, health untouched) |
| `reset_all_vitals()` | health/ammo back to defaults (a new round) |
| `spawn_scripted_actor(id, model, teamId, x, y, angle°)` / `remove_scripted_actor(id)` | a tank + AI controller inside the core |
| `apply_input(id, seq, action, name)` | `'down'/'up'` input + key name; `seq` is confirmed in the player block |
| `step(dt)` | fixed physics steps + bot AI + the spatial grid |
| `clear()` | fully clears the world (a map change) |
| `remove_players_and_shots()` | a JSON array of names for clients to clear their canvas |
| `players_data()` | JSON `{ model: { id: [x,y,angle,gun,vx,vy,engineLoad,condition,size,team] } }` for the first frame (`FIRST_SHOT_DATA`); reads the cache, doesn't drain accumulators |
| `body_has_events()` | whether the last `pack_body()` carried event blocks (tracers/bombs/explosions/removals); the host's Worker uses it to classify the WebRTC channel (events → meta, positions → state) without changing `pack_body`'s signature |
| `serialize_state()` / `deserialize_state(dump)` | dumping/restoring the simulation for a Worker handoff; drain `pack_body()` before dumping |

### Events (`take_events()`)

A JSON array; the buffer clears on read. The standard engine dictionary
(Wasm Host ABI, `packages/engine/core/src/events.rs`) — `GameCoreAdapter._drainEvents`
routes it into meta by itself, with no game-side mediator: `panelSet`/
`panelActive` → Panel (`field` is the game's panel-schema key, not tied to
a specific weapon), `death` → RoundManager.reportKill, `shake` → per-user
camera shake in frame meta. `custom` is the only type outside the
dictionary, carrying game-specific meaning: the adapter drains it as-is
into `HostPlugin.onCoreEvent(data, services)` (tanks doesn't use it —
`onCoreEvent` is left unset):

```json
[
  { "type": "death", "victim": 2, "killer": 1 },
  { "type": "panelSet", "id": 2, "field": "health", "value": 60.0 },
  { "type": "panelSet", "id": 1, "field": "w1", "value": 199.0 },
  { "type": "panelActive", "id": 1, "field": "w2" },
  { "type": "shake", "id": 2, "intensity": 20, "duration": 200 }
]
```

Health and ammo are **the source of truth in the core**: the JS panel is a
projection of these events.

### Frames (v3, byte-for-byte with the decoder)

- `pack_body()` — the broadcast body, once per frame sent; it **drains**
  the snapshot's event accumulators (shots/explosions/removals accumulate
  in the core between sends — the send-rate throttle, `SnapshotThrottle`,
  stays on the JS side);
- `pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId)`
  — a per-user frame: header + camera + a player block (if `playerId >= 0`
  and the tank exists) + a copy of the body; returns its length;
- `frame_ptr()` — a pointer for zero-copy reads in the browser:
  `new Uint8Array(wasm.memory.buffer, ptr, len)` (memory comes from the
  web target's `init()`);
- `frame_bytes()` — a copy of the frame (the nodejs target doesn't expose
  its memory).

Frames are decoded by the client core (`games/tanks/vimp-engine-core's client/unpack.rs`) — the
packer and unpacker live in the same crate, so a layout mismatch is
impossible by construction; the shapes are locked in by round-trip tests
(`#[cfg(test)]` in `unpack.rs` plus `tests/core/core.test.js` and
`tests/core/clientCore.test.js`).

### State queries

`is_alive(id)`, `position_of(id)` (rounded to 2 decimals),
`last_input_seq(id)`, `alive_players()` (a flat array `[id, teamId, x, y, ...]`).

## ClientCore — the core's client mode

A second wasm-bindgen class from the same binary; lives in the main thread
of a client tab (for the host player, a second WASM instance sits next to
the Worker). `ClientCore` wraps
`vimp_engine_core::client::game::ClientState<TanksClient>`: the engine
crate owns the network buffer (`Interpolator`), the event-frame queue and
the hot-buffer write (`ClientState<G>` in `packages/engine/core/src/client/game.rs`);
`TanksClient` (`games/tanks/core/src/client/mod.rs`) implements the
`GameClientDef` trait — `Predictor`/`ShotPredictor` orchestration, own-tank
tracking, and the predicted render overlay. `export_client_core_abi!`
generates the engine-minimum wasm-bindgen methods below (all but
`set_model`/`try_fire`/`cycle_weapon`/`sync_panel`, which stay hand-written
in `games/tanks/core/src/lib.rs` since their shape is game-specific). The
trait's shape is validated by a fixture second client (`TestClient`, tests
in `packages/engine/core/src/client/game.rs`) before any real second game
exists. Its config is assembled by
[packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) from the
`prediction`/`interpolation` sections of CONFIG_DATA plus the bundled
`opcodes.js` registry; the `timeStepMs` field fixes the units (ms, unlike
`CoreConfig.timeStep` in seconds).

| Method | Purpose |
| --- | --- |
| `new ClientCore(config_json)` | models/weapons/keys + the snapshot-key registry + interpolation |
| `push_frame(bytes, localNow)` | decodes a frame, inserts into the buffer by `seq` (+dedup/late), reconciles the predictor from the player block; `false` — the frame was dropped (port/version/corrupt) |
| `my_game_id()` / `offset()` | one's own id from the player block (−1) / an EMA estimate of `serverTime − localNow` (NaN) |
| `sample(localNow)` | the entire render tick: emitting crossed frames (dedup filter → a JSON queue), interpolation, a predictor step; returns the hot buffer's length |
| `hot_ptr()` / `hot_values()` | a zero-copy pointer to the hot buffer (web) / a copy (nodejs) |
| `take_frames()` | event frames as a JSON string `[{game, camera}, …]` (the `applyShot` shape); the queue is cleared |
| `apply_input(action, key, localNow)` | records input into the predictor's history |
| `try_fire(localNow)` | a local visual shot; gates (cooldown/ammo/pending bomb/alive/active) are internal; returns spawn JSON or `undefined` |
| `cycle_weapon(back)` | a local weapon-cycle switch (authoritative confirmation comes via the panel) |
| `set_model(name)` / `set_active(bool)` / `set_map(json)` / `sync_panel(json)` / `reset()` | client port mirrors: auth, KEYSET, MAP_DATA, PANEL_DATA, CLEAR |
| `decode_frame(bytes)` | a plain v3 decode → the frame's JSON shape (tests/harness); `'null'` on a version mismatch |

**Hot buffer layout** (flat, reusable Float32):
`[0]` — flags (`HOT_FLAGS` in `opcodes.js`: game/camera/predicted/frames),
`[1..2]` — camera x/y (already resolved by the core: predicted position or
interpolated), `[3]` — the tank count N, followed by N×12
(`keyId, gameId, x, y, angle, gun, vx, vy, engineLoad, condition, size,
teamId`), then M dynamics × 5 (`keyId, index, x, y, angle`); the local
tank's predicted record comes last. This tail is written by the engine
verbatim from `GameClientDef::render_overlay`'s `RenderOverlay.tail` — the
engine only knows the camera (`RenderOverlay.camera`) and the presence flag,
not the tail's field layout (`TanksClient::render_overlay` builds it as the
same 12-value shape, so bytes are unchanged from before the trait split).
`keyId` — numeric ids from the game's snapshot schema
(`games/tanks/src/config/snapshot.js`); client JS reads the records
generically off the same schema (record width = 2 service fields + the
key's `fields` count).

**motion.rs** — shared mass-free tick formulas for motion (turret, throttle,
lateral grip, thrust/braking, engine load, turning): the authoritative side
(`Tank::update`) multiplies them by mass/inertia for Rapier impulses, while
the predictor replica integrates manually (position by velocity *before*
damping → `v *= 1/(1+dt·d)` — an empirically matched Rapier order). The
replica can't diverge from the authoritative path on formulas; integration
parity is locked in by the cargo tests `client::predictor::parity` (6
scenarios).
⚠️ **Any edit to motion in the core or `models.js` requires running
`npm run core:test`.**

## Determinism

- `rapier2d` is built with `enhanced-determinism` (bit-for-bit across
  platforms given identical input);
- all randomness (weapon spread, bot decisions) goes through a built-in
  SplitMix64 PRNG seeded from the config (`seed`), no `Math.random`;
- a handoff dump restores the simulation bit-for-bit (locked in by the
  `state_dump_restores_identical_simulation` tests in both Rust and JS).

## Tests

| Layer | Where | Covers |
| --- | --- | --- |
| Rust unit | `packages/engine/core/src/* + games/tanks/core/src/*` (`#[cfg(test)]`) | PRNG, BodyTag, frame layout, the nav grid, A*, the spatial grid; the client module: round-trip unpack, the interpolator (seq/dedup/late/lerp), the predictor (replay/visualError/freeze), shots (gates/dedup/RTT), raycast, the hot buffer |
| Predictor parity | `games/tanks/core/src/client/predictor.rs` (`mod parity`) | the predictor's motion replica against the Rapier world (6 scenarios) — **required to run for any edit to motion in the core or `models.js`** |
| Rust integration | `games/tanks/core/tests/sim.rs` | simulation scenarios: driving, walls, hitscan kills, friendly fire, a bomb, weapon switching, bots (patrol and combat), clears, handoff |
| JS↔WASM harness | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | the ABI on a real config/maps, frame round-trips via `decode_frame`; e2e for the client core: interpolation, seq reordering, predictor convergence with the core on a real config, try_fire and duplicate suppression |

`tests/core/` tests are part of `npm test` and **are skipped** if
`games/tanks/core/pkg-node/` isn't built (JS development is possible without the Rust
toolchain). CI builds the core and runs both layers of tests.

## Known technical quirks

- **A freshly created body enters the broad phase on the world's first
  step**: a shot fired the same tick as a spawn "misses" the target
  (tests use a warm-up `step`). Doesn't show up in real scenarios (a spawn
  at round start).
- `remove_actor` places a null removal marker in the next frame itself.

---

[← Previous: Browser Host](host.md) · [Next: Client Modules →](client.md)
