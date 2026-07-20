# Д7. Отложенные улучшения (низкий приоритет, по желанию)

Не блокируют релиз; делать по мере надобности.

- Форма комнаты, генерируемая по ключам `roomDefaults` (сейчас движковое
  лобби знает игровое поле `friendlyFire` — `config/lobby.js:62`;
  контрактно допустимо по §3.1, актуально при второй игре).
- Stat-колонки `status/score/deaths/latency`, безусловно пишемые движком
  (RoundManager/RTTManager) — сделать объявляемыми схемой.
- Нейтральные имена в Rust-трейте `GameClientDef` (`cycle_weapon`/`try_fire`
  → нейтральные) — внутренняя правка engine-crate, JS не затрагивает.
- `pixi.js`/`howler` → devDependencies `@vimp/engine`: `npm ci --omit=dev`
  в runner-образе перестанет тащить клиентские пакеты.
- cwd-зависимые пути мастера (`path.resolve('..','..','games')`,
  `express.static(path.join(...))`, WorkerCatalog) → якорь от
  `import.meta.url`.
