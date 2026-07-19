# Браузерный хост

Браузерный хост разворачивает **авторитетную часть матча прямо во вкладке
создателя комнаты**: WASM-ядро симуляции (`core/`) и JS-мету — в Web Worker'е, а
`RTCPeerConnection`-роутер — в главном потоке. Это каноничная «серверная часть»
игры: легаси авторитетный WS-сервер (`src/server/`) полностью демонтирован.

Код хоста — `packages/engine/src/host/` (Worker + ядро + мета-модули `packages/engine/src/host/meta/`) и
`packages/engine/src/client/network/` (роутер главного потока + транспорты).

## Топология вкладки хоста

```
Вкладка хоста
├─ Главный поток (клиент + роутер)
│   ├─ client (packages/engine/src/client/main.js): рендер, предикт, звук — как обычный клиент
│   ├─ HostController: спавнит Worker, роутит пакеты Worker ↔ клиенты
│   ├─ LoopbackTransport: транспорт хоста-игрока (интерфейс WebRtcManager
│   │  поверх postMessage)
│   └─ HostConnectionManager: WebRTC-answerer для удалённых клиентов
│      (register_host, meta/state, бэкпрешер)
└─ Web Worker (packages/engine/src/host/host.worker.js): авторитетная симуляция
    ├─ GameCore (WASM, core/pkg-web)
    ├─ GameCoreAdapter: поверхность физики/ботов/упаковки поверх ядра
    └─ HostGame-фасад + мета packages/engine/src/host/meta/ (RoundManager, Participant-
       Manager, Chat, Vote, Stat, Panel, TimerManager, RTTManager,
       CommandProcessor, VoteCoordinator, SocketManager) + цикл ~120 Гц
```

Ключевое правило: `RTCPeerConnection` **живут в главном потоке** (в Worker их
создать нельзя), а игровой цикл — **в Worker'е** (его таймеры не троттлятся
браузером в фоновой вкладке, в отличие от главного потока). Главный поток —
дамб-пайп: пересылает wire-кадры между DataChannel/loopback и Worker'ом.

## Web Worker (`packages/engine/src/host/host.worker.js`)

Загружает WASM-ядро (`init()` + `GameCore` из `core/pkg-web`), строит `HostGame`
с настройками комнаты и держит per-client порт-машину — автомат клиентских
портов 0–8 (см. [network.md](network.md)). Сообщения главного потока:

- `init(room, handoff?)` — собирает конфиг игры (merge движковых дефолтов
  `packages/engine/src/config/hostDefaults.js` и `HostPlugin.gameConfig`) и
  применяет к нему настройки комнаты (`applyRoomOverrides`: имя/карта/лимит
  ≤ `roomDefaults.maxPlayers`/таймеры/friendly fire; карты —
  из `room.maps`, если главный поток скачал каталог мастера), инициализирует
  ядро, создаёт `HostGame`, отвечает `ready`; `handoff` — состояние эстафеты
  Worker'ов: комната восстанавливается вместо холодного старта. Сбой
  (WASM/конфиг/handoff-мета) — сообщение `error { message }`: при холодном
  старте главный поток гасит комнату и возвращает в лобби, при эстафете —
  возобновляет старый Worker;
- `connect(socketId)` — новый клиент: регистрирует wire-сокет в `SocketManager`,
  шлёт `CONFIG_DATA` (порт 0), запускает handshake config→auth→map→firstShot.
  **Полная комната** (`HostGame.isFull`, **люди** против `maxPlayers`; боты
  слот не занимают — при подключении человека сверх суммарного лимита один бот
  кикается, `_freeSlotForHuman`) — отказ: закрытие соединения кодом `4006`
  с причиной `roomFull` (очереди ожидания в P2P-комнате нет). Клиент из
  handoff-меты эстафеты восстанавливается минуя handshake — порт-машина
  поднимается сразу в игровом состоянии;
- `message(socketId, data)` — входящее сообщение клиента (`JSON [port, payload]`),
  диспетчеризуется по разрешённым портам;
- `disconnect(socketId)` — удаляет участника из игры и реестра;
- `update_maps(maps)` — обновлённый каталог карт мастера →
  `HostGame.updateMaps`;
