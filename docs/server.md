# Серверные модули и системы

Сервер: Node.js + Express + `ws` + ViteExpress. Точка входа — [src/server/main.js](../src/server/main.js) (сборка конфигов, HTTP/HTTPS-сервер, подключение WebSocket-слоя). Обзор взаимодействия модулей — в [architecture.md](architecture.md).

> **Статус (P2P-миграция, Этап 4).** Легаси авторитетный сервер — **рабочий эталон поведения** до демонтажа после вехи Этапа 4. Мета-модули отсюда (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`, `TimerManager`, `CommandProcessor`, `VoteCoordinator`, `SocketManager`, `RTTManager`) переиспользуются браузерным хостом **без правок** через инъекцию — см. [host.md](host.md). Физику (`Game`/Rapier-compat) и ручную сборку снапшота хост заменяет на Rust-ядро ([core.md](core.md)) через `GameCoreAdapter`. Менять эти модули под нужды хоста нельзя, чтобы не разъехаться с эталоном.

## VIMP — фасад

[src/server/modules/VIMP.js](../src/server/modules/VIMP.js) (синглтон, ~530 строк) — wiring всех модулей + делегирование. Сам содержит только:

- **жизненный цикл соединения**: `createUser` (регистрация спектатора во всех модулях), `removeUser`, `mapReady`, `firstShotReady`, `sendMap` (прокси к RoundManager);
- **ввод**: `updateKeys(gameId, 'seq:action:name')` — сохраняет `lastInputSeq`, для наблюдателя переключает наблюдаемого игрока, для игрока передаёт в `Game.updateKeys`;
- **чат/голосования**: `pushMessage` (санитизация, лимит длины, `/команды` → CommandProcessor), `parseVote` (запросы списков `maps`/`teams`, смена карты/команды, приём голоса);
- **тик** `_onShotTick(dt)`: физика → боты → снапшот (`SnapshotManager.processTick`) → `packBody` один раз → per-user `packFrame` (камера + player-блок) → отправка кадра и меты (panel/stat/chat/vote — только при изменении);
- **мосты колбэков** `TimerManager`/`RTTManager`: кики за idle/задержку/пропуск пингов, рассылка пингов;
- `reportKill`, `triggerCameraShake`, `updateRTT`.

Бизнес-логика вынесена в менеджеры (ниже); зависимости передаются через конструкторы (DI).

## ParticipantManager — реестр участников

[src/server/player/](../src/server/player/) — **единый источник истины об участниках** (люди + боты):

- классы `Participant` (база: `gameId`, `name`, `model`, `team`, `teamId`, `status`) → `HumanParticipant` (`socketId`, `isReady`, `currentMap`, `isWatching`, `watchedGameId`, `forceCameraReset`, `pendingShake`, `lastActionTime`, `lastInputSeq`) и `BotParticipant` (ссылка на `BotController`);
- различение бот/человек — геттеры `isBot`/`isNetworked`, **не** по формату id: люди и боты делят единое числовое пространство id (генератор — наименьший свободный);
- API: `createHuman`/`createBot`/`remove`/`get`/`getAll`/`getHumans`/`getBots`/`getNetworkedReady` (готовые к рассылке), `checkName` (дедупликация имён), размеры команд (`getTeamSize`/`addToTeam`/`resetTeamSizes`), список активных для наблюдения (`addActive`/`removeActive`/`getActiveList`/`replaceWatched`), лимит `maxPlayers` (`totalCount`).

## Менеджеры core/

[src/server/core/](../src/server/core/) — логика, выделенная из VIMP:

### RoundManager

Раунды, команды, карты. Владеет состоянием: `currentMap`, `currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`.

- `createMap()` — остановка таймеров, сброс Panel/Stat/Vote и команд, пересоздание мира, `CLEAR` всем, все — в наблюдатели, рассылка карты, перезапуск таймеров, воссоздание ботов;
- `initiateNewRound()`/`_startRound()` — очистка активных, пересоздание карты в Game, применение отложенной смены команд, дефолтная панель, полный stat, keySet по статусу, респауны и создание танков;
- `changeTeam(gameId, team)` — с проверкой свободных респаунов (может вытеснить бота), grace-period в начале раунда, иначе — смена со следующего раунда;
- `changeName`, `changeMap` (голосование за карту от игрока), `forceChangeMap`, `onMapTimeEnd` (голосование за следующую карту по таймеру; если никто не проголосовал — продление текущей);
- `reportKill(victimId, killerId)` — статистика (фраги/смерти/friendly fire), перенос наблюдателей на убийцу, `_checkTeamWipe` → завершение раунда (победа команде, звуки victory/defeat, рестарт через `roundRestartDelay`);
- `setActive`/`setSpectator` — переводы игрок↔наблюдатель с отправкой keySet и панели.

### CommandProcessor

Парсинг чат-команд (сообщения, начинающиеся с `/`): `/name <ник>`, `/timeleft`, `/mapname`, `/nr` (новый раунд, **только в dev-режиме**), `/bot`:

```
/bot 5 team1   # создать 5 ботов в team1
/bot 10        # создать 10 ботов с равномерным распределением
/bot 0 team2   # удалить ботов team2
/bot 0         # удалить всех ботов
```

`/bot` доступен только активным игрокам; если активных людей больше одного — вместо немедленного исполнения запускается голосование (категория `botManagement`). Неизвестная команда — системное сообщение «Command not found».

### VoteCoordinator

Создание голосований поверх модуля `Vote`: `canCreateVote` (проверка кулдауна темы), `createVote` (payload + колбэк результата + список участников), `reset`. Кулдаун темы — `timeBlockedVote` (30 с).

## Game — физический мир

[src/server/modules/Game.js](../src/server/modules/Game.js) (синглтон) — авторитетная физика на **Rapier 2D** (`@dimforge/rapier2d-compat`, WASM). WASM инициализируется top-level await в [src/server/physics/rapier.js](../src/server/physics/rapier.js) — единственной точке импорта Rapier (все конструкторы остаются синхронными).

- **Фиксированный шаг**: `updateData(dt)` накапливает время и делает шаги ровно по `timeStep` (защита от «спирали смерти» при лагах); контакты собираются из `EventQueue` после каждого `world.step`;
- **игроки**: `createPlayer`/`removePlayer`/`updateKeys`/`getPosition`/`changePlayerData`/`getAlivePlayers`/`isAlive`; кеш данных для снапшота (`getPlayersData`), `getPredictionState(gameId)` — точное состояние танка для player-блока;
- **урон**: `applyDamage(target, shooter, weapon, value?)` — friendly fire по конфигу, тряска камеры, при смерти — `vimp.reportKill`;
- **снаряды**: реестр активных пуль/бомб, кольцевой буфер времени жизни, эффекты завершения (`w2e`), `getDynamicMapData` — динамика карты для снапшота;
- `clear()` — полная очистка мира (сначала карта и снаряды удаляют свои тела: повторный `removeRigidBody` крэшит Rapier WASM).

### Физические части (src/server/parts/)

- **`BaseModel`** — база моделей: очередь нажатых клавиш (`updateKeys`/`getKeysForProcessing`), геттеры `gameId`/`teamId`/`name`/`model`/`currentWeapon`.
- **`Tank`** — модель движения танка: импульсы газа/торможения, velocity-clamp к `maxForwardSpeed`/`maxReverseSpeed`, боковое сцепление (`lateralGrip`), поворот с учётом скорости, башня (`gunRotation`, центрирование), `getData()` → `[x, y, angle, gunRotation, vx, vy, engineLoad, condition, size, teamId]` (`condition`: 3/2/1/0 — состояние/смерть), `getMuzzlePosition`/`getFireDirection` — реплицируются клиентским `ShotPredictor`. ⚠️ Изменения `Tank.updateData` и коэффициентов `models.js` обязаны сопровождаться обновлением клиентской реплики — это ловит паритет-тест `tests/server/TankPredictorParity.test.js`.
- **`Bomb`** — физический снаряд `w2`: тело в мире Rapier, таймер детонации, взрыв с уроном по радиусу, данные для снапшота (с `ownerId`).
- **`Map`** — тела карты: статика из тайлов `physicsStatic`, динамические объекты `physicsDynamic` (передаются в снапшоте `c1`/`c2`), `destroyMap`.
- **`HitscanService`** — мгновенный расчёт выстрела `w1`: `world.castRay` (сенсоры исключены), урон цели, данные трассера `[startX, startY, endX, endY, bodyX, bodyY, wasHit, shooterId]`.

## Мета-модули

- **`Panel`** ([Panel.js](../src/server/modules/Panel.js)) — HUD per-user: значения из `game:panel` (health/w1/w2), `updateUser(gameId, param, value, op)` с накоплением `pendingChanges`, `processUpdates()` раз в тик снапшота отдаёт только изменения (строки `'ключ:значение'`, время раунда `t` — при смене секунды), `getFullPanel`/`getEmptyPanel`, `setActiveWeapon` (`wa`), `hasResources`/`getCurrentValue` — авторитетная проверка боезапаса.
- **`Stat`** ([Stat.js](../src/server/modules/Stat.js)) — scoreboard: строки (body) и итоги команд (head) по конфигу `game:stat`; `addUser`/`removeUser`/`moveUser`/`updateUser`/`updateHead`; `getLast()` — дельта за тик, `getFull()` — полное состояние (при входе).
- **`Chat`** ([modules/chat/](../src/server/modules/chat/)) — пользовательские сообщения и системные шаблоны ([systemMessages.js](../src/server/modules/chat/systemMessages.js)): `push` (общее), `pushSystem`/`pushSystemByUser` (шаблонные `'группа:номер:параметры'`), очереди `shift`/`shiftByUser`.
- **`Vote`** ([Vote.js](../src/server/modules/Vote.js)) — механика голосований: очередь (новое голосование во время активного не отклоняется, а ждёт), время жизни `voteTime`, пагинация списков (более 7 вариантов — страницы Back/More), разрешение ничьей случайным выбором, персональные выдачи (`pushByUser`/`shiftByUser`), `addInVote`, `getResult`.

## Инфраструктура

- **`TimerManager`** ([TimerManager.js](../src/server/modules/TimerManager.js)) — все таймеры игры: игровой цикл (`onShotTick`, ~120 Гц), раунд (`onRoundTimeEnd`), карта (`onMapTimeEnd`), RTT-пинги, проверка бездействия, отложенные вызовы (рестарт раунда, смена карты); `getRoundTimeLeft`/`getMapTimeLeft`.
- **`SnapshotManager`** ([SnapshotManager.js](../src/server/modules/SnapshotManager.js)) — троттлинг снапшотов: `processTick()` возвращает снимок мира только каждый `networkSendRate`-й тик, иначе `null`.
- **`RTTManager`** ([RTTManager.js](../src/server/modules/RTTManager.js)) — учёт пингов: `scheduleNextPing()` (кому слать и с каким id), `handlePong` (расчёт latency), колбэки кика при `maxLatency`/`maxMissedPings`.
- **`SocketManager`** ([socket/SocketManager.js](../src/server/socket/SocketManager.js)) — единственная точка отправки: JSON `_send(socketId, port, data)` и бинарная `sendShot(socketId, frameBuffer)`; типизированные методы (`sendConfig`, `sendMap`, `sendPanel`, `sendStat`, `sendChat`, `sendVote`, `sendKeySet`, `sendRoundStart`, `sendTechInform`, …) и `close` с техническим кодом. Составные отправки: `sendFirstShot` (первый кадр + полный stat + пустая панель + keySet 0), `sendPlayerDefaultShot`/`sendSpectatorDefaultShot`.
- **WebSocket-слой** ([socket/index.js](../src/server/socket/index.js)) — приём соединений: origin-проверка, `oneConnection`, очередь при полном сервере, поэтапная активация клиентских портов, маршрутизация входящих сообщений в VIMP. Подробности протокола — в [network.md](network.md).

## Боты (src/server/modules/bots/)

Боты функционально идентичны игрокам: та же запись в `ParticipantManager`, тот же `Tank` в Game, тот же путь `updateKeys`; отличие — источник ввода (AI вместо WebSocket) и отсутствие сокета.

- **`BotManager`** ([bots/index.js](../src/server/modules/bots/index.js) / `BotManager.js`) — создание/удаление ботов (записи — в ParticipantManager, здесь только контроллеры), `updateBots(dt)` в тике, `buildSpatialGrid`, подсчёты (`getBotCount`, `getBotCountForTeam`).
- **`BotController`** — ИИ одного бота: выбор цели, стрельба, вождение; данные берёт через `ParticipantManager`/`BotManager`, не через приватные поля VIMP.
- **`NavigationSystem`** + **`Pathfinder`** — построение маршрутов по сетке карты (поиск пути), обход препятствий.
- **`SpatialManager`** — пространственная сетка для быстрых запросов «кто рядом».

Добавляются командой `/bot` или голосованием; при нехватке респаунов для человека бот может быть вытеснен (см. RoundManager).
