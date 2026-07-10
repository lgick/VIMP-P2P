# Архитектура

VIMP Tank Battle — многопользовательская 2D-игра реального времени на
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
src/
  master/        — мастер-сервер (точка входа): реестр комнат, REST,
                   сигналинг, каталог карт (docs/master.md)
  host/          — браузерный хост (docs/host.md)
    host.worker.js — Web Worker: WASM-ядро + мета + порт-машина + цикл ~120 Гц
    HostGame.js  — host-фасад: wiring мета-модулей, core-driven тик
    GameCoreAdapter.js — поверхность физики/ботов/упаковки поверх GameCore
    HostBotManager.js  — тонкий реестр ботов (ИИ — в ядре)
    meta/        — JS-мета Worker'а: core/ (RoundManager, CommandProcessor,
                   VoteCoordinator), modules/ (Panel, Stat, Vote, chat/,
                   TimerManager, RTTManager), player/ (Participant/Human/Bot +
                   ParticipantManager), SocketManager
  client/        — браузерный клиент
    main.js      — диспетчер портов, лобби/роли, инициализация модулей, рендер-цикл
    network/     — SignalingClient, WebRtcManager (offerer), HostController,
                   LoopbackTransport, HostConnectionManager (answerer)
    components/  — MVC-тройки (Auth, Lobby, CanvasManager, Controls, Game,
                   Chat, Panel, Stat, Vote)
    parts/       — PixiJS-сущности и эффекты
    providers/   — BakingProvider (текстуры), DependencyProvider
    SnapshotInterpolator.js / TankPredictor.js / ShotPredictor.js / SoundManager.js
  config/        — общие конфиги (game, client, auth, sounds, wsports, opcodes,
                   lobby, master)
  data/          — статические данные: maps/, models.js, weapons.js
  lib/           — общие утилиты: Publisher, factory, math, vec2, raycast,
                   snapshotCodec, validators, sanitizers, security, config, …
core/            — Rust-ядро симуляции → WASM: физика, танки, оружие, боты,
                   упаковка снапшотов (docs/core.md)
tests/           — Vitest (tests/host — хост и мета; tests/core — JS↔WASM
                   харнесс ядра; tests/master, tests/client, tests/lib)
public/          — статика (звуки)
scripts/         — вспомогательные скрипты (обработка аудио, экспорт карт в JSON)
.github/         — CI/CD (test.yml, deploy.yml) и скрипты развертывания
```

`src/config/`, `src/data/` и `src/lib/` — **shared-слой**: импортируются
мастером (Node.js), Worker'ом хоста и клиентом (Vite-бандл). Благодаря этому
кодек снапшота, математика, валидаторы и параметры моделей гарантированно
совпадают на всех сторонах.

История миграции с авторитетного WS-сервера на эту архитектуру — в
[P2P-PLAN.md](../P2P-PLAN.md).

## Вкладка хоста

Авторитетная часть матча живёт в Web Worker'е (его таймеры не троттлятся в
фоновой вкладке), `RTCPeerConnection` — в главном потоке (в Worker их создать
нельзя), который работает роутером пакетов. Хост-игрок играет в той же вкладке
через postMessage-loopback. Такое разделение позволяет заменять Worker без
разрыва P2P — на этом построена **эстафета Worker'ов** (Этап 5.2): при деплое
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
                                    Stat, Panel, TimerManager… (src/host/meta/)
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
 └─ HostBotManager       — реестр участников-ботов (ИИ — в ядре)
```

**Граница ядра — симуляция, а не мета**: в ядре физика, танки, оба типа оружия,
боты и упаковка бинарных кадров; здоровье/боезапас тоже живут в ядре, панель —
проекция его событий (`take_events()`: kill/health/ammo/activeWeapon/shake).
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

Клиент строится вокруг трёх механизмов сглаживания сети (подробно — [client.md](client.md)):

- **Интерполяция** (`SnapshotInterpolator`): кадры буферизуются, мир рендерится в прошлом (`serverNow − 100 мс`); события выдаются ровно один раз, позиции интерполируются.
- **Предсказание** (`TankPredictor`): свой танк симулируется локальной репликой авторитетной модели движения; хост подтверждает ввод (`lastInputSeq`), reconciliation переигрывает неподтверждённые вводы, расхождение плавно затухает.
- **Клиентский спавн снарядов** (`ShotPredictor`): выстрел виден и слышен мгновенно, дубли от хоста подавляются по id автора.

Рендеринг — MVC-компоненты + PixiJS-сущности `parts/` на двух полотнах (`vimp`, `radar`), процедурные текстуры запекаются при старте.

## Ключевые инварианты

- **Источник истины по портам** — `src/config/wsports.js`; по snapshot-ключам и версии бинарного формата — `src/config/opcodes.js`.
- **Паритет реплики движения**: движение танка в Rust-ядре и клиентская реплика `TankPredictor` обязаны совпадать численно; закреплено тестом `tests/core/predictorParity.test.js` — любая правка движения в ядре или коэффициентов `models.js` требует его прогона.
- **Единое числовое пространство id** для людей и ботов; различение — `isBot`/`isNetworked`. Ядро оперирует числовыми id, мета ключует строками — приведение на границе `GameCoreAdapter`.
- Все отправки клиенту — только через `SocketManager`.
