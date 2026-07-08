# Браузерный хост (Этап 4 P2P-миграции)

Браузерный хост разворачивает **авторитетную часть матча прямо во вкладке
создателя комнаты**: WASM-ядро симуляции (`core/`) и JS-мету — в Web Worker'е, а
`RTCPeerConnection`-роутер — в главном потоке. Это заменяет легаси
авторитетный сервер (`src/server/`), который живёт параллельно как эталон
до вехи демонтажа (после Этапа 4).

> **Статус.** Фаза 1 (loopback хоста-игрока в своей вкладке) и Фаза 2
> (удалённые клиенты по WebRTC: answerer, `register_host`, классификация
> каналов meta/state, бэкпрешер) реализованы. Остаётся Фаза 3 — прогон вехи
> end-to-end (8 игроков + боты), см. `P2P-PLAN.md`.

Код хоста — `src/host/` (Worker + ядро + мета) и `src/client/network/`
(роутер главного потока + транспорты).

## Топология вкладки хоста

```
Вкладка хоста
├─ Главный поток (клиент + роутер)
│   ├─ client (src/client/main.js): рендер, предикт, звук — как обычный клиент
│   ├─ HostController: спавнит Worker, роутит пакеты Worker ↔ клиенты
│   ├─ LoopbackTransport: транспорт хоста-игрока (интерфейс WebRtcManager
│   │  поверх postMessage)
│   └─ HostConnectionManager: WebRTC-answerer для удалённых клиентов
│      (register_host, meta/state, бэкпрешер)
└─ Web Worker (src/host/host.worker.js): авторитетная симуляция
    ├─ GameCore (WASM, core/pkg-web)
    ├─ GameCoreAdapter: поверхность Game.js/Bots/Snapshot поверх ядра
    └─ HostGame-фасад + переиспользованная мета (RoundManager, Participant-
       Manager, Chat, Vote, Stat, Panel, TimerManager, CommandProcessor,
       VoteCoordinator, SocketManager) + игровой цикл ~120 Гц
```

Ключевое правило: `RTCPeerConnection` **живут в главном потоке** (в Worker их
создать нельзя), а игровой цикл — **в Worker'е** (его таймеры не троттлятся
браузером в фоновой вкладке, в отличие от главного потока). Главный поток —
дамб-пайп: пересылает wire-кадры между DataChannel/loopback и Worker'ом.

## Web Worker (`src/host/host.worker.js`)

Загружает WASM-ядро (`init()` + `GameCore` из `core/pkg-web`), строит `HostGame`
с настройками комнаты и держит per-client порт-машину — тот же автомат портов
0–8, что и легаси `src/server/socket/index.js` (минус `ws`/origin/очередь
ожидания). Сообщения главного потока:

- `init(room)` — применяет настройки комнаты к конфигу игры
  (`applyRoomOverrides`: имя/карта/лимит ≤ 8/таймеры/friendly fire),
  инициализирует ядро, создаёт `HostGame`, отвечает `ready`;
- `connect(socketId)` — новый клиент: регистрирует wire-сокет в `SocketManager`,
  шлёт `CONFIG_DATA` (порт 0), запускает handshake config→auth→map→firstShot;
- `message(socketId, data)` — входящее сообщение клиента (`JSON [port, payload]`),
  диспетчеризуется по разрешённым портам;
- `disconnect(socketId)` — удаляет участника из игры и реестра.

Обратно в главный поток Worker шлёт `to_client` (wire-кадр: JSON-строка или
бинарный `ArrayBuffer` через Transferable), `close_client` и `ready`.
Per-user **wire-сокет** (`makeWorkerSocket`) реализует контракт `SocketManager`
(`send`/`sendBinary`/`close`) поверх `postMessage`, поэтому `SocketManager`
переиспользуется **без единой правки**.

Игровой цикл ~120 Гц стартует сам (конструктор `HostGame` → `RoundManager.createMap`
→ `TimerManager.startGameTimers`); кадры уходят только готовым к игре участникам.

## HostGame (`src/host/HostGame.js`)

Host-фасад — аналог `src/server/modules/VIMP.js`, но:

