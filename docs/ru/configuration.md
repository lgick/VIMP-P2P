# Конфигурация

Вся конфигурация проекта разделена на три уровня:

1. **Переменные окружения** (`.env`) — параметры инстанса мастер-сервера (домен, порт). Применяются только в production.
2. **`packages/engine/src/config/`** — общие конфиги, используемые мастером (Node.js), Worker'ом браузерного хоста и клиентом (Vite-бандл).
3. **`games/tanks/src/data/`** — статические игровые данные: карты, модели, оружие.

Мастер собирает свой конфиг в единое хранилище `packages/engine/src/lib/config.js` (доступ по пути с двоеточием) в [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js); Worker хоста ([packages/engine/src/host/host.worker.js](../../packages/engine/src/host/host.worker.js)) собирает конфиг игры как merge движковых дефолтов (`hostDefaults`) и игровой половины из `HostPlugin` (`@vimp/tanks/host/index.js`: `gameConfig`, `authSchema`, `buildClientGameConfig()`), применяя поверх настройки комнаты. Клиент получает свой конфиг (CONFIG_DATA) от хоста при подключении (порт `0`).

## Переменные окружения (.env)

Читаются в [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js) при `NODE_ENV=production` (запуск `npm start` использует `node --env-file .env`). В режиме разработки игнорируются — действуют значения из `packages/engine/src/config/master.js`.

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | Домен мастера. **Обязательна** в production (иначе процесс завершится с ошибкой) | `localhost` |
| `VIMP_MASTER_PORT` | Порт мастер-сервера | `3002` |
| `VIMP_AUTH_SERVICE_URL` | Origin central auth-сервиса (`packages/auth`), переопределяет `security.authServiceUrl` — используется в CSP `connect-src` и прокси-роутах `/auth/*` ([auth.md](auth.md), [deployment.md](deployment.md#central-auth-сервис-packagesauth)) | `http://localhost:3010` |
| `GAMES_MATRIX` | JSON-массив, переопределяющий `master:games` (список игр-плагинов, резолвится `GameCatalog`, `{id, package, version}[]`) — см. [master.md](master.md#get-gamesmanifestjson-get-gamesidmanifestjson-get-gamesidmaps) | `[{"id":"tanks","package":"@vimp/tanks","version":"0.1.0"}]` |

Игровые параметры (карта, лимит игроков, таймеры, friendly fire) переменными окружения не задаются: их выбирает создатель комнаты в лобби, а дефолты живут в `packages/engine/src/config/hostDefaults.js` (движковые) и `games/tanks/src/config/game.js` (игровые).

### Auth-сервис (`packages/auth`)

Читаются в [packages/auth/src/main.js](../../packages/auth/src/main.js) при
`NODE_ENV=production`; при отсутствии любой из них сервис завершается при
старте (см. [auth.md](auth.md#запуск)).

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `VIMP_AUTH_DATABASE_URL` | строка подключения к PostgreSQL | `postgres://localhost:5432/vimp_auth` |
| `VIMP_AUTH_PORT` | порт auth-сервиса | `3010` |
| `VIMP_AUTH_PUBLIC_URL` | собственный публичный origin — для OAuth `redirect_uri`. **Обязательна** в production | — (в dev fallback на `http://localhost:PORT`) |
| `VIMP_AUTH_ALLOWED_ORIGINS` | CSV origin'ов мастеров, которым разрешён CORS `POST /nick` и OAuth-редирект (`returnUrl`). **Обязательна** в production | `https://localhost:3002` (только в dev) |
| `VIMP_AUTH_STATE_SECRET` | HMAC-секрет для stateless OAuth `state`. **Обязательна** в production | — |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | реквизиты GitHub OAuth App. **Обязательны** в production | — |

## packages/engine/src/config/hostDefaults.js — движковые дефолты хоста

Источник: [packages/engine/src/config/hostDefaults.js](../../packages/engine/src/config/hostDefaults.js). Движковая половина конфига хоста: лимиты, таймеры, кик-политики, спектаторский keyset (наблюдение — механизм движка). Worker хоста merge'ит её с игровым конфигом танков и применяет поверх настройки комнаты; в этапе 6 плана статический merge заменит `HostPlugin.gameConfig`.

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
| `roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | Серверные границы клампа пользовательских `roundTime`/`mapTime` комнаты (форма лобби — не граница доверия) |
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

Источник: [games/tanks/src/config/game.js](../../games/tanks/src/config/game.js). Игровая половина конфига хоста (приходит в Worker полем `gameConfig` HostPlugin — `host.worker.js` грузит `HostPlugin` динамически по `entries.host` активного `GameManifest`, Этап 6.4). Импортирует карты, модели и оружие из `games/tanks/src/data/`.

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
| `scripted` | `namePrefix: 'Bot', defaultModel: 'm1'` | Параметры scripted-участников (ботов): префикс имени `Bot<id>` и модель танка по умолчанию |
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

Состав колонок объявляет схема: движковые записи (`name`/`status`/`score`/`deaths`/`latency` из RoundManager/RTTManager) в не объявленные схемой колонки молча игнорируются — игра может опустить любую из них.

### Rank/state игрока (`playerState`)

Этап B4 (см. [auth.md](auth.md#загрузка-и-синхронизация-rank-и-state-хост) и
[host.md](host.md#синхронизация-rank-и-state-игрока-этап-b4)): объявляет
дефолтную форму непрозрачного per-player блока «скиллов», синхронизируемого
с центральным auth-сервисом.

| Параметр | Значение | Описание |
| --- | --- | --- |
| `playerState.defaultState` | `{}` | С чем стартует участник, если у auth-сервиса нет сохранённой записи для него (или он недоступен на входе) |

Движок обращается с `state` как с непрозрачным JSON-блобом (только
транспорт + хранение) — форму интерпретирует только игра, точно так же, как
`stat` выше объявляет столбцы scoreboard. У `rank` (простой числовой
аккумулятор дельты по убийствам, ±1 за фраг) своей конфиг-схемы нет — это
просто число.

### Панель HUD (`panel`)

Схема панели: `fields` — поля со строковыми ключами и дефолтными значениями ресурсов игрока (обновляются каждый раунд; уходят и в ядро через `buildCoreConfig`), `activeKey` — ключ активного оружия в кадрах панели:

- `fields.health` → ключ `h`, значение `100`;
- `fields.w1` → ключ `w1`, `200` патронов;
- `fields.w2` → ключ `w2`, `100` бомб;
- `activeKey: 'wa'`.

Клиентское сопоставление ключей элементам DOM — в игровом client-конфиге (`modules.panel.keys`, включая `t` — время и `wa` — активное оружие).

### Клавиши (`spectatorKeys`, `playerKeys`)

`spectatorKeys` — команды наблюдателя (`nextPlayer`/`prevPlayer`); набор движковый, живёт в `packages/engine/src/config/hostDefaults.js`.

`playerKeys` — команды игрока (игровой конфиг). Каждая клавиша имеет битовую маску `key` (`1 << n`, используется предиктором и ядром в истории ввода) и опциональный `type`:

- `type: 0` (по умолчанию) — многократное действие: начинается на keyDown, завершается на keyUp (движение, поворот башни);
- `type: 1` — срабатывает один раз на keyDown (`gunCenter`, `fire`, `nextWeapon`, `prevWeapon`).

Соответствие keyCode → команда задаётся на клиенте (`client.js` → `modules.controls.keySetList`).

## Клиентский конфиг: clientDefaults.js + games/tanks client.js

Клиентский CONFIG_DATA собирается из двух половин: движковые дефолты — [packages/engine/src/config/clientDefaults.js](../../packages/engine/src/config/clientDefaults.js) (интерполяция, режимы/служебные клавиши управления, DOM-структуры движковых модулей, `techInformList`) и игровая половина — [games/tanks/src/config/client.js](../../games/tanks/src/config/client.js) (`parts.*`, канвасы, keyset игрока, схемы panel/stat, тексты chat/vote/gameInform, `initIdList`). Deep-merge выполняет [packages/engine/src/lib/buildClientConfig.js](../../packages/engine/src/lib/buildClientConfig.js) в Worker'е хоста; перед отправкой он дописывает:

- `modules.vote.params.time` = `game:timers:voteTime`;
- `prediction` — данные для клиентской реплики движения и стрельбы (`timeStep`, `playerKeys`, `models`, `weapons`).

В этапе 6 плана игровую половину будет поставлять `HostPlugin.buildClientGameConfig()` вместо статического импорта.

### `parts` — игровые сущности (игровая половина)

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

### `interpolation` — snapshot-интерполяция (движок)

- `delay: 100` — мс; мир рендерится в прошлом (`renderTime = serverNow − delay`), ~3 кадра при 30 пакетах/сек;
- `maxFrameAge: 1000` — страховочная очистка старых кадров буфера.

### `modules.canvasManager` — полотна и камера

Общие параметры `dynamicCamera` — движковые; набор полотен `canvases` — игровой. Canvas-элементы генерирует `main.js` из этого конфига (ключ — id элемента; `width`/`height` — стартовый размер до первого resize):

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

- **`keySetList`** (игра) — массив из двух наборов `keyCode: 'команда'`: `[0]` — наблюдатель (`n`/`p` — переключение наблюдаемого игрока), `[1]` — игрок (`w/s/a/d` — движение, `k/l/u` — башня, `j` — огонь, `n/p` — смена оружия). Какой набор активен, диктует хост через порт `17` (KEYSET_DATA).
- **`modes`** (движок) — режимы UI: `c` — чат, `m` — голосование, `tab` — статистика.
- **`cmds`** (движок) — служебные клавиши (`escape`, `enter`), имеют высший приоритет и используются внутри режимов.

### Прочие модули

DOM-структуры (`elems`) — движковые; тексты и схемы — игровые:

- **`chat`** — id DOM-элементов, лимиты вывода (`listLimit: 5` строк, `lineTime: 15000` мс) и кэш — движок; **шаблоны системных сообщений** (`messages`, игра): группы `s` (статусы/команды), `v` (голосования), `m` (карты), `c` (команды), `n` (имена), `b` (боты). Хост шлёт только `'группа:номер:параметры'`, текст собирает клиент.
- **`panel`** — контейнер `containerId` (движок); сопоставление серверных ключей (`t`, `h`, `wa`, `w1`, `w2`) полям (`keys`) и типизированная схема полей `fields` (игра): упорядоченный список `{ name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }` — `PanelView` генерирует DOM и поведение по типам, а не по именам полей.
- **`stat`** — id контейнера (движок); подписи колонок `columns`, таблицы шапок/тел (`heads`, `bodies`) и `sortList` (игра) — DOM scoreboard генерирует `StatView` по схеме; `sortList` — параметры сортировки: массив пар `[номер ячейки, по убыванию?]`; при равенстве сравнение переходит к следующей паре.
- **`vote`** — id/классы DOM (движок) и **шаблоны голосований** (`templates`, игра): `[заголовок с плейсхолдерами {0}, варианты (массив — статичные, строка — запросить список у хоста), timeOff]`. `menu` — пункты главного меню голосования.
- **`gameInform`** / **`techInformList`** — шаблоны игровых сообщений (id элемента — движок, тексты `list` — игра) и технических экранов (движок): комната полна, кик за бездействие/задержку и т.д.
- **`initIdList`** (игра) — какие модули/полотна инициализировать при старте (`vimp`, `radar`, `panel`, `chat`); механика инициализации — движковая (`main.js`).

## packages/engine/src/config/master.js

Конфиг мастер-сервера (см. [master.md](master.md)); читается `packages/engine/src/master/main.js` (и `vite.config.js` — `httpsOptions` для dev HMR):

- `protocol`, `domain`, `port` — адрес; порт по умолчанию `3002` (`3001` — Vite HMR). В production домен переопределяет `VIMP_DOMAIN`, порт — `VIMP_MASTER_PORT`;
- `httpsOptions` — пути к локальным сертификатам `.certs/key.pem`/`cert.pem` (только для разработки; в production HTTPS терминирует Nginx);
- `games` — список игр-плагинов, резолвится `GameCatalog`: `{id, package, version}[]` (по умолчанию — `@vimp/tanks`). `package` резолвится в `node_modules/` (до разъезда репозиториев движка/игры — workspace-симлинк на `games/<id>`, после — обычная зависимость); `version` самим `GameCatalog` не используется — резервируется под проверку версии при деплое. В production переопределяется переменной окружения `GAMES_MATRIX` (JSON);
- `servers` — параметры `GET /servers`: `regionThreshold: 15` (комнат меньше или столько — региональный фильтр и пагинация отключаются), `defaultLimit: 10`, `maxLimit: 50`;
- `host` — ограничения комнат: `maxNameLength: 30`, `maxPlayersLimit: 8`, `heartbeatTimeout: 30000` (без heartbeat дольше — комната удаляется), `sweepInterval: 10000`; соц-модерация `/ban`: `banThreshold: 5` (уникальных по IP жалоб для бана), `reportWindowMs: 3600000` (окно учёта жалоб и срок бана, 1 ч);
- `regionHeader: 'x-region'` — заголовок с регионом хоста от Nginx/CDN;
- `pingRateLimit` — лимит сигнальных `ping_host` с одного IP (`limit: 10` за `windowMs: 1000`);
- `security` (гигиена среды) — `csp` (строка Content-Security-Policy: single source of truth политики, в проде мастер ставит её на свои ответы, авторитетно на статику/`.wasm` — Nginx, см. [deployment.md](deployment.md)) и `referrerPolicy: 'no-referrer'`; заголовки `nosniff`/`X-Frame-Options`/`Referrer-Policy` мастер шлёт всегда, CSP — только в проде (в dev сломала бы Vite HMR);
- `iceServers` — ICE-конфигурация для клиентов и хостов (STUN; TURN — опционально).

## packages/engine/src/config/lobby.js

Конфиг клиентского лобби (см. [client.md](client.md#mvc-компоненты-srcclientcomponents)). В отличие от `client.js` **бандлится в сборку**, а не приходит от хоста: лобби проходит до подключения к хосту.

- `serversUrl: '/servers'` — REST-эндпоинт мастера со списком серверов;
- `gamesManifestUrl: '/games/manifest.json'` — каталог игр мастера (`GameCatalog`): `roomDefaults` формы создания комнаты и ClientPlugin берутся отсюда;
- `maps` — каталог карт мастера, per-game функции-URL: `manifestUrl: gameId => '/games/<id>/maps/manifest.json'`, `baseUrl: gameId => '/games/<id>/maps'` — комната хоста стартует на актуальных картах активной игры (fallback на бандл при недоступности);
- `game` — манифест конкретной игры: `manifestUrl: gameId => '/games/<id>/manifest.json'` — эстафета Worker'ов перечитывает его перед свопом, чтобы новый Worker получил свежие `entries.host/wasm`;
- `worker` — манифест worker-бандла мастера: `manifestUrl: '/worker/manifest.json'` — Worker комнаты создаётся по `url` из манифеста, расхождение `codeVersion` при re-register запускает эстафету Worker'ов (fallback на бандловый URL без обновлений кода — dev/недоступность);
- `reconnect` — переподключение сигнального WS хоста: экспоненциальный бэкофф от `baseDelay: 1000` до `maxDelay: 30000` (мс);
- `pageSize: 10` — размер страницы для «Загрузить ещё» (`offset`/`limit`);
- `pingInterval: 5000` — минимальный интервал повторного `ping_host` одного сервера (защита от спама при скролле/перерисовке);
- `elems` — id DOM-элементов лобби (из `lobby.pug`), включая `nameId`/`hostBtnId` — поле имени и кнопка «создать сервер» (браузерный хост, [host.md](host.md));
- `create` — настройки создания комнаты: `defaultName`, `maxPlayers` (≤ 8), `heartbeatInterval` (период `update_host` у мастера), `hostSocketId: 'local'` — socketId loopback-соединения хоста-игрока (по нему Worker исключает хоста из kick-политик).

## games/tanks/src/config/auth.js

Конфиг авторизации игры ([games/tanks/src/config/auth.js](../../games/tanks/src/config/auth.js)), приезжает через `HostPlugin.authSchema`: id DOM-элементов (`elems`), параметры формы (`params`), игровые валидаторы (`validators`) и тексты формы (`texts`: `title` + help-секции `{ heading, lines: [{ keys, text, last? } | { separator }] }`) — движковый шаблон `auth.pug` нейтрален, заголовок и подсказки игры подставляет `AuthView` из `texts`. Каждый параметр: `name`, значение по умолчанию, `validator` (имя функции) и ключ `storage` для localStorage. Движковый валидатор — `isValidName` ([packages/engine/src/lib/validators.js](../../packages/engine/src/lib/validators.js)); игровые (например `isValidModel` — модель есть в `models.js`) инжектируются в `validateAuth` третьим аргументом. Валидация выполняется и на клиенте (валидаторы из бандла игры), и повторно хостом (Worker); по проводу (`AUTH_DATA`, порт 1) уходят только `elems`/`params`/`texts` — код валидаторов не передаётся.

## games/tanks/src/config/sounds.js

Каталог звуков. Каждый звук: `file` (имя файла без расширения в `games/tanks/dist/sounds/`), `priority` (выше — важнее при конкуренции за голоса), `volume`, опционально `loop: true`. `codecList: ['webm', 'mp3']` — файлы должны существовать в обоих форматах. Подробнее о системе воспроизведения — в [client.md](client.md#soundmanager).

## packages/engine/src/config/wsports.js и packages/engine/src/config/opcodes.js

- **`wsports.js`** — реестр числовых портов игрового протокола (источник истины). Полные таблицы — в [network.md](network.md#порты).
- **`opcodes.js`** — версия бинарного snapshot-формата (`SNAPSHOT_FORMAT_VERSION = 3`), `ENGINE_API_VERSION` и `HOT_FLAGS`. Реестр снапшот-ключей — данные игры: `games/tanks/src/config/snapshot.js` (`gameConfig.snapshot`: `m1`, `w1`, `w2`, `w2e`, `c1`, `c2` → числовой id + `kind`, задающий байтовую раскладку блока). Незарегистрированный ключ уронит упаковку кадра. Подробности — в [network.md](network.md#бинарный-snapshot-кадр-порт-5).

## games/tanks/src/data/ — игровые данные

### models.js

Единственная модель — танк `m1` ([games/tanks/src/data/models.js](../../games/tanks/src/data/models.js)): конструктор `Tank`, стартовое оружие `w1`, размер (`size: 2`, габариты `size×4 : size×3`), параметры движения (ускорение/торможение, `maxForwardSpeed: 260`, `maxReverseSpeed: −130`, поворотный момент, демпфирование, боковое сцепление), физика (`density`, `friction`, `restitution`), «манера вождения» (пороги и скорости газа/поворота) и башня (`maxGunAngle: 1.4` рад, скорости поворота/центрирования).

> ⚠️ Коэффициенты `models.js` используются и авторитетным путём ядра, и репликой клиентского предикта (`games/tanks/core/src/client/predictor.rs`, формулы общие — `games/tanks/core/src/motion.rs`). Их изменение проверяется cargo-паритетом: `npm run core:test`.

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
