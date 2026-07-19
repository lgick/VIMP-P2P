# Rust Simulation Core (core/)

A single simulation core: physics, tanks, weapons, bots, and binary snapshot
packing are written in Rust and compiled to WASM. The core runs on the
browser host (`GameCore`, [host.md](host.md)) **and on every client**
(`ClientCore` — client-side math: interpolation, prediction, visual shot
spawning, frame decoding).

**The core's boundary is simulation, not meta**: chat, votes, stats, the
panel, round orchestration, the participant registry, and auth stay in JS.
Meta drives the core with commands and feeds on its events.

## Layout

```
core/
├── Cargo.toml            # rapier2d (enhanced-determinism, serde), wasm-bindgen
├── src/
│   ├── lib.rs            # the public ABI (wasm-bindgen): GameCore + ClientCore
│   ├── game.rs            # GameState — tick, damage, detonation, hitscan
│   ├── tank.rs            # Tank — movement, turret,
│   │                      #   health/ammo/cooldowns — in the core, not the panel
│   ├── motion.rs          # shared mass-free motion formulas: one code path for
│   │                      #   the authoritative side (Rapier impulses) and the predictor replica
│   ├── bomb.rs             # Bomb — the projectile body (detonation lives in game.rs)
│   ├── map.rs              # GameMap — map scaling
│   ├── snapshot.rs         # SnapshotPacker — packs the v3 binary frame
│   ├── events.rs           # CoreEvent — events for JS meta
│   ├── config.rs           # serde structs for init configs (CoreConfig + ClientConfig)
│   ├── physics.rs          # BodyTag (body user_data), rounding, angles
│   ├── rng.rs              # deterministic PRNG (SplitMix64)
│   ├── bots/                # bot AI
│   │   ├── controller.rs   # BotBrain — bot AI (input is generated inside the core)
│   │   ├── navigation.rs   # nav grid + graph (NavigationSystem)
│   │   ├── pathfinder.rs   # A*
│   │   └── spatial.rs      # spatial grid for target search
│   └── client/              # the core's client mode
│       ├── mod.rs           # ClientState — the sample() pipeline, the hot buffer
│       ├── unpack.rs        # the v3 frame decoder + JSON forms
│       ├── interpolator.rs  # the snapshot buffer, seq, lerp
│       ├── predictor.rs     # the motion replica built on motion.rs
│       ├── shot.rs          # gates, dedup, the raycast world
│       └── raycast.rs       # DDA over tiles + an OBB slab test
├── tests/
│   └── sim.rs             # integration simulation scenarios (cargo test)
├── pkg-web/               # the browser/Worker build (generated, not in git)
└── pkg-node/              # the Node.js/Vitest build (generated, not in git)
```

## Build

Requires the Rust toolchain (see [getting-started.md](getting-started.md#rust-toolchain-the-core-core)):

```bash
npm run core:build        # both targets (web + nodejs)
npm run core:build:web    # browser/Worker → core/pkg-web/
npm run core:build:node   # Node.js (tests) → core/pkg-node/
npm run core:test         # Rust core tests (cargo test)
```

`npm run build` includes `core:build:web`: the WASM binary is needed by both
the host's Worker and the client (a single asset in the Vite build).

## ABI: commands, events, frames

Two classes are exported: **`GameCore`** (the host's authoritative
simulation) and **`ClientCore`** (client mode, see below). Init data is
passed as JSON strings; the `GameCore` config is assembled by
`packages/engine/src/lib/coreConfig.js` (`buildCoreConfig()`), and maps are exported to JSON
via the `npm run maps:export` script (a step shared with serving maps
without a client rebuild).

```js
import { buildCoreConfig } from '../packages/engine/src/lib/coreConfig.js';
const { GameCore } = require('../core/pkg-node/vimp_core.js'); // nodejs target

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // scaling happens inside the core
```

### Commands

| Method | Purpose |
| --- | --- |
| `new GameCore(config_json)` | the Rapier world, weapons, models, keys, the snapshot-key registry |
| `load_map(map_json)` | map bodies + bots' nav graph; scale — the map's `scale` or the config's `mapScale` |
| `map_info()` | JSON: `setId`, `step`, dimensions, scaled `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | a tank; emits `activeWeapon` + `health` |
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

A JSON array; the buffer clears on read. Fuel for RoundManager (`kill`),
Panel (`health`/`ammo`/`activeWeapon`), and the frame-side meta (`shake`):

```json
[
  { "type": "kill", "victim": 2, "killer": 1 },
  { "type": "health", "id": 2, "value": 60.0 },
  { "type": "ammo", "id": 1, "weapon": "w1", "value": 199.0 },
  { "type": "activeWeapon", "id": 1, "weapon": "w2" },
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

Frames are decoded by the client core (`core/src/client/unpack.rs`) — the
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
the Worker). Its config is assembled by
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
tank's predicted record comes last (12 values, the same shape — it
overrides the interpolated one). `keyId` — numeric ids from `SNAPSHOT_KEYS`.

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
| Rust unit | `core/src/*` (`#[cfg(test)]`) | PRNG, BodyTag, frame layout, the nav grid, A*, the spatial grid; the client module: round-trip unpack, the interpolator (seq/dedup/late/lerp), the predictor (replay/visualError/freeze), shots (gates/dedup/RTT), raycast, the hot buffer |
| Predictor parity | `core/src/client/predictor.rs` (`mod parity`) | the predictor's motion replica against the Rapier world (6 scenarios) — **required to run for any edit to motion in the core or `models.js`** |
| Rust integration | `core/tests/sim.rs` | simulation scenarios: driving, walls, hitscan kills, friendly fire, a bomb, weapon switching, bots (patrol and combat), clears, handoff |
| JS↔WASM harness | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | the ABI on a real config/maps, frame round-trips via `decode_frame`; e2e for the client core: interpolation, seq reordering, predictor convergence with the core on a real config, try_fire and duplicate suppression |

`tests/core/` tests are part of `npm test` and **are skipped** if
`core/pkg-node/` isn't built (JS development is possible without the Rust
toolchain). CI builds the core and runs both layers of tests.

## Known technical quirks

- **A freshly created body enters the broad phase on the world's first
  step**: a shot fired the same tick as a spawn "misses" the target
  (tests use a warm-up `step`). Doesn't show up in real scenarios (a spawn
  at round start).
- `remove_actor` places a null removal marker in the next frame itself.

---

[← Previous: Browser Host](host.md) · [Next: Client Modules →](client.md)