- `prepare_handoff` / `resume` / `handoff_complete` — протокол эстафеты
  Worker'ов (см. одноимённый раздел ниже).

Обратно в главный поток Worker шлёт `to_client` (wire-кадр: JSON-строка или
бинарный `ArrayBuffer` через Transferable), `close_client`, `ready`,
`error` (сбой инициализации), `map_changed { mapName }` (смена карты
голосованием/таймером — главный поток актуализирует комнату у мастера) и
`handoff_state { state }` (эстафета: состояние комнаты на границе раунда).
Per-user **wire-сокет** (`makeWorkerSocket`) реализует контракт `SocketManager`
(`send`/`sendBinary`/`close`) поверх `postMessage`. Особенности транспорта:

- `close(code, data)`: закрытие data channel не несёт код/причину — причина
  (кик за бездействие/RTT, полная комната) доставляется отдельным
  `TECH_INFORM_DATA` по meta **до** `close_client` (reliable-ordered
  гарантирует порядок), клиент показывает её вместо общего «Host left»;
- `send(port, data, reliable)`: `reliable: false` уводит JSON-сообщение в
  ненадёжный state-канал — так ходит только `PING` (см. `network.md`).

Игровой цикл ~120 Гц стартует сам (конструктор `HostGame` → `RoundManager.createMap`
→ `TimerManager.startGameTimers`); кадры уходят только готовым к игре участникам.

## HostGame (`packages/engine/src/host/HostGame.js`)

Host-фасад — wiring модулей + жизненный цикл участников:

