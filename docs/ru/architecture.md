# Архитектура

VIMP P2P Tank Battle — многопользовательская 2D-игра реального времени на
**P2P-архитектуре**. **Хост авторитетен**: вся физика (Rapier 2D в Rust-ядре,
WASM), урон и правила считаются в Web Worker'е вкладки создателя комнаты;
клиенты рендерят мир (PixiJS) и маскируют сетевую задержку интерполяцией и
предсказанием. Мастер-сервер (Node.js) игровой логики не несёт: лобби,
сигналинг WebRTC, каталог карт, соц-модерация.

```
┌──────────────────┐  сигнальный WS (SDP/ICE, ping, /ban)  ┌──────────────────┐
│  Мастер-сервер   │ ◄───────────────────────────────────► │      Клиент      │
│ Node.js: лобби,  │                                       │ PixiJS + Howler  │
│ GET /servers,    │ ◄───────────┐                         │ интерполяция     │
│ каталог карт     │             │ register_host,          │ (−100 мс),       │
└──────────────────┘             │ heartbeat               │ prediction       │
                                 │                         └────────┬─────────┘
                        ┌────────┴─────────┐   WebRTC DataChannels  │
                        │  Вкладка хоста   │  meta (reliable): JSON │
                        │ Worker: ядро+мета│  [port, payload] + со- │
                        │ симуляция ~120 Гц│  бытийные кадры        │
                        │ снапшоты 30/сек  │ ◄──────────────────────┘
                        └──────────────────┘  state (unreliable):
                                              позиционные кадры (5);
                                              ввод "seq:action:name"
```

## Структура репозитория

```
packages/engine/ — @vimp/engine: движок-приложение (npm workspace)
  index.html / vite.config.js — Vite-root движка
  public/        — статика (звуки, favicon)
  src/
    master/      — мастер-сервер (точка входа): реестр комнат, REST,
                   сигналинг, каталог карт (docs/master.md)
    host/        — браузерный хост (docs/host.md)
      host.worker.js — Web Worker: WASM-ядро + мета + порт-машина + цикл ~120 Гц
      HostGame.js — host-фасад: wiring мета-модулей, core-driven тик
      GameCoreAdapter.js — поверхность физики/ботов/упаковки поверх GameCore
      meta/      — JS-мета Worker'а: core/ (RoundManager, CommandProcessor,
                   VoteCoordinator), modules/ (Panel, Stat, Vote, chat/,
                   TimerManager, RTTManager), player/ (Participant/Human/Bot +
                   ParticipantManager), SocketManager
    client/      — браузерный клиент
      main.js    — диспетчер портов, лобби/роли, инициализация модулей, рендер-цикл
      network/   — SignalingClient, WebRtcManager (offerer), HostController,
                   LoopbackTransport, HostConnectionManager (answerer)
      components/ — MVC-тройки (Auth, Lobby, CanvasManager, Controls, Game,
                   Chat, Panel, Stat, Vote)
      providers/ — BakingProvider (пекари приходят из ClientPlugin игры),
                   DependencyProvider
      SoundManager.js / InputListener.js
    config/      — конфиги движка (hostDefaults, clientDefaults, wsports,
                   opcodes, lobby, master)
    lib/         — общие утилиты: Publisher, factory, math, validators,
                   sanitizers, security, config, clientCoreConfig, …
games/tanks/     — @vimp/tanks: игра (npm workspace)
  src/host/      — HostPlugin: роутер core-событий, TanksBotManager, /bot,
                   системные сообщения b:*
  src/client/    — ClientPlugin: parts/ (PixiJS-сущности и эффекты),
                   bakers/ (процедурные текстуры), хуки, игровой CSS
  src/config/    — игровые половины конфигов (game.js, client.js, auth.js, sounds.js)
  src/data/      — статические данные: maps/, models.js, weapons.js
core/            — Rust-ядро симуляции → WASM: физика, танки, оружие, боты,
                   кодек снапшотов и клиентская математика — интерполяция,
                   предикт, спавн снарядов (подмодуль client в core/src, docs/core.md)
tests/           — Vitest-проекты: engine-node, engine-client, tanks,
                   integration (tests/host/HostGame.test.js + tests/core)
scripts/         — вспомогательные скрипты (обработка аудио, экспорт карт в JSON)
.github/         — CI/CD (test.yml, deploy.yml) и скрипты развертывания
```

