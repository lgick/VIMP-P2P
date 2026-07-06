# Мастер-сервер (лобби и сигналинг P2P)

Мастер-сервер (`src/master/`) — центральный узел P2P-архитектуры (Этап 1 [плана миграции](../P2P-PLAN.md)): хранит реестр активных комнат (браузерных хостов), отдаёт их список по REST и маршрутизирует WebRTC-координацию (SDP-офферы/ответы, ICE-кандидаты) между клиентами и хостами. **Игровой логики в нём нет** — только координация соединений.

До вехи демонтажа (после Этапа 4 плана) мастер живёт параллельно текущему авторитетному игровому серверу (`src/server/`) и запускается отдельной точкой входа. После демонтажа `src/master/main.js` станет основной точкой входа проекта.

## Запуск

```bash
npm run master:dev     # dev: https://localhost:3002 (nodemon + ViteExpress)
npm run master:start   # production: HTTP за Nginx, читает .env
```

- dev: HTTPS с локальными сертификатами из `.certs/` (как у игрового сервера), клиентскую статику раздаёт ViteExpress. Порт `3002` (`3000` занят игровым сервером, `3001` — Vite HMR).
- production: обычный HTTP за Nginx; обязательна `VIMP_DOMAIN`, порт задаёт `VIMP_MASTER_PORT`.

Конфигурация — [src/config/master.js](../src/config/master.js), описание — в [configuration.md](configuration.md#srcconfigmasterjs).

## Модули

| Модуль | Ответственность |
| --- | --- |
| `src/master/main.js` | точка входа: Express + REST, HTTPS/HTTP-сервер, сигнальный `WebSocketServer`, периодическая уборка протухших комнат |
| `src/master/HostRegistry.js` | реестр комнат `Map<hostId, HostSession>`: регистрация (не более 1 комнаты с IP), heartbeat/`lastSeen`, жалобы, выборка для `GET /servers` |
| `src/master/SignalingServer.js` | сигнальный WebSocket: жизненный цикл соединений, маршрутизация WebRTC-сообщений, rate limiting пингов |
| `src/lib/rateLimiter.js` | общий rate limiter с фиксированным окном (лимит событий на ключ за интервал) |

`HostSession`: `hostId` (uuid), `name`, `maxPlayers` (clamp к `host.maxPlayersLimit`, рамка плана — 8), `currentPlayers`, `mapName`, `region`, `ip`, `status` (`online`/`banned`), `reportCount` + `reporters` (уникальность жалоб), `lastSeen`.

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
      "region": "DE"
    }
  ]
}
```

IP хоста и служебные поля наружу не отдаются.

## Сигнальный протокол (WebSocket)

Сообщения — JSON-объекты с полем `type`. При подключении соединение проходит проверку `Origin` (allowlist через `security.createOriginValidator`; отсутствие `Origin` — немедленный `terminate`, чужой — закрытие с кодом `4001`), затем получает:

```json
{ "type": "welcome", "id": "<uuid соединения>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` — ICE-конфигурация для `RTCPeerConnection` (STUN обязателен; TURN — опциональный релей по итогам Этапа 0).

### Сообщения хоста

| → мастеру | Ответ / эффект |
| --- | --- |
| `register_host { name, maxPlayers, mapName }` | `host_registered { hostId }`; регион — из заголовка, IP — из соединения. Ошибки: `alreadyRegistered`, `hostLimit` (уже есть комната с этого IP) |
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
| `report_host { hostId }` | жалоба `/ban`: инкремент `reportCount`, уникальность репортёров по IP (бан-логика — Этап 5) |

### Общие сообщения

| → мастеру | Эффект |
| --- | --- |
| `ice_candidate { targetId, candidate }` | пересылается адресату (`targetId` — `hostId` или `clientId`) как `ice_candidate { fromId, candidate }` |

Ошибки приходят как `{ "type": "error", "code": "<код>" }`. Невалидный JSON и неизвестные `type` молча игнорируются.

## Защита

- **Origin-allowlist** — паттерн `src/lib/security.js` (`createOriginValidator` с параметрами мастера).
- **1 комната на IP** — проверка в `HostRegistry.add`.
- **Rate limiting пингов** — `RateLimiter` (фиксированное окно, по умолчанию 10 запросов/с с IP).
- Санитизация входных строк (`sanitizeMessage`), clamp числовых полей.

## Тесты

`tests/master/` (node-проект Vitest): `HostRegistry.test.js` (регистрация, лимит по IP, heartbeat/уборка, жалобы, вся логика выборки `GET /servers`), `SignalingServer.test.js` (жизненный цикл соединений, маршрутизация всех сигнальных сообщений на фейковых ws, rate limiting, уборка протухших хостов). Rate limiter — `tests/lib/rateLimiter.test.js`.
