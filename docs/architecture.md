# Архитектура

VIMP Tank Battle — многопользовательская 2D-игра реального времени. **Сервер авторитетен**: вся физика (Rapier 2D), урон и правила считаются на сервере; клиент рендерит мир (PixiJS) и маскирует сетевую задержку интерполяцией и предсказанием.

```
┌─────────────────────────┐        WebSocket         ┌─────────────────────────┐
│         Сервер          │  JSON [port, payload] +  │         Клиент          │
│  Node.js + Express + ws │  бинарный snapshot (5)   │     PixiJS + Howler     │
│  физика Rapier 2D ~120Гц│ ───────────────────────► │  интерполяция (−100 мс) │
│  снапшоты 30/сек        │ ◄─────────────────────── │  prediction своего танка│
└─────────────────────────┘   ввод "seq:action:name" └─────────────────────────┘
```

## Структура репозитория

```
src/
  server/        — игровой сервер
    main.js      — bootstrap: конфиги, HTTP(S), ViteExpress, WebSocket
    modules/     — VIMP (фасад), Game (физика), Panel, Stat, Vote, chat/,
                   TimerManager, SnapshotManager, RTTManager, bots/
    core/        — RoundManager, CommandProcessor, VoteCoordinator
    player/      — Participant/Human/Bot + ParticipantManager (реестр участников)
    parts/       — физические сущности: Tank, Bomb, Map, HitscanService, BaseModel
    physics/     — rapier.js (инициализация WASM, единственная точка импорта Rapier)
    socket/      — WebSocket-слой + SocketManager (все отправки)
  client/        — браузерный клиент
    main.js      — WS-диспетчер, инициализация модулей, рендер-цикл
    components/  — MVC-тройки (Auth, CanvasManager, Controls, Game, Chat, Panel, Stat, Vote)
    parts/       — PixiJS-сущности и эффекты
    providers/   — BakingProvider (текстуры), DependencyProvider
    SnapshotInterpolator.js / TankPredictor.js / ShotPredictor.js / SoundManager.js
  config/        — общие конфиги сервера и клиента (game, client, server, auth,
                   sounds, wsports, opcodes)
  data/          — статические данные: maps/, models.js, weapons.js
  master/        — мастер-сервер P2P: реестр комнат, REST, сигналинг (docs/master.md)
  lib/           — общие утилиты: Publisher, factory, math, vec2, raycast,
                   snapshotCodec, validators, sanitizers, security, config, …
core/            — Rust-ядро симуляции → WASM (Этап 2 P2P-миграции): физика,
                   танки, оружие, боты, упаковка снапшотов (docs/core.md)
tests/           — Vitest (зеркалит структуру src/; tests/core — JS↔WASM харнесс ядра)
public/          — статика (звуки)
scripts/         — вспомогательные скрипты (обработка аудио, экспорт карт в JSON)
.github/         — CI/CD (test.yml, deploy.yml) и скрипты развертывания
```

`src/config/`, `src/data/` и `src/lib/` — **shared-слой**: импортируются и сервером (Node.js), и клиентом (Vite-бандл). Благодаря этому кодек снапшота, математика, валидаторы и параметры моделей гарантированно совпадают на обеих сторонах.

Проект мигрирует на P2P-архитектуру ([P2P-PLAN.md](../P2P-PLAN.md)): мастер-сервер (`src/master/`, Этап 1) и Rust-ядро симуляции (`core/`, Этап 2) уже в репозитории и живут **параллельно** текущему авторитетному серверу — он остаётся рабочим путём и эталоном поведения до вехи Этапа 4 (полный матч на браузерном хосте), после которой демонтируется.

## Серверная сторона

**`VIMP`** (синглтон, [src/server/modules/VIMP.js](../src/server/modules/VIMP.js)) — фасад: связывает модули, ведёт жизненный цикл соединений и делегирует тик. Дерево владения:

```
VIMP (фасад/wiring + делегирование тика)
 ├─ ParticipantManager   — единый реестр игроков и ботов (источник истины)
 ├─ RoundManager         — раунды, team wipe, смена карты, spectator↔active
 ├─ CommandProcessor     — чат-команды (/name, /bot, /nr, /timeleft, /mapname)
 ├─ VoteCoordinator      — создание/кулдаун/сброс голосований
 ├─ Game (Rapier 2D)     — физика, Tank/Bomb/Map/HitscanService
 ├─ Network: SnapshotManager + SnapshotPacker (бинарь) + SocketManager
 ├─ Cold path: Panel, Stat, Chat, Vote (JSON, по изменению)
 ├─ TimerManager         — все таймеры  /  RTTManager — пинги и кики
 └─ Bots                 — BotController, NavigationSystem, SpatialManager
```

Подробно о каждом модуле — [server.md](server.md).

### Игровой цикл

`TimerManager` вызывает `onShotTick` с частотой ~120 Гц (`timers.timeStep`). За тик:

1. `Game.updateData(dt)` — фиксированные шаги физики Rapier (с защитой от «спирали смерти»);
2. обновление ботов (если есть);
3. `SnapshotManager.processTick()` — каждый `networkSendRate`-й тик (4 → **30 снапшотов/сек**) возвращает снимок мира, иначе тик завершён;
4. `SnapshotPacker.packBody` — broadcast-часть кадра пакуется **один раз**;
5. для каждого готового пользователя: `packFrame` (камера + player-блок играющего) → бинарная отправка (порт 5) + мета (panel/stat/chat/vote) своими JSON-каналами **только при изменении**.

### Жизненный цикл соединения

```
connect → origin-проверка → CONFIG → auth → createUser (спектатор)
  → sendMap → mapReady → firstShotReady → участие в игровом цикле
  → removeUser при отключении (или кик: idle / RTT)
```

Детали протокола и портов — [network.md](network.md).

## Клиентская сторона

Клиент строится вокруг трёх механизмов сглаживания сети (подробно — [client.md](client.md)):

- **Интерполяция** (`SnapshotInterpolator`): кадры буферизуются, мир рендерится в прошлом (`serverNow − 100 мс`); события выдаются ровно один раз, позиции интерполируются.
- **Предсказание** (`TankPredictor`): свой танк симулируется локальной репликой серверной модели движения; сервер подтверждает ввод (`lastInputSeq`), reconciliation переигрывает неподтверждённые вводы, расхождение плавно затухает.
- **Клиентский спавн снарядов** (`ShotPredictor`): выстрел виден и слышен мгновенно, серверные дубли подавляются по id автора.

Рендеринг — MVC-компоненты + PixiJS-сущности `parts/` на двух полотнах (`vimp`, `radar`), процедурные текстуры запекаются при старте.

## Ключевые инварианты

- **Источник истины по портам** — `src/config/wsports.js`; по snapshot-ключам и версии бинарного формата — `src/config/opcodes.js`.
- **Паритет реплики движения**: `Tank.updateData` (сервер) и `TankPredictor` (клиент) обязаны совпадать численно; закреплено тестом `tests/server/TankPredictorParity.test.js` — любая правка `Tank.updateData`/`models.js` требует его прогона. С Этапа 2 паритет расширен на Rust-ядро: `tests/core/serverParity.test.js` (ядро ↔ сервер) и `tests/core/predictorParity.test.js` (реплика ↔ ядро) — движение обязано совпадать во всех трёх реализациях.
- **Rapier импортируется только через** `src/server/physics/rapier.js` (top-level await инициализации WASM).
- **Единое числовое пространство id** для людей и ботов; различение — `isBot`/`isNetworked`.
- Все отправки клиенту — только через `SocketManager`.
