# Клиентские модули и системы

Клиент — браузерное приложение на PixiJS (сборка Vite, шаблоны Pug в [src/client/views/](../src/client/views/)). Точка входа — [src/client/main.js](../src/client/main.js).

## main.js — бутстрап, диспетчер и рендер-цикл

- **Бутстрап**: создаёт `SignalingClient`, подключается к мастеру; по `welcome` поднимает лобби (`initLobby`). Выбор сервера → `connectToHost` создаёт `WebRtcManager` и устанавливает P2P.
- Ветвит входящие пакеты хоста (`handleMessage`) по типу данных: строка → JSON `[portId, payload]` → обработчик `socketMethods[portId]`; `ArrayBuffer` → `unpackFrame` → буфер `SnapshotInterpolator` (несовпадение версии — кадр отброшен).
- По `CONFIG_DATA` (порт 0) инициализирует все модули: PixiJS `Application`-ы, MVC-компоненты, `BakingProvider` (запекание текстур), `SoundManager`, предикторы; отвечает `CONFIG_READY`.
- Первый кадр (`FIRST_SHOT_DATA`, порт 4) применяется немедленно, минуя буфер интерполяции.
- **Рендер-цикл** `renderTick` на `Ticker.shared` (rAF): `sample()` интерполятора → применение кадров/интерполяции → предсказание своего танка поверх (`applyGameData`) → камера.
- Сбросы: смена карты (`MAP_DATA`) и `CLEAR` очищают буфер интерполяции и предикторы.
- **Разрыв P2P** (`handleDisconnect`): выход хоста = смерть комнаты (host-migration нет) — останавливает рендер-тик и `Application`-ы, показывает заглушку и возвращает в лобби перезагрузкой.

## Сетевой слой (src/client/network/, Этап 3)

