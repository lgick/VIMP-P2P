# B6. Конфиг/деплой/доки (B) ✅важно

- `config/master.js`: блок `auth` (URL auth-сервиса, публичный ключ/`jwks` URL,
  включённые провайдеры), обновлённый CSP. Секреты (OAuth client_secret, ключ
  подписи) — в `.env` auth-сервиса, не в коде (по образцу `VIMP_DOMAIN`).
- Деплой: добавить auth-сервис (свой Docker-образ + PostgreSQL) в CI/CD; мастера
  получают URL auth-сервиса через env. `docs/en+ru`: обновить `master.md`
  (эндпоинты, проксирование), `configuration.md` (env auth), `gameplay.md`
  (`/rank`, ник из лобби), `deployment.md` (auth-сервис + БД), новую страницу
  `auth.md` при необходимости.

> Примечание: игро-специфичные части B (схема state/rank в `game.js`, `/rank`,
> правка `auth.js`) после направления A3 (вынос репозитория игры) продолжают
> жить уже в репозитории игры — их актуализация там довершает B6.

## Критические файлы

`packages/engine/src/config/master.js` (блок `auth`, CSP); `docs/**` (`master.md`,
`configuration.md`, `gameplay.md`, `deployment.md`, при необходимости `auth.md`).
