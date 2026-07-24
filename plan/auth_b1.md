# B1. Центральный auth-сервис + схема БД ✅критично

- Новый сервис (Node.js/Express, как мастер; отдельный деплой/домен). PostgreSQL
  (первая БД в проекте — сегодня зависимостей БД нет вообще). Таблицы `users`,
  `ratings`, `states`:

  ```
  users:    id, provider, provider_uid, nick(UNIQUE), created_at
  ratings:  user_id, game_id, rank, updated_at
  states:   user_id, game_id, state(JSONB opaque), updated_at   ← «скиллы»
  ```

  Ключ подписи JWT (RS256), публичная часть отдаётся на `/jwks`.
- REST-эндпоинты: OAuth start/callback на три провайдера; `POST /nick`
  (первый вход, проверка глобальной уникальности — заменяет пер-комнатный
  `checkName`); `GET /rank?game=`, `GET/PUT /state?game=` (Bearer JWT).
- Валидатор ника переиспользуется из движка (`packages/engine/src/lib/validators.js`,
  `NAME_REGEXP`) — вынести в общий пакет или продублировать в сервисе.

## Критические файлы

Новый auth-сервис (новый репозиторий/каталог) + PostgreSQL-схема;
`packages/engine/src/lib/validators.js` (общий валидатор ника).
