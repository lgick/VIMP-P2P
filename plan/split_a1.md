# A1. Публикуемые артефакты движка ✅критично

- **npm-пакет `@vimp/engine`.** Уже есть `exports`-мапа (`./lib/*`, `./config/*`).
  Игра импортирует из него только `@vimp/engine/config/opcodes.js`
  (`ENGINE_API_VERSION`). Настроить `publishConfig`/`files`, версионирование по
  `ENGINE_API_VERSION`. Первично можно публиковать в приватный GitHub Packages
  registry (или git-зависимостью), крейт — аналогично.
- **Rust-crate `vimp-engine-core`** (`packages/engine/core/`, rlib, без
  wasm-bindgen). Сейчас игра тянет его path-зависимостью
  (`games/tanks/core/Cargo.toml`: `path = "../../../packages/engine/core"`).
  Публиковать git-тегом (`vimp-engine-core = { git = "…", tag = "vX" }`) или в
  приватный registry. Внутри крейта — макросы ABI (`abi.rs`:
  `export_game_core_abi!`/`export_client_core_abi!`) и трейты
  (`sim.rs`/`client/game.rs`) уже уезжают вместе с ним без изменений кода.
- **Скрипты сборки игры** (`scripts/{export-maps,copy-game-sounds,`
  `build-game-manifest,process-audio}.js`) переезжают в репозиторий игры.
  `build-game-manifest.js` сейчас статически импортирует
  `packages/engine/src/config/opcodes.js` и `hostDefaults.js` — переключить на
  импорт из установленного `@vimp/engine`.
- Критерий: чистая сборка `games/tanks` при движке, подключённом только как
  опубликованный пакет/crate (без path-deps, без общего Cargo workspace).

## Критические файлы

`packages/engine/package.json` (`exports`/`publishConfig`/`files`),
`packages/engine/core/Cargo.toml`, `packages/engine/core/src/abi.rs`,
`scripts/build-game-manifest.js` (импорт из `@vimp/engine`).
