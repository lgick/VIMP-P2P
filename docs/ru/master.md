# Мастер-сервер (лобби и сигналинг P2P)

Мастер-сервер (`packages/engine/src/master/`) — центральный узел P2P-архитектуры: хранит реестр активных комнат (браузерных хостов), отдаёт их список по REST и маршрутизирует WebRTC-координацию (SDP-офферы/ответы, ICE-кандидаты) между клиентами и хостами. **Игровой логики в нём нет** — только координация соединений.

`packages/engine/src/master/main.js` — **точка входа проекта** (легаси авторитетный игровой сервер полностью демонтирован).

## Запуск

```bash
npm run dev       # dev: https://localhost:3002 (nodemon + ViteExpress)
npm start         # production: HTTP за Nginx, читает .env
```

- dev: HTTPS с локальными сертификатами из `.certs/`, клиентскую статику раздаёт ViteExpress. Порт `3002` (`3001` — Vite HMR).
- production: обычный HTTP за Nginx; обязательна `VIMP_DOMAIN`, порт задаёт `VIMP_MASTER_PORT`.

Конфигурация — [packages/engine/src/config/master.js](../../packages/engine/src/config/master.js), описание — в [configuration.md](configuration.md#srcconfigmasterjs).

## Модули

| Модуль | Ответственность |
| --- | --- |
| `packages/engine/src/master/main.js` | точка входа: Express + REST, HTTPS/HTTP-сервер, сигнальный `WebSocketServer`, периодическая уборка протухших комнат |
| `packages/engine/src/master/HostRegistry.js` | реестр комнат `Map<hostId, HostSession>`: регистрация (не более 1 комнаты с IP), heartbeat/`lastSeen`, жалобы, выборка для `GET /servers` |
| `packages/engine/src/master/SignalingServer.js` | сигнальный WebSocket: жизненный цикл соединений, маршрутизация WebRTC-сообщений, rate limiting пингов |
| `packages/engine/src/master/MapCatalog.js` | каталог карт: JSON-представление `games/tanks/src/data/maps` в памяти + версия-хеш содержимого; раздача хостам без пересборки |
| `packages/engine/src/master/WorkerCatalog.js` | каталог worker-бандла: версия-хеш содержимого `dist/assets/host.worker-*.js` + его URL; по нему хосты обнаруживают новую версию кода и меняют Worker эстафетой |
| `packages/engine/src/master/GameCatalog.js` | каталог игр-плагинов: сканирует `games/*/dist/manifest.json` (продукт `npm run game:build`) и строит per-game `MapCatalog` из `games/*/dist/maps/*.json`; в dev `entries.client/host/wasm` подменяются на исходники Vite `/@fs/` (HMR) — см. [plugin-api.md](plugin-api.md#gamemanifest) |
| `packages/engine/src/lib/rateLimiter.js` | общий rate limiter с фиксированным окном (лимит событий на ключ за интервал) |

`HostSession`: `hostId` (uuid), `name`, `maxPlayers` (clamp к `host.maxPlayersLimit`, целевой размер комнаты — 8), `currentPlayers`, `mapName`, `region`, `ip`, `gameId`/`gameVersion` (какую игру-плагин и версию манифеста объявил хост в `register_host` — каждый хост с Этапа 6.4), `status` (`online`/`banned`), `reportCount` + `reporters` (`Map` репортёр → timestamp: уникальность жалоб и окно давности), `reportReasons` (причины жалоб, аудит — наружу не отдаются, capped), `lastSeen`.

Регион определяется по заголовку от Nginx/CDN (`regionHeader`, по умолчанию `x-region`; например, `CF-IPCountry`) — выбран вместо `geoip-lite` как бесплатный по памяти. Без заголовка регион — `unknown`.

## REST API

### GET /servers

Query-параметры: `offset`, `limit`, `region`, `search`. Логика (в порядке приоритета):

1. `search` — поиск по подстроке в имени комнаты без учёта регистра; остальные параметры игнорируются.
2. Если всего комнат ≤ `servers.regionThreshold` (15) — возвращается весь список без фильтров и пагинации.
3. Иначе — фильтр по `region` (если передан) и срез `offset`/`limit` (`limit` по умолчанию 10, максимум 50).

Забаненные комнаты (`status !== 'online'`) в выдачу не попадают. Ответ:

```json
{
  "total": 1,
  "servers": [
    {
      "hostId": "3b86e7a7-…",
      "name": "My Room",
      "mapName": "arena",
      "currentPlayers": 3,
      "maxPlayers": 8,
      "region": "DE",
      "gameId": "tanks"
    }
  ]
}
```

IP хоста и служебные поля наружу не отдаются. `gameId` — задел под будущий
фильтр по игре в лобби; каждый хост теперь объявляет свою игру в
`register_host` (Этап 6.4), поэтому `null` бывает только у хостов на
клиентском коде до 6.4.

### GET /games/manifest.json, GET /games/:id/manifest.json, GET /games/:id/maps/\*

Каталог `GameManifest` (`GameCatalog`, Этап 6.2 — см.
[plugin-api.md](plugin-api.md#gamemanifest)): при старте мастера сканирует
`games/*/dist/manifest.json` (продукт `npm run game:build`), по одной записи
на игру-плагин.

- `GET /games/manifest.json` → JSON-массив манифестов всех известных игр.
- `GET /games/:id/manifest.json` → манифест одной игры; неизвестный id →
  `404 { "error": "unknownGame" }`.
- `GET /games/:id/maps/manifest.json` / `GET /games/:id/maps/:name` —
  `{ "version": "<хеш содержимого>", "maps": ["canopy", …] }` и JSON карты
  соответственно, per-game (строится из `games/<id>/dist/maps/*.json`);
  неизвестная игра/карта — `404`. `MapCatalog` (per-game, внутри
  `GameCatalog`) держит собранные `maps/*.json` в памяти. Как хост
  потребляет каталог — см. [host.md](host.md#динамические-карты).
- `GET /games/:id/*` — собранные ассеты игры (`dist/`: хешированные
  client/host-бандлы, общий хешированный `.wasm`, звуки) раздаются статикой
  под `assetsBase` (`/games/<id>/`).

В dev `entries.client`/`entries.host`/`entries.wasm` подменяются на
абсолютные пути исходников через Vite `/@fs/` (`games/<id>/src/client/index.js`
и т.п., `.wasm` — из `core/pkg-web/`), чтобы импорт шёл через dev-трансформацию
и HMR Vite, а не собранный бандл; остальное содержимое манифеста (`maps`,
`assetsBase`, `roomDefaults`, `version`) по-прежнему берётся из собранного
`dist/manifest.json` — игру нужно собрать один раз (`npm run game:build`)
перед первым запуском в dev, как и `npm run core:build` для WASM-ядра.

### GET /worker/manifest.json

Манифест worker-бандла хоста для эстафеты Worker'ов:

- `GET /worker/manifest.json` → `{ "version": "<хеш содержимого>", "url": "/assets/host.worker-<hash>.js" }`.

`WorkerCatalog` при старте мастера находит бандл в `dist/assets/` и хеширует
его содержимое (SHA-256, 16 символов — по образцу `MapCatalog`). Vite хеширует
имена ассетов, поэтому страница старой сборки не может знать имя нового
бандла — вкладка хоста создаёт Worker по `url` из манифеста и сверяет
`version` с `codeVersion` из `host_registered`. В dev каталог пуст
(`{ "version": null, "url": null }`) — Worker раздаёт Vite из исходников,
обновления кода отключены. Как хост потребляет манифест — см.
[host.md](host.md#эстафета-workerов).

## Сигнальный протокол (WebSocket)

Сообщения — JSON-объекты с полем `type`. При подключении соединение проходит проверку `Origin` (allowlist через `security.createOriginValidator`; отсутствие `Origin` — немедленный `terminate`, чужой — закрытие с кодом `4001`), затем получает:

```json
{ "type": "welcome", "id": "<uuid соединения>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` — ICE-конфигурация для `RTCPeerConnection` (STUN обязателен; TURN — опциональный релей).

Клиентская сторона сигналинга — [packages/engine/src/client/network/SignalingClient.js](../../packages/engine/src/client/network/SignalingClient.js): подключается к этому WS, потребляет `welcome`/`iceServers`, шлёт `webrtc_offer`/`ice_candidate`/`ping_host`/`report_host` и ретранслирует входящие сообщения по `type`. Игровой трафик после установки P2P идёт по WebRTC (`WebRtcManager`), минуя мастер — см. [client.md](client.md#сетевой-слой-srcclientnetwork) и [network.md](network.md#транспорт-webrtc).

### Сообщения хоста

| → мастеру | Ответ / эффект |
| --- | --- |
| `register_host { name, maxPlayers, mapName, gameId, gameVersion }` | `host_registered { hostId, gameId, mapsVersion, codeVersion }`; регион — из заголовка, IP — из соединения; `gameId`/`gameVersion` — какую игру-плагин и версию манифеста запустил хост (сохраняются в сессии, эхо в ответе; с Этапа 6.4 их шлёт каждый хост — `connectAsHost` собирает `room.game` из активного `GameManifest`); `mapsVersion` — `GameManifest.maps.version` объявленной игры через `GameCatalog` (`null`, если `gameId` неизвестен каталогу); `codeVersion` — версия worker-бандла движка (при re-register после разрыва — деплой рестартует мастер — хост сверяет их со своими: расхождение карт → перечитывание каталога, кода → эстафета Worker'ов). Ошибки: `alreadyRegistered`, `hostLimit` (уже есть комната с этого IP) |
| `update_host { currentPlayers, mapName }` | актуализация данных комнаты (одновременно heartbeat) |
| `heartbeat {}` | обновление `lastSeen` |
| `webrtc_answer { clientId, sdp }` | пересылается клиенту как `webrtc_answer { hostId, sdp }` |
| `pong_host { clientId, pingId }` | пересылается клиенту как `pong_host { hostId, pingId }` |

Хост держит сигнальный WS постоянно. Комната без heartbeat дольше `host.heartbeatTimeout` (30 с) удаляется из реестра, её соединение закрывается кодом `4000` (проверка каждые `host.sweepInterval`). Разрыв WS хоста также удаляет комнату.

### Сообщения клиента

| → мастеру | Ответ / эффект |
| --- | --- |
| `webrtc_offer { hostId, sdp }` | пересылается хосту как `webrtc_offer { clientId, sdp }`; ошибка `unknownHost` |
| `ping_host { hostId, pingId }` | пересылается хосту; ограничен rate limiter'ом по IP (`pingRateLimit`, ошибка `rateLimited`). Замер **приблизительный** (клиент→мастер→хост, не P2P RTT) |
| `report_host { hostId, reason }` | жалоба `/ban`: принимается **только от сессии, слававшей `webrtc_offer` этой комнате** (иначе ошибка `reportRejected` — чужие IP не могут банить хост, не заходя в игру); причина обязательна (жалоба без неё не учитывается). Уникальность репортёров по IP в окне `host.reportWindowMs`; при `host.banThreshold` уникальных жалобах комната банится (см. ниже). `reason` санитизируется и складывается в `reportReasons` (аудит, публично не отображается) |

### Общие сообщения

| → мастеру | Эффект |
| --- | --- |
| `ice_candidate { targetId, candidate }` | пересылается адресату (`targetId` — `hostId` или `clientId`) как `ice_candidate { fromId, candidate }` |

Ошибки приходят как `{ "type": "error", "code": "<код>" }`. Невалидный JSON и неизвестные `type` молча игнорируются.

## Соц-модерация `/ban`

Единственная анти-чит-мера проекта. Браузерный хост физически исполняет
симуляцию у себя в процессе — WASM-память доступна ему из JS, и модифицированный
клиент может читерить в обход логики ядра. Техническая защита против этого
невозможна без переноса авторитетности обратно на доверенный сервер (что
противоречит цели P2P), поэтому единственная мера — социальная.

Жалоба перехватывается **на клиенте** (`packages/engine/src/client/main.js`, команда `/ban <причина>`) и уходит **напрямую мастеру** по сигнальному WS, минуя хоста: его `CommandProcessor` мог бы отфильтровать жалобу на самого себя. Причина обязательна (гейт на стороне клиента), публично не отображается.

Логика бана (`HostRegistry`):

- жалоба принимается только от сессии, реально подключавшейся к комнате (слала ей `webrtc_offer`) — проверка членства в `SignalingServer._onReportHost` (`session.offeredHosts`); причина обязательна — жалоба без непустого `reason` не учитывается (`report` возвращает `counted: false`).
- `report(hostId, reporterKey, reason)` чистит `reporters` от записей старше `host.reportWindowMs`, добавляет нового репортёра (по IP), обновляет `reportCount = reporters.size`; возвращает `{ counted, banned }`.
- При `reporters.size >= host.banThreshold` комната переводится в `status: 'banned'` (сразу выпадает из `GET /servers`), а её IP заносится в реестр забаненных до конца окна.
- `SignalingServer` при `banned` закрывает сигнальный WS хоста кодом `4002` — новые WebRTC-офферы к нему больше не маршрутизируются (уже установленные P2P-пиры это не рвёт, host-migration нет: читер остаётся в комнате один).
- `isBanned(ip)` не даёт забаненному IP перерегистрировать комнату до истечения окна (`register_host` → ошибка `banned`). Протухшие записи бана чистятся лениво и в `sweepStale`.

Уникальность жалоб — по IP репортёра, поэтому несколько гостей за одним NAT считаются одним. Осознанное ограничение принятой модели «минимум анти-чита»: базовая гигиена среды (см. «Защита» ниже) отсекает «уличных» злоумышленников, но не хоста, исполняющего оригинальный WASM и правящего его память из JS — более тяжёлые схемы (кросс-валидация состояний хоста через теневых валидаторов, серверные реплей-проверки, криптографические подписи снапшотов) были рассмотрены и отклонены: все они в итоге доверяют потоку вводов/данных, которым управляет сам проверяемый хост.

**Наблюдаемость**: каждая учтённая жалоба и факт бана пишутся в консоль мастера (`[report] room ... N report(s) in window`) — это единственное место, где жалобы можно посмотреть (админ-интерфейса нет; причины наружу не отдаются, capped-история хранится в памяти `HostSession.reportReasons` до рестарта/уборки комнаты).

## Защита

- **Origin-allowlist** — паттерн `packages/engine/src/lib/security.js` (`createOriginValidator` с параметрами мастера).
- **1 комната на IP** — проверка в `HostRegistry.add`; забаненный IP отклоняется (`isBanned`).
- **Rate limiting пингов** — `RateLimiter` (фиксированное окно, по умолчанию 10 запросов/с с IP).
- **Security-заголовки** (гигиена среды) — мастер ставит `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` на все ответы; `Content-Security-Policy` — только в проде (в dev сломала бы Vite HMR). Прод-статику и `.wasm` с CSP отдаёт Nginx — см. [deployment.md](deployment.md); строка политики — единый source of truth в `packages/engine/src/config/master.js` (`security.csp`).
- Санитизация входных строк (`sanitizeMessage`), clamp числовых полей.

## Тесты

`tests/master/` (node-проект Vitest): `HostRegistry.test.js` (регистрация, лимит по IP, heartbeat/уборка, жалобы — включая обязательность причины, вся логика выборки `GET /servers`, хранение `gameId`/`gameVersion`), `SignalingServer.test.js` (жизненный цикл соединений, маршрутизация всех сигнальных сообщений на фейковых ws, rate limiting, membership-проверка жалоб, уборка протухших хостов, `mapsVersion`/`codeVersion` в `host_registered`, per-game `mapsVersion` через стаб `gameCatalog`), `MapCatalog.test.js` (манифест, выдача карт, стабильность версии), `WorkerCatalog.test.js` (версия-хеш и URL бандла, пустой каталог в dev, выбор новейшего из нескольких), `GameCatalog.test.js` (сканирование `games/*/dist/manifest.json`, per-game каталоги карт, несобранная/неизвестная игра, подмена entries на `/@fs/` в dev). Rate limiter — `tests/lib/rateLimiter.test.js`.

---

[← Предыдущая: Игровой процесс](gameplay.md) · [Следующая: Браузерный хост →](host.md)