- симуляция/боты/упаковка снапшотов — в Rust-ядре через `GameCoreAdapter`;
- мета (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`,
  `TimerManager`, `RTTManager`, `CommandProcessor`, `VoteCoordinator`,
  `SocketManager`) — модули `packages/engine/src/host/meta/` (см. раздел «Мета-модули»),
  зависимости передаются через конструкторы (DI);
- горячий тик `_onShotTick` core-driven: `adapter.updateData(dt)` (шаг ядра +
  дренаж событий), троттлинг отправки (`SnapshotThrottle` — кадр каждый
  `networkSendRate`-й тик), `adapter.packBody()` один раз/тик, затем per-user
  `adapter.packFrame(...)` (ядро само собирает player-блок предикшена по
  `playerId`);
- **жизненный цикл соединения**: `createUser` (регистрация спектатора во всех
  модулях), `removeUser`, `mapReady`, `firstShotReady`, `sendMap` (прокси к
  RoundManager); **ввод** `updateKeys(gameId, 'seq:action:name')`; **чат и
  голосования** `pushMessage` (санитизация, `/команды` → CommandProcessor) и
  `parseVote`; мосты колбэков `TimerManager`/`RTTManager` (кики), `reportKill`,
  `triggerCameraShake`, `updateRTT`;
- **хост-игрок исключён из kick-политик** (idle- и RTT-кики): его loopback —
  сама комната, кик убил бы её для всех. `hostSocketId` приходит в опциях
  (из `lobbyConfig.create.hostSocketId`, значение `'local'` согласовано с
  `LoopbackTransport`); гости кикаются штатно;
- `isFull`/`maxPlayers` — гейт заполненности комнаты для порт-машины Worker'а:
  считаются только люди; боты уступают место (при входе игрока в полную
  команду бота кикает `RoundManager.changeTeam`, при подключении человека
  сверх суммарного лимита — `_freeSlotForHuman`);
- `updateMaps(maps)` — обновление каталога карт: `_maps`/`_mapList`
  правятся на месте (эти же ссылки держит `RoundManager` и голосования) —
  новые данные применяются со следующей смены карты, без правок `RoundManager`;
- смена карты отслеживается в тике (`onMapChange` → `map_changed` в главный
  поток) — лобби мастера видит актуальную карту комнаты;
- **эстафета Worker'ов**: `requestHandoff(cb)` (остановка игры и
  сбор handoff-меты на ближайшей границе раунда), `completeHandoff(socketIds)`
  (в новом Worker'е: кик не переподключившихся, возобновление таймеров, первый
  раунд), `resumeAfterHandoff()` (откат при сбое нового Worker'а), опция
  конструктора `handoff` (восстановление вместо холодного старта) — см. раздел
  «Эстафета Worker'ов».

Клиентский `CONFIG_DATA` (порт 0: базовый конфиг + время голосования + данные
prediction) собирает `packages/engine/src/lib/buildClientConfig.js`.

## GameCoreAdapter (`packages/engine/src/host/GameCoreAdapter.js`)

Реализует поверхность физики/ботов/упаковки, которую потребляют
`RoundManager`/`SocketManager`/`HostGame`, но за ней стоит `GameCore`:

- **жизненный цикл/физика** → ABI ядра: `createMap` → `load_map` (карта уже
  отмасштабирована в JS `RoundManager.scaleMapData`, поэтому грузится со
  `scale: 1` — ядро не масштабирует повторно); `createPlayer`/`removePlayer`
  различают scripted-участника и человека по `participant.isScripted`
  (`spawn_scripted_actor`/`remove_scripted_actor` — танк + ИИ в ядре — против
  `spawn_actor`/`remove_actor`); `changePlayerData` → `reset_actor`;
- **ввод** → `apply_input` (seq подтверждается ядром в player-блоке кадра);
- **проекция событий**: после `step` дренирует `take_events()` и отдаёт каждое
  событие инъецируемому игровому `eventRouter`'у
  (`games/tanks/src/host/coreEventRouter.js`) вместе с сервисами меты
  (`{ panel, vimp }`) — словарь типов событий принадлежит игре, адаптер его
  не знает. Роутер танков маппит `health`/`ammo` →
  `panel.updateUser(..., 'set')`, `activeWeapon` → `panel.setActiveWeapon`,
  `shake` → `HostGame.triggerCameraShake`, `kill` → `HostGame.reportKill`
  (здоровье/боезапас живут в ядре, панель — их проекция). Ядро оперирует
  числовыми id (u32), мета ключует строками — id событий роутер приводит к
  строкам на этой границе;
- **упаковка**: `packBody` → `pack_body`, `packFrame` → `pack_frame` +
  `frame_bytes` (копия из памяти WASM, работает и на web-, и на nodejs-таргете);
- **первый кадр**: `getPlayersData` → `players_data()` ядра (полный снапшот
  игроков без дренажа накопителей — для `FIRST_SHOT_DATA`).

`TanksBotManager` (`games/tanks/src/host/TanksBotManager.js`) — игровой
scripted-модуль: тонкий менеджер ботов, регистрация участников и связка со
`Stat`/`Panel` (ИИ, навигация и пространственная сетка — в ядре). Создаётся
фабрикой `createModules(ctx)` (`games/tanks/src/host/createModules.js` —
будущий `HostPlugin.createModules`); движок дергает контракт scripted-модуля:
`createMap`, `createBots(count, team?)`, `removeBots(team?)`,
`removeOneBotForPlayer(team)`, `getBots`, `getBotCount`,
`getBotCountsPerTeam`. Параметры — `scripted` из конфига игры
(`namePrefix`, `defaultModel`).

**HostPlugin танков** (`games/tanks/src/host/index.js`; импортируется движком
только через `gameRegistry.static.js` — временная статическая композиция до
этапа 6) — вся игровая половина хоста одним объектом:
`gameConfig`, `authSchema`, `coreEventRouter`, `chatCommands` (`/bot`),
`systemMessages` (группа `b:*`), `createModules` (scripted-модуль ботов),
`buildClientGameConfig()` (игровая половина CONFIG_DATA). Его потребляют
`host.worker.js` (конфиги/авторизация) и `HostGame` (роутер событий, команды,
коды, модули).

## Мета-модули (`packages/engine/src/host/meta/`)

JS-мета Worker'а: игровая логика поверх событий ядра. Модули инъекционны и
Worker-safe (только изоморфные API — `Date`/`Math`/`performance`/`setTimeout`/
`queueMicrotask`, никаких Node-глобалов).

### ParticipantManager — реестр участников (`meta/player/`)

**Единый источник истины об участниках** (люди + scripted-участники/боты):

- классы `Participant` (база: `gameId`, `name`, `model`, `team`, `teamId`,
  `status`) → `HumanParticipant` (`socketId`, `isReady`, `currentMap`,
  `isWatching`, `watchedGameId`, `forceCameraReset`, `pendingShake`,
  `lastActionTime`, `lastInputSeq`) и `BotParticipant`;
- различение scripted/человек — геттеры `isScripted`/`isNetworked`,
  **не** по формату id: люди и
  scripted-участники делят единое числовое пространство id (генератор —
  наименьший свободный);
- API: `createHuman`/`createScripted`/`remove`/`get`/`getAll`/`getHumans`/
  `getScripted`/`getNetworkedReady` (готовые к рассылке), `checkName`
  (дедупликация имён; имя scripted — `scripted.namePrefix` + id из конфига
  игры), размеры команд (`getTeamSize`/`addToTeam`/`resetTeamSizes`), список
  активных для наблюдения
  (`addActive`/`removeActive`/`getActiveList`/`replaceWatched`),
  лимит `maxPlayers` (`totalCount`).

### Менеджеры `meta/core/`

**RoundManager** — раунды, команды, карты. Владеет состоянием: `currentMap`,
`currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`.

- `createMap()` — остановка таймеров, сброс Panel/Stat/Vote и команд,
  пересоздание мира (в ядре через `GameCoreAdapter`), `CLEAR` всем, все — в
  наблюдатели, рассылка карты, перезапуск таймеров, воссоздание ботов;
- `initiateNewRound()`/`_startRound()` — очистка активных, пересоздание карты,
  применение отложенной смены команд, дефолтная панель, полный stat, keySet по
  статусу, респауны и создание танков;
- `changeTeam(gameId, team)` — с проверкой свободных респаунов (может вытеснить
  бота), grace-period в начале раунда, иначе — смена со следующего раунда;
- `changeName`, `changeMap` (голосование за карту от игрока), `forceChangeMap`,
  `onMapTimeEnd` (голосование за следующую карту по таймеру; если никто не
  проголосовал — продление текущей);
- `reportKill(victimId, killerId)` — статистика (фраги/смерти/friendly fire),
  перенос наблюдателей на убийцу, `_checkTeamWipe` → завершение раунда (победа
  команде, звуки victory/defeat, рестарт через `roundRestartDelay`);
- `setActive`/`setSpectator` — переводы игрок↔наблюдатель с отправкой keySet
  и панели.

**CommandProcessor** — парсинг чат-команд (сообщения, начинающиеся с `/`).
Движковое ядро: `/name <ник>`, `/timeleft`, `/mapname`, `/nr` (новый раунд,
**только в dev-режиме**); игровые команды регистрируются через
`registerCommand(name, handler)` и получают контекст меты —
`handler(ctx, gameId, args)`. У танков зарегистрирована `/bot`
(`games/tanks/src/host/botCommand.js`):

```
/bot 5 team1   # создать 5 ботов в team1
/bot 10        # создать 10 ботов с равномерным распределением
/bot 0 team2   # удалить ботов team2
/bot 0         # удалить всех ботов
```

`/bot` доступен только активным игрокам; если активных людей больше одного —
вместо немедленного исполнения запускается голосование (категория
`botManagement`). Неизвестная команда — системное сообщение «Command not
found». (`/ban` до хоста не доходит — клиент перехватывает её и шлёт жалобу
напрямую мастеру, см. [master.md](master.md).)

**VoteCoordinator** — создание голосований поверх модуля `Vote`:
`canCreateVote` (проверка кулдауна темы), `createVote` (payload + колбэк
результата + список участников), `reset`. Кулдаун темы — `timeBlockedVote`
(30 с).

### Модули `meta/modules/`

- **`Panel`** — HUD per-user: схема из `game:panel` (`fields` —
  health/w1/w2, `activeKey` — ключ активного оружия),
  `updateUser(gameId, param, value, op)` с накоплением `pendingChanges`,
  `processUpdates()` раз в тик снапшота отдаёт только изменения (строки
  `'ключ:значение'`, время раунда `t` — при смене секунды),
  `getFullPanel`/`getEmptyPanel`, `setActiveWeapon` (пишет `activeKey`
  схемы, у танков `wa`), `hasResources`/`getCurrentValue`. Авторитетные значения health/ammo живут в
  ядре — панель наполняется проекцией его событий (`GameCoreAdapter`).
- **`Stat`** — scoreboard: строки (body) и итоги команд (head) по конфигу
  `game:stat`; `addUser`/`removeUser`/`moveUser`/`updateUser`/`updateHead`;
  `getLast()` — дельта за тик, `getFull()` — полное состояние (при входе).
- **`Chat`** (`meta/modules/chat/`) — пользовательские сообщения и системные
  шаблоны (`systemMessages.js`): `push` (общее), `pushSystem`/`pushSystemByUser`
  (шаблонные `'группа:номер:параметры'`), очереди `shift`/`shiftByUser`.
  Реестр кодов — движковые группы `s`/`v`/`m`/`c`/`n`; игровые коды
  регистрируются через `registerCodes` (у танков — группа `b:*`,
  `games/tanks/src/host/systemMessages.js`); тексты шаблонов — на клиенте.
- **`Vote`** — механика голосований: очередь (новое голосование во время
  активного не отклоняется, а ждёт), время жизни `voteTime`, пагинация списков
  (более 7 вариантов — страницы Back/More), разрешение ничьей случайным
  выбором, персональные выдачи (`pushByUser`/`shiftByUser`), `addInVote`,
  `getResult`.
- **`TimerManager`** — все таймеры игры: игровой цикл (`onShotTick`, ~120 Гц),
  раунд (`onRoundTimeEnd`), карта (`onMapTimeEnd`), RTT-пинги, проверка
  бездействия, отложенные вызовы (рестарт раунда, смена карты);
  `getRoundTimeLeft`/`getMapTimeLeft`.
- **`RTTManager`** — учёт пингов: `scheduleNextPing()` (кому слать и с каким
  id), `handlePong` (расчёт latency, EMA), колбэки кика при
  `maxLatency`/`maxMissedPings`. Ping/pong ходят по ненадёжному state-каналу —
  замер не искажается ретрансмиссиями reliable-потока.

### SocketManager (`meta/SocketManager.js`)

Единственная точка отправки: JSON `_send(socketId, port, data, reliable)` и
бинарная `sendShot(socketId, frameBuffer, reliable)`; типизированные методы
(`sendConfig`, `sendMap`, `sendPanel`, `sendStat`, `sendChat`, `sendVote`,
`sendKeySet`, `sendGameInform`, `sendTechInform`, …) и `close` с техническим
кодом. Игровая параметризация — из конфига игры: `sendSoundCue(socketId, cue)`
маппит движковые события (`roundStart`/`victory`/`defeat`/`frag`/`death`) на
имена звуков игры по `soundCues`, `sendFirstVote` шлёт голосование
`initialVote` (у танков — выбор команды). Составные отправки: `sendFirstShot` (первый кадр + полный stat + пустая
панель + keySet 0), `sendPlayerDefaultShot`/`sendSpectatorDefaultShot`.
Транспорт абстрагирован: в Worker'е под ним wire-сокеты `postMessage`
(`makeWorkerSocket`), флаг `reliable` классифицирует каналы meta/state.

## Главный поток: роутер и транспорты (`packages/engine/src/client/network/`)

- **`HostController`** — спавнит Worker (по `workerUrl` из манифеста мастера;
  без него — бандловый `new Worker(new URL('host.worker.js'),
  { type: 'module' })`; фабрика инъектируется для тестов), шлёт `init(room)`,
  роутит `to_client`/`close_client` зарегистрированным клиентам и пересылает
  входящие сообщения в Worker. Общий для loopback и удалённых клиентов;
  `onReady` (Worker поднят) — момент регистрации комнаты у мастера (при
  эстафете повторно не вызывается); `swapWorker(url)` — эстафета Worker'ов
  (см. одноимённый раздел).
- **`LoopbackTransport`** — транспорт хоста-игрока: реализует интерфейс
  `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные
  ходят через `HostController` → Worker постмесседжами. Для клиентского кода
  транспорт прозрачен; флаг `reliable` игнорируется (loopback надёжен и
  упорядочен по определению).
- **`HostConnectionManager`** — WebRTC-answerer удалённых клиентов (зеркало
  `WebRtcManager`, который у клиента offerer). Через `SignalingClient`
  ловит `webrtc_offer`, на каждого клиента создаёт `RTCPeerConnection`,
  `ondatachannel` принимает каналы `meta`/`state`, шлёт `webrtc_answer` и
  обменивается ICE. Когда оба канала клиента открыты — поднимает его соединение
  в Worker'е (`HostController.open` → `connect`). Отвечает на сигнальный
  `ping_host` клиента (`pong_host` — замер задержки в лобби).

### Классификация каналов и бэкпрешер

Исходящий Worker-кадр раскладывается по каналам: **события → `meta`**
(reliable-ordered), **чистые позиции → `state`** (unreliable). Решение —
по флагу `reliable`, который `HostGame` вычисляет per-user:
`core.body_has_events()` (трассеры/бомбы/взрывы/удаления в теле, stateless-
геттер ядра — не меняет сигнатуру `pack_body`) ∨ `forceReset` камеры ∨
`shake`. JSON-протокол (порты `[portId, payload]`) — всегда по `meta`. Флаг
идёт через `SocketManager.sendShot(socketId, buffer, reliable)` → worker-сокет
→ `to_client` → answerer. **Бэкпрешер**: перед отправкой позиционного кадра
проверяется `bufferedAmount` state-канала; выше порога кадр дропается
(следующий компенсирует), `meta` не дропается никогда.

### Регистрация у мастера

По `onReady` хост шлёт `register_host` (имя/лимит/карта — фактическая карта
приходит из Worker'а в `ready`) и заводит heartbeat (`update_host` каждые
`lobbyConfig.create.heartbeatInterval` мс, меньше `heartbeatTimeout` мастера).
`currentPlayers` = 1 (хост-игрок) + число WebRTC-пиров, актуализируется при
входе/выходе клиента (`onPeersChange`); `mapName` — при смене карты
(`map_changed` из Worker'а). Выход хоста-игрока = смерть комнаты:
`handleDisconnect` гасит heartbeat, закрывает пиров (`HostConnectionManager.
destroy`) и Worker (`HostController.destroy`).

**Reconnect сигналинга**: сигнальный WS хоста должен жить постоянно (офферы,
heartbeat, выдача в списке) — при разрыве `main.js` переподключается с
экспоненциальным бэкоффом (`lobbyConfig.reconnect`), повторный `welcome`
вызывает re-register комнаты (новый `hostId` — приемлемо). Уже установленные
P2P-соединения разрыв сигналинга не рвёт. В ответе `host_registered` мастер
передаёт `mapsVersion` и `codeVersion` — расхождение с версиями, на которых
поднята комната, инициирует перечитывание каталога карт (см. ниже) /
эстафету Worker'ов.

### Динамические карты

Комната стартует на актуальных картах мастера, а не на вшитых в бандл:
`connectAsHost` фетчит `GET /maps/manifest.json` + все карты и передаёт их в
`init` Worker'а (`room.maps`; недоступность каталога некритична — fallback на
карты из бандла). Обновление на лету: `host_registered.mapsVersion` (после
reconnect) или сигнал `update_available` мастера → `refreshHostMaps` → fetch
каталога → `HostController.updateMaps` → Worker `update_maps` →
`HostGame.updateMaps`. Новые данные применяются **со следующей смены карты**
(штатный путь `RoundManager.createMap`: масштабирование в JS → `load_map` ядра
со `scale: 1`); список карт в голосованиях актуализируется сразу. Гости
изменений не требуют — карту им шлёт хост по порту 3.

### Эстафета Worker'ов

Обновление кода живой комнаты: при деплое новой версии Worker хоста заменяется
на новый бандл **без разрыва WebRTC-соединений** — `RTCPeerConnection` живут в
главном потоке и подмену Worker'а не замечают. Реализована **мягкая эстафета
на границе раунда**: ядро не дампится (мир и так пересоздаётся с нуля стартом
каждого раунда — `RoundManager._startRound`), переносится только JS-мета;
клиенты видят обычный старт раунда. `serialize_state`/`deserialize_state`
остаются в ABI ядра на будущее (mid-round handoff), в эстафете не участвуют.

**Обнаружение новой версии.** Worker комнаты создаётся по `url` из
`GET /worker/manifest.json` мастера (`lobbyConfig.worker.manifestUrl`) — Vite
хеширует имена ассетов, и после деплоя бандловый URL старой страницы исчезает
из раздачи; версия манифеста запоминается (`hostCodeVersion`). Деплой
рестартует мастер → сигнальный WS рвётся → штатный reconnect → re-register →
`host_registered.codeVersion` расходится с нашей → `refreshHostWorker()`:
повторный фетч манифеста → `HostController.swapWorker(url)`. Версия, своп на
которую не удался, запоминается и не ретраится на каждом re-register. Также
обрабатывается `update_available { codeVersion }` (push мастера, на будущее).
В dev манифест пуст (`version: null`) — обновления кода отключены, Worker
бандловый.

**Протокол свопа** (`HostController.swapWorker`):

1. старому Worker'у уходит `prepare_handoff` → `HostGame.requestHandoff`
   ставит колбэк в `RoundManager`; игра продолжается до ближайшей границы
   раунда (единая воронка `initiateNewRound`: таймер раунда, отложенный
   рестарт после team wipe, рестарт при смене команды);
2. на границе старый Worker останавливает игру (`stopGameTimers` + idle) и
   шлёт `handoff_state { state }`; с этого момента `HostController` буферизует
   входящие сообщения клиентов (очередь с капом);
3. главный поток создаёт новый Worker по URL новой версии и шлёт ему
   `init { room, handoff: state }` (в `room.maps` — актуальный каталог карт);
4. новый Worker восстанавливает комнату (см. ниже) и отвечает `ready` →
   `HostController` переподключает всех живых клиентов внутренними
   `connect`'ами (порт-машины поднимаются минуя handshake), доставляет
   накопленную очередь, шлёт `handoff_complete` и гасит старый Worker
   (`terminate`);
5. `handoff_complete` в новом Worker'е: `HostGame.completeHandoff` кикает
   восстановленных участников, чей `connect` не пришёл (отвалились в паузу),
   возобновляет таймеры (карта — с остатком времени, `TimerManager.
   startMapTimer(duration)`) и стартует первый раунд — клиенты получают
   штатные `sendClear`/респаун/старт раунда (`sendSoundCue`+`sendGameInform`).

**Handoff-мета** (`HostGame._collectHandoff`, формат версионирован —
`HANDOFF_VERSION`): участники-люди с `isReady` (gameId/socketId/имя/модель/
команда) и боты (с исходными gameId — единое числовое пространство
сохраняется), счёт `Stat` целиком, текущая карта + остаток её времени, `seq`
кадров (нумерация снапшотов продолжается — интерполятор клиентов не ломается).
**Осознанно не переносятся**: чат-история, активные голосования и кулдауны,
RTT-статистика, panel (здоровье/боезапас живут в ядре и сбрасываются стартом
раунда), не завершившие handshake гости (их строки в scoreboard вычищаются,
клиенту такой гость проходит handshake заново).

**Отказоустойчивость**: сбой init нового Worker'а (`error`: несовместимая
`HANDOFF_VERSION`, карта ушла из каталога, сбой WASM) или таймаут (15 с) →
новый Worker гасится, старому уходит `resume` (`resumeAfterHandoff`:
возврат таймеров + перезапуск прерванного раунда) — **комната продолжает жить
на прежней версии кода**, игроки ничего не замечают. Параллельные свопы
исключены (guard в `main.js` и в `HostController`).

