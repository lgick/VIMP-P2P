# VIMP Tank Battle

Многопользовательская 2D онлайн реалтайм игра: командные танковые бои по раундам.

![game video](./.github/assets/video/game.gif?raw=true)

- **P2P**: авторитетный хост — Web Worker во вкладке создателя комнаты (Rust-ядро в WASM: Rapier 2D ~120 Гц, боты, бинарные снапшоты 30 пакетов/сек); клиенты подключаются по WebRTC.
- **Мастер-сервер**: Node.js + Express + `ws` — лобби, сигналинг WebRTC, каталог карт.
- **Клиент**: PixiJS, snapshot-интерполяция, client-side prediction, процедурные текстуры, пространственный звук (Howler).
- **Игра**: две команды, hitscan-пули и бомбы, боты, голосования, чат, статистика.

## Быстрый старт

```bash
git clone https://github.com/lgick/VIMP-Tank-Battle.git
cd VIMP-Tank-Battle
npm install
npm run core:build   # WASM-ядро (нужен Rust-тулчейн: rustup + wasm-pack)
npm run dev
```

Для разработки нужны локальные HTTPS-сертификаты (mkcert) и Rust-тулчейн — см. [docs/getting-started.md](docs/getting-started.md).

## Документация

Полная документация — в [docs/](docs/README.md):

- [Локальная настройка](docs/getting-started.md)
- [Архитектура](docs/architecture.md)
- [Игровой процесс](docs/gameplay.md)
- [Мастер-сервер](docs/master.md) · [Браузерный хост](docs/host.md) · [Rust-ядро](docs/core.md)
- [Клиентские модули](docs/client.md)
- [Сетевой протокол](docs/network.md)
- [Конфигурация](docs/configuration.md)
- [Расширение игры (карты, оружие, звуки)](docs/extending.md)
- [Развертывание](docs/deployment.md)

## Интерфейс

![interface](./.github/assets/images/face.png?raw=true)

## ❤️ Supporting the Project

If you find this project useful and want to support its development, starring the project on GitHub
is a great way to show your appreciation!

Donations are also welcome via Bitcoin. Every contribution helps sustain the project and is greatly
appreciated.

| Currency | Address                                      | QR Code                                                                                                                                            |
| :------- | :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BTC**  | `bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu` | <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu" alt="BTC QR Code" width="120"> |
