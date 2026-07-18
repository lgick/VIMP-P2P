# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language Rule

**СТРОГОЕ ПРАВИЛО**: Все ответы, пояснения, комментарии к коду и любые сообщения в ходе работы писать ИСКЛЮЧИТЕЛЬНО на русском языке. Это правило имеет наивысший приоритет и не имеет исключений.

## Работа по плану

**СТРОГОЕ ПРАВИЛО**: если задача выполняется по плану (например, `PLAN.md`), по завершении этапа фиксировать это в самом файле плана (пометка «✅ выполнен» у заголовка этапа). По плану всегда должно быть видно, на каком этапе находится работа.

## Коммиты

**СТРОГОЕ ПРАВИЛО**: не делать `git commit` самостоятельно. Коммиты делает разработчик. Изменения оставлять в рабочем дереве (staged или unstaged) — фиксацию в историю выполняет только пользователь.

## Project Overview

VIMP P2P — a multiplayer 2D real-time online tank game on a P2P architecture. The authoritative match runs in a Web Worker in the room creator's browser tab (Rust simulation core compiled to WASM); clients render via PixiJS and connect over WebRTC. A lightweight Node.js master server provides the lobby, WebRTC signaling and map catalog. Легаси авторитетный WS-сервер полностью демонтирован.

## Documentation

Пользовательская документация — двуязычный многостраничный `docs/`: английская версия (основная, `docs/en/`, оглавление в `docs/en/README.md`) и русская версия (`docs/ru/`, оглавление в `docs/ru/README.md`) с идентичной структурой страниц. Каждая контентная страница заканчивается пагинацией (ссылки «Предыдущая/Следующая» на соседние страницы своей локали); страницы одной локали ссылаются только друг на друга.

- `getting-started.md` — локальная настройка, Rust-тулчейн, запуск, тесты
- `architecture.md` — обзорная архитектура (мастер/хост/клиент), игровой цикл, жизненный цикл соединения
- `gameplay.md` — правила игры: раунды, статистика, голосования, чат-команды, управление, боты
- `master.md` — мастер-сервер (точка входа): реестр комнат, REST-список серверов, каталог карт, сигналинг WebRTC, `/ban`
- `host.md` — браузерный хост: Worker с ядром, `GameCoreAdapter`, host-фасад `HostGame`, мета-модули `src/host/meta/`, loopback хоста-игрока, роутер главного потока
- `core.md` — Rust-ядро симуляции: структура `core/`, ABI (команды/события/кадры), сборка WASM, тесты
- `client.md` — клиентские модули (MVC, интерполяция, prediction, рендер, звук)
- `network.md` — протокол: WebRTC-каналы, порты, бинарный snapshot, форматы данных, RTT
- `configuration.md` — `.env`, все `src/config/*`, `games/tanks/src/data/*`
- `extending.md` — добавление карт, оружия, звуков, клиентских сущностей
- `deployment.md` — развертывание VPS + CI/CD

**СТРОГОЕ ПРАВИЛО актуализации**: при изменении функционала обновлять соответствующие страницы `docs/en/` **и** `docs/ru/` в том же изменении. Соответствие «что менялось → что править»:

| Изменение | Страница docs/{en,ru}/ |
| --- | --- |
| порты, бинарный формат кадра, кодек, форматы меты | `network.md` |
| конфиги `src/config/*`, env-переменные, `games/tanks/src/data/*` (баланс) | `configuration.md` |
| мастер-сервер `src/master/` | `master.md` |
| браузерный хост `src/host/` (Worker, адаптер ядра, мета-модули, транспорт хоста) | `host.md` |
| Rust-ядро `core/` (ABI, события, сборка, тесты) | `core.md` |
| клиентские модули/parts/клиентское ядро (ClientCore) | `client.md` |
| правила игры (раунды, статистика, голосования, команды чата, управление) | `gameplay.md` |
| новые карты/оружие/звуки — если изменился сам процесс добавления | `extending.md` |
| скрипты деплоя, workflows, npm-скрипты | `deployment.md`, `getting-started.md` |

Корневой `README.md` (английский, со ссылкой на `docs/ru/README.md`) — краткая витрина со ссылками на `docs/en/`; детали туда не добавлять.

## Commands

```bash
# Development — мастер-сервер: лобби + сигналинг, https://localhost:3002
# (nodemon watches src/master, src/lib, src/config, games/tanks/src)
npm run dev

# Production (мастер; читает .env)
npm start

# Build (WASM-ядро + аудио + Vite bundle; нужен Rust-тулчейн)
npm run build
npm run build:app   # без ядра: только аудио + Vite (ядро уже собрано)

# Lint
npx eslint .

# Tests (Vitest)
npm test            # одиночный прогон
npm run test:watch  # watch-режим при разработке
npm run test:coverage

# Rust-ядро (core/; нужен Rust-тулчейн: rustup + wasm32 target + wasm-pack)
npm run core:build       # WASM-сборка обоих таргетов (web + nodejs)
npm run core:build:node  # только nodejs-таргет (для tests/core)
npm run core:test        # Rust-тесты ядра (cargo test)
npm run maps:export      # экспорт карт в JSON (games/tanks/src/data/maps/json/)
```