`packages/engine/src/config/`, `games/tanks/src/data/` и `packages/engine/src/lib/` — **shared-слой**: импортируются
мастером (Node.js), Worker'ом хоста и клиентом (Vite-бандл). Благодаря этому
кодек снапшота, математика, валидаторы и параметры моделей гарантированно
совпадают на всех сторонах.

Проект изначально строился вокруг авторитетного WS-сервера; текущая
P2P-архитектура (браузерный хост + мастер-сервер) — результат завершённой
миграции, легаси-сервер полностью демонтирован.

## Вкладка хоста

Авторитетная часть матча живёт в Web Worker'е (его таймеры не троттлятся в
фоновой вкладке), `RTCPeerConnection` — в главном потоке (в Worker их создать
нельзя), который работает роутером пакетов. Хост-игрок играет в той же вкладке
через postMessage-loopback. Такое разделение позволяет заменять Worker без
разрыва P2P — на этом построена **эстафета Worker'ов**: при деплое
комната на границе раунда переезжает на новый worker-бандл мастера с переносом
участников и счёта. Детали — [host.md](host.md), раздел «Эстафета Worker'ов».

```
Вкладка хоста
├─ Главный поток (client + router)
│   ├─ client (main.js)          — рендер, prediction, звук (обычный клиент)
│   ├─ HostController            — спавнит Worker, мост Worker↔транспорт
│   ├─ LoopbackTransport         — транспорт хоста-игрока поверх postMessage
│   └─ HostConnectionManager     — WebRTC-answerer удалённых клиентов + бэкпрешер
└─ Web Worker (host.worker.js)   — авторитетная симуляция ~120 Гц
    ├─ GameCore (WASM, core/)    — физика, оружие, боты
    ├─ GameCoreAdapter           — поверхность физики/ботов/упаковки поверх ядра
    └─ HostGame-фасад + мета      — RoundManager, ParticipantManager, Chat, Vote,
                                    Stat, Panel, TimerManager… (packages/engine/src/host/meta/)
```

**`HostGame`** — фасад: связывает модули, ведёт жизненный цикл соединений и
делегирует тик. Дерево владения:

```
HostGame (фасад/wiring + core-driven тик)
 ├─ ParticipantManager   — единый реестр игроков и ботов (источник истины)
 ├─ RoundManager         — раунды, team wipe, смена карты, spectator↔active
 ├─ CommandProcessor     — чат-команды (/name, /bot, /nr, /timeleft, /mapname)
 ├─ VoteCoordinator      — создание/кулдаун/сброс голосований
 ├─ GameCoreAdapter      — ядро: физика, Tank/Bomb/Hitscan, боты, packBody/packFrame
 ├─ Cold path: Panel, Stat, Chat, Vote (JSON, по изменению)
 ├─ TimerManager         — все таймеры  /  RTTManager — пинги и кики
 └─ TanksBotManager      — scripted-модуль игры (games/tanks; ИИ — в ядре)
```

**Граница ядра — симуляция, а не мета**: в ядре физика, танки, оба типа оружия,
боты и упаковка бинарных кадров; здоровье/боезапас тоже живут в ядре, панель —
проекция его событий (стандартный словарь `take_events()`:
panelSet/panelActive/death/shake/custom).
Мета (чат, голосования, статистика, раунды, реестр участников, auth) — JS в
Worker'е.

### Игровой цикл

`TimerManager` вызывает `onShotTick` с частотой ~120 Гц (`timers.timeStep`). За тик:

1. `GameCoreAdapter.updateData(dt)` — шаг ядра (физика + боты) + дренаж событий
   в мету (panel/reportKill/shake);
2. `SnapshotThrottle` — каждый `networkSendRate`-й тик (4 → **30 снапшотов/сек**)
   кадр отправляется, иначе тик завершён;
3. `packBody` (в ядре) — broadcast-часть кадра пакуется **один раз**;
4. для каждого готового пользователя: `packFrame` (камера + player-блок
   играющего) → бинарная отправка (порт 5; события → канал `meta`, чистые
   позиции → `state`) + мета (panel/stat/chat/vote) своими JSON-каналами
   **только при изменении**.

