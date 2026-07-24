# VIMP engine Documentation

A multiplayer 2D real-time online game on a P2P architecture: a browser host
(Web Worker + Rust core in WASM) runs the authoritative simulation, PixiJS
clients connect over WebRTC, and a Node.js master server handles the lobby
and signaling.

## Sections

| Page | Covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Local setup: install, Rust toolchain, HTTPS certificates, running, tests, local multiplayer |
| [architecture.md](architecture.md) | Overall architecture: master/host/client, game loop, connection lifecycle, key invariants |
| [gameplay.md](gameplay.md) | Gameplay: rounds, teams, stats, votes, chat commands, controls, weapons, bots, kicks |
| [master.md](master.md) | Master server (entry point): room registry, `GET /servers`, map catalog, WebRTC signaling, `/ban` |
| [auth.md](auth.md) | Central auth service (`packages/auth/`): OAuth login, global nick, JWT/JWKS, per-game rank/state |
| [host.md](host.md) | Browser host: Worker with the core, `GameCoreAdapter`, the host facade, meta modules, host-player loopback, main-thread router |
| [core.md](core.md) | Rust simulation core: `core/` layout, ABI (commands/events/frames), WASM build, tests |
| [client.md](client.md) | Client modules: MVC components, client core (interpolation/prediction/shot spawning), rendering, sound |
| [network.md](network.md) | Host↔client sync: WebRTC channels, port protocol, binary snapshot frame (v3), data formats, RTT |
| [configuration.md](configuration.md) | Configuration: `.env` variables, every file under `packages/engine/src/config/`, `games/tanks/src/data/` |
| [extending.md](extending.md) | Extending the game: new maps, weapons, sounds, client entities |
| [deployment.md](deployment.md) | Deployment: VPS setup, adding/removing servers, CI/CD |
| [plugin-api.md](plugin-api.md) | Engine ↔ game plugin contracts (draft): GameManifest, HostPlugin, ClientPlugin, Wasm ABI, snapshot schema, versioning |

## Where to start

- **I want to run it locally** → [getting-started.md](getting-started.md)
- **I want to understand how it works** → [architecture.md](architecture.md), then [host.md](host.md) / [client.md](client.md) / [network.md](network.md)
- **I want to host my own server** → [deployment.md](deployment.md)
- **I want to add a map/weapon** → [extending.md](extending.md)

> Documentation is maintained alongside the code: whenever functionality changes, the relevant page is updated in the same change (a rule codified in [CLAUDE.md](../../CLAUDE.md)).