### Dev prerequisites

Local HTTPS certificates are required for development. ViteExpress serves the Vite-built client alongside the Express server. Браузерный хост требует собранного WASM-ядра: `npm run core:build` один раз (и после правок `core/`).

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

In production, the master runs plain HTTP behind Nginx (which handles HTTPS). `.env` file controls runtime config (`VIMP_DOMAIN`, `VIMP_MASTER_PORT`). Игровые параметры комнаты (карта, лимит, таймеры) задаёт создатель в лобби, не env.

## Architecture

### Master server (`src/master/`)

**Точка входа проекта** — `src/master/main.js` (`npm run dev`, порт 3002; конфиг `src/config/master.js`). Реестр комнат браузерных хостов (`HostRegistry`), REST `GET /servers` (поиск/регионы/пагинация), **каталог карт** (`MapCatalog` — JSON карт `games/tanks/src/data/maps` в памяти; `GET /maps/manifest.json` с версией-хешем + `GET /maps/:name`; `host_registered` несёт `mapsVersion` для сверки хостом), **каталог worker-бандла** (`WorkerCatalog` — версия-хеш `dist/assets/host.worker-*.js` + его URL; `GET /worker/manifest.json`; `host_registered` несёт `codeVersion` — расхождение запускает эстафету Worker'ов; в dev каталог пуст), сигналинг WebRTC (`SignalingServer`: `register_host`, `webrtc_offer`/`webrtc_answer`, `ice_candidate`, `ping_host`/`pong_host`, `report_host`), rate limiting (`src/lib/rateLimiter.js`), origin-allowlist (`security.createOriginValidator`). **Соц-модерация `/ban`** — единственная анти-чит-мера: клиент перехватывает `/ban <причина>` и шлёт `report_host` напрямую мастеру, минуя хоста-читера; мастер принимает жалобу только от сессий, слававших `webrtc_offer` этой комнате, причина обязательна; `HostRegistry` при `banThreshold` уникальных по IP жалобах за окно `reportWindowMs` банит комнату (выпадает из выдачи, WS хоста закрывается кодом 4002, IP не перерегистрируется). **Гигиена среды** — security-заголовки на ответах мастера; CSP на статику/`.wasm` — заголовок Nginx в проде (`docs/deployment.md`). Игровой логики нет. Детали — `docs/master.md`.

### Browser host (`src/host/`)

Авторитетная часть матча в Web Worker'е вкладки создателя комнаты; каноничная «серверная часть» игры. Состав:

- `host.worker.js` — загрузка WASM-ядра `core/pkg-web` + порт-машина клиентских портов + игровой цикл ~120 Гц (Worker-таймеры не троттлятся в фоновой вкладке; `RTCPeerConnection` живут в главном потоке).
- `HostGame.js` — host-фасад: wiring (игровая половина — статический `HostPlugin` `games/tanks/src/host/index.js`: gameConfig/authSchema/coreEventRouter/chatCommands/systemMessages/createModules/buildClientGameConfig) + core-driven тик + жизненный цикл соединения (`createUser`/`removeUser`/`updateKeys`/`pushMessage`/`parseVote`/`sendMap`/`mapReady`/`firstShotReady`/`updateRTT`/`reportKill`/`triggerCameraShake`) + мост колбэков `TimerManager`/`RTTManager` + эстафета Worker'ов (`requestHandoff`/`completeHandoff`/`resumeAfterHandoff`, опция `handoff` конструктора, `HANDOFF_VERSION`). Троттлинг кадров — встроенный `SnapshotThrottle`.
- `GameCoreAdapter.js` — поверхность физики/ботов/упаковки поверх `GameCore`: проекция `take_events()` в `panel`/фасад; `createMap` грузит уже-масштабированную карту со `scale:1`; бот/человек — по `isBot` → `add_bot`/`spawn_tank`; id событий ядра (числа) приводятся к строкам на границе `_drainEvents` (мета ключует строками).
- Игровой scripted-модуль ботов — `games/tanks/src/host/TanksBotManager.js` (фабрика `createModules(ctx)`; контракт: createMap/createBots/removeBots/removeOneBotForPlayer/getBots/getBotCount/getBotCountsPerTeam; ИИ — в ядре).
- **`meta/` — JS-мета Worker'а** (Worker-safe: только изоморфные API — `Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`, никаких Node-глобалов):
  - `meta/player/` — **единый источник истины об участниках** (игроки + боты): `ParticipantManager` + классы `Participant`/`HumanParticipant`/`BotParticipant`; реестр, размеры команд, список активных, генерация id (единое числовое пространство), проверка имён, наблюдение. Различение scripted/человек — геттеры `isScripted`/`isNetworked` (`isBot` — алиас до конца этапа 5), не по формату id.
  - `meta/core/` — `RoundManager` (раунды, команды, карты; владеет `currentMap`/`currentMapData`/`scaledMapData`/`isRoundEnding`/`removedPlayersList`), `CommandProcessor` (чат-команды `/name`, `/nr`, `/timeleft`, `/mapname`, `/bot`), `VoteCoordinator` (создание/кулдаун/сброс голосований).
  - `meta/modules/` — `Panel` (per-player HUD; авторитетные health/ammo живут в ядре, панель — проекция событий), `Stat` (scoreboard), `chat/` (сообщения + системные шаблоны), `Vote` (очередь, кулдауны, пагинация), `TimerManager` (все таймеры: раунд, карта, голосование, RTT-пинги, idle), `RTTManager` (ping/pong по ненадёжному state-каналу, кик-пороги).
  - `meta/SocketManager.js` — единственная точка отправки: JSON `[portId, payload]` и бинарные кадры с флагом `reliable` (классификация каналов meta/state); в Worker'е под ним wire-сокеты `postMessage`.

**Game loop**: `TimerManager` fires `onShotTick` at ~120 Hz. Ядро шагает симуляцию (`adapter.updateData` — физика + боты + дренаж событий), кадр производится каждый `networkSendRate`-й тик, broadcast-тело пакуется один раз (`pack_body` в ядре), per-user кадры — `pack_frame`, отправка через `SocketManager.sendShot` (binary, флаг `reliable`).

**Поведение комнаты**: полная комната — отказ `roomFull` (код 4006, лимит по **людям** — боты уступают место; очереди ожидания нет); хост-игрок исключён из idle/RTT-киков (его кик = смерть комнаты); причина кика доставляется `TECH_INFORM_DATA` до закрытия канала (data channel не несёт код/причину). Карты комнаты фетчатся с мастера при создании и обновляются `update_maps`.

**Эстафета Worker'ов (5.2)**: при деплое комната сама переезжает на новый worker-бандл без разрыва P2P (`RTCPeerConnection` живут в главном потоке). Worker создаётся по URL из `GET /worker/manifest.json`; расхождение `codeVersion` при re-register → `HostController.swapWorker(url)`: `prepare_handoff` → старый Worker на границе раунда отдаёт `handoff_state` (мягкая эстафета: ядро НЕ дампится — мир пересоздаётся стартом раунда; переносится JS-мета: участники+боты с исходными gameId, счёт Stat, карта с остатком времени, seq кадров) → новый Worker поднимается с `init {room, handoff}`, клиенты переподключаются внутренними `connect` минуя хендшейк → `handoff_complete` (кик не переподключившихся + первый раунд). Сбой/таймаут init нового → `resume` старому, комната живёт на прежней версии. Не переносятся: чат-история, голосования, RTT, panel. `serialize_state`/`deserialize_state` ядра в эстафете не участвуют (остаются для будущего mid-round handoff).

**User lifecycle**: connect (каналы meta+state открыты) → auth → `createUser` (spectator) → `sendMap` → `mapReady` → `firstShotReady` (ready for game loop) → `removeUser` on disconnect.

Главный поток (`src/client/network/`): `HostController` (роутер Worker↔клиенты + оркестрация эстафеты `swapWorker`), `LoopbackTransport` (транспорт хоста-игрока с интерфейсом `WebRtcManager`), `HostConnectionManager` (WebRTC-answerer удалённых клиентов: `ondatachannel` meta/state, `webrtc_answer`, ICE; регистрация `register_host`/heartbeat + reconnect сигналинга с бэкоффом; бэкпрешер по `bufferedAmount`). Клиентский конфиг (порт 0) собирает `src/lib/buildClientConfig.js`. Детали — `docs/host.md`.

**Bots** функционально идентичны реальным игрокам, но с ограниченным набором действий. Данные участника-бота живут в `ParticipantManager` (общий реестр; scripted-параметры `namePrefix`/`defaultModel` — из конфига игры), ИИ/навигация — в Rust-ядре, `TanksBotManager` (games/tanks) — только регистрация и связка со Stat/Panel. Боты и игроки делят единое числовое пространство id. Полная унификация ботов и игроков в одну абстракцию — цель на будущее.

### Rust core (`core/`)

Единое ядро симуляции: физика (нативный `rapier2d` с `enhanced-determinism`), танки, оба типа оружия, боты, кодек бинарных кадров v3 и **клиентская математика** (срез 2.6) — на Rust, компилируется wasm-pack'ом под два таргета (`pkg-web/` для браузера/Worker, `pkg-node/` для Vitest; оба генерируются, в git не входят). Публичный ABI — два класса (`core/src/lib.rs`): **`GameCore`** (авторитетная симуляция хоста): команды (`load_map`/`spawn_tank`/`add_bot`/`apply_input`/`step`/…), события для меты (`take_events`: kill/health/ammo/activeWeapon/shake — здоровье и боезапас живут в ядре, панель — проекция событий), кадры (`pack_body`/`pack_frame` + zero-copy `frame_ptr`, `body_has_events` для классификации каналов), handoff (`serialize_state`/`deserialize_state`); **`ClientCore`** (клиентский режим, `core/src/client/`): `push_frame` (распаковка + буфер по seq + reconciliation), `sample` (рендер-тик → плоский hot-буфер zero-copy через `hot_ptr`), `take_frames` (событийные кадры JSON), `apply_input`/`try_fire`/`cycle_weapon`, зеркала портов (`set_model`/`set_active`/`set_map`/`sync_panel`/`reset`), `decode_frame` (распаковка для тестов). Формулы движения общие для авторитетного пути и реплики предикта — `core/src/motion.rs`. Конфиги собирают `src/lib/coreConfig.js` (GameCore) и `src/lib/clientCoreConfig.js` (ClientCore); карты конвертируются в JSON (`npm run maps:export`). При изменении движения танка в ядре или `models.js` — обязательный `npm run core:test` (cargo-паритет реплика-vs-Rapier); раскладки кадра меняются только в ядре (`snapshot.rs` + `client/unpack.rs`) с поднятием версии в `opcodes.js`. Детали — `docs/core.md`.

### Client (`src/client/`)

Entry point: `src/client/main.js`. Транспорт — **WebRTC** (`src/client/network/`): `SignalingClient` (сигнальный WS мастера — только координация установки P2P) + `WebRtcManager` (два `RTCDataChannel` с хостом: `meta` reliable-ordered для JSON `[portId, payload]` и событийных бинарных кадров, `state` unreliable-unordered для позиционных кадров). Клиент — offerer. Входящие данные обоих каналов идут одним потоком в `handleMessage`, который диспетчеризует JSON по `socketMethods[portId]`, а бинарные кадры (порт `5`) — в буфер интерполяции. Классификация meta/state — на стороне хоста при упаковке. Клиент проходит **лобби** (выбор сервера или «Создать сервер») до подключения к хосту; выход хоста = смерть комнаты (host-migration нет) → `handleDisconnect` останавливает рендер и возвращает в лобби. Детали — `docs/network.md`, `docs/client.md`.

**Клиентское ядро** (`ClientCore`, срез 2.6): интерполяция, предикт своего танка, визуальный спавн снарядов и распаковка кадров живут в Rust-ядре (`core/src/client/`); JS-оболочка (`main.js`) пересылает данные и применяет результат. Рендер-тик: `sample(now)` → плоский Float32 hot-буфер zero-copy (`new Float32Array(wasm.memory.buffer, hot_ptr(), len)`, view пересоздаётся каждый тик; раскладка и флаги `HOT_FLAGS` — в `opcodes.js`) → адаптер `reconstructHot` в `main.js` собирает прежнюю форму `{ m1: { id: [...] } }` для `applyGameData`; событийные кадры — `take_frames()` JSON → `applyShot`. Конфиг ядра собирает `src/lib/clientCoreConfig.js` из `prediction`/`interpolation` CONFIG_DATA (поле `timeStepMs` — мс).

**Client-side prediction** (`core/src/client/predictor.rs`): свой танк симулируется репликой авторитетной модели движения (без коллизий) фикс-шагом `timeStep`; формулы тика общие с `Tank::update` (`core/src/motion.rs`). Ввод шлётся как `"seq:action:name"` и пишется в историю (`apply_input`). Хост авторитетен: в per-user заголовке кадра играющий получает **player-блок** (`gameId`, `lastInputSeq`, точное состояние танка) — reconciliation переигрывает историю ввода от `serverTime` кадра до оценки авторитетного «сейчас», расхождение уходит в `visualError` и экспоненциально затухает. Рендер: predicted-запись hot-буфера перекрывает интерполяцию тем же конвейером, камера следует предсказанной позиции (разрешается в ядре). Сбросы: `camera[2]` (respawn/телепорт), смена keySet, смена карты; при `condition 0` предикт заморожен. **Паритет реплики с Rapier-миром фиксируют cargo-тесты** (`client::predictor::parity`, 6 сценариев) — при изменении движения в ядре или `models.js` обязателен `npm run core:test`. Порядок интеграции (эмпирический, закреплён паритетом): импульсы → интеграция позиций скоростью до демпфирования → damping `v *= 1/(1+dt·d)`.

**Клиентский спавн снарядов** (`core/src/client/shot.rs`): при нажатии fire трассер (`w1`) и бомба (`w2`) своего танка спавнятся немедленно (вместе со звуком), физика/урон/взрыв (`w2e`) — авторитетные (ядро хоста). `try_fire` реплицирует авторитетный гейт (кулдаун `fireRate`, патроны из панели, активное оружие — локальный цикл `nextWeapon`/`prevWeapon` + авторитетный `'wa'` панели, живой танк) и формулы позиции дула/направления выстрела; конечная точка трассера — приближённый raycast (`core/src/client/raycast.rs`: DDA по тайлам стен + OBB slab-тест по динамике карты и танкам, позиции — из мира ядра по интерполированным кадрам; разброс — клиентский PRNG, не синхронизирован с хостом). JSON спавна уходит в обычный `applyGameData`-конвейер. Авторитетные дубли своих выстрелов подавляются в ядре при выдаче событийных кадров по id автора (`tracers[7]`, `bombs[5]`, кадр v3): трассеры — FIFO pending-очередь с таймаутом 2с, своя бомба — гейт (следующий `explosive`-выстрел блокируется до подтверждения, исключая FIFO-рассинхрон при высоком RTT); при подтверждении локальная сущность (`L<n>`) убирается, авторитетная становится основной. Бомба с локальным ключом `L<n>` не пересекается с base36-ключами хоста. Позиция бомбы RTT-компенсирована при спавне: `spawnX = x + vx × (RTT/2)` по внутренней оценке оффсета интерполятора.

**Snapshot-интерполяция** (`core/src/client/interpolator.rs`): кадры порта `5` не применяются немедленно, а буферизуются в ядре; рендер-цикл на `Ticker.shared` (`renderTick` в `main.js`) каждый rAF вызывает `clientCore.sample()` — мир рендерится в прошлом (`renderTime = serverNow − delay`, серверное время оценивается EMA-оффсетом). Пересечённые `renderTime` кадры выдаются целиком **ровно один раз** через `take_frames()` (события `w1`/`w2e`, создания/удаления, reset/shake камеры), а позиции танков (`m1`), динамики карты (`c1`/`c2`) и камеры интерполируются (lerp/lerpAngle) между соседними кадрами и уходят в hot-буфер; классификация ключей — по `kind` из `SNAPSHOT_KEYS`. Настройки — `interpolation` в `src/config/clientDefaults.js` (`delay: 100`); частота отправки снапшотов — `networkSendRate: 4` (30 пакетов/сек). Экстраполяции нет (hold на последнем кадре); буфер сбрасывается при смене карты и `clear`. Первый кадр (порт `4`) применяется немедленно, минуя ядро. **Вставка по `seq`**: под ненадёжный `state`-канал кадры вставляются по `seq` с дедупликацией; события опоздавшего reliable-кадра (его `serverTime` уже позади `renderTime`) выдаются немедленно следующим `sample()`.

**MVC triplets** in `src/client/components/`: each game feature (Auth, Lobby, CanvasManager, Controls, Game, Chat, Panel, Stat, Vote) has a `model/`, `view/`, and `controller/` file. **Lobby** — экран выбора сервера до подключения к хосту: список из `GET /servers` мастера, пагинация/поиск, умный пинг через `IntersectionObserver` (пинг только видимых карточек, `pong` пересортировывает по задержке). Модель без I/O — публикует `fetch`/`ping-request`/`join`; конфиг `src/config/lobby.js` бандлится в сборку (лобби проходит до CONFIG_DATA хоста).

Publisher-паттерн внутри MVC-тройки:
- `main.js` или `view` → методы `controller` вызываются **напрямую**
- `controller` → методы `model` вызываются **напрямую**
- `model` → методы `view` вызываются **через `Publisher`** (model публикует событие, view подписана)
- На модель могут подписываться и внешние подписчики (не только view)
- `Publisher` допустимо использовать везде, где это удобно и улучшает читаемость

**CanvasManager** управляет несколькими PixiJS `Application` одновременно:
- `vimp` — основной игровой canvas (все игровые сущности)
- `radar` — упрощённый вид `vimp` (мини-карта); данные из снапшота могут поступать в оба canvas

**Rendering parts** in `src/client/parts/`: entity classes (`Tank`, `Map`, `Bomb`, `Tracks`, etc.) rendered on PixiJS `Application` instances. Танк один — `parts/Tank.js` (свой танк перекрывается предсказанием тем же конвейером, разделение Local/Remote не понадобилось). Effects (explosions, smoke, tracers) are in `parts/effects/` и анимируются на `Ticker.shared`. При создании новой `part` смотреть на существующие как образец — фиксированного контракта нет.

**Texture baking** (`src/client/providers/BakingProvider.js`): procedural textures are generated once at startup using `bakers/` and cached. `DependencyProvider` injects renderer/soundManager into entities. При создании нового baker-а ориентироваться на существующие файлы в `bakers/` — фиксированного интерфейса нет.

**`Factory`** (`src/lib/factory.js`): registry that maps entity names (e.g. `'tank'`, `'bullet'`) to their constructor classes. `GameCtrl.parse(name, data)` creates/updates/removes entity instances based on incoming snapshot data.

### Shared

- **`src/config/`** — shared config consumed by the master (Node.js), the host Worker and the client (Vite bundler): `hostDefaults.js` (движковые дефолты хоста: лимиты, таймеры, кики, spectatorKeys; игровая половина бывшего `game.js` — `games/tanks/src/config/game.js`, merge выполняет `host.worker.js`), `clientDefaults.js` (движковые дефолты клиентского CONFIG_DATA; игровая половина бывшего `client.js` — `games/tanks/src/config/client.js`, merge выполняет `buildClientConfig`), `wsports.js`, `opcodes.js` (реестр ключей бинарного снапшота + версия формата), `lobby.js`, `master.js`. Конфиг авторизации — `games/tanks/src/config/auth.js` (elems/params/validators).
- **`src/lib/`** — utilities: `Publisher` (observer), `AbstractTimer`, `factory`, `math`, `formatters`, `sanitizers`, `validators`, `security`, `buildClientConfig` (CONFIG_DATA порта 0), `coreConfig` (init-конфиг GameCore), `clientCoreConfig` (init-конфиг ClientCore; отдельный модуль — не тянет `games/tanks/src/data/*` в клиентский бандл), `rateLimiter`. Бинарный кодек снапшота целиком в ядре (`core/src/snapshot.rs` + `core/src/client/unpack.rs`).
- **`games/tanks/`** — npm-workspace `@vimp/tanks` (план отделения движка, этап 2): листовые данные игры, импортируются как `@vimp/tanks/data/*` и `@vimp/tanks/config/*`. Состав: `src/data/` — static game data: `maps/` (tiled map definitions with respawns + physics bodies), `models.js`, `weapons.js`; `src/config/game.js` — игровой конфиг хоста (teams, panel, stat, playerKeys, карты/баланс, roomDefaults); `src/config/sounds.js` — звуки; `src/host/` — игровые host-модули (роутер core-событий, `/bot`, системные сообщения `b:*`); `assets/audio-raw/` — исходники аудио.

### Протокол портов

Транспорт — WebRTC: JSON `[portId, payload]` и событийные бинарные кадры едут по каналу `meta` (reliable), позиционные снапшоты — по `state` (unreliable); на клиенте всё сходится в один поток (`handleMessage`).

Port IDs live in `src/config/wsports.js` (источник истины). Host→client ports: `0` config, `1` auth data, `2` auth result, `3` map, `4` first shot, `5` shot (game frame), `6` sound, `7` game inform, `8` tech inform, `9` MISC (свободен), `10` ping, `11` clear, `12` console (свободен), `13` panel, `14` stat, `15` chat, `16` vote, `17` keyset. Client→host ports: `0` config ready, `1` auth, `2` modules ready, `3` map ready, `4` first shot ready, `5` keys (формат `"seq:action:name"` — seq подтверждается в player-блоке кадра), `6` chat, `7` vote, `8` pong.

**Разделение каналов**: горячий snapshot отделён от редкой меты. Кадр порта `5` несёт `[gameSnapshot, camera, serverTime, seq]` (broadcast snapshot + per-user камера). Мета шлётся своими каналами **только при изменении**: panel (`13`, per-user), stat (`14`, broadcast), chat (`15`), vote (`16`); keySet (смена режима спектатор↔игрок) — порт `17`, точечно при смене статуса.

**Бинарный snapshot**: кадр порта `5` передаётся бинарно (big-endian; ручной block-layout без библиотек). Упаковка — в ядре хоста (`core/src/snapshot.rs`); распаковка — в клиентском ядре (`core/src/client/unpack.rs`, обе стороны в одном crate); реестр ключей снапшота, версия формата и флаги hot-буфера (`HOT_FLAGS`) — `src/config/opcodes.js`. Раскладка (v3): `port(Uint8)`, `version(Uint8)`, `seq(Uint32)`, `serverTime(Float64)`, camera-блок (флаги + x/y + shake-строка), опциональный player-блок для играющего (`gameId`, `lastInputSeq`, состояние танка Float32×8 без округления + флаг центрирования башни — фундамент prediction), затем блоки сущностей (`m1`/`w1`/`w2`/`w2e`/`c1`/`c2`). События оружия несут id автора: трассер `w1` — `[..., wasHit, shooterId]`, бомба `w2` — `[..., time, ownerId]` — по нему стрелок подавляет авторитетные дубли локально заспавненных выстрелов. Клиент различает форматы по типу `e.data` (string → JSON-диспетчер, `ArrayBuffer` → `ClientCore.push_frame`); несовпадение версии — кадр отбрасывается. Первый кадр (`FIRST_SHOT_DATA`, порт `4`, одноразовый) и `PING` остаются JSON (`PING`/`PONG` — по ненадёжному `state`-каналу). Снапшоты шлются с частотой `networkSendRate: 4` (30 пакетов/сек); плавность обеспечивает клиентская интерполяция (см. секцию Client).

## Client UI Components (z-index stacking)

`vimp` canvas (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9). `#lobby` (z-index 8) — стартовый экран выбора сервера, скрывается при входе в игру. Canvas-элементы генерирует `main.js` из конфига канвасов игры; DOM панели и scoreboard генерируют движковые `PanelView`/`StatView` по схемам игры из CONFIG_DATA (в `panel.pug`/`stat.pug` — только контейнеры). Игровые хуки клиентского ядра (`set_model`/`sync_panel`/`try_fire`/`cycle_weapon`) зовутся только из `ClientPlugin` (`games/tanks/src/client/index.js`); игровой CSS — `games/tanks/src/client/tanks.css`.

## Code Conventions

- ES modules throughout (`"type": "module"`)
- Именование: `camelCase` для переменных и функций, `PascalCase` для классов, `UPPER_SNAKE_CASE` для констант
- Нет двух заглавных букв подряд в camelCase (ESLint enforces this, exceptions: `VX`, `VY`, `RTT`)
- `===` required (`eqeqeq`)
- `let`/`const` only (`no-var`)
- Curly braces required for all blocks
- Files/dirs prefixed with `_` — **экспериментальные**, к проекту прямого отношения не имеют и **не коммитятся в git**. Игнорируются ESLint и Claude: не читать, не изучать, не редактировать, не предлагать изменения — если только разработчик явно не укажет иное в переписке
- **Мета-модули `src/host/meta/` обязаны оставаться Worker-safe**: только изоморфные API (`Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`), никаких Node-глобалов (`process`, `Buffer`, `require`)
- **Тесты**: Vitest. Подробности и паттерны — в разделе [Testing](#testing)
- **Импорты**: при редактировании файла приводить к порядку: Node.js built-ins → npm пакеты → внутренние модули проекта → относительные пути
- **Качество кода**: чистота и читаемость важнее краткости. Хардкорные решения и хаки недопустимы. При спорных архитектурных решениях или выборе паттерна — уточнять у разработчика
- **Комментарии**: лаконичные, по сути. Объяснять *зачем*, а не *что*; без развёрнутых рассуждений и многострочных пояснений там, где хватает короткой строки
- Новые сущности (entity) выполнять в едином стиле с существующими; при отсутствии шаблона — придерживаться сложившегося стиля кодовой базы

## Testing

- **Обязательно**: после добавления или изменения кода проверять актуальность тестов и обновлять их — покрывать новый код тестами, править/удалять устаревшие. Любое изменение завершается зелёным `npx eslint .` + `npm test`.
- **Стек**: Vitest + happy-dom (клиент) + `@vitest/coverage-v8`. Конфиг `vitest.config.js` — два проекта: `node` (`tests/master`, `tests/host`, `tests/lib`, `tests/config`, `tests/core`, окружение node) и `client` (`tests/client`, окружение happy-dom).
- **Запуск**: `npm test` (одиночный прогон), `npm run test:watch`, `npm run test:coverage`; Rust-тесты ядра — `npm run core:test`. CI: `.github/workflows/test.yml` гоняет `eslint`, `cargo test`, сборку nodejs-таргета ядра и Vitest на каждый push/PR.
- **Тесты ядра** (`tests/core/` + `core/`): JS↔WASM харнесс (`core.test.js` — ABI и round-trip кадров через `ClientCore.decode_frame`; `clientCore.test.js` — e2e клиентского ядра: интерполяция, реордер seq, предикт со сходимостью к ядру на реальном конфиге, try_fire/подавление дублей). Все `tests/core/` и `tests/host/HostGame.test.js` пропускаются (`describe.skipIf`), если `core/pkg-node/` не собран — `npm test` зелёный и без Rust-тулчейна. Rust-слой: юнит-тесты в модулях (включая клиентский модуль `core/src/client/`) + **cargo-паритет реплики движения против Rapier** (`client::predictor::parity` — обязателен к прогону при любой правке движения в ядре или `models.js`: `npm run core:test`) + сценарии симуляции `core/tests/sim.rs`.
- **Расположение**: тесты в `tests/`, зеркалят структуру `src/` (не рядом с кодом). Файлы тестов имеют override в `eslint.config.js` (глобалы Vitest).
- **Покрыто** (~620 JS + ~90 cargo тестов): вся логика `lib/` (включая `security`); клиентская математика — cargo-тестами ядра (`core/src/client/`: интерполятор, предикт, выстрелы, raycast, unpack) + JS↔WASM e2e (`clientCore.test.js`); сетевой слой клиента `SignalingClient`/`WebRtcManager` (`tests/client/network/`, фейковые сокет/peer/observer); хост и мета (`tests/host/`): `GameCoreAdapter`, `HostGame` (интеграционно поверх реального ядра), `HostController`/`LoopbackTransport`, `HostConnectionManager`, мета-модули с логикой (Stat, Vote, RTTManager, Panel, Chat, TimerManager, SocketManager, `ParticipantManager`, `VoteCoordinator`, `RoundManager`, `CommandProcessor`); мастер (`tests/master/`): `HostRegistry`, `SignalingServer`, `MapCatalog`; клиентские модели (Lobby, Chat, Vote, Controls, Stat, Panel, Auth, Game, CanvasManager) + InputListener, SoundManager; клиентские контроллеры и view (все 9 — DOM через happy-dom).
- **Не покрыто** (низкий ROI для unit-тестов): Pixi-`parts/`+`effects/`, провайдеры (`BakingProvider`/`DependencyProvider`), обвязка `host.worker.js`/`main.js` (проверяется ручным прогоном — чек-лист в `docs/host.md`).
- **Паттерны** (соблюдать при добавлении тестов):
  - **Синглтоны** (Vote, Stat, Panel, TimerManager, клиентские `*Model`, InputListener) изолируют через `vi.resetModules()` в `beforeEach` + динамический `await import(...)`.
  - **Интеграция host-фасада** (`tests/host/HostGame.test.js` + `tests/host/harness.js`): реальный `HostGame` со всеми реальными мета-модулями + реальное ядро (`pkg-node`) + `FakeSocketManager` (пишет wire-кадры; `lastShot` декодирует бинарный кадр клиентским ядром `ClientCore.decode_frame` — end-to-end покрытие бинарного пути). Критично: `vi.useFakeTimers()` ДО конструктора `HostGame` (тот стартует таймеры/игровой цикл); игровой цикл двигать прямыми `host._onShotTick(dt)`, а не `advanceTimers`; `queueMicrotask`-колбэки (`createUser`) ждать через `flushMicro()`. Детерминизм: ассертить факт/направление, а не точные координаты.
  - Имя метода-мока с двумя заглавными подряд (например, из внешнего API) задавать вычисляемым/строковым ключом — иначе ESLint `no-consecutive-caps`.
- **Зафиксированные тестами поведенческие особенности** (не блокеры, но учитывать при доработках): `CanvasManager.resize` при `fixSize` отдаёт `height` строкой; `sanitizeMessage` — не XSS-защита (экранирование на выводе: `textContent` для текста, `setAttribute` для имени); удаляет только управляющие символы и возвращает `''` для не-строк; `validateAuth` непоследователен (ранний `return` для missing/non-string vs накопление ошибок валидаторов).

## Local Development

- Мультиплеер локально: открыть несколько вкладок браузера — одна создаёт комнату («Создать сервер» в лобби), остальные подключаются из списка
- Перед первым запуском собрать WASM-ядро: `npm run core:build`
- Debug-режима нет; при необходимости реализовать отдельно

## Deployment

- CI/CD конфигурация в `.github/`; деплоится только мастер-сервер (Docker: Rust-стадия собирает `core/pkg-web`, node-стадия — клиент, runner запускает `src/master/main.js`)
- Только production-окружение (staging отсутствует)

## Sound System

Звуки описаны в `games/tanks/src/config/sounds.js`: каждый звук имеет `file` (имя файла без расширения), `priority` (выше = важнее при конкуренции), `volume`, опционально `loop: true`.

Воспроизведение через `src/client/SoundManager.js`:
- **UI/системные звуки** (не привязаны к позиции): `soundManager.playSystemSound(soundName)` — воспроизводится немедленно, в обход системы приоритетов.
- **Пространственные звуки** (привязаны к позиции в мире): `registerSound(soundName, { position })` → `processAudibility()` → `updateActiveSounds()`. `SoundManager` сам решает, какие звуки слышны, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и систему приоритетов.

Добавление нового звука: добавить запись в `games/tanks/src/config/sounds.js`, положить аудиофайл в `public/sounds/` в форматах `.webm` и `.mp3`.

## Adding a New Map

1. Create `games/tanks/src/data/maps/<name>.js` following the existing map format (layers, tiles, respawns, physicsStatic, physicsDynamic).
2. Export and register it in `games/tanks/src/data/maps/index.js`.
3. The map name becomes available in votes and room settings; каталог карт мастера (`MapCatalog`) читает те же данные.

## Adding a New Weapon

Существует два архитектурно разных типа оружия:

**Hitscan** (пример: `w1` — пуля): попадание рассчитывается мгновенно лучом в ядре (`castRay`). Нет физического снаряда — только результат (куда попало).

**Explosive** (пример: `w2` — бомба): создаётся физический снаряд (`Bomb`) в мире Rapier ядра. Живёт в физическом цикле, передаётся клиенту как сущность в снапшоте, взрывается по таймеру.

Шаги добавления нового оружия:
1. Определить оружие в `games/tanks/src/data/weapons.js` (данные уходят и в ядро через `buildCoreConfig`, и клиенту).
2. Выбрать тип (hitscan или explosive) и реализовать авторитетную часть в Rust-ядре (`core/src/`: `game.rs`, `tank.rs`, при необходимости своя сущность по образцу `bomb.rs`; упаковка блока — `snapshot.rs`).
3. Создать клиентский рендеринг в `src/client/parts/`.
4. Зарегистрировать сущность в `games/tanks/src/config/client.js` в `parts.gameSets` и `parts.entitiesOnCanvas`.
5. Зарегистрировать snapshot-ключи оружия (и его эффектов) в `SNAPSHOT_KEYS` в `src/config/opcodes.js` — незарегистрированный ключ уронит упаковку кадра. Если существующие `kind` не подходят под формат данных, добавить новую раскладку блока в `core/src/snapshot.rs` и зеркально в `core/src/client/unpack.rs`, подняв версию формата.
6. Последним элементом данных события/сущности передавать id автора (как `shooterId` у `w1` и `ownerId` у `w2`) — по нему клиентское ядро (`core/src/client/shot.rs`) подавляет авторитетные дубли клиентского спавна; типы `hitscan`/`explosive` оно поддерживает автоматически по конфигу оружия.

## Known Issues / Future Tasks

- **P2P-миграция завершена**: клиентская математика (интерполяция/предикт/спавн снарядов/распаковка кадров) перенесена в ядро (`core/src/client/`), легаси JS-модули и JS-паритет удалены. Остался ручной smoke-прогон клиента на двух вкладках (движение/выстрелы/респаун/смена карты).
- **Унификация ботов и игроков**: частично сделано — общий реестр `ParticipantManager` с единым числовым пространством id и классами `Human/BotParticipant`. Остаётся полностью объединить поведение (сетевой ввод vs AI ядра) в одну абстракцию.
- **Debug-режим**: инструментов отладки нет, может потребоваться реализация.