В лобби (`packages/engine/src/client/main.js`):

- **присоединиться** — карточка сервера → `connectToHost(hostId)` →
  `WebRtcManager` (offerer);
- **создать сервер** — кнопка/имя в лобби (`#lobby-host`/`#lobby-name`,
  `packages/engine/src/config/lobby.js`) → `connectAsHost(room)` → `HostController` + Worker +
  `LoopbackTransport` (хост-игрок) + `HostConnectionManager` (удалённые клиенты)
  + регистрация у мастера.

Дальше клиентский код одинаков (транспорт абстрагирован). Выход хоста = смерть
комнаты (host-migration нет) — как и у обычного клиента: `handleDisconnect`
останавливает рендер и возвращает в лобби.

## Тесты

Тесты хоста и мета-модулей — `tests/host/`:

- `GameCoreAdapter.test.js` — юнит на фейковом ядре: маппинг команд на ABI,
  различение бот/человек, проекция событий в панель/фасад, флаги камеры.
- `HostGame.test.js` — интеграция поверх **реального** ядра (`pkg-node`,
  `describe.skipIf` без сборки): онбординг, активный игрок с player-блоком,
  движение, стрельба (трассер + боезапас), боты, `players_data`, `removeUser`
  (null-маркер в кадре), лимит комнаты (`isFull`), kick-исключение
  хоста-игрока, `updateMaps`/`onMapChange`, эстафета Worker'ов (сбор меты на
  границе раунда, восстановление участников/счёта/`seq`, `completeHandoff` с
  киком не переподключившихся, `resumeAfterHandoff`, отказ по несовместимой
  версии/ушедшей карте); бинарные кадры декодирует клиентское ядро
  (`ClientCore.decode_frame`; каркас — `tests/host/harness.js`
  с `FakeSocketManager`).
