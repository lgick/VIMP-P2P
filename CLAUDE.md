# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language Rule

**СТРОГОЕ ПРАВИЛО**: Все ответы, пояснения, комментарии к коду и любые сообщения в ходе работы писать ИСКЛЮЧИТЕЛЬНО на русском языке. Это правило имеет наивысший приоритет и не имеет исключений.

## Project Overview

VIMP Tank Battle — a multiplayer 2D real-time online tank game. The server runs an authoritative physics loop; clients render via PixiJS and communicate over WebSocket.

## Documentation

Пользовательская документация проекта — многостраничный `docs/` (на русском, оглавление в `docs/README.md`):

- `docs/getting-started.md` — локальная настройка, запуск, тесты
- `docs/architecture.md` — обзорная архитектура, игровой цикл, жизненный цикл соединения
- `docs/gameplay.md` — правила игры: раунды, статистика, голосования, чат-команды, управление, боты
- `docs/server.md` — серверные модули (VIMP, менеджеры, Game/Rapier, parts, боты, инфраструктура)
- `docs/client.md` — клиентские модули (MVC, интерполяция, prediction, рендер, звук)
- `docs/network.md` — WS-протокол: порты, бинарный snapshot, форматы данных, RTT
- `docs/configuration.md` — `.env`, все `src/config/*`, `src/data/*`
- `docs/extending.md` — добавление карт, оружия, звуков, клиентских сущностей
- `docs/deployment.md` — развертывание VPS + CI/CD (перенесено из `.github/deployment/README.md`, там осталась ссылка)
- `docs/master.md` — мастер-сервер P2P (Этап 1 миграции): реестр комнат, REST-список серверов, сигналинг WebRTC

**СТРОГОЕ ПРАВИЛО актуализации**: при изменении функционала обновлять соответствующие страницы `docs/` в том же изменении. Соответствие «что менялось → что править»:

| Изменение | Страница docs/ |
| --- | --- |
| порты, бинарный формат кадра, кодек, форматы меты | `network.md` |
| конфиги `src/config/*`, env-переменные, `src/data/*` (баланс) | `configuration.md` |
| серверные модули/менеджеры/parts | `server.md` |
| клиентские модули/parts/предикторы | `client.md` |
| правила игры (раунды, статистика, голосования, команды чата, управление) | `gameplay.md` |
| новые карты/оружие/звуки — если изменился сам процесс добавления | `extending.md` |
| скрипты деплоя, workflows, npm-скрипты | `deployment.md`, `getting-started.md` |

Корневой `README.md` — краткая витрина со ссылками на `docs/`; детали туда не добавлять.

## Commands

```bash
# Development (nodemon watches src/server, src/lib, src/config, src/data)
npm run dev

# P2P master server (лобби + сигналинг; dev: https://localhost:3002)
npm run master:dev
npm run master:start

# Production
npm start

# Build (processes audio + Vite bundle)
npm run build

# Lint
npx eslint .

# Tests (Vitest)
npm test            # одиночный прогон
npm run test:watch  # watch-режим при разработке
npm run test:coverage
```

### Dev prerequisites

Local HTTPS certificates are required for development. ViteExpress serves the Vite-built client alongside the Express server.

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

In production, the server runs plain HTTP behind Nginx (which handles HTTPS). `.env` file controls runtime config (`VIMP_DOMAIN`, `VIMP_PORT`, `VIMP_PLAYERS`, `VIMP_MAP`, `VIMP_ROUND_TIME`, `VIMP_MAP_TIME`, `VIMP_FRIENDLY_FIRE`).

## Architecture

### Server (`src/server/`)

The game server is Node.js + Express + `ws` WebSockets + ViteExpress.