Игровой транспорт — WebRTC, а не WebSocket (детали каналов — [network.md](network.md#транспорт-этап-3-webrtc-вместо-websocket)):

- **`SignalingClient`** — тонкая обёртка сигнального WebSocket мастера: `connect()`, кэш `id`/`iceServers` из `welcome`, ретрансляция входящих сообщений подписчикам по полю `type` (через `Publisher`), методы `sendOffer`/`sendIceCandidate`/`pingHost`/`reportHost`. Транспорт инъектируется фабрикой ради тестов.
- **`WebRtcManager`** — P2P-соединение с хостом: `RTCPeerConnection` + каналы `meta` (reliable-ordered) и `state` (unreliable-unordered). Клиент — offerer: создаёт каналы/оффер, обменивается SDP/ICE через `SignalingClient`. События `Publisher`: `open` (оба канала открыты), `message` (данные из любого канала одним потоком), `close` (разрыв). `RTCPeerConnection` инъектируется фабрикой ради тестов.

Роль клиента выбирается в лобби (`src/client/main.js`): **присоединиться** (`connectToHost` → `WebRtcManager`, offerer) или **создать сервер** (`connectAsHost` → браузерный хост в этой же вкладке). Для хоста игровой транспорт — **`LoopbackTransport`** (Этап 4): тот же интерфейс, что у `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные ходят через `HostController` → Web Worker постмесседжами, минуя WebRTC. Клиентский код при этом одинаков — транспорт прозрачен. Детали — [host.md](host.md).

## MVC-компоненты (src/client/components/)

Девять троек `model/` + `view/` + `controller/`: **Auth**, **Lobby**, **CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**, **Stat**, **Vote**.

**Lobby** (Этап 3) — экран выбора сервера ДО подключения к хосту:

- **model** — реестр серверов (ответы `GET /servers` мастера), пагинация, поиск, умный пинг. I/O не делает: публикует `fetch` (запросить REST), `ping-request` (сигнальный ping), `join` (выбран сервер), `list`/`ping-update` (для view). `latency` живёт отдельно от списка и переживает refresh/пагинацию.
- **view** — рендер карточек, поиск, «Загрузить ещё»; **умный пинг** через `IntersectionObserver`: карточка в видимой зоне → `visible` → контроллер шлёт `ping_host`; `pong` обновляет задержку и пересортировывает карточки по возрастанию. `IntersectionObserver` инъектируется ради тестов.
- **controller** — проксирует view-события в модель; дросселирование пинга — в модели (`pingHost` возвращает `false`, если сервер пинговали недавно, интервал `pingInterval`).

Конфиг — [src/config/lobby.js](../src/config/lobby.js) (бандлится в сборку, т.к. лобби проходит до подключения к хосту). Замер пинга **приблизительный** (клиент→мастер→хост, не P2P RTT) — так и подаётся в UI.

Publisher-паттерн связей внутри тройки:

- `main.js` или `view` → методы `controller` вызываются **напрямую**;
- `controller` → методы `model` вызываются **напрямую**;
- `model` → `view` — **через `Publisher`** ([src/lib/Publisher.js](../src/lib/Publisher.js)): модель публикует событие, view подписана; на модель могут подписываться и внешние подписчики.

Назначение компонентов:

- **Auth** — форма входа (имя, модель), клиентская валидация (`validators.js`), localStorage.
- **CanvasManager** — управляет несколькими PixiJS `Application` одновременно: `vimp` (основной игровой canvas) и `radar` (мини-карта). Адаптивное масштабирование (эталон 1920px), `aspectRatio`/`fixSize`/`baseScale`, динамическая камера (look-ahead, zoom от скорости) и тряска — параметры в [configuration.md](configuration.md#modulescanvasmanager--полотна-и-камера).
- **Controls** — перехват клавиатуры (`InputListener`), активный набор клавиш диктует сервер (порт 17), режимы `chat`/`vote`/`stat`, отправка ввода `"seq:action:name"`.
- **Game** — ядро рендеринга: `GameCtrl.parse(name, data)` создаёт/обновляет/удаляет экземпляры сущностей по снапшот-данным через `Factory`.
- **Chat** — вывод сообщений (лимит строк, время жизни), командная строка; экранирование на выводе (`textContent`).
- **Panel** — HUD: время раунда, здоровье, боезапас, активное оружие (по строкам `'ключ:значение'`).
- **Stat** — таблицы scoreboard с сортировкой (`sortList`), показывается по Tab.
- **Vote** — окна голосований из шаблонов, пагинация, таймер жизни.

## Сетевая плавность (Фазы 5a–5c)

### SnapshotInterpolator

[src/client/SnapshotInterpolator.js](../src/client/SnapshotInterpolator.js) — кадры порта 5 не применяются немедленно, а буферизуются; мир рендерится в прошлом:

- серверное время оценивается EMA-оффсетом (`serverTime − localNow`), `renderTime = serverNow − delay` (конфиг `interpolation.delay: 100` мс);
- `sample()` выдаёт пересечённые `renderTime` кадры **целиком ровно один раз** (события `w1`/`w2e`, создания/удаления, reset/shake камеры), а непрерывные величины интерполирует между соседними кадрами: танки `m1` (x/y/vx/vy/engineLoad — `lerp`, углы — `lerpAngle` из [src/lib/math.js](../src/lib/math.js)), динамика карты `c1`/`c2`, камера;
- классификация ключей — по `kind` из `SNAPSHOT_KEYS` (`opcodes.js`); экстраполяции нет — hold на последнем кадре; буфер сбрасывается при смене карты и `CLEAR`;
- **вставка по `seq`** (Этап 3): транспорт `state`-канала не гарантирует порядок и доставку — `push(..., seq)` вставляет кадр по `seq` с дедупликацией; события опоздавшего reliable-кадра (его `serverTime` уже позади `renderTime`) выдаются немедленно следующим `sample()`, «ровно один раз» сохраняется.

### TankPredictor

[src/client/TankPredictor.js](../src/client/TankPredictor.js) — client-side prediction своего танка:

- локальная реплика серверной модели движения (`Tank.updateData` без Rapier-коллизий) фикс-шагом `timeStep`; параметры реплики приходят в конфиге порта 0 (`prediction`: timeStep/playerKeys/models/weapons);
- ввод пишется в локальную историю (`{time, keysMask, oneShotMask}`) и уходит на сервер как `"seq:action:name"`;
- **reconciliation**: из player-блока кадра (`gameId`, `lastInputSeq`, точное состояние) состояние := серверное → replay истории ввода от `serverTime` кадра до оценки серверного «сейчас»; расхождение уходит в `visualError` и экспоненциально затухает (снап при большом расхождении);
- рендер: предсказанное состояние перекрывает интерполяцию тем же `parse`-конвейером, камера следует предсказанной позиции;
- сбросы: `camera[2]` (respawn/телепорт), смена keySet, смена карты; при `condition 0` (смерть) предикт заморожен.

⚠️ Точность реплики фиксирует паритет-тест `tests/server/TankPredictorParity.test.js` (реальный Rapier против реплики). Порядок интеграции (эмпирический, закреплён тестом): импульсы → интеграция позиций скоростью до демпфирования → damping `v *= 1/(1+dt·d)`.

### ShotPredictor

[src/client/ShotPredictor.js](../src/client/ShotPredictor.js) — немедленный визуальный спавн снарядов своего танка:

- при нажатии fire трассер (`w1`) и бомба (`w2`) спавнятся сразу (вместе со звуком); физика, урон и взрыв (`w2e`) — серверные;
- `tryFire` реплицирует серверный гейт: кулдаун `fireRate`, патроны из панели, активное оружие (локальный цикл `nextWeapon`/`prevWeapon` + авторитетный `'wa'`), формулы `Tank.getMuzzlePosition`/`getFireDirection`;
- конечная точка трассера — приближённый raycast ([src/lib/raycast.js](../src/lib/raycast.js)): `rayVsGrid` (DDA по тайлам стен) + `rayVsBox` (динамика карты и танки) по интерполированным позициям;
- **гейт для бомбы**: следующий выстрел типа `explosive` разрешается только после подтверждения предыдущего сервером — исключает FIFO-рассинхрон при высоком RTT;
- **RTT-компенсация позиции**: при спавне бомбы локальная позиция экстраполируется на `velocity × (RTT/2)` (оценка из `interpolator.offset`), чтобы совпасть с серверной позицией в момент обработки команды;
- **подавление серверных дублей** (`filterServerSnapshot`) по id автора в данных события (`tracers[7]`, `bombs[5]`): свои трассеры — FIFO pending-очередь с таймаутом 2 с; своя бомба — при подтверждении локальная сущность (`L<n>`) убирается, серверная становится авторитетной (локальный ключ `L<n>` не пересекается с base36-ключами сервера).

## Рендеринг

### parts/ — сущности

[src/client/parts/](../src/client/parts/) — классы, отрисовываемые на PixiJS-полотнах: `Tank` (один класс и для своего, и для чужих танков), `TankRadar`, `Map`, `MapRadar`, `Bomb`, `Smoke`, `Tracks` (+`TrackMark`), `ParticlePool`. Эффекты — в `parts/effects/` (`BaseEffect`, `explosion/` — взрыв/воронка/дым, `shot/` — трассер/попадание), анимируются на `Ticker.shared`.

Соответствие снапшот-ключей классам и распределение по полотнам — `gameSets`/`entitiesOnCanvas` в `client.js`. Фиксированного контракта у part нет — при создании новой смотреть существующие как образец.

### Factory

[src/lib/factory.js](../src/lib/factory.js) — реестр имя сущности → класс. `GameCtrl.parse(name, data)` по входным данным создаёт экземпляр, вызывает `update(data)` существующего или удаляет (`null`).

### Провайдеры

- **`BakingProvider`** ([providers/BakingProvider.js](../src/client/providers/BakingProvider.js)) — однократная генерация процедурных текстур при старте по конфигу `bakedAssets`; функции запекания — в [providers/bakers/](../src/client/providers/bakers/) (фиксированного интерфейса нет, ориентироваться на существующие).
- **`DependencyProvider`** — инъекция сервисов (`renderer`, `soundManager`) в компоненты по карте `componentDependencies`.

## SoundManager

[src/client/SoundManager.js](../src/client/SoundManager.js) (на Howler.js). Звуки описаны в `src/config/sounds.js`.

- **UI/системные** (без позиции): `playSystemSound(name)` — немедленно, в обход приоритетов (используется и для звуков порта 6).
- **Пространственные** (позиция в мире): `registerSound(name, { position })` → `processAudibility()` → `updateActiveSounds()` — менеджер сам решает, что слышно, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и приоритеты из конфига.

## InputListener

[src/client/InputListener.js](../src/client/InputListener.js) — низкоуровневый перехват keydown/keyup для Controls; `modes`/`cmds` имеют приоритет над игровым набором клавиш.

## Иерархия UI (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9). Лобби (`#lobby`, z-index 8) — стартовый экран выбора сервера, показывается до подключения к хосту и скрывается при входе в игру.
