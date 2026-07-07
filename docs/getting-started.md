# Локальная настройка

## Требования

- **Node.js 22** (CI использует Node 22), npm;
- **mkcert** — локальные HTTPS-сертификаты обязательны для разработки (WebSocket работает по `wss://`).

## Установка

```bash
git clone https://github.com/lgick/VIMP-Tank-Battle.git
cd VIMP-Tank-Battle
npm install
```

## HTTPS-сертификаты (один раз)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Пути к сертификатам заданы в `src/config/server.js` (`httpsOptions`). В production сертификаты не нужны — сервер работает по HTTP за Nginx (см. [deployment.md](deployment.md)).

## Запуск

```bash
npm run dev
```

Откроется сервер на `https://localhost:3000` (ViteExpress отдаёт клиент рядом с Express-сервером; nodemon следит за `src/server`, `src/lib`, `src/config`, `src/data`).

Остальные команды:

```bash
npm start              # production-запуск (читает .env: VIMP_DOMAIN и др.)
npm run master:dev     # мастер-сервер P2P на https://localhost:3002 (см. docs/master.md)
npm run master:start   # production-запуск мастер-сервера
npm run build          # сборка (обработка аудио + Vite bundle)
npm run core:build     # сборка Rust-ядра в WASM (web + nodejs; нужен Rust-тулчейн)
npm run core:test      # Rust-тесты ядра (cargo test)
npm run maps:export    # экспорт карт в JSON (src/data/maps/json/) для ядра
npx eslint .           # линтер
npm test               # тесты (Vitest), одиночный прогон
npm run test:watch     # тесты в watch-режиме
npm run test:coverage  # покрытие
```

Переменные `.env` для production описаны в [configuration.md](configuration.md#переменные-окружения-env).

## Rust-тулчейн (ядро core/)

Для работы с Rust-ядром симуляции ([core.md](core.md)) нужны `rustup` и
`wasm-pack`; для чистой JS-разработки они **не обязательны** — тесты ядра
пропускаются, если `core/pkg-node/` не собран.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # или: cargo install wasm-pack

npm run core:build            # сборка обоих WASM-таргетов
npm run core:test             # Rust-тесты
```

## Локальный мультиплеер

- Откройте несколько вкладок браузера — каждая станет отдельным игроком.
- В dev-режиме `oneConnection` отключается автоматически (`src/server/main.js`), так что несколько соединений с одного IP допустимы. Если запускаете иначе — отключите `oneConnection: true` в `src/config/server.js`.
- Ботов удобно добавлять чат-командой `/bot 5` (см. [gameplay.md](gameplay.md#чат-клавиша-c-и-команды)).
- Debug-режима нет; при необходимости реализуется отдельно.

## Тесты

Стек: **Vitest** + happy-dom (клиентские тесты) + coverage-v8. Конфиг `vitest.config.js` делит прогон на два проекта:

- `node` — `tests/server`, `tests/master`, `tests/lib`, `tests/config`, `tests/core` (окружение node; Rapier WASM работает в тестах);
- `client` — `tests/client` (окружение happy-dom).

Тесты лежат в `tests/` и зеркалят структуру `src/`. Интеграционные — в `tests/server/integration/` (полный жизненный цикл VIMP с реальными модулями). JS↔WASM харнесс Rust-ядра — в `tests/core/` (пропускается без собранного `core/pkg-node/`, см. [core.md](core.md)); Rust-тесты ядра гоняются отдельно (`npm run core:test`). Правило проекта: **любое изменение кода завершается зелёными `npx eslint .` и `npm test`**; при правке `Tank.updateData`/`models.js` обязательны паритет-тесты `tests/server/TankPredictorParity.test.js` и `tests/core/` (serverParity/predictorParity).

CI (`.github/workflows/test.yml`) гоняет eslint, Rust-тесты ядра, сборку nodejs-таргета ядра и Vitest на каждый push/PR.