**`VIMP` (singleton)** in `src/server/modules/VIMP.js` is a **facade** (~530 строк): wiring + делегирование тика + жизненный цикл соединения (`createUser`/`removeUser`/`updateKeys`/`pushMessage`/`parseVote`/`sendMap`/`mapReady`/`firstShotReady`/`updateRTT`/`reportKill`/`triggerCameraShake`) + мост колбэков `TimerManager`/`RTTManager`. Бизнес-логика вынесена в отдельные менеджеры. VIMP владеет модулями:
- `ParticipantManager` (`src/server/player/`) — **единый источник истины об участниках** (игроки + боты): реестр, размеры команд, список активных, генерация id (единое числовое пространство), проверка имён, наблюдение. Участники — классы `Participant`/`HumanParticipant`/`BotParticipant`. Различение бот/человек — через геттеры `isBot`/`isNetworked`, не по формату id.
- `RoundManager` (`src/server/core/`) — раунды, команды, карты: `createMap`/`startRound`/`initiateNewRound`/`changeTeam`/`changeMap`/`changeName`/`checkTeamWipe`/`reportKill`/`setActive`/`setSpectator`. Владеет состоянием раунда/карты (`currentMap`, `currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`).
- `CommandProcessor` (`src/server/core/`) — парсинг чат-команд (`/name`, `/nr`, `/timeleft`, `/mapname`, `/bot`); `pushMessage` делегирует сюда.
- `VoteCoordinator` (`src/server/core/`) — создание/кулдаун/сброс голосований (`canCreateVote`/`createVote`/`reset`).
- `Game` — physics world (Rapier 2D, WASM: `@dimforge/rapier2d-compat`), players, weapons, map. WASM инициализируется top-level await в `src/server/physics/rapier.js` — единственной точке импорта Rapier (конструкторы остаются синхронными)
- `Panel` — per-player HUD data
- `Stat` — scoreboard (body rows + head totals, with configurable sort)
- `Chat` — messages (user + system templates)
- `Vote` — voting system with queue, cooldowns, pagination
- `TimerManager` — all game timers (round, map, vote, RTT ping, idle check)
- `SnapshotManager` — throttles physics snapshots before sending to clients
- `RTTManager` — ping/pong latency tracking and kick thresholds
- `Bots` — server-side AI (`src/server/modules/bots/`): BotController, NavigationSystem, Pathfinder, SpatialManager

**Game loop**: `TimerManager` fires `onShotTick` at ~120 Hz. Physics is stepped, a snapshot is optionally produced (controlled by `networkSendRate`), then the broadcast body is packed once via `SnapshotPacker.packBody`, per-user frames are built by `packFrame` and sent via `SocketManager.sendShot` (binary).

**`SocketManager`** (`src/server/socket/`) wraps WebSocket sends; wire messages are `[portId, payload]` JSON arrays (numeric IDs from `src/config/wsports.js`), except the snapshot channel (port `5`), which is binary (see WebSocket Protocol).

**User lifecycle**: connect → auth → `createUser` (spectator) → `sendMap` → `mapReady` → `firstShotReady` (ready for game loop) → `removeUser` on disconnect.

**Bots** функционально идентичны реальным игрокам, но с ограниченным набором действий. Данные участника-бота живут в `ParticipantManager` (общий реестр), `BotManager` отвечает только за `BotController`/`NavigationSystem`/`SpatialManager` и навигацию. `BotController` берёт данные через `ParticipantManager`/`BotManager`, **не читает приватные поля VIMP**. Боты и игроки делят единое числовое пространство id. Полная унификация ботов и игроков в одну абстракцию — цель на будущее.

### Client (`src/client/`)

Entry point: `src/client/main.js`. It opens a WebSocket and dispatches JSON messages to `socketMethods[portId]`; binary snapshot frames (port `5`) go to the interpolation buffer.

**Client-side prediction** (`src/client/TankPredictor.js`, Фаза 5b): свой танк симулируется локальной репликой серверной модели движения (`Tank.updateData` без Rapier-коллизий) фикс-шагом `timeStep`; ввод шлётся как `"seq:action:name"` и пишется в локальную историю. Сервер авторитетен: в per-user заголовке кадра v2 играющий получает **player-блок** (`gameId`, `lastInputSeq`, точное состояние танка) — reconciliation переигрывает историю ввода от `serverTime` кадра до оценки серверного «сейчас», расхождение уходит в `visualError` и экспоненциально затухает. Рендер: предсказанное состояние перекрывает интерполяцию (`renderTick` → `applyGameData` поверх), камера следует предсказанной позиции. Сбросы: `camera[2]` (respawn/телепорт), смена keySet, смена карты; при `condition 0` предикт заморожен. Параметры реплик клиент получает в конфиге порта 0 (`prediction`: timeStep/playerKeys/models/weapons — собирает `src/server/main.js`). **Точность реплики фиксирует паритет-тест** `tests/server/TankPredictorParity.test.js` (реальный Rapier против реплики) — при изменении `Tank.updateData` или коэффициентов `models.js` реплика обязана обновляться, тест это ловит. Порядок интеграции Rapier (эмпирический, закреплён паритетом): импульсы → интеграция позиций скоростью до демпфирования → damping `v *= 1/(1+dt·d)`.

