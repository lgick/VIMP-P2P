# Конфигурация

Вся конфигурация проекта разделена на три уровня:

1. **Переменные окружения** (`.env`) — параметры инстанса мастер-сервера (домен, порт). Применяются только в production.
2. **`src/config/`** — общие конфиги, используемые мастером (Node.js), Worker'ом браузерного хоста и клиентом (Vite-бандл).
3. **`games/tanks/src/data/`** — статические игровые данные: карты, модели, оружие.

Мастер собирает свой конфиг в единое хранилище `src/lib/config.js` (доступ по пути с двоеточием) в [src/master/main.js](../../src/master/main.js); Worker хоста ([src/host/host.worker.js](../../src/host/host.worker.js)) собирает конфиг игры как merge движковых дефолтов (`hostDefaults`) и игрового конфига (`@vimp/tanks/config/game.js`), применяет поверх него настройки комнаты, а `client`/`auth`/`wsports` импортирует напрямую. Клиент получает свой конфиг (`client`) от хоста при подключении (порт `0`).

## Переменные окружения (.env)

Читаются в [src/master/main.js](../../src/master/main.js) при `NODE_ENV=production` (запуск `npm start` использует `node --env-file .env`). В режиме разработки игнорируются — действуют значения из `src/config/master.js`.

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | Домен мастера. **Обязательна** в production (иначе процесс завершится с ошибкой) | `localhost` |
| `VIMP_MASTER_PORT` | Порт мастер-сервера | `3002` |

Игровые параметры (карта, лимит игроков, таймеры, friendly fire) переменными окружения не задаются: их выбирает создатель комнаты в лобби, а дефолты живут в `src/config/hostDefaults.js` (движковые) и `games/tanks/src/config/game.js` (игровые).

## src/config/hostDefaults.js — движковые дефолты хоста

Источник: [src/config/hostDefaults.js](../../src/config/hostDefaults.js). Движковая половина конфига хоста: лимиты, таймеры, кик-политики, спектаторский keyset (наблюдение — механизм движка). Worker хоста merge'ит её с игровым конфигом танков и применяет поверх настройки комнаты; в этапе 6 плана статический merge заменит `HostPlugin.gameConfig`.

| Параметр | Значение | Описание |
| --- | --- | --- |
| `isDevMode` | `false` | Флаг режима разработки (открывает dev-команды чата) |
| `maxPlayers` | `30` | Дефолтный лимит участников; комната хоста ограничивает его настройкой создателя (кламп к `roomDefaults.maxPlayers` игры), лимит считается по людям |
| `chatMaxLength` | `60` | Максимальная длина сообщения чата (авторитетно на хосте; должна совпадать с `maxlength` инпута в `chat.pug`) |
| `spectatorKeys` | `nextPlayer`/`prevPlayer` | Команды наблюдателя и неактивного игрока (переключение наблюдаемого) |

### Таймеры (`timers`, мс)

| Параметр | Значение | Описание |
| --- | --- | --- |
| `timeStep` | `1000/120` | Шаг физического тика ядра (~120 Гц) |
| `networkSendRate` | `4` | Снапшот отправляется каждый N-й тик (4 → 30 пакетов/сек) |
| `roundTime` | `120000` | Время раунда |
| `mapTime` | `600000` | Время карты |
| `voteTime` | `10000` | Время жизни окна голосования |
| `timeBlockedVote` | `30000` | Кулдаун между голосованиями одной темы |
| `teamChangeGracePeriod` | `10000` | Окно смены команды в начале раунда |
| `roundRestartDelay` | `5000` | Пауза между раундами |
| `mapChangeDelay` | `2000` | Пауза перед сменой карты после голосования |
| `rttPingInterval` | `3000` | Интервал RTT-пингов |
| `idleCheckInterval` | `30000` | Периодичность проверки бездействия |

### Кики (`rtt`, `idleKickTimeout`)

