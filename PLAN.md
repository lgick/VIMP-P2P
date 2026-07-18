# План отделения движка от игры (VIMP Engine ↔ игра-плагин)

## 1. Контекст и цель

VIMP P2P сейчас — монолит: движковая инфраструктура (мастер-сервер, WebRTC-транспорт, Worker-хост, мета-модули, MVC-каркас клиента, Rust-ядро) переплетена с игровым контентом (танки, оружие, бомбы, боты, карты, звуки, текстуры, тексты). Цель — превратить проект в **движок-приложение**, которое загружает **игру как внешний динамический плагин**. В будущем на движке появятся другие игры; игра со временем может переехать в отдельный репозиторий. Ботов в движке быть не должно — только нейтральная абстракция «скриптовый участник».

К игре относятся: персонажи (модели), карты и их названия, оружие, звуки, боты (ИИ и реестр), рендеры сущностей (parts), процедурные текстуры (bakers), тексты чата/голосований/информеров, раскладки клавиш игрока, схемы панели и статистики, баланс.

К движку относятся: мастер (лобби/сигналинг/каталоги), P2P-транспорт, Worker-инфраструктура и эстафета, мета-МЕХАНИЗМЫ (Panel/Stat/Chat/Vote/Timer/RTT/Participant/Round/CommandProcessor), MVC-каркас клиента, рендер-инфраструктура (CanvasManager/Factory/провайдеры), SoundManager, InputListener, Rust-каркас (Rapier-обвязка, фикс-шаг, кодек кадров, интерполяция, каркас предикта, raycast, PRNG, A*, spatial-grid).

Принятые решения:

1. **Композиция**: движок — приложение (деплоится один раз); игра — динамический плагин (JS-бандлы client/host, WASM, ассеты), загружаемый по манифесту с мастера. В перспективе один мастер обслуживает несколько игр.
2. **Rust-ядро**: пилится сразу на два crate — `vimp-engine-core` (rlib, каркас) и `vimp-tanks-core` (cdylib, игра + wasm-bindgen-обёртки), связь через трейты со статической мономорфизацией.
3. **Мета-модули**: Stat, Panel, Vote, Chat (и Round/Timer/RTT/Participant/CommandProcessor) — часть движка; **вся их параметризация — из конфига игры**: поля панели, колонки и количество команд статистики, определения и шаблоны голосований, чат-команды, тексты сообщений. DOM панели/статистики движок генерирует по схеме игры (сейчас захардкожен в pug).
4. **Структура**: npm workspaces `packages/engine` (`@vimp/engine`) + `games/tanks` (`@vimp/tanks`); cargo workspace `packages/engine/core` + `games/tanks/core`.

Следующий шаг разработки (НЕ входит в этот план, но учитывается в архитектуре): полноценные игровые слои карт и графический редактор тайловых карт как страница движка. Поэтому **формат карт и загрузчик — движковые**, контент карт — игровой; schema-friendly решения (respawns как словарь произвольных команд) закладываются сейчас.

## 2. Целевая структура репозитория

```
vimp-p2p/
├─ package.json                  # workspaces: packages/engine, games/tanks; корневые скрипты-прокси
├─ Cargo.toml                    # cargo workspace: packages/engine/core, games/tanks/core
├─ packages/engine/              # @vimp/engine — ДВИЖОК (приложение)
│  ├─ core/                      # Rust rlib vimp-engine-core (без wasm-bindgen)
│  ├─ src/master/                # мастер: HostRegistry, SignalingServer, WorkerCatalog,
│  │                             #   GameCatalog (новый), MapCatalog (per-game)
│  ├─ src/host/                  # HostGame, GameCoreAdapter (generic), meta/** (механизмы),
│  │                             #   host.worker.js (динамич. загрузка HostPlugin)
│  ├─ src/client/                # bootstrap (GameRuntime), MVC-компоненты, network/,
│  │                             #   SoundManager, InputListener, providers/*Provider
│  ├─ src/lib/                   # утилиты + сборщики конфигов (generic)
│  ├─ src/config/                # ДВИЖКОВЫЕ конфиги: wsports, opcodes (framing+HOT_FLAGS,
│  │                             #   ENGINE_API_VERSION), master, lobby, hostDefaults, clientDefaults
│  ├─ index.html                 # нейтральный shell (без игровых DOM-id)
│  └─ vite.config.js
├─ games/tanks/                  # @vimp/tanks — ИГРА (плагин)
│  ├─ core/                      # Rust cdylib vimp-tanks-core → pkg-web/pkg-node
│  ├─ src/host/                  # HostPlugin: createCore, event-router, TanksBotManager,
│  │                             #   /bot-команда, системные коды 'b:*'
│  ├─ src/client/                # ClientPlugin: parts/ (9 классов), bakers/ (8 текстур),
│  │                             #   хуки (onAuth/onPanel/onLocalAction), игровой CSS
│  ├─ src/config/                # игровые половины game.js/client.js, auth.js, sounds.js,
│  │                             #   snapshot-схема (ключи m1/w1/w2/w2e/c1/c2)
│  ├─ src/data/                  # maps/, models.js, weapons.js
│  ├─ assets/audio-raw/          # исходники звуков
│  └─ vite.config.js             # сборка бандлов плагина + manifest.json
└─ scripts/                      # общие скрипты сборки
```

## 3. Контракты движок ↔ игра

