# Local Setup

## Requirements

- **Node.js 22** (CI uses Node 22), npm;
- **mkcert** — local HTTPS certificates are required for development (the signaling WebSocket runs over `wss://`, and WebRTC requires a secure context);
- **Rust toolchain** (`rustup` + `wasm-pack`) — to build the WASM core loaded by the browser host and the client (see [below](#rust-toolchain-the-core-core)).

## Install

```bash
git clone https://github.com/lgick/VIMP-P2P.git
cd VIMP-P2P
npm install
```

## HTTPS certificates (one-time)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Certificate paths are set in `src/config/master.js` (`httpsOptions`). Certificates aren't needed in production — the master runs over plain HTTP behind Nginx (see [deployment.md](deployment.md)).

## Running

```bash
npm run core:build     # WASM core (once; repeat after editing core/)
npm run audio:process
npm run dev
```

This starts the **master server** at `https://localhost:3002` (lobby + signaling, [master.md](master.md)); ViteExpress serves the client alongside the Express server, and nodemon watches `src/master`, `src/lib`, `src/config`, `src/data`.

Matches run through the **browser host** ([host.md](host.md)): "Create server" in the lobby spins up a Web Worker with the Rust core in the current tab; other tabs/machines join the room from the server list.

Other commands:

```bash
npm start              # production run of the master (reads .env: VIMP_DOMAIN, etc.)
npm run build           # production build (WASM core + audio processing + Vite bundle)
npm run build:app       # build without the core (audio + Vite; core already built)
npm run core:build      # build the Rust core to WASM (web + nodejs; needs the Rust toolchain)
npm run core:test       # Rust core tests (cargo test)
npm run maps:export     # export maps to JSON (src/data/maps/json/) for the core
npx eslint .             # linter
npm test                 # tests (Vitest), single run
npm run test:watch       # tests in watch mode
npm run test:coverage    # coverage
```

Production `.env` variables are described in [configuration.md](configuration.md#environment-variables-env).

## Rust toolchain (the core, core/)

The browser host loads the web target of the core (`core/pkg-web/`), so the
Rust toolchain is required to play and for the production build (`npm run
build` includes `core:build:web`). It isn't needed for plain JS development
without running a match — core tests are skipped if `core/pkg-node/` isn't
built.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # or: cargo install wasm-pack

npm run core:build            # builds both WASM targets
npm run core:test             # Rust tests
```

## Local multiplayer

- Open several browser tabs — each becomes a separate player: one creates the server, the rest join from the lobby.
- Bots are easiest to add with the chat command `/bot 5` (see [gameplay.md](gameplay.md#chat-c-key-and-commands)).
- There's no debug mode; implement one separately if needed.

## Tests

Stack: **Vitest** + happy-dom (client tests) + coverage-v8. `vitest.config.js` splits the run into two projects:

- `node` — `tests/master`, `tests/host`, `tests/lib`, `tests/config`, `tests/core` (node environment);
- `client` — `tests/client` (happy-dom environment).

Tests live in `tests/` and mirror the `src/` layout. Host-facade integration on top of the real core — `tests/host/HostGame.test.js`; the JS↔WASM harness for the Rust core — `tests/core/` (skipped without a built `core/pkg-node/`, see [core.md](core.md)); Rust core tests run separately (`npm run core:test`). Project rule: **any code change must end with a green `npx eslint .` and `npm test`**; editing motion in the core or `models.js` requires the cargo predictor-replica parity run (`npm run core:test`).

CI (`.github/workflows/test.yml`) runs eslint, the Rust core tests, the nodejs core-target build, and Vitest on every push/PR.

---

[Next: Architecture →](architecture.md)