- `LoopbackTransport.test.js` — юнит на фейковом Worker: `HostController`
  (роутинг, очередь connect до `ready`, флаг `reliable`,
  `error`/`map_changed`/`updateMaps`; эстафета — `workerUrl`, буферизация на
  паузе, порядок connect/flush/`handoff_complete`, откат на старый Worker при
  `error`, guard параллельного свопа) и `LoopbackTransport`.
- `HostConnectionManager.test.js` — юнит на фейковых peer/каналах:
  оффер→answer, каналы meta/state, классификация reliable, бэкпрешер, ICE,
  сигнальный pong, закрытие, гонка open/close, cleanup при сбое SDP,
  нефатальность транзиентного `'disconnected'`.
- юнит-тесты мета-модулей: `RoundManager`, `CommandProcessor`,
  `VoteCoordinator`, `ParticipantManager` (включая `restoreHuman`/`restoreBot`
  эстафеты), `Chat`, `Vote`, `Stat` (включая `serialize`/`restore`), `Panel`,
  `TimerManager`, `RTTManager`, `SocketManager`.
- смежные: `tests/client/network/SignalingClient.test.js` (исходящие хоста —
  `register_host`/`update_host`/`webrtc_answer`/`pong_host`),
  `tests/core/core.test.js` (`body_has_events()` — классификация meta/state).

