# Клиентские модули и системы

Клиент — браузерное приложение на PixiJS (сборка Vite, шаблоны Pug в [src/client/views/](../../src/client/views/)). Точка входа — [src/client/main.js](../../src/client/main.js).

## main.js — бутстрап, диспетчер и рендер-цикл

- **Бутстрап**: создаёт `SignalingClient`, подключается к мастеру; по `welcome` поднимает лобби (`initLobby`). Выбор сервера → `connectToHost` создаёт `WebRtcManager`, устанавливает P2P и запоминает `currentHostId` (для `/ban`).
- **Соц-модерация `/ban`**: исходящий чат идёт через `handleChatSend` — он перехватывает `/ban <причина>` и вместо отправки хосту (порт `CHAT_DATA`) шлёт жалобу напрямую мастеру (`signaling.reportHost(currentHostId, reason)`), минуя хоста-читера. Причина обязательна, доступно только гостю (`currentHostId` есть); у хоста-игрока команда даёт локальную подсказку; при разорванном сигнальном WS — честное сообщение об ошибке (жалоба не отправлена). Мастер дополнительно принимает жалобу только от сессии, реально подключавшейся к комнате — см. [master.md](master.md#соц-модерация-ban). Остальной чат — хосту как обычно.
- Ветвит входящие пакеты хоста (`handleMessage`) по типу данных: строка → JSON `[portId, payload]` → обработчик `socketMethods[portId]`; `ArrayBuffer` → `clientCore.push_frame` (распаковка, вставка в буфер по seq и reconciliation предикта — в ядре; несовпадение версии — кадр отброшен).
- По `CONFIG_DATA` (порт 0) инициализирует все модули: PixiJS `Application`-ы, MVC-компоненты, `BakingProvider` (запекание текстур), `SoundManager` и **клиентское ядро** (`await init()` WASM + `new ClientCore(...)`, конфиг собирает [src/lib/clientCoreConfig.js](../../src/lib/clientCoreConfig.js) из секций `prediction`/`interpolation` CONFIG_DATA); отвечает `CONFIG_READY`.
- Первый кадр (`FIRST_SHOT_DATA`, порт 4) применяется немедленно (`applyShot`), минуя ядро.
- **Рендер-цикл** `renderTick` на `Ticker.shared` (rAF): `clientCore.sample(now)` → чтение плоского hot-буфера zero-copy из памяти WASM (танки/динамика/камера/предсказанный танк) + `take_frames()` для редких событийных кадров → применение прежним `parse`-конвейером (см. «Клиентское ядро» ниже).
- Сбросы: смена карты (`MAP_DATA` → `set_map`) и `CLEAR` (→ `reset`) очищают буфер кадров и предикт в ядре.
- **Разрыв P2P** (`handleDisconnect`): выход хоста = смерть комнаты (host-migration нет) — останавливает рендер-тик и `Application`-ы, показывает заглушку и возвращает в лобби перезагрузкой. Терминальная причина закрытия, уже показанная tech-informer'ом (кик, полная комната — любые коды, кроме `loading`), общим сообщением «Host left…» не затирается; причину Worker хоста доставляет `TECH_INFORM_DATA`-сообщением непосредственно перед закрытием канала (см. [network.md](network.md#rtt-pingpong-и-кики)). `techInformList` имеет дефолт из бандла (`src/config/clientDefaults.js`) — отказ полной комнаты приходит до `CONFIG_DATA`.
- **Отсутствие WebRTC** (`ensureWebRtcAvailable`): если `RTCPeerConnection` недоступен (Firefox с `media.peerconnection.enabled = false`, resistFingerprinting и т.п.), `connectToHost`/`connectAsHost` показывают честное сообщение и не покидают лобби вместо падения с чёрным экраном.
- **Роль хоста**: `connectAsHost` перед стартом Worker'а фетчит каталог карт мастера (fallback на бандл), после `ready` регистрирует комнату и держит heartbeat; сигнальный WS хоста при разрыве переподключается с бэкоффом (`lobbyConfig.reconnect`) и заново регистрирует комнату (повторный `welcome` лобби не пересоздаёт — guard в `initLobby`). Сбой инициализации Worker'а (`error`) гасит комнату с сообщением и возвращает в лобби.

## Сетевой слой (src/client/network/)

Игровой транспорт — WebRTC, а не WebSocket (детали каналов — [network.md](network.md#транспорт-webrtc)):

- **`SignalingClient`** — тонкая обёртка сигнального WebSocket мастера: `connect()`, кэш `id`/`iceServers` из `welcome`, ретрансляция входящих сообщений подписчикам по полю `type` (через `Publisher`), методы `sendOffer`/`sendIceCandidate`/`pingHost`/`reportHost`. Транспорт инъектируется фабрикой ради тестов.
- **`WebRtcManager`** — P2P-соединение с хостом: `RTCPeerConnection` + каналы `meta` (reliable-ordered) и `state` (unreliable-unordered). Клиент — offerer: создаёт каналы/оффер, обменивается SDP/ICE через `SignalingClient`. События `Publisher`: `open` (оба канала открыты), `message` (данные из любого канала одним потоком), `close` (разрыв). `RTCPeerConnection` инъектируется фабрикой ради тестов.

Роль клиента выбирается в лобби (`src/client/main.js`): **присоединиться** (`connectToHost` → `WebRtcManager`, offerer) или **создать сервер** (`connectAsHost` → браузерный хост в этой же вкладке). Для хоста игровой транспорт — **`LoopbackTransport`**: тот же интерфейс, что у `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные ходят через `HostController` → Web Worker постмесседжами, минуя WebRTC. Клиентский код при этом одинаков — транспорт прозрачен.

Хост-вкладка дополнительно поднимает главнопоточную инфраструктуру роутинга (главный поток — не Worker): **`HostController`** спавнит Worker с ядром и мостит его с транспортами; **`HostConnectionManager`** — **WebRTC-answerer** удалённых клиентов (зеркало `WebRtcManager`): слушает `webrtc_offer` через `SignalingClient`, на каждого создаёт `RTCPeerConnection`, ловит каналы `meta`/`state` в `ondatachannel`, шлёт `webrtc_answer`+ICE, регистрирует комнату у мастера (`register_host`/heartbeat) и отвечает на лобби-пинг (`ping_host`). Данные удалённых клиентов идут в тот же Worker, что и loopback хоста-игрока. Детали — [host.md](host.md).

## MVC-компоненты (src/client/components/)

Девять троек `model/` + `view/` + `controller/`: **Auth**, **Lobby**, **CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**, **Stat**, **Vote**.

**Lobby** — экран выбора сервера ДО подключения к хосту:

- **model** — реестр серверов (ответы `GET /servers` мастера), пагинация, поиск, умный пинг. I/O не делает: публикует `fetch` (запросить REST), `ping-request` (сигнальный ping), `join` (выбран сервер), `list`/`ping-update` (для view). `latency` живёт отдельно от списка и переживает refresh/пагинацию.
- **view** — рендер карточек, поиск, «Загрузить ещё»; **умный пинг** через `IntersectionObserver`: карточка в видимой зоне → `visible` → контроллер шлёт `ping_host`; `pong` обновляет задержку и пересортировывает карточки по возрастанию. `IntersectionObserver` инъектируется ради тестов.
- **controller** — проксирует view-события в модель; дросселирование пинга — в модели (`pingHost` возвращает `false`, если сервер пинговали недавно, интервал `pingInterval`).

Конфиг — [src/config/lobby.js](../../src/config/lobby.js) (бандлится в сборку, т.к. лобби проходит до подключения к хосту). Замер пинга **приблизительный** (клиент→мастер→хост, не P2P RTT) — так и подаётся в UI.

Publisher-паттерн связей внутри тройки:

- `main.js` или `view` → методы `controller` вызываются **напрямую**;
- `controller` → методы `model` вызываются **напрямую**;
- `model` → `view` — **через `Publisher`** ([src/lib/Publisher.js](../../src/lib/Publisher.js)): модель публикует событие, view подписана; на модель могут подписываться и внешние подписчики.

Назначение компонентов:

- **Auth** — форма входа (имя, модель), клиентская валидация (`validators.js`), localStorage.
- **CanvasManager** — управляет несколькими PixiJS `Application` одновременно: `vimp` (основной игровой canvas) и `radar` (мини-карта); canvas-элементы генерирует `main.js` из конфига канвасов игры (`modules.canvasManager.canvases`, включая стартовые `width`/`height`) — в HTML их нет. Адаптивное масштабирование (эталон 1920px), `aspectRatio`/`fixSize`/`baseScale`, динамическая камера (look-ahead, zoom от скорости) и тряска — параметры в [configuration.md](configuration.md#modulescanvasmanager--полотна-и-камера).
- **Controls** — перехват клавиатуры (`InputListener`), активный набор клавиш диктует сервер (порт 17), режимы `chat`/`vote`/`stat`, отправка ввода `"seq:action:name"`.
- **Game** — ядро рендеринга: `GameCtrl.parse(name, data)` создаёт/обновляет/удаляет экземпляры сущностей по снапшот-данным через `Factory`.
- **Chat** — вывод сообщений (лимит строк, время жизни), командная строка; экранирование на выводе (`textContent`).
- **Panel** — HUD: время раунда, здоровье, боезапас, активное оружие (по строкам `'ключ:значение'`). `PanelView` **генерирует DOM по схеме игры** (`modules.panel.elems`: порядок health → оружие → time) внутри движкового контейнера `#panel`; внешний вид ячеек — CSS игры.
- **Stat** — таблицы scoreboard с сортировкой (`sortList`), показывается по Tab. `StatView` **генерирует шапку и таблицы по схеме игры** (`modules.stat.params`: `columns` — подписи колонок, `bodies` — произвольное число команд) внутри контейнера `#stat`; цвета/подписи команд — CSS игры.
- **Vote** — окна голосований из шаблонов, пагинация, таймер жизни.

## Клиентское ядро (ClientCore)

Клиентская математика — интерполяция снапшотов, предикт своего танка,
визуальный спавн снарядов и распаковка кадров v3 — живёт в Rust-ядре
(`core/src/client/`, wasm-bindgen класс `ClientCore` из того же WASM-бинаря,
что `GameCore` хоста). JS-оболочка (`main.js`) только пересылает данные и
применяет результат к рендеру; ABI и раскладки — в [core.md](core.md#clientcore--клиентский-режим-ядра).

Поток данных:

- **Вход**: `handleMessage` передаёт бинарный кадр в `push_frame(bytes, now)` —
  ядро распаковывает (несовпадение версии — кадр отброшен), вставляет в буфер
  по `seq` с дедупликацией и, если кадр несёт player-блок, делает
  reconciliation предикта. Порты `MAP_DATA`/`PANEL_DATA`/`KEYSET_DATA`/`CLEAR`
  зеркалятся в `set_map`/`sync_panel`/`set_active`/`reset`; модель танка —
  `set_model` при авторизации.
- **Рендер-тик**: `sample(now)` возвращает длину плоского **hot-буфера** —
  `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` читается zero-copy
  (view пересоздаётся каждый тик: рост памяти WASM детачит buffer). Буфер несёт
  флаги, камеру (уже разрешённую: предсказанная позиция либо интерполированная),
  интерполированные записи танков/динамики и predicted-запись своего танка
  последней. Адаптер `reconstructHot` (~40 строк в `main.js`) собирает из него
  объект прежней формы `{ m1: { id: [...] }, c1: {...} }` и отдаёт в
  существующий `applyGameData` — GameCtrl/parts не менялись; predicted-запись
  перекрывает свой танк тем же конвейером.
- **Событийные кадры** (флаг `hasFrames`): `take_frames()` отдаёт JSON-массив
  `[{ game, camera }, …]` — пересечённые `renderTime` кадры целиком ровно один
  раз (события `w1`/`w2e`, создания/удаления, reset/shake камеры), уже с
  подавленными дублями своих выстрелов; применяются прежним `applyShot`.
  Звук и эффекты триггерятся, как и раньше, самими parts при создании
  сущностей — отдельного eventId-диспетчера нет.
- **Ввод**: `apply_input(action, name, now)` пишет историю предикта; игровые
  действия идут через хук `ClientPlugin.hooks.onLocalAction` (`try_fire(now)` —
  гейты кулдауна/патронов/pending-бомбы/жив внутри ядра — возвращает JSON
  спавна для `applyGameData`; `nextWeapon`/`prevWeapon` — `cycle_weapon`).
  Отправка хосту `"seq:action:name"` не изменилась.

**ClientPlugin танков** (`games/tanks/src/client/index.js`, временная
статическая композиция до этапа 6): игровые методы ядра зовутся только из его
хуков — `onAuth` (`set_model` при авторизации), `onPanel` (`sync_panel` на
кадр панели), `onLocalAction` (`try_fire`/`cycle_weapon`); `main.js` игровых
методов ядра не знает. Игровой CSS (ячейки панели, полотна, цвета команд) —
`games/tanks/src/client/tanks.css`, движковый каркас UI — `src/client/style.css`.

Внутри ядро реализует следующие алгоритмы:

- **интерполяция** (`client/interpolator.rs`): EMA-оффсет серверного времени,
  `renderTime = serverNow − delay` (конфиг `interpolation.delay: 100` мс),
  лерп танков/динамики/камеры (углы — по кратчайшему пути), дискретные поля из
  опорного кадра, hold без экстраполяции, вставка по `seq` + немедленная выдача
  событий опоздавших кадров;
- **предикт** (`client/predictor.rs`): реплика авторитетного движения без
  Rapier-коллизий фикс-шагом `timeStep`; формулы тика **общие** с
  `Tank::update` (`core/src/motion.rs`) — реплика не может разойтись с
  авторитетным путём по формулам, паритет интеграции (ручная против Rapier)
  закрепляют cargo-тесты `client_parity`; история ввода, replay от `serverTime`
  кадра, `visualError` с экспоненциальным затуханием и снапом, freeze при
  `condition 0`, сброс по forceReset камеры/смене карты/keySet;
- **спавн снарядов** (`client/shot.rs` + `client/raycast.rs`): реплика
  авторитетного гейта и формул дула, DDA-raycast по тайлам стен + OBB-тест по
  динамике и танкам, гейт одной pending-бомбы, RTT-компенсация позиции бомбы,
  подавление авторитетных дублей по id автора (`tracers[7]`, `bombs[5]`,
  FIFO с таймаутом 2 с, локальные ключи `L<n>`). Разброс трассера использует
  клиентский PRNG, не синхронизированный с хостом — визуальный эффект,
  авторитетный трассер приходит кадром.

## Рендеринг

### parts/ — сущности

[src/client/parts/](../../src/client/parts/) — классы, отрисовываемые на PixiJS-полотнах: `Tank` (один класс и для своего, и для чужих танков), `TankRadar`, `Map`, `MapRadar`, `Bomb`, `Smoke`, `Tracks` (+`TrackMark`), `ParticlePool`. Эффекты — в `parts/effects/` (`BaseEffect`, `explosion/` — взрыв/воронка/дым, `shot/` — трассер/попадание), анимируются на `Ticker.shared`.

Соответствие снапшот-ключей классам и распределение по полотнам — `gameSets`/`entitiesOnCanvas` в `client.js`. Фиксированного контракта у part нет — при создании новой смотреть существующие как образец.

### Factory

[src/lib/factory.js](../../src/lib/factory.js) — реестр имя сущности → класс. `GameCtrl.parse(name, data)` по входным данным создаёт экземпляр, вызывает `update(data)` существующего или удаляет (`null`).

### Провайдеры

- **`BakingProvider`** ([providers/BakingProvider.js](../../src/client/providers/BakingProvider.js)) — однократная генерация процедурных текстур при старте по конфигу `bakedAssets`; функции запекания — в [providers/bakers/](../../src/client/providers/bakers/) (фиксированного интерфейса нет, ориентироваться на существующие).
- **`DependencyProvider`** — инъекция сервисов (`renderer`, `soundManager`) в компоненты по карте `componentDependencies`.

## SoundManager

[src/client/SoundManager.js](../../src/client/SoundManager.js) (на Howler.js). Звуки описаны в `games/tanks/src/config/sounds.js`.

- **UI/системные** (без позиции): `playSystemSound(name)` — немедленно, в обход приоритетов (используется и для звуков порта 6).
- **Пространственные** (позиция в мире): `registerSound(name, { position })` → `processAudibility()` → `updateActiveSounds()` — менеджер сам решает, что слышно, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и приоритеты из конфига.

## InputListener

[src/client/InputListener.js](../../src/client/InputListener.js) — низкоуровневый перехват keydown/keyup для Controls; `modes`/`cmds` имеют приоритет над игровым набором клавиш.

## Иерархия UI (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9). Лобби (`#lobby`, z-index 8) — стартовый экран выбора сервера, показывается до подключения к хосту и скрывается при входе в игру.

---

[← Предыдущая: Rust-ядро](core.md) · [Следующая: Сетевой протокол →](network.md)