Четыре контракта, версионируются константой `ENGINE_API_VERSION` (движок, `packages/engine/src/config/opcodes.js`); несовпадение `plugin.engineApi` при загрузке → отказ с внятной ошибкой.

### 3.1. GameManifest (JSON, мастер → лобби/хост/клиент)

Генерируется сборкой игры в `dist/games/<id>/manifest.json` (версия — хеш контента бандлов, по образцу `WorkerCatalog`). **Мастер не исполняет код игры** — ему хватает манифеста и статических JSON карт (продукт `maps:export` при сборке игры).

```jsonc
{
  "id": "tanks",
  "engineApi": 1,
  "version": "<hash>",                     // gameVersion (контент client+host+wasm)
  "title": "VIMP Tanks",                   // для лобби
  "entries": {
    "client": "/games/tanks/client-<hash>.js",  // ESM, default export = ClientPlugin
    "host":   "/games/tanks/host-<hash>.js",    // ESM worker-safe, default export = HostPlugin
    "wasm":   "/games/tanks/core-<hash>.wasm"   // единый hashed .wasm обоих entry (общий HTTP-кеш)
  },
  "assetsBase": "/games/tanks/",           // база звуков/ассетов
  "maps": { "version": "<hash>", "list": ["pool mini", "canopy", "garden"] },
  "roomDefaults": { "maxPlayers": 8, "roundTime": 120000, "mapTime": 600000,
                    "friendlyFire": false, "map": "pool mini" }
}
```