### Жизненный цикл соединения

```
лобби → выбор комнаты → сигналинг (offer/answer/ICE) → каналы meta+state
  → CONFIG → auth → createUser (спектатор) → sendMap → mapReady
  → firstShotReady → участие в игровом цикле
  → removeUser при отключении (или кик: idle / RTT; хост-игрок не кикается)
```

Выход хоста = смерть комнаты (host-migration нет): клиенты возвращаются в
лобби. Детали протокола и портов — [network.md](network.md).

## Клиентская сторона

Клиент строится вокруг трёх механизмов сглаживания сети; все три живут в клиентском ядре — WASM-классе `ClientCore` того же Rust-бинаря (подробно — [client.md](client.md), ABI — [core.md](core.md#clientcore--клиентский-режим-ядра)):

- **Интерполяция** (`core/src/client/interpolator.rs`): кадры буферизуются, мир рендерится в прошлом (`serverNow − 100 мс`); события выдаются ровно один раз, позиции интерполируются.
- **Предсказание** (`core/src/client/predictor.rs`): свой танк симулируется репликой авторитетной модели движения (формулы общие с ядром — `motion.rs`); хост подтверждает ввод (`lastInputSeq`), reconciliation переигрывает неподтверждённые вводы, расхождение плавно затухает.
- **Клиентский спавн снарядов** (`core/src/client/shot.rs`): выстрел виден и слышен мгновенно, дубли от хоста подавляются по id автора.

JS-оболочка читает результат рендер-тика плоским Float32-буфером zero-copy из памяти WASM (горячие позиции) и JSON-строкой (редкие событийные кадры), применяя его прежним parse-конвейером.

Рендеринг — MVC-компоненты + PixiJS-сущности `parts/` на двух полотнах (`vimp`, `radar`), процедурные текстуры запекаются при старте.

## ADR: движок — приложение, игра — динамический плагин

**Статус: принято, миграция в процессе** (этапы и порядок — `PLAN.md`;
целевые контракты — [plugin-api.md](plugin-api.md)).

**Решение.** Проект разделяется на **движок** — приложение, деплоящееся
один раз (мастер, P2P-транспорт, Worker-инфраструктура и эстафета,
мета-*механизмы*, MVC-каркас клиента, рендер/звук-инфраструктура,
Rust-каркас), — и **игру** — динамический плагин (JS-бандлы client/host,
WASM-бинарь, ассеты), загружаемый по манифесту с мастера. Композиция: npm
workspaces `packages/engine` (`@vimp/engine`) + `games/tanks`
(`@vimp/tanks`); Rust-ядро распиливается на два crate —
`vimp-engine-core` (rlib, каркас) и `vimp-tanks-core` (cdylib, игра +
wasm-bindgen-обёртки) — связь через трейты со статической мономорфизацией.
Мета-модули (Panel/Stat/Chat/Vote/Timer/RTT/Participant/Round/
CommandProcessor) остаются движковыми, но **вся их параметризация — из
конфига игры**. Ботов в движке нет — только нейтральное понятие
«скриптовый участник».

**Обоснование.** На движке появятся другие игры; игра со временем может
переехать в отдельный репозиторий; один мастер должен обслуживать несколько
игр. Динамический плагин (а не build-time зависимость) позволяет деплоить
движок один раз, а играм версионироваться независимо (`codeVersion`
становится составным, расхождение запускает эстафету Worker'ов).

### Разметка файлов (ENGINE / GAME / MIXED)

Полная разметка текущего дерева. MIXED-файлы подлежат разрезу в ходе
миграции (что именно вырезается — в скобках).

| Область | ENGINE | GAME | MIXED (что вырезается) |
| --- | --- | --- | --- |
| Мастер | весь `packages/engine/src/master/` (`HostRegistry`, `SignalingServer`, `WorkerCatalog`, `MapCatalog` становится per-game; новый `GameCatalog`) | — | `packages/engine/src/master/main.js` — статический импорт `games/tanks/src/data/maps` |
| Хост | `host.worker.js` (загрузка плагина), `HostGame.js`, `GameCoreAdapter.js` (generic), `meta/player/*` (`isScripted` вместо `isBot`), `meta/core/RoundManager`, `VoteCoordinator`, `meta/modules/*` (Panel, Stat, Vote, механизм chat, TimerManager, RTTManager) | `HostBotManager.js` → `TanksBotManager` (контракт scripted-модуля), команда `/bot`, системные сообщения `b:*`, роутер core-событий | `GameCoreAdapter._drainEvents` (игровой словарь событий), `SocketManager` (звуковые хардкоды `roundStart/victory/…`, `sendFirstVote`), `CommandProcessor` (`/bot`), `chat/systemMessages.js` (группа `b:*`), `Panel.js` (хардкод `'wa'`) |
| Клиент | `main.js` (bootstrap/диспетчер), `network/*`, MVC-компоненты, `CanvasManager`, `SoundManager`, `InputListener`, `providers/*`, schema-driven view Panel/Stat | `parts/*` (9 классов), `bakers/*` (8 текстур), игровой CSS, клиентские хуки (`set_model`/`sync_panel`/`try_fire`/`cycle_weapon`) | `main.js` (игровые хуки, захардкоженная раскладка танка в `reconstructHot`), `index.html`+`views/includes/{panel,stat}.pug` (игровые DOM-id), `style.css` |
| Конфиг | `wsports.js`, `opcodes.js` (фрейминг, `HOT_FLAGS`, `ENGINE_API_VERSION`), `master.js`, `lobby.js`, новые `hostDefaults.js`/`clientDefaults.js` | `sounds.js`, `auth.js`, схема snapshot-ключей (`m1/w1/w2/w2e/c1/c2`) | `game.js` (движок: `maxPlayers`, таймеры, rtt, idle-кик / игра: teams, panel, stat, playerKeys, параметры карт), `client.js` (движок: interpolation, controls modes/cmds, elems, techInformList / игра: parts, keySetList, схемы panel/stat, тексты, канвасы), `opcodes.js` (`SNAPSHOT_KEYS` — данные игры) |
| Данные | *формат* карт и загрузчик | весь `games/tanks/src/data/`: `maps/`, `models.js`, `weapons.js`; `assets/audio-raw` | — |
| Lib | `Publisher`, `factory`, `math`, `formatters`, `sanitizers`, `security`, `rateLimiter`, `buildClientConfig`/`coreConfig`/`clientCoreConfig` (становятся generic-мерджерами) | — | `validators.js` (`isValidModel` хардкодит `'m1'` → `authSchema` плагина) |
| Rust-ядро | `physics.rs` (мир, generic BodyTag, math), `rng.rs`, `map.rs`, `bots/pathfinder.rs`+`spatial.rs` (→ `nav/`), фрейминг `snapshot.rs`, `client/{interpolator,predictor,raycast,unpack,hot}`, фикс-шаг/контакты, handoff-каркас | `tank.rs`, `bomb.rs`, `motion.rs` (+parity-тесты), `bots/{controller,navigation}.rs`, игровая логика `game.rs` (→ `sim.rs`), `client/shot.rs`, раскладки блоков, `#[wasm_bindgen]`-обёртки, `tests/sim.rs` | `game.rs` (движковый цикл vs игровые правила), `snapshot.rs` (фрейминг vs раскладки блоков), `events`-маппинг |

## Ключевые инварианты

- **Источник истины по портам** — `packages/engine/src/config/wsports.js`; по snapshot-ключам и версии бинарного формата — `packages/engine/src/config/opcodes.js`.
- **Паритет реплики движения**: авторитетное движение (Rapier) и реплика клиентского предикта делят формулы тика (`core/src/motion.rs`); паритет интеграции закреплён cargo-тестами (`client::predictor::parity`) — любая правка движения в ядре или коэффициентов `models.js` требует прогона `npm run core:test`.
- **Единое числовое пространство id** для людей и scripted-участников (ботов); различение — `isScripted`/`isNetworked`. Ядро оперирует числовыми id, мета ключует строками — приведение на границе `GameCoreAdapter`.
- Все отправки клиенту — только через `SocketManager`.

---

[← Предыдущая: Локальная настройка](getting-started.md) · [Следующая: Игровой процесс →](gameplay.md)