- симуляция/боты/упаковка снапшотов — в Rust-ядре через `GameCoreAdapter`
  вместо `Game`/`Bots`/`SnapshotManager`/`SnapshotPacker`;
- мета (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`,
  `TimerManager`, `CommandProcessor`, `VoteCoordinator`, `SocketManager`) —
  **импортируется из `src/server/` как есть** (модули инъекционны и не зависят
  от физики/транспорта);
- горячий тик `_onShotTick` core-driven: `adapter.updateData(dt)` (шаг ядра +
  дренаж событий), троттлинг отправки, `adapter.packBody()` один раз/тик,
  затем per-user `adapter.packFrame(...)` (ядро само собирает player-блок
  предикшена по `playerId`).

На вехе демонтажа (после Этапа 4) `VIMP.js` удаляется, `HostGame` становится
каноничным — это и есть «переработка VIMP.js» из карты судьбы модулей плана.

Общий билдер `src/lib/buildClientConfig.js` собирает клиентский `CONFIG_DATA`
(порт 0: базовый конфиг + время голосования + данные prediction) — один и тот
же для Worker'а хоста и легаси-сервера.

## GameCoreAdapter (`src/host/GameCoreAdapter.js`)

Реализует поверхность `Game.js` (+ упаковка кадров), которую потребляют
`RoundManager`/`SocketManager`/`HostGame`, но за ней стоит `GameCore`:

- **жизненный цикл/физика** → ABI ядра: `createMap` → `load_map` (карта уже
  отмасштабирована в JS `RoundManager.scaleMapData`, поэтому грузится со
  `scale: 1` — ядро не масштабирует повторно, геометрия совпадает с легаси
  байт-в-байт); `createPlayer`/`removePlayer` различают бота и человека по
  `participant.isBot` (`add_bot`/`remove_bot` — танк + ИИ в ядре — против
  `spawn_tank`/`remove_tank`); `changePlayerData` → `reset_tank`;
- **ввод** → `apply_input` (seq подтверждается ядром в player-блоке кадра);
- **проекция событий**: после `step` дренирует `take_events()` и вызывает те
  же точки, куда JS-`Game` писал напрямую — `health`/`ammo` →
  `panel.updateUser(..., 'set')`, `activeWeapon` → `panel.setActiveWeapon`,
  `shake` → `HostGame.triggerCameraShake`, `kill` → `HostGame.reportKill`
  (здоровье/боезапас живут в ядре, панель — их проекция);
- **упаковка**: `packBody` → `pack_body`, `packFrame` → `pack_frame` +
  `frame_bytes` (копия из памяти WASM, работает и на web-, и на nodejs-таргете);
- **первый кадр**: `getPlayersData` → `players_data()` ядра (полный снапшот
  игроков без дренажа накопителей — для `FIRST_SHOT_DATA`).

`HostBotManager` (`src/host/HostBotManager.js`) — тонкий менеджер ботов:
регистрация участников-ботов и связка со `Stat`/`Panel` (ИИ, навигация и
пространственная сетка — в ядре; JS `BotController`/`NavigationSystem`/
`SpatialManager` не задействованы).

## Главный поток: роутер и транспорты (`src/client/network/`)

- **`HostController`** — спавнит Worker (`new Worker(new URL('host.worker.js'),
  { type: 'module' })`; фабрика инъектируется для тестов), шлёт `init(room)`,
  роутит `to_client`/`close_client` зарегистрированным клиентам и пересылает
  входящие сообщения в Worker. Общий для loopback и удалённых клиентов;
  `onReady` (Worker поднят) — момент регистрации комнаты у мастера.
- **`LoopbackTransport`** — транспорт хоста-игрока: реализует интерфейс
  `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные
  ходят через `HostController` → Worker постмесседжами. Для клиентского кода
  транспорт прозрачен; флаг `reliable` игнорируется (loopback надёжен и
  упорядочен по определению).
- **`HostConnectionManager`** (Фаза 2) — WebRTC-answerer удалённых клиентов
  (зеркало `WebRtcManager`, который у клиента offerer). Через `SignalingClient`
  ловит `webrtc_offer`, на каждого клиента создаёт `RTCPeerConnection`,
  `ondatachannel` принимает каналы `meta`/`state`, шлёт `webrtc_answer` и
  обменивается ICE. Когда оба канала клиента открыты — поднимает его соединение
  в Worker'е (`HostController.open` → `connect`). Отвечает на сигнальный
  `ping_host` клиента (`pong_host` — замер задержки в лобби).

### Классификация каналов и бэкпрешер (Фаза 2)

Исходящий Worker-кадр раскладывается по каналам: **события → `meta`**
(reliable-ordered), **чистые позиции → `state`** (unreliable). Решение —
по флагу `reliable`, который `HostGame` вычисляет per-user:
`core.body_has_events()` (трассеры/бомбы/взрывы/удаления в теле, stateless-
геттер ядра — не меняет сигнатуру `pack_body`) ∨ `forceReset` камеры ∨
`shake`. JSON-протокол (порты `[portId, payload]`) — всегда по `meta`. Флаг
идёт через `SocketManager.sendShot(socketId, buffer, reliable)` (легаси-ws его
игнорирует) → worker-сокет → `to_client` → answerer. **Бэкпрешер**: перед
отправкой позиционного кадра проверяется `bufferedAmount` state-канала; выше
порога кадр дропается (следующий компенсирует), `meta` не дропается никогда.

### Регистрация у мастера (Фаза 2)

По `onReady` хост шлёт `register_host` (имя/лимит/карта — фактическая карта
приходит из Worker'а в `ready`) и заводит heartbeat (`update_host` каждые
`lobbyConfig.create.heartbeatInterval` мс, меньше `heartbeatTimeout` мастера).
`currentPlayers` = 1 (хост-игрок) + число WebRTC-пиров, актуализируется при
входе/выходе клиента (`onPeersChange`). Выход хоста-игрока = смерть комнаты:
`handleDisconnect` гасит heartbeat, закрывает пиров (`HostConnectionManager.
destroy`) и Worker (`HostController.destroy`).

## Выбор роли (клиентский бутстрап)

В лобби (`src/client/main.js`):

- **присоединиться** — карточка сервера → `connectToHost(hostId)` →
  `WebRtcManager` (offerer, как в Этапе 3);
- **создать сервер** — кнопка/имя в лобби (`#lobby-host`/`#lobby-name`,
  `src/config/lobby.js`) → `connectAsHost(room)` → `HostController` + Worker +
  `LoopbackTransport` (хост-игрок) + `HostConnectionManager` (удалённые клиенты)
  + регистрация у мастера.

Дальше клиентский код одинаков (транспорт абстрагирован). Выход хоста = смерть
комнаты (host-migration нет) — как и у обычного клиента: `handleDisconnect`
останавливает рендер и возвращает в лобби.

## Тесты

- `tests/host/GameCoreAdapter.test.js` — юнит на фейковом ядре: маппинг команд
  на ABI, различение бот/человек, проекция событий в панель/фасад, флаги камеры.
- `tests/host/HostGame.test.js` — интеграция поверх **реального** ядра
  (`pkg-node`, `describe.skipIf` без сборки): онбординг, активный игрок с
  player-блоком, движение, стрельба (трассер + боезапас), боты, `players_data`;
  бинарные кадры декодируются реальным `unpackFrame`.
- `tests/host/LoopbackTransport.test.js` — юнит на фейковом Worker:
  `HostController` (роутинг, очередь connect до `ready`, флаг `reliable`) и
  `LoopbackTransport`.
- `tests/host/HostConnectionManager.test.js` — юнит на фейковых peer/каналах:
  оффер→answer, каналы meta/state, классификация reliable, бэкпрешер, ICE,
  сигнальный pong, закрытие.
- `tests/client/network/SignalingClient.test.js` — исходящие хоста
  (`register_host`/`update_host`/`webrtc_answer`/`pong_host`).
- `tests/core/core.test.js` — `body_has_events()` (классификация meta/state).

## Сборка

Worker грузит `core/pkg-web` (web-таргет ядра). Прод-сборка (`npm run build`)
собирает его сама (`core:build:web`) — деплой теперь требует Rust-тулчейн (см.
[getting-started.md](getting-started.md), [deployment.md](deployment.md)). Для
dev host-фичи `core/pkg-web` нужно собрать вручную один раз
(`npm run core:build`).