Проекции: **мастер** — весь манифест + раздача `/games/:id/maps/*`; **хост** — `entries.host` (dynamic import в Worker'е) + `entries.wasm` + карты с мастера; **клиент** — `entries.client` (dynamic import после выбора комнаты) + `entries.wasm` + `assetsBase`. Богатые схемы (панель, тексты, keysets) в манифест НЕ входят — едут кодом плагинов и, как сейчас, данными CONFIG_DATA (порт 0) от хоста: клиентские данные игры всегда согласованы с хостом комнаты.

### 3.2. HostPlugin API (default export host-entry игры, worker-safe)

```js
export default {
  id: 'tanks',
  engineApi: 1,
  async createCore(coreConfigJson, { wasmUrl }) { /* init(wasmUrl); return new GameCore(...) */ },

  gameConfig: {                       // игровая половина бывшего config/game.js
    teams: { team1: 1, team2: 2, spectators: 3 },   // произвольное число команд
    spectatorTeam: 'spectators',
    models, weapons,                  // из games/tanks/src/data
    playerKeys, // spectatorKeys — движковые (наблюдение — механизм движка)
    panel: { fields: { health: {key:'h', value:100}, w1: {…}, w2: {…} }, activeKey: 'wa' },
    stat:  { columns: {name:{…}, status:{…}, score:{…}, deaths:{…}, latency:{…}} },
    scripted: { namePrefix: 'Bot', defaultModel: 'm1' },   // вместо хардкодов Bot${id}/'m1'
    mapScale: 0.3, mapSetId: 'c1', mapsInVote: 4, defaultMap: 'pool mini',
    chatMaxLength: 60,
    initialVote: 'teamChange',        // вместо хардкода SocketManager.sendFirstVote
    soundCues: { roundStart:'roundStart', victory:'victory', defeat:'defeat',
                 frag:'frag', death:'gameOver' },          // вместо хардкодов SocketManager
  },

  buildCoreGameConfig(overrides),     // game-секция init-JSON ядра
  buildClientGameConfig(),            // game-секция CONFIG_DATA (см. 3.5)
  authSchema: { params: [...], validators: { isValidModel: v => v in models } },

  onCoreEvent(ctx, event),            // только 'custom'-события; стандартные роутит движок
  chatCommands: [{ name: '/bot', handler(ctx, gameId, args) {…} }],   // регистрация в CommandProcessor
  systemMessages: { BOT_PLAYERS_ONLY: 'b:0', … },                     // merge в реестр кодов движка
  voteDefs: ['createBots', 'createBotsForTeam', 'removeBots', 'removeBotsForTeam'],

  createModules(ctx) { return { bots: new TanksBotManager(ctx) }; },
  // ctx = { participants, coreAdapter, panel, stat, chat, roundManager,
  //         voteCoordinator, timerManager, socketManager }
  // Контракт scripted-модуля (дергает движок — RoundManager/HostGame):
  //   createMap(scaledMapData), createBots(count, team?), removeBots(team?),
  //   removeOneBotForPlayer(team), getBots(), getBotCount(), getBotCountsPerTeam()
};
```

### 3.3. ClientPlugin API (default export client-entry игры)

```js
export default {
  id: 'tanks',
  engineApi: 1,
  async createClientCore(clientConfigJson, { wasmUrl }) { /* init(wasmUrl); return { core, memory } */ },
  parts:  { Map, MapRadar, Tank, TankRadar, Bomb, ExplosionEffect, Smoke, Tracks, ShotEffect },
  bakers: { explosionTexture, …, trackMarkTexture },
  styles: '…css…',                    // игровой CSS (спрайты оружия панели и т.п.)
  views: { Panel: CustomPanelView },  // опционально: свои view вместо schema-генератора (см. ниже)
  hooks: {
    onAuth(core, authData)   { core.set_model(authData.model); },
    onPanel(core, panelData) { core.sync_panel(JSON.stringify(panelData)); },
    onLocalAction(core, action, name, now) { /* try_fire / cycle_weapon; → JSON спавна | null */ },
  },
};
```

**Ключевое: модули Stat/Panel/Vote/Chat — движковые, но настраиваются конфигом игры.** Следствия:

| Движковый модуль | Что поставляет игра (через CONFIG_DATA / gameConfig) |
| --- | --- |
| Panel (host + client MVC) | схема полей (`fields` + типы отображения: bar/число/время/иконка-оружия), `activeKey`; движковый PanelView **генерирует DOM по схеме** (замена хардкода `panel.pug` `#panel-health/-bullet/-bomb/-time`), внешний вид полей — CSS игры |
| Stat (host + client MVC) | колонки (имена/методы агрегации) и **список команд произвольной длины**; движковый StatView **генерирует таблицы по числу команд** (замена хардкода `stat.pug` `#team1/#team2/#spectators` и 5 фиксированных колонок) |
| Vote (host + client MVC) | определения игровых голосований (`voteDefs`) + все шаблоны/меню (тексты); движковые голосования механизмов (teamChange, mapChangeByUser/BySystem) остаются в движке, их тексты — тоже у игры |
| Chat (host + client MVC) | игровые коды системных сообщений (группа `b:*` и будущие) + ВСЕ тексты сообщений; движок владеет механизмом и кодами своих механизмов (`s/v/m/c/n`) |
| CommandProcessor | регистрация игровых команд (`/bot`); движковые `/name`, `/nr`, `/timeleft`, `/mapname` остаются |
| RoundManager / ParticipantManager | `teams` (произвольные), `spectatorTeam`, respawns из карт, `scripted`-параметры; в движке — нейтральное понятие «scripted participant» (геттер `isScripted`; слова «bot» в движке не остаётся) |
| SocketManager | `soundCues` (какой звук на какое движковое событие), `initialVote` |
| SoundManager (client) | список звуков + файлы (`assetsBase`) |
| Controls (client) | player-keyset и раскладка; спектаторский набор — движковый |
| Auth | схема формы (`authSchema`) + валидатор модели |

Опциональный обход схемы: `views: { Panel?, Stat? }` — кастомный view-класс игры, реализующий view-интерфейс MVC-тройки (подписка на движковую модель через `Publisher`; model/controller остаются движковыми). В v1 движок реализует только schema-генератор — поле лишь валидируется при загрузке плагина, подстановка добавится при первой необходимости. Радиальные/canvas-индикаторы возможны и без этого: HUD-сущность на canvas — обычный `part`.

### 3.4. Generic WASM ABI (Wasm Host ABI v1)

Обёртки `#[wasm_bindgen] GameCore/ClientCore` живут в game-crate (wasm-bindgen не экспортирует generics), но обязательный набор методов фиксирует движок (часть `engineApi`) — их вызывает движковый JS. Принцип: **горячий путь без JSON** (скаляры + zero-copy указатели); JSON — конструктор/карта/события/редкие запросы.

Бойлерплейт делегации (~45 методов на два класса) снимают движковые макросы `export_game_core_abi!($Sim)` / `export_client_core_abi!($Client)` (`macro_rules!` в `vimp-engine-core` — единственный источник истины обязательного набора, дрейф исключён): game-crate вызывает их рядом со своими дополнительными методами (`try_fire`, `set_model`, `sync_panel`, кастомные аргументы `spawn_actor`). Раскрытие происходит в game-crate, поэтому `#[wasm_bindgen]`/`JsError` резолвятся против его зависимостей — engine-crate от wasm-bindgen по-прежнему не зависит. Procedural macro не нужен: список методов фиксирован.

GameCore — переименования: `spawn_tank`→`spawn_actor`, `remove_tank`→`remove_actor`, `reset_tank`→`reset_actor`, `add_bot`→`spawn_scripted_actor`, `remove_bot`→`remove_scripted_actor`. Без изменений: `new(configJson)` (формат `{engine:{timeStep,seed,snapshot,mapScale,mapSetId}, game:{models,weapons,panel,playerKeys,friendlyFire}}`), `load_map`, `map_info`, `apply_input`, `step`, `take_events`, `pack_body`, `pack_frame`, `body_has_events`, `frame_ptr/frame_bytes`, `is_alive`, `position_of`, `players_data`, `alive_players`, `last_input_seq`, `reset_all_vitals`, `remove_players_and_shots`, `clear`, `serialize_state/deserialize_state`.

Стандартный словарь событий `take_events` (убирает игровой словарь из `GameCoreAdapter._drainEvents`, src/host/GameCoreAdapter.js:114-144):

```jsonc
[{ "type": "panelSet",    "id": 3, "field": "health", "value": 55 },   // field — имя поля схемы панели
 { "type": "panelActive", "id": 3, "field": "w2" },
 { "type": "death",       "victim": 3, "killer": 1 },
 { "type": "shake",       "id": 3, "intensity": 20, "duration": 200 },
 { "type": "custom",      "data": {…} }]                                // → HostPlugin.onCoreEvent
```

ClientCore — движковый минимум: `new`, `push_frame`, `my_game_id`, `offset`, `sample`, `hot_ptr/hot_values`, `take_frames`, `apply_input`, `set_active`, `set_map`, `reset`, `decode_frame`. Игровые методы (`set_model`, `try_fire`, `cycle_weapon`, `sync_panel`) в минимум не входят — их зовут только хуки ClientPlugin.

**Snapshot-блоки — декларативная схема вместо жёстких раскладок.** `SnapshotConfig.keys` расширяется до полной схемы блока: `id`, ширины count/id, `nullMarker`, список полей с типом (`f32/u8/u16/u32`) и способом интерполяции (`lerp`/`lerpAngle`/дискретное), класс `hot` (интерполируется) / `event` (только кадром), `idPrefix`. Пакер (`snapshot.rs`), анпакер (`client/unpack.rs`), интерполятор и hot-буфер движка становятся интерпретаторами схемы; game-crate поставляет строки как плоские `RowData`. Та же схема едет клиентскому JS в CONFIG_DATA → generic `reconstructHot` (замена захардкоженной «12-польной» раскладки танка в `src/client/main.js:505-551`); `SNAPSHOT_KEYS` из клиентского бандла исчезает (схему всегда даёт хост — устраняется скрытая связь «бандл клиента обязан совпадать с хостом»). Player-блок описывается схемой `playerState` (сейчас `[f32;8]+centering`). `SNAPSHOT_FORMAT_VERSION` → 4 (фрейминг движка); байт-совместимость между деплоями не требуется (хост и клиенты — один деплой; версия защищает только фрейминг внутри комнаты).

### 3.5. CONFIG_DATA (порт 0)

Остаётся движковым механизмом; собирается `buildClientConfig` как merge: движковые дефолты (`clientDefaults`: interpolation, controls.modes/cmds, elems-структура, techInformList) + `HostPlugin.buildClientGameConfig()` (parts.gameSets/entitiesOnCanvas/bakedAssets/componentDependencies/sounds, keySetList, схемы panel/stat, тексты chat/vote/gameInform, prediction: models/weapons/playerKeys/timeStep) + снапшот-схема + производные комнаты (voteTime). `initIdList`/список канвасов — из конфига, не из хардкода.

### 3.6. Rust-трейты `vimp-engine-core`

Engine-crate — чистый Rust без wasm-bindgen (ошибки `Result<_, String>`; в `JsError` мапит game-crate). Статическая generic-диспетчеризация: `EngineSim<TanksGame>` / `EngineClient<TanksClient>` мономорфизируются — ноль оверхеда на 120 Гц; `dyn` не нужен (один wasm-бандл = одна игра).

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G>`: `new`, `spawn_actor`, `spawn_scripted`, `remove_actor`, `reset_actor`, `reset_all_vitals`, `apply_input`, `on_fixed_step(ctx, dt)`, `on_contacts(ctx, pairs)`, `on_ai_tick(ctx, dt)`, `build_blocks(ctx) -> (Vec<(String, RowBlock)>, has_events)`, `prediction_state`, `players_json`, `alive`, `position`, `last_input_seq`, `clear`, `remove_players_and_shots`, `serialize/deserialize` (mid-round handoff — задел, сохраняется).
- `SimCtx<'a, G>` — доступ игры к движковому: `world` (Rapier), `map` (respawns — `IndexMap<String, Vec<[f32;3]>>`, произвольные команды), `nav`/`spatial` (A*/сетка — движковые утилиты в модуле `nav/`, без слова «bot»), `rng`, `events`, `game_cfg`, destroy-очередь.
- Движок владеет: аккумулятор фикс-шага, сбор контактов, destroy-очередь, schema-driven `SnapshotPacker`, handoff-каркас, `EngineEvent`.
- Клиентская половина: `trait GameClientDef { type Config; const STATE_LEN; fn motion_step(state, keys, model, dt, ctx: &PredictCtx); fn render_from_state(state) }`; `PredictCtx` даёт опциональный доступ к движковой сетке статических тайлов (та же, что у raycast — клиентское ядро уже владеет картой через `set_map`) — задел под клиентское скольжение вдоль стен для жанров без инерции; танки контекст игнорируют (parity-тесты не меняются). Движок — `Interpolator` (schema-driven), `Predictor<G>` (история ввода, reconciliation, visual-error decay), hot-буфер, raycast. `ShotPredictor` (try_fire/cycle_weapon/sync_panel/filter_frame_game/клиентский спавн) — целиком в game-crate, зовёт движковый raycast.

Разъезд модулей текущего `core/src/`:

| → `vimp-engine-core` | → `vimp-tanks-core` |
| --- | --- |
| `physics.rs` (мир, generic BodyTag, math), `rng.rs`, `map.rs`, `bots/pathfinder.rs`+`bots/spatial.rs` (→ `nav/`), фрейминг `snapshot.rs`, `client/{interpolator,predictor(generic),raycast,unpack(framing),hot}`, фикс-шаг/контакты из `game.rs`, handoff-каркас | `tank.rs`, `bomb.rs`, `motion.rs` (+parity-тесты), `events`-маппинг, `bots/{controller,navigation}.rs`, игровая логика `game.rs` (→ `sim.rs`), `client/shot.rs`, game-раскладки блоков (как схема+RowData), `#[wasm_bindgen]`-обёртки, `tests/sim.rs` |

### 3.7. Версии и совместимость

| Константа | Владелец | Политика |
| --- | --- | --- |
| `ENGINE_API_VERSION` (=1) | движок | проверяется при import плагинов (host worker и клиент); ломающие изменения Plugin API / Wasm ABI → +1 |
| `SNAPSHOT_FORMAT_VERSION` (→4) | движок (фрейминг) | схема блоков едет в CONFIG_DATA → внутри комнаты всегда согласована |
| `HANDOFF_VERSION` (→2) | движок | +`gameId`, `gameVersion` в мете эстафеты; несовпадение → штатный `resume` |
| `codeVersion` | мастер | составной: `{ engine: hash(host.worker-*.js), game: {id, version} }`; расхождение любой части → эстафета (новый Worker получает свежий `entries.host`) |
| `mapsVersion` | мастер | per-game: `/games/:id/maps/manifest.json` |

## 4. Этапы

Сквозные правила каждого этапа: `npx eslint .` + `npm test` + `npm run core:test` зелёные; `npm run dev` живой (две вкладки играют); тесты правятся в том же PR, что и код; **docs/{en,ru} актуализируются в том же изменении** (правило CLAUDE.md). Размеры: S≈день, M≈2–4 дня, L≈неделя, XL≈2+ недели.

### Этап 1. Фиксация контрактов (S, 1 PR) — ✅ выполнен

- `docs/{en,ru}/plugin-api.md` — черновик контрактов из раздела 3 (GameManifest, HostPlugin, ClientPlugin, Wasm ABI, снапшот-схема, версии).
- В `docs/{en,ru}/architecture.md` — ADR: «движок — приложение, игра — динамический плагин»; таблица распила файлов (полная разметка ENGINE/GAME/MIXED из аудита).
- `ENGINE_API_VERSION` в `src/config/opcodes.js` (номинально).
- Готово: документы есть, код не менялся.

### Этап 2. Каркас монорепо + листовые данные (M, 1–2 PR) — ✅ выполнен

- Корневой `package.json` → `workspaces: ["packages/engine", "games/tanks"]`; создать `games/tanks/package.json` (`@vimp/tanks`, exports `./data/*`, `./config/*`). Движковый код пока остаётся в `src/` корня.
- Перенести: `src/data/{models.js,weapons.js,maps/}` → `games/tanks/src/data/`; `src/config/sounds.js` и `src/assets/audio-raw` → `games/tanks/`.
- Поправить все точки входа игровых данных (их ровно три): `src/config/game.js:1-3`, `src/lib/coreConfig.js:7-8`, `src/master/main.js:11`; плюс `scripts/export-maps.js`, `scripts/process-audio.js`, пути coverage в `vitest.config.js`, nodemon watch (`games/tanks/src`).
- `vite.config.js`: `server.fs.allow` расширить до корня репо — Vite dev должен читать воркспейс-симлинк `node_modules/@vimp/tanks` и файлы `games/` вне будущего Vite-root `packages/engine`.
- Готово: тесты/линт/dev/`maps:export`/`audio:process` работают; smoke: Vite и бандл worker'а переваривают workspace-симлинк `node_modules/@vimp/tanks`.

### Этап 3. JS-инверсия на месте (XL, 8–10 мелких PR)

Новые игровые модули сразу создаются в `games/tanks/src/`; движок временно импортирует их статически (композиция рвётся в этапе 6).

| PR | Задача | Ключевые файлы |
| --- | --- | --- |
| 3.1 ✅ | `GameCoreAdapter._drainEvents`: игровой словарь → инъецируемый `eventRouter` (временный мост до стандартных событий этапа 4a) | `src/host/GameCoreAdapter.js`, новый `games/tanks/src/host/coreEventRouter.js` |
| 3.2 ✅ | `SocketManager`: `sendRoundStart/Victory/Defeat/FragSound/GameOverSound` → generic `sendSoundCue(cue)` по `soundCues`; `sendFirstVote` → `initialVote` из конфига | `src/host/meta/SocketManager.js`, `src/host/HostGame.js`, `src/host/meta/core/RoundManager.js` |
| 3.3 | `CommandProcessor`: движковое ядро (`/name`,`/nr`,`/timeleft`,`/mapname`) + `registerCommand()`; `/bot` со всей логикой и голосованиями → игра | `src/host/meta/core/CommandProcessor.js`, `games/tanks/src/host/botCommand.js` |
| 3.4 | `systemMessages.js`: движковый реестр (группы s/v/m/c/n) + `registerCodes()`; группа `b:*` → игра | `src/host/meta/modules/chat/systemMessages.js`, `games/tanks/src/host/systemMessages.js` |
| 3.5 | Разрез `config/game.js`: движковое (`maxPlayers`, `timers`, `rtt`, `idleKickTimeout`, `isDevMode`, `chatMaxLength`?) → `src/config/hostDefaults.js`; игровое (`teams`, `spectatorTeam`, `panel`, `stat`, `playerKeys`, `mapScale`, `mapSetId`, `mapsInVote`, `currentMap`, `parts.*`) → `games/tanks/src/config/game.js`; спектаторский keyset — движковый | `src/config/game.js`, `src/lib/coreConfig.js`, `src/host/host.worker.js` (включая `MAX_ROOM_PLAYERS=8` → roomDefaults) |
| 3.6 | Разрез `config/client.js`: движковое (`interpolation`, controls.modes/cmds, elems-структуры, `techInformList`, `initIdList`-механика) → `src/config/clientDefaults.js`; игровое (`parts.*`, `keySetList`, схемы panel/stat, тексты chat/vote/gameInform, канвасы) → `games/tanks/src/config/client.js`; merge в `buildClientConfig` | `src/config/client.js`, `src/lib/buildClientConfig.js` |
| 3.7 | Auth: `config/auth.js` → игра; `isValidModel` (хардкод `'m1'`, `src/lib/validators.js:16`) → валидатор из `authSchema` | `src/lib/validators.js`, `src/host/host.worker.js` |
| 3.8 | Panel: ключ `'wa'` (`src/host/meta/modules/Panel.js:99`) → `activeKey` из схемы | `src/host/meta/modules/Panel.js` |
| 3.9 | Боты: `HostBotManager` → `games/tanks/src/host/TanksBotManager.js` (контракт scripted-модуля, `createModules(ctx)`); в движке `Participant`/`ParticipantManager` — нейтральный `isScripted` (алиас `isBot` до конца этапа 5), имя `Bot${id}` → `scripted.namePrefix`, модель `'m1'` → `scripted.defaultModel` | `src/host/HostBotManager.js`, `src/host/meta/player/*`, `src/host/HostGame.js` (`_freeSlotForHuman` — generic политика «scripted уступают людям») |
| 3.10 | Клиент: собрать HostPlugin/ClientPlugin-объекты (пока статический импорт); из `main.js` вынести хуки (set_model/sync_panel/try_fire/cycle_weapon — строки 242, 358-361, 721-731); **PanelView/StatView движка генерируют DOM по схеме игры** (замена `panel.pug`/`stat.pug`; произвольное число команд и полей); канвасы — из конфига; игровой CSS отделить от движкового `style.css` | `src/client/main.js`, `index.html`, `src/client/views/includes/{panel,stat}.pug`, `src/client/components/view/{Panel,Stat}.js`, `games/tanks/src/client/index.js` |

Готово: после каждого PR тесты зелёные и поведение в dev идентично; после 3.10 — ручной smoke двух вкладок (движение/выстрелы/панель/стата/чат/голосования/боты).

### Этап 4. Rust: генерализация и распил ядра (XL, параллелен этапу 3; 4a — до этапа 5)

**4a. Генерализация в одном crate (XL, 3 PR).**
1. Трейты `GameDef/GameSim` + `EngineSim<TanksGame>`: `GameState` (`core/src/game.rs`) распадается на движковый цикл (аккумулятор фикс-шага, контакты, destroy-очередь — `game.rs:344-417`) и `TanksSim` (`on_fixed_step`/`on_contacts`/`on_ai_tick`); ABI-переименования (`spawn_actor`/`spawn_scripted_actor`/...); зеркально `GameCoreAdapter`.
2. Schema-driven снапшот: расширенный `SnapshotConfig` (схема блоков + `playerState`), интерпретаторы в `snapshot.rs`/`unpack.rs`/интерполятор/hot-буфер; `SNAPSHOT_FORMAT_VERSION=4`; зеркально `src/config/opcodes.js` (схема уходит в конфиг игры) и generic `reconstructHot` в `main.js`.
3. Стандартные события (`panelSet/panelActive/death/shake/custom`) + конфиг `{engine, game}`; `GameCoreAdapter._drainEvents` → generic-роутинг (снимает временный eventRouter из 3.1); `Predictor` generic (`STATE_LEN` из схемы), `ShotPredictor` → игровой модуль crate.
- Готово: `cargo test` (~90) зелёный, `tests/core/*` + `tests/host/HostGame.test.js` зелёные на пересобранном `pkg-node`, бенчмарк-гейт `step+pack_body` без деградации, ручной smoke.

**4b. Физический распил на два crate (L, 1–2 PR).**
- `packages/engine/core` (`vimp-engine-core`, rlib, БЕЗ wasm-bindgen) + `games/tanks/core` (`vimp-tanks-core`, cdylib+rlib, обёртки `GameCore/ClientCore` — через движковые макросы `export_game_core_abi!`/`export_client_core_abi!`, см. 3.4); корневой cargo workspace.
- npm-скрипты: `core:build:web/node` → `wasm-pack build games/tanks/core ...` (артефакты `pkg-web/pkg-node` — теперь игры); харнессы `tests/core/helpers.js`, `tests/host/harness.js`, `describe.skipIf`-пути; CI `test.yml`.
- Тесты движковых модулей (интерполятор, предиктор, raycast, unpack, snapshot, nav) — в engine-crate на `#[cfg(test)]`-фикстуре `TestGame`; parity и `tests/sim.rs` — в tanks-crate.
- Готово: обе цели собираются, все тесты зелёные, `cargo test --workspace` в CI.

### Этап 5. Физический переезд JS (L, 2–3 PR; после 3 и 4a)

- `src/{master,host,client,lib,config}` + `index.html` + `vite.config.js` → `packages/engine/`; корень — только оркестрация (`npm run dev` → `npm -w @vimp/engine run dev`). Игровые остатки (parts/, bakers/, игровой CSS, конфиги) → `games/tanks/src/client/`.
- Временная статическая композиция — единственный файл `packages/engine/src/gameRegistry.static.js` (импортирует `@vimp/tanks/host` и `@vimp/tanks/client`), помечен к удалению в этапе 6.
- ESLint-граница: `no-restricted-imports` — `packages/engine/**` (кроме gameRegistry.static.js) не импортирует `@vimp/tanks/**`/`games/**`; `games/tanks/**` импортирует только публичные entry `@vimp/engine`. Нарушение = ошибка CI.
- `vitest.config.js` → projects: `engine-node`, `engine-client`, `tanks`, `integration` (`tests/host/HostGame.test.js` и tests/core — integration: реальное ядро танков).
- Финал этапа: снять алиас `isBot` в движке (остаётся `isScripted`).
- Готово: граница чиста, тесты зелёные, dev и сборка работают.

### Этап 6. Динамическая загрузка игры (XL, 4–5 PR)

| PR | Задача |
| --- | --- |
| 6.1 | **Сборка игры**: `games/tanks/vite.config.js` — два независимых build-прогона (client-entry, host-entry worker-safe) в общий `dist/games/tanks/`; wasm — hashed asset (общий у обоих entry; URL — `entries.wasm` манифеста); пост-шаги: `maps:export` → `dist/games/tanks/maps/*.json`, звуки → `dist/games/tanks/sounds/`, генерация `manifest.json` (хеш-версии). Проверка: host-бандл не содержит DOM-кода |
| 6.2 | **Мастер**: `GameCatalog` (`packages/engine/src/master/GameCatalog.js`, по образцу `WorkerCatalog`) — сканирует `dist/games/*/manifest.json`; REST `/games/manifest.json`, `/games/:id/manifest.json`, `/games/:id/maps/*` (per-game `MapCatalog`); `HostRegistry` + `GET /servers` + `register_host`/`host_registered` — поля `gameId`/`gameVersion`. Dev-режим: манифест с Vite-URL исходников (`/@fs/…/games/tanks/src/client/index.js` — трансформация и HMR штатные), `entries.wasm` — Vite-URL `.wasm` из `pkg-web`; ассеты (звуки, карты из `games/tanks/src/data`) — `express.static`-mount `/games/:id/` на мастере |
| 6.3 | **Клиент**: лобби — `roomDefaults` из манифеста в форму создания комнаты (селект игры скрыт, пока игра одна); «Создать сервер» — фича-детект module worker + dynamic import с внятной ошибкой («браузер не может быть хостом»; join не блокируется); join: `GET /games/:id/manifest.json` → `import(entries.client)` → проверка `engineApi` → подключение; `sounds.path` от `assetsBase`; удалить клиентскую половину `gameRegistry.static.js` |
| 6.4 | **Worker**: `init`-сообщение несёт `room.game = {id, version, hostEntryUrl, wasmUrl}`; `host.worker.js` → `await import(hostEntryUrl)` → `plugin.createCore(coreConfigJson, { wasmUrl })`; `applyRoomOverrides` валидирует по `roomDefaults`; удалить `gameRegistry.static.js` целиком |
| 6.5 | **Эстафета**: составной `codeVersion` (движок+игра), `HANDOFF_VERSION=2` (+gameId/gameVersion), при свопе новый Worker получает свежий `hostEntryUrl`; сбой → существующий `resume`-путь |

Готово: `npm run build` даёт dist движка + `dist/games/tanks/`; ручной сценарий эстафеты с подменой версии игры; dev-режим без пересборки работает; тесты зелёные.

### Этап 7. Фикстурная мини-игра и CI-матрица (M, 2 PR; можно после 5)

- JS-фикстура `packages/engine/tests/fixtures/miniGame/`: HostPlugin с fake-core (JS-объект, реализующий Wasm Host ABI — благодаря generic ABI это ~150 строк) + ClientPlugin с 1–2 заглушечными parts и минимальными схемами panel/stat (1 команда! — проверка настраиваемости). Тесты движковой меты/HostGame переводятся на фикстуру; интеграционные на реальном `@vimp/tanks` остаются в `integration`.
- Rust: расширить сценарии `TestGame` в engine-crate (схемы снапшота, предиктор).
- CI-матрица: `lint` → `engine` (cargo engine + vitest engine-*) / `tanks` (cargo tanks + vitest tanks) / `integration` (core:build:node + сборка игры + integration).
- Готово: движковые тесты проходят без Rust-артефактов игры; матрица зелёная. Фикстура — фактическое доказательство «второй игры».

### Этап 8. Сборка, деплой, документация, финал (L, 2–3 PR)

- Dockerfile: rust-стадия — `wasm-pack build games/*/core`; node-стадия — движок + игры (`dist/` + `dist/games/*`); runner — `dist/`, `public/`, `packages/engine/src/{config,lib,master}` (каталог `src/data` из runner-а исчезает — карты в `dist/games/*/maps`). `deploy.yml` — без сущностных изменений.
- Документация `docs/{en,ru}`: реструктуризация — движковые страницы (architecture, master, host, client, core, network, configuration, deployment) + `plugin-api.md` + страница игры (`games/tanks.md`: правила, баланс, карты/оружие/звуки из текущих gameplay/extending); переписать CLAUDE.md (структура, команды, границы, таблица актуализации доков).
- Чек-лист выноса `games/tanks` в отдельный репозиторий: публикация `@vimp/engine` (npm/архив) + `vimp-engine-core` (git/crates-зависимость), CI игры, политика `engineApi`.
- Финальный ручной smoke: две вкладки (движение/выстрелы/респаун/смена карты/боты/голосования/чат/панель/стата), эстафета Worker'ов, `/ban`, прод-развёртывание на VPS.

Критический путь: 1 → 2 → 3 → 5 → 6 → 8; этап 4 параллелен 3 (синхронизация: 4a до 5); 7 — после 5.

## 5. Риски

1. **wasm-bindgen и generics** — решено обёртками в game-crate; engine-crate не должен зависеть от wasm-bindgen вовсе (иначе конфликт glue). Проверить в 4b сборку `wasm-pack build games/tanks/core` с path-dependency.
2. **Производительность** — мономорфизация без оверхеда; schema-driven кодек — интерпретация на ~30 упаковок/сек, пренебрежимо на фоне Rapier; `sample()` без аллокаций (переиспользуемый буфер). Бенчмарк-гейт в 4a (время `step+pack_body` до/после).
3. **Vite и мульти-entry игры** — общие chunks могут утащить DOM-код в worker-бандл: собирать client/host двумя независимыми прогонами. WASM грузится только по явному `entries.wasm` через `init(url)` — `import.meta.url`-резолюция glue не используется вовсе (известные грабли динамически импортируемых модулей в Worker'е); base64-инлайн отвергнут (+33% размера, ломает `instantiateStreaming`, дублирует WASM в двух бандлах вместо общего HTTP-кеша).
4. **Двойной WASM во вкладке хоста** (GameCore в Worker + ClientCore в main thread) — уже так; следить, чтобы оба entry ссылались на один hashed `.wasm` (HTTP-кеш).
5. **CSP/динамический import** — бандлы игры same-origin (`/games/...`): `script-src 'self'` достаточно, для wasm — `'wasm-unsafe-eval'` в prod-CSP Nginx (задокументировать в deployment.md). Module-Worker — уже требование текущего прода (`HostController` создаёт `new Worker(url, {type:'module'})`), и нужен он только хосту комнаты; classic-fallback не строим (запретил бы ESM и потребовал инлайн WASM) — вместо него фича-детект при «Создать сервер» (6.3). Dynamic import в module-Worker'е — включить в smoke этапов 6 и 8 (особенно Firefox/Safari).
6. **Эстафета при рассинхроне** — плагин с чужим `engineApi` отвергается при init нового Worker'а → штатный `resume`; хеши по содержимому, чтобы смена только манифеста не провоцировала эстафету.
7. **Schema-driven DOM панели/статы** — самый заметный UI-рефакторинг (генерация вместо pug): регресс стилей/z-index; игровой CSS отделяется от движкового. Митигируется ручным smoke в 3.10 и скриншот-сравнением.
8. **Объём правок тестов** (~620 JS) — этапы 3 (моки SocketManager/CommandProcessor/Panel), 4a (формы decode_frame в harness), 5 (пути). Митигируется мелкой нарезкой PR и правилом «тесты в том же PR».
9. **Инварианты, которые легко потерять**: gameId в кадре — u8 (≤255 участников — задокументировать в plugin-api.md); порядок ключей `weapons` определяет weapon-index (зафиксировать тестом); соответствие полей `panel` ↔ ключей `weapons` валидировать в `new GameCore`.
10. **Dev-DX** — HMR для parts сохраняется через Vite-URL исходников в dev-манифесте; для Worker'а HMR нет и не было (reload); nodemon следит за `games/*/src`.

## 6. Открытые вопросы (решать по ходу, с рекомендациями)

- **`GAME_CODES`/`gameInform`** (winnerTeam/roundStart/gameOver): раунды — движковый механизм, тексты — у игры (рекомендация: оставить коды движковыми, на v1 не усложнять хуками).
- **Лобби при нескольких играх**: поля `gameId`/`title` в `/servers` и фильтр заложить в 6.2/6.3; полноценный UI выбора игры — при появлении второй игры.
- **Публикация движка для внешнего репозитория игры**: npm-пакет + git/crates-зависимость engine-core — решение на этапе 8 (чек-лист), монорепо не блокирует.
- **`serialize_state`/`deserialize_state`** (mid-round handoff): переводятся на `{engine, game}`-дамп через `GameSim::serialize`, сохраняются как задел — не выпиливать.
- **`chatMaxLength`** — связан с DOM-инпутом чата (движок) и валидацией хоста: рекомендация — движковый параметр с override игры.

## 7. Задел под пункт 2 (слои карт и редактор — вне этого плана)

- Формат тайл-карты — движковый (`map.rs` + `MapCatalog`/`maps:export`), контент — игровой: редактор карт станет страницей движка, пишущей движковый формат.
- `respawns` как словарь произвольных команд (3.6) и schema-driven снапшот (3.4) — уже готовы к «полноценным игровым слоям» (слой как поле сущности в схеме, семантика слоёв — у игры).
- Схемы panel/stat/vote (произвольные команды/поля) не будут мешать картам с иным числом команд.
- `PredictCtx` в `motion_step` (3.6) — готовый канал доступа предиктора к сетке статических тайлов карты: клиентские коллизии/скольжение вдоль стен для будущих жанров без инерции, без bump `ENGINE_API_VERSION`.

## 8. Верификация всего плана

- Автоматическая: на каждом этапе — `npx eslint .`, `npm test`, `npm run core:test` (позже `cargo test --workspace`), CI-матрица этапа 7; ESLint-граница «движок не импортирует игру» с этапа 5.
- Ручной smoke (минимум в 3.10, 4a, 6, 8): две вкладки — создание комнаты, движение/выстрелы/урон/респаун, панель/стата/чат/голосования, `/bot`, смена карты; эстафета Worker'ов с подменой версии; `/ban`.
- Доказательство отделимости: фикстурная мини-игра (этап 7) собирается и проходит движковые тесты без единого импорта из `games/tanks`.