## Сборка

Worker грузит `core/pkg-web` (web-таргет ядра). Прод-сборка (`npm run build`)
собирает его сама (`core:build:web`) — сборка требует Rust-тулчейн (см.
[getting-started.md](getting-started.md), [deployment.md](deployment.md)). Для
dev `core/pkg-web` нужно собрать вручную один раз (`npm run core:build`).

## Ручной прогон (чек-лист)

Vitest не воспроизводит реальный WebRTC и его реордеринг, поэтому сквозная
проверка матча — ручная, в браузере:

```bash
npm run core:build     # web-таргет ядра для Worker (один раз)
npm run dev            # мастер: лобби + сигналинг, https://localhost:3002
```

Открыть `https://localhost:3002`, «Создать сервер» → хост-вкладка. Удалённые
клиенты — другие вкладки/машины: лобби → комната появляется в списке → вход.

Чек-лист:

- [ ] движение своего танка (prediction/reconciliation без рывков);
- [ ] стрельба `w1`/`w2`, урон, смерть и респаун, смена команды (`/bot`, меню);
- [ ] боты: спавн, патруль, бой (ИИ в ядре);
- [ ] чат, голосования (смена карты/команды), статистика, панель — обновляются;
- [ ] раунд: старт/таймер/победа команды/новый раунд;
- [ ] полный матч на 8 игроков + боты end-to-end;
- [ ] разрыв: выход хоста = смерть комнаты → удалённые клиенты редиректятся
      в лобби (`handleDisconnect`); host-migration нет.

**Эстафета Worker'ов** проверяется только на собранном `dist`
(в dev манифест кода пуст): `npm run build` → мастер в prod-режиме → создать
комнату + подключить гостя → внести правку в код хоста → `npm run build:app`
→ перезапустить мастер → дождаться reconnect/re-register хоста:

- [ ] на границе раунда комната переезжает на новый Worker (консоль:
      `[worker] room migrated to code version …`);
- [ ] P2P-соединения живы, гость видит обычный старт раунда;
- [ ] счёт scoreboard и имена сохранены, боты на месте, `/timeleft` карты
      продолжает отсчёт (не сброшен);
- [ ] чат/голосования работают после переезда.

---

[← Предыдущая: Мастер-сервер](master.md) · [Следующая: Rust-ядро →](core.md)
