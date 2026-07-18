# Extending the Game

Guides for adding content. General project rule: new entities follow the
existing style (there's no fixed contract — existing files serve as
templates), and every change ends with a green `npx eslint .` and `npm
test`, with the new code covered by tests.

## New map

1. Create `games/tanks/src/data/maps/<name>.js` following the existing ones (e.g.
   [pool_mini.js](../../games/tanks/src/data/maps/pool_mini.js)). Format:
   - `setId` — the map constructor's snapshot key (`c1`/`c2`);
   - `scale` — the map's scale;
   - `spriteSheet` — the tile image and frames `[x, y, w, h]`;
   - `layers` — tile distribution across render layers (1 — under tanks,
     2 — tank level, 3+ — above);
   - `physicsStatic` — tile numbers that act as walls (static physics and
     client-side raycasting are built from these);
   - `physicsDynamic` — dynamic physical objects (they move and are sent
     in the snapshot);
   - `step` — the tile size;
   - `respawns` — respawn points by team: arrays `[x, y, angle]`;
   - `map` — the tile matrix.
2. Register the map in
   [games/tanks/src/data/maps/index.js](../../games/tanks/src/data/maps/index.js) — the object's
   key becomes its name in votes and room settings. The master's map
   catalog reads the same data (a master restart refreshes what it
   serves).

## New weapon

There are two architecturally different types (see [core.md](core.md)):

- **Hitscan** (example `w1`): the hit is computed instantly by a ray
  (`castRay` in the core); there's no physical projectile, only the
  result.
- **Explosive** (example `w2`): a physical projectile (`Bomb`) is created
  in the Rapier world, lives through the physics cycle, is sent to the
  client as a snapshot entity, and detonates on a timer.

Steps:

1. Define the weapon in
   [games/tanks/src/data/weapons.js](../../games/tanks/src/data/weapons.js) (type, damage,
   cooldown, cost, etc.) — this data flows both into the core
   (`buildCoreConfig`) and to the client.
2. Implement the authoritative side in the Rust core (`core/src/`:
   `game.rs`, `tank.rs`, and, if needed, its own entity modeled on
   `bomb.rs`; block packing — `snapshot.rs`), following the existing
   weapon of the same type.
3. Create the client-side rendering in `games/tanks/src/client/parts/`.
4. Register the entity in `games/tanks/src/config/client.js`: `parts.gameSets`
   (snapshot key → classes) and `parts.entitiesOnCanvas` (class →
   canvas).
5. Register the weapon's snapshot keys (and its effects) in
   `SNAPSHOT_KEYS` in [packages/engine/src/config/opcodes.js](../../packages/engine/src/config/opcodes.js)
   — an unregistered key breaks frame packing. If the existing `kind`
   values don't fit the data shape, add a new block layout to
   `core/src/snapshot.rs` and mirror it in the client decoder
   `core/src/client/unpack.rs`, bumping the format version.
6. Pass the **author's id** as the last element of the event/entity data
   (like `shooterId` for `w1` and `ownerId` for `w2`) — the client core
   (`core/src/client/shot.rs`) uses it to suppress authoritative
   duplicates of client-side spawns; it supports `hitscan`/`explosive`
   automatically from the weapon config.
7. Add ammo to `games/tanks/src/config/game.js` (`panel`) and a panel key
   in `client.js` (`modules.panel`).

## New sound

1. Add an entry in [games/tanks/src/config/sounds.js](../../games/tanks/src/config/sounds.js):
   `file`, `priority`, `volume`, optionally `loop`.
2. Place the audio file in `public/sounds/` in both **`.webm` and
   `.mp3`** formats (the codec list — `codecList`).
3. Playback: UI/system sounds — `soundManager.playSystemSound(name)`;
   spatial ones — `registerSound(name, { position })` (voice limits and
   priorities are handled by `SoundManager`, see
   [client.md](client.md#soundmanager)).

## New client entity (part)

1. Create a class in `games/tanks/src/client/parts/` following the existing ones
   (`Tank`, `Bomb`, effects in `parts/effects/`) and export it from
   `parts/index.js` — it lands in the `Factory` registry.
2. Add it to `gameSets`/`entitiesOnCanvas` (`games/tanks/src/config/client.js`).
3. If it needs a procedural texture, add a baker in
   `games/tanks/src/client/bakers/` (follow the existing ones) and an
   entry in `bakedAssets`.
4. If it needs services (`renderer`, `soundManager`), add the class to
   `componentDependencies`.

Entities can be subclassed and shown on different canvases: for example,
a simplified radar class is created for the radar (like `MapRadar` from
`Map`).

## Tests

New code is covered by tests in `tests/` (the layout mirrors `packages/engine/src/` and `games/tanks/src/`).
Patterns — CLAUDE.md's Testing section: singletons through
`vi.resetModules()` + a dynamic import; core logic — Rust tests
(`cargo test`) + the JS↔WASM harness in `tests/core/`; host-facade
integration — `tests/host/HostGame.test.js` on top of the real
`pkg-node`. Changing the tank's motion model requires running the cargo
predictor-replica parity check (`npm run core:test`).

---

[← Previous: Configuration](configuration.md) · [Next: Deployment →](deployment.md)
