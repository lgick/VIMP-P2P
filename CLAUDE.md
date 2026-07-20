# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

VIMP P2P — a multiplayer 2D real-time tank game on a P2P architecture. The
authoritative match runs in a Web Worker in the room creator's browser tab
(Rust simulation core compiled to WASM); clients render via PixiJS and
connect over WebRTC. A lightweight Node.js master server provides the lobby,
WebRTC signaling and map catalog.

## Documentation

Bilingual user docs live in `docs/en/` (canonical, ToC at
`docs/en/README.md`) and `docs/ru/` (identical structure, ToC at
`docs/ru/README.md`). **Rule**: any functional change updates the matching
`docs/en/` and `docs/ru/` pages in the same change. Area → page:

| Change | Page |
| --- | --- |
| ports, binary frame format, opcodes | `network.md` |
| `packages/engine/src/config/*`, env vars, `games/tanks/src/data/*` (balance) | `configuration.md` |
| master server `packages/engine/src/master/` | `master.md` |
| browser host `packages/engine/src/host/` (Worker, core adapter, meta, transport) | `host.md` |
| Rust core `core/` (ABI, events, build, tests) | `core.md` |
| client modules / parts / ClientCore | `client.md` |
| game rules (rounds, stats, votes, chat commands, controls) | `gameplay.md` |
| new maps/weapons/sounds — if the add-process itself changed | `extending.md` |
| deploy scripts, workflows, npm scripts | `deployment.md`, `getting-started.md` |

Root `README.md` is a short showcase linking into `docs/en/`; keep details
out of it.

## Commands

```bash
npm run dev              # master: lobby + signaling, https://localhost:3002
npm start                # production master (reads .env)
npm run build             # WASM core + audio + Vite bundle (needs Rust toolchain)
npm run build:app         # Vite + audio only (core already built)
npx eslint .              # lint
npm test                  # Vitest, single run
npm run test:watch
npm run test:coverage
npm run core:build        # WASM core, both targets (web + nodejs)
npm run core:build:node   # nodejs target only (for tests/core)
npm run core:test         # Rust core tests (cargo test)
npm run maps:export       # export maps to JSON
npm run game:build        # build @vimp/tanks plugin bundle -> games/tanks/dist/
```

Dev requires local HTTPS certs (`mkcert`, see `docs/en/getting-started.md`)
and a built WASM core (`npm run core:build`) before the first run.

## Architecture

- **Master** (`packages/engine/src/master/`) — Node.js entry point: room
  registry, `GET /servers`, map/worker-bundle catalogs, WebRTC signaling,
  `/ban` moderation. No game logic. Details: `docs/en/master.md`.
- **Browser host** (`packages/engine/src/host/`) — the authoritative match,
  running in a Web Worker: `host.worker.js`, `HostGame.js` facade,
  `GameCoreAdapter.js`, Worker-safe `meta/` modules (participants, rounds,
  votes, timers). Details: `docs/en/host.md`.
- **Rust core** (`core/`) — physics (`rapier2d`), tanks, weapons, bots, the
  binary frame codec, and client-side math (interpolation/prediction/shot
  spawning), compiled via wasm-pack to `pkg-web`/`pkg-node`. Public ABI:
  `GameCore` (host) and `ClientCore` (client) in `core/src/lib.rs`. Details:
  `docs/en/core.md`.
- **Client** (`packages/engine/src/client/`) — WebRTC transport, MVC
  component triplets (model/view/controller, Publisher pattern), PixiJS
  rendering parts in `games/tanks/src/client/parts/`. Details:
  `docs/en/client.md`.
- **`games/tanks/`** — the game-plugin workspace (`@vimp/tanks`), imported by
  the engine only through `packages/engine/src/gameRegistry.static.js`; the
  boundary is enforced by ESLint `no-restricted-imports` in both directions.

## Code Conventions

- ES modules throughout (`"type": "module"`)
- `camelCase` for variables/functions, `PascalCase` for classes,
  `UPPER_SNAKE_CASE` for constants
- No two consecutive uppercase letters in camelCase (ESLint-enforced;
  exceptions: `VX`, `VY`, `RTT`)
- `===` required, `let`/`const` only, curly braces required for all blocks
- Import order on edit: Node built-ins → npm packages → internal modules →
  relative paths
- Files/dirs prefixed with `_` are experimental scratch work, not committed
  to git — don't read, edit, or suggest changes to them unless the developer
  explicitly says otherwise
- `packages/engine/src/host/meta/` must stay Worker-safe: isomorphic APIs
  only (`Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`), no Node
  globals
- Comments explain *why*, not *what*; keep them short
- When adding a new entity/module with no existing template, follow the
  codebase's established style

## Testing

Vitest (+ happy-dom for client, `@vitest/coverage-v8`). Every change ends
with a green `npx eslint .` and `npm test`. Tests live under `tests/`,
mirroring `packages/engine/src/` and `games/tanks/src/` (not colocated with
source). `tests/core/` and `tests/host/HostGame.test.js` are
`describe.skipIf`-gated on `core/pkg-node/` being built, so `npm test` stays
green without the Rust toolchain. Rust-side: unit tests per module plus a
cargo motion-parity suite (`client::predictor::parity`) — run
`npm run core:test` after any change to core movement or `models.js`.

## Local Development

- Local multiplayer: open several browser tabs — one creates a room
  ("Create server" in the lobby), the rest join from the list
- Build the WASM core once before the first run: `npm run core:build`
- No debug mode exists; implement one separately if needed

## Deployment

CI/CD is in `.github/`; only the master server is deployed (Docker: Rust
stage builds `core/pkg-web`, Node stage builds the client, the runner starts
`packages/engine/src/master/main.js`). Production only, no staging. Details:
`docs/en/deployment.md`.