**Клиентский спавн снарядов** (`src/client/ShotPredictor.js`, Фаза 5c): при нажатии fire трассер (`w1`) и бомба (`w2`) своего танка спавнятся немедленно (вместе со звуком), физика/урон/взрыв (`w2e`) — серверные. `tryFire` реплицирует серверный гейт (кулдаун `fireRate`, патроны из панели, активное оружие — локальный цикл `nextWeapon`/`prevWeapon` + авторитетный `'wa'` панели) и формулы `Tank.getMuzzlePosition`/`getFireDirection`; конечная точка трассера — приближённый raycast (`src/lib/raycast.js`: `rayVsGrid` DDA по тайлам стен + `rayVsBox` по динамике карты и танкам, позиции — из `updateWorld` по интерполированным кадрам). Результат уходит в обычный `applyGameData`-конвейер. Серверные дубли своих выстрелов подавляются в `filterServerSnapshot` по id автора в данных события (`tracers[7]`, `bombs[5]`, кадр v3): трассеры — FIFO pending-очередь с таймаутом 2с, своя бомба — гейт (следующий `explosive`-выстрел блокируется до серверного подтверждения, исключая FIFO-рассинхрон при высоком RTT); при подтверждении локальная сущность (`L<n>`) убирается, серверная становится авторитетной. Бомба с локальным ключом `L<n>` не пересекается с base36-ключами сервера. Позиция бомбы RTT-компенсирована при спавне: `spawnX = x + vx × (RTT/2)`, оценка через `interpolator.offset`, обновляется из рендер-тика через `setServerOffset`.

**Snapshot-интерполяция** (`src/client/SnapshotInterpolator.js`): кадры порта `5` не применяются немедленно, а буферизуются; рендер-цикл на `Ticker.shared` (`renderTick` в `main.js`) каждый rAF вызывает `sample()` — мир рендерится в прошлом (`renderTime = serverNow − delay`, серверное время оценивается EMA-оффсетом). Пересечённые `renderTime` кадры выдаются целиком **ровно один раз** (события `w1`/`w2e`, создания/удаления, reset/shake камеры), а позиции танков (`m1`), динамики карты (`c1`/`c2`) и камеры интерполируются (`lerp`/`lerpAngle` из `src/lib/math.js`) между соседними кадрами; классификация ключей — по `kind` из `SNAPSHOT_KEYS`. Настройки — `interpolation` в `src/config/client.js` (`delay: 100`); частота отправки снапшотов — `networkSendRate: 4` (30 пакетов/сек). Экстраполяции нет (hold на последнем кадре); буфер сбрасывается при смене карты и `clear`. Первый кадр (порт `4`) применяется немедленно, минуя буфер.

**MVC triplets** in `src/client/components/`: each game feature (Auth, CanvasManager, Controls, Game, Chat, Panel, Stat, Vote) has a `model/`, `view/`, and `controller/` file.

Publisher-паттерн внутри MVC-тройки:
- `main.js` или `view` → методы `controller` вызываются **напрямую**
- `controller` → методы `model` вызываются **напрямую**
- `model` → методы `view` вызываются **через `Publisher`** (model публикует событие, view подписана)
- На модель могут подписываться и внешние подписчики (не только view)
- `Publisher` допустимо использовать везде, где это удобно и улучшает читаемость

**CanvasManager** управляет несколькими PixiJS `Application` одновременно:
- `vimp` — основной игровой canvas (все игровые сущности)
- `radar` — упрощённый вид `vimp` (мини-карта); данные с сервера могут поступать в оба canvas