- `rtt.maxMissedPings: 5` — количество подряд пропущенных pong-ответов до кика;
- `rtt.maxLatency: 1000` — сглаженная (EMA) задержка (мс), при превышении которой игрок кикается; порог рассчитан на P2P-хостинг с домашних каналов (реальный RTT 200–300 мс и спайки на смене карты — норма);
- `idleKickTimeout.player: 120000` — кик игрока за бездействие (2 минуты);
- `idleKickTimeout.spectator: null` — `null` отключает кик (наблюдатели не кикаются).

## games/tanks/src/config/game.js — игровой конфиг (танки)

Источник: [games/tanks/src/config/game.js](../../games/tanks/src/config/game.js). Игровая половина конфига хоста (импортируется Worker'ом как `@vimp/tanks/config/game.js` — временная статическая композиция до этапа 6). Импортирует карты, модели и оружие из `games/tanks/src/data/`.

### Основные параметры

| Параметр | Значение | Описание |
| --- | --- | --- |
| `parts.friendlyFire` | `false` | Урон по своей команде |
| `parts.mapConstructor` | `'Map'` | Имя конструктора карт |
| `parts.hitscanService` | `'HitscanService'` | Сервис расчёта hitscan-выстрелов |
| `mapScale` | `0.3` | Масштаб карт |
| `currentMap` | `'pool mini'` | Карта по умолчанию |
| `mapsInVote` | `4` | Количество карт в голосовании |
| `mapSetId` | `'c1'` | Дефолтный snapshot-ключ конструктора карты |
| `roomDefaults.maxPlayers` | `8` | Рамка настроек комнаты в лобби: кламп лимита, выбранного создателем (будущий `GameManifest.roomDefaults`, этап 6) |
| `soundCues` | `roundStart, victory, defeat, frag, death: 'gameOver'` | Маппинг движковых событий на имена звуков игры (`SocketManager.sendSoundCue`) |
| `initialVote` | `'teamChange'` | Голосование, отправляемое игроку после первого кадра |
| `spectatorTeam` | `'spectators'` | Название команды наблюдателей |
| `teams` | `team1: 1, team2: 2, spectators: 3` | Команды и их id |

### Статистика (`stat`)

Описывает столбцы scoreboard. Для каждого параметра:

- `key` — порядковый номер ячейки в строке;
- `bodyMethod` — метод обновления в теле таблицы (`=` — замена, `+` — прибавление);
- `bodyValue` — значение по умолчанию;
- `headSync` — синхронизировать body с head;
- `headMethod` — метод обновления в шапке (`#` — количество значений, `=` — замена, `+` — прибавление);
- `headValue` — значение по умолчанию в шапке.

Текущие столбцы: `name` (0), `status` (1), `score` (2), `deaths` (3), `latency` (4).

### Панель HUD (`panel`)

Строковые ключи и дефолтные значения ресурсов игрока (обновляются каждый раунд):

- `health` → ключ `h`, значение `100`;
- `w1` → ключ `w1`, `200` патронов;
- `w2` → ключ `w2`, `100` бомб.

Клиентское сопоставление ключей элементам DOM — в `client.js` (`modules.panel.keys`, включая `t` — время и `wa` — активное оружие).

### Клавиши (`spectatorKeys`, `playerKeys`)

`spectatorKeys` — команды наблюдателя (`nextPlayer`/`prevPlayer`); набор движковый, живёт в `src/config/hostDefaults.js`.

`playerKeys` — команды игрока (игровой конфиг). Каждая клавиша имеет битовую маску `key` (`1 << n`, используется предиктором и ядром в истории ввода) и опциональный `type`:

- `type: 0` (по умолчанию) — многократное действие: начинается на keyDown, завершается на keyUp (движение, поворот башни);
- `type: 1` — срабатывает один раз на keyDown (`gunCenter`, `fire`, `nextWeapon`, `prevWeapon`).

Соответствие keyCode → команда задаётся на клиенте (`client.js` → `modules.controls.keySetList`).

## src/config/client.js — конфиг клиента

Источник: [src/config/client.js](../../src/config/client.js). Отправляется клиенту при подключении. Перед отправкой хост дописывает в него:

- `modules.vote.params.time` = `game:timers:voteTime`;
- `prediction` — данные для клиентской реплики движения и стрельбы (`timeStep`, `playerKeys`, `models`, `weapons`) — собирает [src/lib/buildClientConfig.js](../../src/lib/buildClientConfig.js).

### `parts` — игровые сущности

- **`gameSets`** — сопоставление snapshot-ключей классам рендеринга:

  ```js
  gameSets: {
    c1: ['Map', 'MapRadar'],
    c2: ['Map'],
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  }
  ```

  Один ключ может создавать несколько сущностей (танк рисуется и на основном полотне, и на радаре, плюс дым и следы гусениц).

- **`entitiesOnCanvas`** — на каком полотне (`vimp` или `radar`) отрисовывается каждый класс. Сущности можно наследовать и отображать на разных полотнах (например, `MapRadar` — упрощённая карта для радара).

- **`bakedAssets`** — процедурные текстуры, «запекаемые» один раз при старте (`BakingProvider`): взрывы, частицы, дым, танк, бомба, следы гусениц, отметки радара. Каждая запись: `name` (id текстуры), `component` (кому назначена), `params` (параметры генерации).

- **`componentDependencies`** — какие сервисы инжектируются в компоненты (`renderer` → Map; `soundManager` → ExplosionEffect, ShotEffect, Bomb, Tank).

### `interpolation` — snapshot-интерполяция

- `delay: 100` — мс; мир рендерится в прошлом (`renderTime = serverNow − delay`), ~3 кадра при 30 пакетах/сек;
- `maxFrameAge: 1000` — страховочная очистка старых кадров буфера.

### `modules.canvasManager` — полотна и камера

`canvases` — ключи соответствуют id элементов canvas в HTML:

| Параметр | Описание |
| --- | --- |
| `aspectRatio` | Соотношение сторон (`'16:9'`). Canvas заполняет максимум окна, сохраняя пропорцию. Без параметра — 100% окна |
| `fixSize` | Фиксированный размер в px (`'150'` — квадрат, `'200:100'` — прямоугольник). Отключает `aspectRatio` и адаптивное масштабирование |
| `baseScale` | Базовый зум (`'Числитель:Знаменатель'`). Для адаптивных полотен — масштаб при эталонной ширине 1920px (`итог = ширина/1920 × baseScale`); для фиксированных — постоянный множитель |
| `dynamicCamera` | Включает динамическую камеру (look-ahead + zoom от скорости) |
| `shakeCamera` | Разрешает тряску камеры |

Адаптивное масштабирование гарантирует одинаковый угол обзора на любых мониторах (эталон — Full HD 1920px).

`dynamicCamera` (общие параметры): `lookAheadFactor` (смещение камеры вперёд по движению), `zoomOutFactor`/`maxZoomOut` (отдаление от скорости), `smoothnessPosition`/`smoothnessZoom`/`smoothnessVelocity` (плавность).

Текущие полотна: `vimp` (16:9, зум 5:1, динамическая камера, тряска) и `radar` (150×150px, масштаб 1:8).

### `modules.controls` — управление

- **`keySetList`** — массив из двух наборов `keyCode: 'команда'`: `[0]` — наблюдатель (`n`/`p` — переключение наблюдаемого игрока), `[1]` — игрок (`w/s/a/d` — движение, `k/l/u` — башня, `j` — огонь, `n/p` — смена оружия). Какой набор активен, диктует хост через порт `17` (KEYSET_DATA).
- **`modes`** — режимы UI: `c` — чат, `m` — голосование, `tab` — статистика.
- **`cmds`** — служебные клавиши (`escape`, `enter`), имеют высший приоритет и используются внутри режимов.

### Прочие модули

- **`chat`** — id DOM-элементов, лимиты вывода (`listLimit: 5` строк, `lineTime: 15000` мс), кэш и **шаблоны системных сообщений** (`messages`): группы `s` (статусы/команды), `v` (голосования), `m` (карты), `c` (команды), `n` (имена), `b` (боты). Хост шлёт только `'группа:номер:параметры'`, текст собирает клиент.
- **`panel`** — id элементов панели и сопоставление серверных ключей (`t`, `h`, `wa`, `w1`, `w2`) элементам.
- **`stat`** — id таблиц шапок/тел (`heads`, `bodies`) и `sortList` — параметры сортировки: массив пар `[номер ячейки, по убыванию?]`; при равенстве сравнение переходит к следующей паре.
- **`vote`** — id/классы DOM и **шаблоны голосований** (`templates`): `[заголовок с плейсхолдерами {0}, варианты (массив — статичные, строка — запросить список у хоста), timeOff]`. `menu` — пункты главного меню голосования.
- **`gameInform`** / **`techInformList`** — шаблоны игровых сообщений (победа, старт раунда) и технических экранов (комната полна, кик за бездействие/задержку и т.д.).

## src/config/master.js

Конфиг мастер-сервера (см. [master.md](master.md)); читается `src/master/main.js` (и `vite.config.js` — `httpsOptions` для dev HMR):

- `protocol`, `domain`, `port` — адрес; порт по умолчанию `3002` (`3001` — Vite HMR). В production домен переопределяет `VIMP_DOMAIN`, порт — `VIMP_MASTER_PORT`;
- `httpsOptions` — пути к локальным сертификатам `.certs/key.pem`/`cert.pem` (только для разработки; в production HTTPS терминирует Nginx);
- `servers` — параметры `GET /servers`: `regionThreshold: 15` (комнат меньше или столько — региональный фильтр и пагинация отключаются), `defaultLimit: 10`, `maxLimit: 50`;
- `host` — ограничения комнат: `maxNameLength: 30`, `maxPlayersLimit: 8`, `heartbeatTimeout: 30000` (без heartbeat дольше — комната удаляется), `sweepInterval: 10000`; соц-модерация `/ban`: `banThreshold: 5` (уникальных по IP жалоб для бана), `reportWindowMs: 3600000` (окно учёта жалоб и срок бана, 1 ч);
- `regionHeader: 'x-region'` — заголовок с регионом хоста от Nginx/CDN;
- `pingRateLimit` — лимит сигнальных `ping_host` с одного IP (`limit: 10` за `windowMs: 1000`);
- `security` (гигиена среды) — `csp` (строка Content-Security-Policy: single source of truth политики, в проде мастер ставит её на свои ответы, авторитетно на статику/`.wasm` — Nginx, см. [deployment.md](deployment.md)) и `referrerPolicy: 'no-referrer'`; заголовки `nosniff`/`X-Frame-Options`/`Referrer-Policy` мастер шлёт всегда, CSP — только в проде (в dev сломала бы Vite HMR);
- `iceServers` — ICE-конфигурация для клиентов и хостов (STUN; TURN — опционально).

## src/config/lobby.js

Конфиг клиентского лобби (см. [client.md](client.md#mvc-компоненты-srcclientcomponents)). В отличие от `client.js` **бандлится в сборку**, а не приходит от хоста: лобби проходит до подключения к хосту.

- `serversUrl: '/servers'` — REST-эндпоинт мастера со списком серверов;
- `maps` — каталог карт мастера: `manifestUrl: '/maps/manifest.json'`, `baseUrl: '/maps'` — комната хоста стартует на актуальных картах (fallback на бандл при недоступности);
- `worker` — манифест worker-бандла мастера: `manifestUrl: '/worker/manifest.json'` — Worker комнаты создаётся по `url` из манифеста, расхождение `codeVersion` при re-register запускает эстафету Worker'ов (fallback на бандловый URL без обновлений кода — dev/недоступность);
- `reconnect` — переподключение сигнального WS хоста: экспоненциальный бэкофф от `baseDelay: 1000` до `maxDelay: 30000` (мс);
- `pageSize: 10` — размер страницы для «Загрузить ещё» (`offset`/`limit`);
- `pingInterval: 5000` — минимальный интервал повторного `ping_host` одного сервера (защита от спама при скролле/перерисовке);
- `elems` — id DOM-элементов лобби (из `lobby.pug`), включая `nameId`/`hostBtnId` — поле имени и кнопка «создать сервер» (браузерный хост, [host.md](host.md));
- `create` — настройки создания комнаты: `defaultName`, `maxPlayers` (≤ 8), `heartbeatInterval` (период `update_host` у мастера), `hostSocketId: 'local'` — socketId loopback-соединения хоста-игрока (по нему Worker исключает хоста из kick-политик).

## src/config/auth.js

Форма авторизации: id DOM-элементов (`elems`) и параметры формы (`params`). Каждый параметр: `name`, значение по умолчанию, `validator` (функция из [src/lib/validators.js](../../src/lib/validators.js): `isValidName`, `isValidModel`) и ключ `storage` для localStorage. Валидация выполняется и на клиенте, и повторно хостом (Worker).

## games/tanks/src/config/sounds.js

Каталог звуков. Каждый звук: `file` (имя файла без расширения в `public/sounds/`), `priority` (выше — важнее при конкуренции за голоса), `volume`, опционально `loop: true`. `codecList: ['webm', 'mp3']` — файлы должны существовать в обоих форматах. Подробнее о системе воспроизведения — в [client.md](client.md#soundmanager).

## src/config/wsports.js и src/config/opcodes.js

- **`wsports.js`** — реестр числовых портов игрового протокола (источник истины). Полные таблицы — в [network.md](network.md#порты).
- **`opcodes.js`** — версия бинарного snapshot-формата (`SNAPSHOT_FORMAT_VERSION = 3`) и реестр ключей `SNAPSHOT_KEYS` (`m1`, `w1`, `w2`, `w2e`, `c1`, `c2` → числовой id + `kind`, задающий байтовую раскладку блока). Незарегистрированный ключ уронит упаковку кадра. Подробности — в [network.md](network.md#бинарный-snapshot-кадр-порт-5).

## games/tanks/src/data/ — игровые данные

### models.js

Единственная модель — танк `m1` ([games/tanks/src/data/models.js](../../games/tanks/src/data/models.js)): конструктор `Tank`, стартовое оружие `w1`, размер (`size: 2`, габариты `size×4 : size×3`), параметры движения (ускорение/торможение, `maxForwardSpeed: 260`, `maxReverseSpeed: −130`, поворотный момент, демпфирование, боковое сцепление), физика (`density`, `friction`, `restitution`), «манера вождения» (пороги и скорости газа/поворота) и башня (`maxGunAngle: 1.4` рад, скорости поворота/центрирования).

> ⚠️ Коэффициенты `models.js` используются и авторитетным путём ядра, и репликой клиентского предикта (`core/src/client/predictor.rs`, формулы общие — `core/src/motion.rs`). Их изменение проверяется cargo-паритетом: `npm run core:test`.

### weapons.js

Два архитектурно разных типа оружия ([games/tanks/src/data/weapons.js](../../games/tanks/src/data/weapons.js)):

| | `w1` (пуля) | `w2` (бомба) |
| --- | --- | --- |
| Тип | `hitscan` — мгновенный луч, физического снаряда нет | `explosive` — физический снаряд `Bomb` в мире Rapier |
| Урон | 40 | 70 в эпицентре, радиус взрыва 50 |
| Дальность | 1500 юнитов | — (детонация по таймеру `time: 300` мс) |
| Кулдаун | 0.01 с | 0.1 с |
| Прочее | `spread: 0`, расход 1 патрон | `size: 8`, импульс взрыва `2000000`, эффект `w2e` |
| Тряска камеры | 20px / 200мс | 30px / 400мс |

### maps/

Три карты: `pool mini` (малая), `canopy`, `garden`. Каждая описывает слои тайлов (`layers`, `tiles`), точки респауна (`respawns`), статическую (`physicsStatic`) и динамическую (`physicsDynamic`) физику. Регистрация — в [games/tanks/src/data/maps/index.js](../../games/tanks/src/data/maps/index.js). Как добавить карту — см. [extending.md](extending.md#новая-карта).

---

[← Предыдущая: Сетевой протокол](network.md) · [Следующая: Расширение игры →](extending.md)
