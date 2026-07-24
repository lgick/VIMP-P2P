# A2. Конфиг-список игр на мастере ✅критично

- В `packages/engine/src/config/master.js` добавить блок `games` (рядом с
  `iceServers`/`servers`/`host`): массив `{ id, package, version }`. В проде —
  переопределяемый env/CI-переменной (по образцу `SERVERS_MATRIX`), например
  `GAMES_MATRIX` (JSON).
- `packages/engine/src/master/GameCatalog.js`: заменить скан `games/*` на чтение
  манифестов из установленных пакетов
  (`node_modules/<package>/dist/manifest.json`). Публичный API каталога
  (`ids`/`manifestList`/`getManifest`/`getMapCatalog`) и все `/games/*` роуты
  (`master/main.js`) остаются как есть. Убрать hardcode
  `gamesDir = <engineDir>/../../games` (`main.js:21-22`).
- `express.static('/games/:id', …)` (`main.js:176-178`) монтируется на
  `dist/`-директорию установленного пакета игры.
- Dev-режим (`_toDevManifest`, Vite `/@fs/`): для локальной разработки игры —
  через `npm link`/локальный path пакета, чтобы HMR работал по исходникам игры.
- Клиентская мапа URL-ов (`config/lobby.js`) и выбор игры (сейчас `[0]`, селектор
  скрыт) — без изменений; много игр в списке уже поддержано.

## Критические файлы

`packages/engine/src/config/master.js` (блок `games`),
`packages/engine/src/master/GameCatalog.js`, `packages/engine/src/master/main.js`
(`gamesDir`, static-mount).