**Rendering parts** in `src/client/parts/`: entity classes (`Tank`, `Map`, `Bomb`, `Tracks`, etc.) rendered on PixiJS `Application` instances. Танк один — `parts/Tank.js` (свой танк перекрывается предсказанием тем же конвейером, разделение Local/Remote не понадобилось). Effects (explosions, smoke, tracers) are in `parts/effects/` и анимируются на `Ticker.shared`. При создании новой `part` смотреть на существующие как образец — фиксированного контракта нет.

**Texture baking** (`src/client/providers/BakingProvider.js`): procedural textures are generated once at startup using `bakers/` and cached. `DependencyProvider` injects renderer/soundManager into entities. При создании нового baker-а ориентироваться на существующие файлы в `bakers/` — фиксированного интерфейса нет.

**`Factory`** (`src/lib/factory.js`): registry that maps entity names (e.g. `'tank'`, `'bullet'`) to their constructor classes. `GameCtrl.parse(name, data)` creates/updates/removes entity instances based on incoming snapshot data.

### Shared

- **`src/config/`** — shared config consumed by both server (Node.js) and client (Vite bundler): `game.js`, `client.js`, `auth.js`, `server.js`, `sounds.js`, `wsports.js`, `opcodes.js` (реестр ключей бинарного снапшота + версия формата).
- **`src/lib/`** — utilities: `Publisher` (observer), `AbstractTimer`, `factory`, `math`, `formatters`, `sanitizers`, `validators`, `security`, `snapshotCodec` (бинарный кодек snapshot-кадра: `SnapshotPacker` для сервера, `unpackFrame` для клиента), `vec2` (2D-вектор `Vec2` + `rotateVec`; серверная физика/боты, в перспективе — клиентский prediction).
- **`src/data/`** — static game data: `maps/` (tiled map definitions with respawns + physics bodies), `models.js`, `weapons.js`.
- **`src/server/player/`** — единый реестр участников: `Participant`/`HumanParticipant`/`BotParticipant`, `ParticipantManager`.
- **`src/server/core/`** — менеджеры, выделенные из VIMP: `RoundManager`, `CommandProcessor`, `VoteCoordinator`.

### Master server (`src/master/`)

Мастер-сервер P2P-миграции (Этап 1 `P2P-PLAN.md`), отдельная точка входа `src/master/main.js` (`npm run master:dev`, порт 3002; конфиг `src/config/master.js`). Реестр комнат браузерных хостов (`HostRegistry`), REST `GET /servers` (поиск/регионы/пагинация), сигналинг WebRTC (`SignalingServer`: `register_host`, `webrtc_offer`/`webrtc_answer`, `ice_candidate`, `ping_host`/`pong_host`, `report_host`), rate limiting (`src/lib/rateLimiter.js`), origin-allowlist (`security.createOriginValidator`). Игровой логики нет; живёт параллельно `src/server/` до вехи демонтажа. Детали — `docs/master.md`.

### WebSocket Protocol

All messages except the snapshot channel: `[portId, payload]` serialized as JSON. Snapshot frames (port `5`) are binary.

Port IDs live in `src/config/wsports.js` (источник истины). Server→client ports: `0` config, `1` auth data, `2` auth result, `3` map, `4` first shot, `5` shot (game frame), `6` sound, `7` game inform, `8` tech inform, `9` MISC (свободен), `10` ping, `11` clear, `12` console (свободен), `13` panel, `14` stat, `15` chat, `16` vote, `17` keyset. Client→server ports: `0` config ready, `1` auth, `2` modules ready, `3` map ready, `4` first shot ready, `5` keys (формат `"seq:action:name"` — seq подтверждается сервером в player-блоке кадра), `6` chat, `7` vote, `8` pong.

**Разделение каналов (Фаза 3)**: горячий snapshot отделён от редкой меты. Кадр порта `5` несёт `[gameSnapshot, camera, serverTime, seq]` (broadcast snapshot + per-user камера; `serverTime`/`seq` — фундамент будущей интерполяции, клиент их пока сохраняет, но не использует). Мета шлётся своими каналами **только при изменении**: panel (`13`, per-user), stat (`14`, broadcast), chat (`15`), vote (`16`); keySet (смена режима спектатор↔игрок) — порт `17`, точечно при смене статуса. Кадровые методы `SocketManager` (`sendFirstShot`/`sendPlayerDefaultShot`/`sendSpectatorDefaultShot`/`sendFirstVote`) распадаются на отправки по этим каналам.

