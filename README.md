# VIMP Tank Battle

A multiplayer 2D real-time online game: team-based tank battles played in rounds.

![game video](./.github/assets/video/game.gif?raw=true)

- **P2P**: the authoritative host is a Web Worker in the room creator's browser tab (a Rust simulation core compiled to WASM: Rapier 2D physics at ~120 Hz, bots, binary snapshots at 30 packets/sec); clients connect over WebRTC.
- **Master server**: Node.js + Express + `ws` — lobby, WebRTC signaling, map catalog.
- **Client**: PixiJS, snapshot interpolation, client-side prediction, procedural textures, spatial audio (Howler).
- **Gameplay**: two teams, hitscan bullets and bombs, bots, votes, chat, statistics.

## Quick start

```bash
git clone https://github.com/lgick/VIMP-Tank-Battle.git
cd VIMP-Tank-Battle
npm install
npm run core:build   # WASM core (needs the Rust toolchain: rustup + wasm-pack)
npm run dev
```

Development requires local HTTPS certificates (mkcert) and the Rust toolchain — see [docs/en/getting-started.md](docs/en/getting-started.md).

## Documentation

Full documentation lives in [docs/en/](docs/en/README.md):

- [Local setup](docs/en/getting-started.md)
- [Architecture](docs/en/architecture.md)
- [Gameplay](docs/en/gameplay.md)
- [Master server](docs/en/master.md) · [Browser host](docs/en/host.md) · [Rust core](docs/en/core.md)
- [Client modules](docs/en/client.md)
- [Network protocol](docs/en/network.md)
- [Configuration](docs/en/configuration.md)
- [Extending the game (maps, weapons, sounds)](docs/en/extending.md)
- [Deployment](docs/en/deployment.md)

[Русская версия](docs/ru/README.md)

## Interface

![interface](./.github/assets/images/face.png?raw=true)

## ❤️ Supporting the Project

If you find this project useful and want to support its development, starring the project on GitHub
is a great way to show your appreciation!

Donations are also welcome via Bitcoin. Every contribution helps sustain the project and is greatly
appreciated.

| Currency | Address                                      | QR Code                                                                                                                                            |
| :------- | :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BTC**  | `bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu` | <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu" alt="BTC QR Code" width="120"> |
