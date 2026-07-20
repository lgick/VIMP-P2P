# Локальная настройка

## Требования

- **Node.js 22** (CI использует Node 22), npm;
- **mkcert** — локальные HTTPS-сертификаты обязательны для разработки (сигнальный WebSocket работает по `wss://`, WebRTC требует secure context);
- **Rust-тулчейн** (`rustup` + `wasm-pack`) — для сборки WASM-ядра, которое грузят браузерный хост и клиент (см. [ниже](#rust-тулчейн-ядро-core)).

## Установка

```bash
git clone https://github.com/lgick/VIMP-P2P.git
cd VIMP-P2P
npm install
```

Репозиторий — npm workspaces: `packages/engine` (`@vimp/engine`, движок-приложение) и `games/tanks` (`@vimp/tanks`, игра-плагин). Корневые скрипты (`npm run dev`, `npm run build`) проксируют в `@vimp/engine`; граница «движок не импортирует игру» — игра грузится динамически в рантайме по `GameManifest` (см. [plugin-api.md](plugin-api.md)) — закреплена правилом ESLint.

## HTTPS-сертификаты (один раз)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Пути к сертификатам заданы в `packages/engine/src/config/master.js` (`httpsOptions`). В production сертификаты не нужны — мастер работает по HTTP за Nginx (см. [deployment.md](deployment.md)).

## Запуск

```bash
npm run core:build     # WASM-ядро (один раз; повторять при правках core/)
npm run game:build     # бандл игры-плагина, включая обработанные звуки (нужен ffmpeg)
npm run dev
```

Поднимается **мастер-сервер** на `https://localhost:3002` (лобби + сигналинг, [master.md](master.md)); ViteExpress отдаёт клиент рядом с Express-сервером, nodemon следит за `packages/engine/src/master`, `packages/engine/src/lib`, `packages/engine/src/config`, `games/tanks/src`.

Матч идёт через **браузерный хост** ([host.md](host.md)): в лобби «Создать сервер» поднимает Web Worker с Rust-ядром в текущей вкладке; остальные вкладки/машины заходят в комнату из списка серверов.

Остальные команды:

```bash
npm start              # production-запуск мастера (читает .env: VIMP_DOMAIN и др.)
npm run build          # прод-сборка (WASM-ядро + бандл игры-плагина, включая аудио + Vite bundle движка)
npm run build:app      # сборка только движка (Vite; ядро и игра-плагин уже собраны)
npm run core:build     # сборка Rust-ядра в WASM (web + nodejs; нужен Rust-тулчейн)
npm run core:test      # Rust-тесты ядра (cargo test)
npm run maps:export    # экспорт карт в JSON (games/tanks/dist/maps/) для мастера/ядра
npm run game:build     # сборка плагина @vimp/tanks (games/tanks/dist/, включая manifest.json)
npx eslint .           # линтер
npm test               # тесты (Vitest), одиночный прогон
npm run test:watch     # тесты в watch-режиме
npm run test:coverage  # покрытие
```

Переменные `.env` для production описаны в [configuration.md](configuration.md#переменные-окружения-env).

## Rust-тулчейн (ядро core/)

Браузерный хост грузит web-таргет ядра (`games/tanks/core/pkg-web/`), поэтому для игры и
прод-сборки (`npm run build` включает `core:build:web`) Rust-тулчейн обязателен.
Для чистой JS-разработки без запуска матча он не нужен — тесты ядра
пропускаются, если `games/tanks/core/pkg-node/` не собран.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # или: cargo install wasm-pack

npm run core:build            # сборка обоих WASM-таргетов
npm run core:test             # Rust-тесты
```

## Локальный мультиплеер

- Откройте несколько вкладок браузера — каждая станет отдельным игроком: одна создаёт сервер, остальные заходят из лобби.
- Ботов удобно добавлять чат-командой `/bot 5` (см. [gameplay.md](gameplay.md#чат-клавиша-c-и-команды)).
- Debug-режима нет; при необходимости реализуется отдельно.

## Тесты

Стек: **Vitest** + happy-dom (клиентские тесты) + coverage-v8. Конфиг `vitest.config.js` делит прогон на четыре проекта:

- `engine-node` — `tests/master`, `tests/host` (кроме игровых файлов ниже), `tests/lib`, `tests/config`, `packages/engine/tests/fixtures` (окружение node);
- `engine-client` — `tests/client` (кроме `tanksClientPlugin.test.js`, окружение happy-dom);
- `tanks` — `tests/host/hostPlugin.test.js`, `botCommand.test.js`, `TanksBotManager.test.js`, `tests/client/tanksClientPlugin.test.js`;
- `integration` — `tests/host/HostGame.test.js` + `tests/core/**` (реальное ядро, пропускается без собранного `games/tanks/core/pkg-node/`).

Тесты лежат в `tests/` и зеркалят структуру `packages/engine/src/` и `games/tanks/src/`. Интеграция host-фасада поверх реального ядра — `tests/host/HostGame.test.js`; JS↔WASM харнесс Rust-ядра — в `tests/core/` (см. [core.md](core.md)); Rust-тесты ядра гоняются отдельно (`npm run core:test`). `packages/engine/tests/fixtures/miniGame/` — самостоятельная вторая пара HostPlugin/ClientPlugin (fake-core, без WASM), доказывающая, что движок и его мета (Panel/Stat/RoundManager/CommandProcessor/…) работают с любой игрой, а не только с `@vimp/tanks` — `engine-node`/`engine-client` зелёные без единого собранного Rust-артефакта игры. Правило проекта: **любое изменение кода завершается зелёными `npx eslint .` и `npm test`**; при правке движения в ядре или `models.js` обязателен cargo-паритет реплики предикта (`npm run core:test`).

CI (`.github/workflows/test.yml`) — четыре независимых job: `lint` (только eslint); `engine` (`cargo test -p vimp-engine-core` + Vitest-проекты `engine-node`/`engine-client`, без сборки WASM вообще); `tanks` (`cargo test -p vimp-tanks-core` + `core:build:web` + Vitest-проект `tanks`); `integration` (`core:build` — оба таргета — + Vitest-проект `integration`).

---

[Следующая: Архитектура →](architecture.md)