**Бинарный snapshot (Фаза 4) и интерполяция (Фаза 5a)**: кадр порта `5` передаётся бинарно (`DataView`, big-endian; ручной block-layout без библиотек). Кодек — `src/lib/snapshotCodec.js` (`SnapshotPacker.packBody` один раз/тик + `packFrame` per-user на сервере, `unpackFrame` на клиенте); реестр ключей снапшота и версия формата — `src/config/opcodes.js`. Раскладка (v3): `port(Uint8)`, `version(Uint8)`, `seq(Uint32)`, `serverTime(Float64)`, camera-блок (флаги + x/y + shake-строка), опциональный player-блок для играющего (`gameId`, `lastInputSeq`, состояние танка Float32×8 без округления + флаг центрирования башни — фундамент prediction), затем блоки сущностей (`m1`/`w1`/`w2`/`w2e`/`c1`/`c2`). События оружия несут id автора (v3, Фаза 5c): трассер `w1` — `[..., wasHit, shooterId]`, бомба `w2` — `[..., time, ownerId]` — по нему стрелок подавляет серверные дубли локально заспавненных выстрелов. Клиент различает форматы по типу `e.data` (string → JSON-диспетчер, `ArrayBuffer` → `unpackFrame` → буфер `SnapshotInterpolator`); несовпадение версии — кадр отбрасывается. Первый кадр (`FIRST_SHOT_DATA`, порт `4`, одноразовый) и `PING` остаются JSON. Снапшоты шлются с частотой `networkSendRate: 4` (30 пакетов/сек); плавность обеспечивает клиентская интерполяция (см. секцию Client).

## Client UI Components (z-index stacking)

