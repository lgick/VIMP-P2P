# A4. Сборка и деплой ✅важно

- **Dockerfile движка**: убрать Rust-стадию `core-builder` и `npm run game:build`
  (движок больше не собирает WASM игры). Node-стадия делает `npm ci` (ставит
  `@vimp/tanks` из registry, что приносит `dist/`) + `build:app` (Vite движка).
  Runner копирует `packages/engine/dist` + master + `node_modules/@vimp/tanks/dist`.
- **CI игры** (в её репозитории): Rust+wasm-pack стадия + `game:build` + публикация
  пакета. Обновление игры = bump версии пакета в `GAMES_MATRIX` движка (или
  автопулл «latest» по политике).
- Совместимость версий: `ENGINE_API_VERSION` теперь реально работает как контракт
  между репозиториями (в `plugin-api.md` уже отмечено: «bump policy kicks in once
  games live in external repos»). Мастер должен отвергать игру с несовпадающим
  `engineApi` (уже проверяется на импорте у хоста/клиента; добавить проверку и в
  `GameCatalog` при загрузке манифеста, чтобы не отдавать несовместимую игру).

## Критические файлы

`Dockerfile` + `.github/workflows/deploy.yml`.