`vimp` canvas (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `auth` (8) → `tech-informer` (9).

## Code Conventions

- ES modules throughout (`"type": "module"`)
- Именование: `camelCase` для переменных и функций, `PascalCase` для классов, `UPPER_SNAKE_CASE` для констант
- Нет двух заглавных букв подряд в camelCase (ESLint enforces this, exceptions: `VX`, `VY`, `RTT`)
- `===` required (`eqeqeq`)
- `let`/`const` only (`no-var`)
- Curly braces required for all blocks
- Files/dirs prefixed with `_` — **экспериментальные**, к проекту прямого отношения не имеют и **не коммитятся в git**. Игнорируются ESLint и Claude: не читать, не изучать, не редактировать, не предлагать изменения — если только разработчик явно не укажет иное в переписке
- **Тесты**: Vitest. Подробности и паттерны — в разделе [Testing](#testing)
- **Импорты**: при редактировании файла приводить к порядку: Node.js built-ins → npm пакеты → внутренние модули проекта → относительные пути
- **Качество кода**: чистота и читаемость важнее краткости. Хардкорные решения и хаки недопустимы. При спорных архитектурных решениях или выборе паттерна — уточнять у разработчика
- **Комментарии**: лаконичные, по сути. Объяснять *зачем*, а не *что*; без развёрнутых рассуждений и многострочных пояснений там, где хватает короткой строки
- Новые сущности (entity) выполнять в едином стиле с существующими; при отсутствии шаблона — придерживаться сложившегося стиля кодовой базы

## Testing

- **Обязательно**: после добавления или изменения кода проверять актуальность тестов и обновлять их — покрывать новый код тестами, править/удалять устаревшие. Любое изменение завершается зелёным `npx eslint .` + `npm test`.
- **Стек**: Vitest + happy-dom (клиент) + `@vitest/coverage-v8`. Конфиг `vitest.config.js` — два проекта: `node` (`tests/server`, `tests/lib`, `tests/config`, окружение node) и `client` (`tests/client`, окружение happy-dom). Интеграционные тесты лежат в `tests/server/integration/` и гоняются в node-проекте.
- **Запуск**: `npm test` (одиночный прогон), `npm run test:watch`, `npm run test:coverage`. CI: `.github/workflows/test.yml` гоняет `eslint` + тесты на каждый push/PR.
- **Расположение**: тесты в `tests/`, зеркалят структуру `src/` (не рядом с кодом). Файлы тестов имеют override в `eslint.config.js` (глобалы Vitest).
- **Покрыто** (~730 тестов): вся логика `lib/` (включая `security`, round-trip `snapshotCodec` и `raycast`); `SnapshotInterpolator`, `TankPredictor` и `ShotPredictor` (клиент) + **паритет-тест** `TankPredictorParity` (реплика движения против реального Rapier — обязателен к прогону при любой правке `Tank.updateData`/`models.js`); серверные модули с логикой (Stat, Vote, RTTManager, SnapshotManager, Panel, Chat, TimerManager, Pathfinder, SpatialManager, NavigationSystem, HitscanService, BaseModel, Bomb, Map, Tank, BotManager, BotController, SocketManager, Game, VIMP); реестр участников (`ParticipantManager`) и менеджеры из `core/` (`VoteCoordinator`, `RoundManager`, `CommandProcessor`); клиентские модели (Chat, Vote, Controls, Stat, Panel, Auth, Game, CanvasManager) + InputListener, SoundManager; клиентские контроллеры и view (все 8 — DOM через happy-dom); **интеграционный слой** (`tests/server/integration/`): полный жизненный цикл VIMP с реальными модулями + протокольный слой `socket/index.js`.
- **Не покрыто** (низкий ROI для unit-тестов): Pixi-`parts/`+`effects/`, провайдеры (`BakingProvider`/`DependencyProvider`).
- **Паттерны** (соблюдать при добавлении тестов):
  - **Синглтоны** (Game, Vote, Stat, Map, Panel, TimerManager, HitscanService, SnapshotManager, клиентские `*Model`, InputListener) изолируют через `vi.resetModules()` в `beforeEach` + динамический `await import(...)`.
  - **Rapier под Vitest работает** (WASM инициализируется top-level await в `src/server/physics/rapier.js`; реальные `World`/`RigidBodyDesc`/`ColliderDesc` доступны и в node-тестах; `vi.resetModules()` переинициализирует WASM без заметного замедления). НО синхронный бесконечный цикл в тестируемом коде вешает весь прогон — при зависании искать infinite loop в коде, а не в конфиге Vitest.
  - **Физические части** (Tank, Bomb, Map, Game) тестируются с моками `world`/`body`/`panel` (Rapier-имена: `createRigidBody`/`createCollider`/`translation`/`linvel`/`applyImpulse`/`castRay`/`collidersWithAabbIntersectingAabb`); реальная физика не симулируется. Дескрипторы — реальные (`RAPIER.RigidBodyDesc`/`ColliderDesc` из `physics/rapier.js`), геометрия проверяется по их полям (`desc.translation`, `collider.shape.halfExtents`).
  - **Тяжёлые синглтоны с громоздким конструктором** (VIMP) тестируются двумя способами: изолированные методы — через прототип `Class.prototype.method.call(fakeThis, ...)` (юнит); оркестрация — интеграционно (см. ниже).
  - **Интеграционные тесты** (`tests/server/integration/`): строят реальный VIMP со всеми реальными модулями + `FakeSocketManager` (пишет wire-кадры) через общий `harness.js`. Бинарные snapshot-кадры (`sendShot`) декодируются реальным `unpackFrame`: `lastShot` возвращает `[snapshot, camera, serverTime, seq]` — это даёт end-to-end покрытие бинарного пути. Критично: `vi.useFakeTimers()` ДО конструктора VIMP (тот стартует таймеры/игровой цикл); игровой цикл двигать прямыми `vimp._onShotTick(dt)`, а не `advanceTimers`; `process.nextTick`-колбэки (createUser, security.origin) ждать через `await nextTick()`. Протокольный слой (`socket/index.js`) тестируется через `vi.doMock('ws', ...)` + фейковый `ws`/`req` (origin `https://localhost:3000` проходит dev-allowlist). Детерминизм физики: ассертить факт/направление, а критичные исходы (kill) гнать через реальный `Game.applyDamage`.
  - Имя метода-мока с двумя заглавными подряд (например, из внешнего API) задавать вычисляемым/строковым ключом — иначе ESLint `no-consecutive-caps`.
- **Зафиксированные тестами поведенческие особенности** (не блокеры, но учитывать при доработках): `CanvasManager.resize` при `fixSize` отдаёт `height` строкой; `waiting.getNext` возвращает `undefined` (не `null`) при пустой очереди; `sanitizeMessage` — не XSS-защита (экранирование на выводе: `textContent` для текста, `setAttribute` для имени); удаляет только управляющие символы и возвращает `''` для не-строк; `validateAuth` непоследователен (ранний `return` для missing/non-string vs накопление ошибок валидаторов).

## Local Development

- Мультиплеер локально: открыть несколько вкладок браузера
- Если нужно несколько одновременных соединений с одного клиента, отключить `oneConnection: true` в `src/config/server.js` (по умолчанию разрывает предыдущее соединение при новом подключении)
- Debug-режима нет; при необходимости реализовать отдельно

## Deployment

- CI/CD конфигурация в `.github/`
- Только production-окружение (staging отсутствует)

## Sound System

Звуки описаны в `src/config/sounds.js`: каждый звук имеет `file` (имя файла без расширения), `priority` (выше = важнее при конкуренции), `volume`, опционально `loop: true`.

Воспроизведение через `src/client/SoundManager.js`:
- **UI/системные звуки** (не привязаны к позиции): `soundManager.playSystemSound(soundName)` — воспроизводится немедленно, в обход системы приоритетов.
- **Пространственные звуки** (привязаны к позиции в мире): `registerSound(soundName, { position })` → `processAudibility()` → `updateActiveSounds()`. `SoundManager` сам решает, какие звуки слышны, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и систему приоритетов.

Добавление нового звука: добавить запись в `src/config/sounds.js`, положить аудиофайл в `public/sounds/` в форматах `.webm` и `.mp3`.

## Adding a New Map

1. Create `src/data/maps/<name>.js` following the existing map format (layers, tiles, respawns, physicsStatic, physicsDynamic).
2. Export and register it in `src/data/maps/index.js`.
3. The map name becomes available in votes and via `VIMP_MAP` env var.

## Adding a New Weapon

Существует два архитектурно разных типа оружия:

**Hitscan** (пример: `w1` — пуля): попадание рассчитывается мгновенно лучом на сервере через `HitscanService`. Нет физического снаряда — только результат (куда попало).

**Explosive** (пример: `w2` — бомба): создаётся физический снаряд (`Bomb`) в мире Rapier. Живёт в физическом цикле, передаётся клиенту как сущность в снапшоте, взрывается по таймеру.

Шаги добавления нового оружия:
1. Определить оружие в `src/data/weapons.js`.
2. Выбрать тип (hitscan или explosive) и реализовать серверную часть в `src/server/parts/` по аналогии с существующим оружием того же типа.
3. Создать клиентский рендеринг в `src/client/parts/`.
4. Зарегистрировать сущность в `src/config/client.js` в `parts.gameSets` и `parts.entitiesOnCanvas`.
5. Зарегистрировать snapshot-ключи оружия (и его эффектов) в `SNAPSHOT_KEYS` в `src/config/opcodes.js` — незарегистрированный ключ уронит упаковку кадра (`SnapshotPacker.packBody` бросает ошибку). Если существующие `kind` не подходят под формат данных, добавить новую раскладку блока в `src/lib/snapshotCodec.js`.
6. Последним элементом данных события/сущности передавать id автора (как `shooterId` у `w1` и `ownerId` у `w2`) — по нему `ShotPredictor` подавляет серверные дубли клиентского спавна; типы `hitscan`/`explosive` он поддерживает автоматически по конфигу оружия.

## Known Issues / Future Tasks

- **Унификация ботов и игроков**: частично сделано — общий реестр `ParticipantManager` с единым числовым пространством id и классами `Human/BotParticipant`. Остаётся полностью объединить поведение (ввод от WebSocket vs AI) в одну абстракцию.
- **Debug-режим**: инструментов отладки нет, может потребоваться реализация.
