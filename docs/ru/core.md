# Rust-ядро симуляции (packages/engine/core + games/tanks/core)

Cargo-workspace из двух crate: физика, фикс-шаг, фрейминг снапшота,
примитивы интерполяции/предикта/raycast и нав-утилиты — движковый код
(`vimp-engine-core`, rlib, **без wasm-bindgen**); танки, оружие, боты и
wasm-bindgen ABI (`GameCore`/`ClientCore`) — игровой crate
(`vimp-tanks-core`, cdylib+rlib), зависящий от движкового. Движковый crate
не может импортировать ничего игрового — вторая игра добавит свой crate
рядом с `games/tanks/core`, переиспользуя `vimp-engine-core` без изменений.
Ядро работает у браузерного хоста (`GameCore`, [host.md](host.md)) **и у
каждого клиента** (`ClientCore` — клиентская математика: интерполяция,
предикт, визуальный спавн снарядов, распаковка кадров).

**Граница ядра — симуляция, а не мета**: чат, голосования,
статистика, панель, оркестрация раундов, реестр участников и auth остаются
на JS. Мета управляет ядром командами и питается его событиями.

## Структура

```
Cargo.toml                        # workspace: packages/engine/core, games/tanks/core
packages/engine/core/             # vimp-engine-core — rlib, без wasm-bindgen
├── Cargo.toml                    # rapier2d (enhanced-determinism, serde) — без wasm-bindgen
├── src/
│   ├── lib.rs                    # только объявления pub mod
│   ├── sim.rs                    # GameDef/GameSim/SimCtx — граница движок↔игра
│   ├── game.rs                   # EngineSim<G> — тик, контакты, очередь удаления, handoff
│   ├── abi.rs                    # export_game_core_abi!/export_client_core_abi! —
│   │                              #   макросы wasm-bindgen-обвязки (см. разделы ABI ниже)
│   ├── map.rs                    # GameMap — статика/динамика тел, масштабирование карт
│   ├── snapshot.rs                # SnapshotPacker + Block — упаковка бинарного кадра v3;
│   │                              #   Block обобщён по форме строки (Indexed8/Indexed32/
│   │                              #   List16/IndexedNoNull8), не по игровой сущности —
│   │                              #   движок не знает слов «танк»/«бомба», только форму
│   ├── events.rs                  # CoreEvent — стандартный словарь событий для JS-меты
│   ├── config.rs                  # EngineConfig/EngineClientConfig + типы схемы снапшота
│   │                              #   (BlockKind — enum формы строки, не игровой сущности)
│   ├── physics.rs                 # тег статики карты (encode_map_object/is_map_object),
│   │                              #   округления, углы — игровые теги тел (игрок/снаряд)
│   │                              #   живут в games/tanks/core/src/body_tag.rs
│   ├── rng.rs                     # детерминированный PRNG (SplitMix64)
│   ├── nav/                       # обобщённые утилиты, смежные с ИИ (без слова «bot»)
│   │   ├── navigation.rs         # нав-сетка + граф + видимость (NavigationSystem)
│   │   ├── pathfinder.rs         # A*
│   │   └── spatial.rs            # пространственная сетка поиска целей
│   └── client/                    # обобщённые клиентские примитивы + оркестрация
│       ├── game.rs                # трейт GameClientDef + generic ClientState<G> —
│       │                          #   конвейер sample(), hot-буфер, очередь кадров;
│       │                          #   предикт/визуальный спавн — от игры через трейт
│       ├── unpack.rs              # декодер кадра v3 + JSON-формы
│       ├── interpolator.rs        # буфер снапшотов, seq, лерп (schema-driven)
│       └── raycast.rs             # DDA по тайлам + OBB slab-тест
└── (wasm ABI здесь отсутствует — см. games/tanks/core/src/lib.rs)

games/tanks/core/                 # vimp-tanks-core — cdylib+rlib, зависит от vimp-engine-core
├── Cargo.toml                    # + wasm-bindgen, path-зависимость на ../../../packages/engine/core
├── src/
│   ├── lib.rs                    # публичный ABI (wasm-bindgen): GameCore + ClientCore
│   ├── body_tag.rs                # BodyTag (user_data тел игрока/снаряда) — только игра;
│   │                              #   резервирует байт тега 1 под тег статики карты движка
│   ├── tanks.rs                   # TanksSim (impl GameSim), TanksGame, алиас GameState
│   ├── tank.rs                    # Tank — движение, башня, здоровье/боезапас/кулдауны
│   ├── motion.rs                  # общие формулы движения (mass-free): один код для
│   │                              #   авторитетного пути (импульсы Rapier) и реплики предикта
│   ├── bomb.rs                    # Bomb — тело снаряда (детонация в tanks.rs)
│   ├── config.rs                  # ModelConfig/WeaponConfig/TanksConfig/TanksClientConfig
│   ├── bots/
│   │   └── controller.rs         # BotBrain — ИИ бота (ввод генерируется внутри ядра)
│   └── client/                    # клиентский режим ядра: TanksClient (impl GameClientDef)
│       ├── mod.rs                 # TanksClient — связывает Predictor/ShotPredictor с
│       │                          #   движковым generic ClientState<TanksClient>
│       ├── predictor.rs           # реплика движения на motion.rs
│       └── shot.rs                # гейты, дубли, мир raycast
├── tests/
│   └── sim.rs                     # интеграционные сценарии симуляции (cargo test)
├── pkg-web/                       # сборка для браузера/Worker (генерируется, не в git)
└── pkg-node/                      # сборка для Node.js/Vitest (генерируется, не в git)
```

## Сборка

Требуется Rust-тулчейн (см. [getting-started.md](getting-started.md#rust-тулчейн-ядро-core)):

```bash
npm run core:build        # оба таргета (web + nodejs)
npm run core:build:web    # браузер/Worker → games/tanks/core/pkg-web/
npm run core:build:node   # Node.js (тесты) → games/tanks/core/pkg-node/
npm run core:test         # cargo test --workspace (оба crate)
```

`npm run build` включает `core:build:web`: WASM-бинарь нужен и Worker'у
хоста, и клиенту (один ассет в сборке Vite).

## ABI: команды, события, кадры

Экспортируются два класса: **`GameCore`** (авторитетная симуляция хоста) и
**`ClientCore`** (клиентский режим, см. ниже). Данные при инициализации
передаются JSON-строками формы `{engine: {...}, game: {...}}` — движковая
половина (`vimp_engine_core::config::EngineConfig`) обобщённая, игровая
(`TanksConfig`) парсится игровым crate. Конфиг `GameCore` собирает
`packages/engine/src/lib/coreConfig.js` (`buildCoreConfig()`), карты
экспортируются в JSON скриптом `npm run maps:export` (общий шаг с раздачей
карт без пересборки клиента).

Обвязка wasm-bindgen для обоих классов (механические 1:1-делегации в
generic `EngineSim<G>`/`ClientState<G>`) генерируется двумя макросами в
`packages/engine/core/src/abi.rs` — `export_game_core_abi!` и
`export_client_core_abi!` — единственным источником истины обязательного
набора методов, дрейф игрового crate от него исключён. Игровой crate зовёт
каждый макрос рядом со своими дополнительными методами (`try_fire`,
`set_model`, `sync_panel`, кастомные аргументы `spawn_actor`); `new`
(парсинг конфига) и не-`#[wasm_bindgen]` тестовые аксессоры остаются
рукописными.

```js
import { buildCoreConfig } from '../packages/engine/src/lib/coreConfig.js';
const { GameCore } = require('../games/tanks/core/pkg-node/vimp_tanks_core.js'); // nodejs-таргет

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // масштабирование внутри ядра
```

### Команды

| Метод | Назначение |
| --- | --- |
| `new GameCore(config_json)` | мир Rapier, оружие, модели, клавиши, реестр снапшот-ключей |
| `load_map(map_json)` | тела карты + нав-граф ботов; масштаб — `scale` карты или `mapScale` конфига |
| `map_info()` | JSON: `setId`, `step`, размеры, масштабированные `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | танк; эмитит `panelActive` + `panelSet(health)` |
| `remove_actor(id)` | удаление + null-маркер в следующем кадре |
| `reset_actor(id, teamId, x, y, angle°)` | респаун/смена команды (клавиши/газ сброшены, здоровье — нет) |
| `reset_all_vitals()` | здоровье/боезапас к дефолтам (новый раунд) |
| `spawn_scripted_actor(id, model, teamId, x, y, angle°)` / `remove_scripted_actor(id)` | танк + ИИ-контроллер внутри ядра |
| `apply_input(id, seq, action, name)` | ввод `'down'/'up'` + имя клавиши; `seq` подтверждается в player-блоке |
| `step(dt)` | фикс-шаги физики + ИИ ботов + пространственная сетка |
| `clear()` | полная очистка мира (смена карты) |
| `remove_players_and_shots()` | JSON-массив имён для очистки полотна клиентов |
| `players_data()` | JSON `{ model: { id: [x,y,angle,gun,vx,vy,engineLoad,condition,size,team] } }` для первого кадра (`FIRST_SHOT_DATA`); читает кеш, накопители не дренирует |
| `body_has_events()` | содержал ли последний `pack_body()` событийные блоки (трассеры/бомбы/взрывы/удаления); Worker хоста классифицирует канал WebRTC (события → meta, позиции → state) без изменения сигнатуры `pack_body` |
| `serialize_state()` / `deserialize_state(dump)` | дамп/восстановление симуляции для Worker Handoff; перед дампом дренировать `pack_body()` |

### События (`take_events()`)

JSON-массив; буфер очищается при чтении. Стандартный движковый словарь
(Wasm Host ABI, `packages/engine/core/src/events.rs`) — `GameCoreAdapter._drainEvents`
роутит его в мету сам, без игрового посредника: `panelSet`/`panelActive` →
Panel (`field` — ключ схемы панели игры, не завязан на конкретное оружие),
`death` → RoundManager.reportKill, `shake` → тряска камеры (per-user мета
кадра). `custom` — единственный тип вне словаря, с игровым смыслом:
дренируется адаптером как есть и уходит в `HostPlugin.onCoreEvent(data,
services)` (у танков не используется — `onCoreEvent` не задан):

```json
[
  { "type": "death", "victim": 2, "killer": 1 },
  { "type": "panelSet", "id": 2, "field": "health", "value": 60.0 },
  { "type": "panelSet", "id": 1, "field": "w1", "value": 199.0 },
  { "type": "panelActive", "id": 1, "field": "w2" },
  { "type": "shake", "id": 2, "intensity": 20, "duration": 200 }
]
```

Здоровье и боезапас — **источник истины в ядре**: панель на JS — проекция
этих событий.

### Кадры (v3, байт-в-байт с распаковкой)

- `pack_body()` — broadcast-тело один раз на отправляемый кадр; **дренирует**
  накопители событий снапшота (выстрелы/взрывы/удаления копятся в ядре между
  отправками — throttle частоты (`SnapshotThrottle`) остаётся на JS);
- `pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId)`
  — per-user кадр: заголовок + камера + player-блок (`playerId >= 0` и танк
  существует) + копия тела; возвращает длину;
- `frame_ptr()` — указатель для zero-copy чтения из браузера:
  `new Uint8Array(wasm.memory.buffer, ptr, len)` (память отдаёт `init()`
  web-таргета);
- `frame_bytes()` — копия кадра (nodejs-таргет память наружу не отдаёт).

Кадры распаковывает клиентское ядро (`games/tanks/core/src/client/mod.rs`
через `vimp_engine_core::client::unpack`) — pack и unpack живут в одном
движковом crate, расхождение раскладок исключено по построению;
формы закреплены round-trip-тестами (`#[cfg(test)]` в `unpack.rs` +
`tests/core/core.test.js` и `tests/core/clientCore.test.js`).

### Запросы состояния

`is_alive(id)`, `position_of(id)` (скруглено до 2 знаков), `last_input_seq(id)`,
`alive_players()` (плоский массив `[id, teamId, x, y, ...]`).

## ClientCore — клиентский режим ядра

Второй wasm-bindgen класс того же бинаря; живёт в главном потоке вкладки
клиента (у хоста-игрока — второй инстанс WASM рядом с Worker'ом).
`ClientCore` оборачивает
`vimp_engine_core::client::game::ClientState<TanksClient>`: движковый crate
владеет сетевым буфером (`Interpolator`), очередью событийных кадров и
записью hot-буфера (`ClientState<G>` в
`packages/engine/core/src/client/game.rs`); `TanksClient`
(`games/tanks/core/src/client/mod.rs`) реализует трейт `GameClientDef` —
оркестрацию `Predictor`/`ShotPredictor`, отслеживание своего танка и
predicted-хвост рендер-тика. `export_client_core_abi!` генерирует
движковый минимум методов ниже (кроме
`set_model`/`try_fire`/`cycle_weapon`/`sync_panel` — они остаются
рукописными в `games/tanks/core/src/lib.rs`, т.к. их форма игровая; внутри
трейта эти хуки носят нейтральные имена — `try_action`/`cycle_item`).
Форма трейта валидирована фикстурным вторым клиентом (`TestClient`, тесты в
`packages/engine/core/src/client/game.rs`) до появления настоящей второй
игры. Конфиг собирает [packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) из
секций `prediction`/`interpolation` CONFIG_DATA + бандлового реестра
`opcodes.js`; поле `timeStepMs` фиксирует единицы (мс — в отличие от
`CoreConfig.timeStep` в секундах).

| Метод | Назначение |
| --- | --- |
| `new ClientCore(config_json)` | модели/оружие/клавиши + реестр снапшот-ключей + interpolation |
| `push_frame(bytes, localNow)` | распаковка кадра, вставка в буфер по `seq` (+дедуп/опоздавшие), reconciliation предикта по player-блоку; `false` — кадр отброшен (порт/версия/повреждён) |
| `my_game_id()` / `offset()` | свой id из player-блока (−1) / EMA-оценка `serverTime − localNow` (NaN) |
| `sample(localNow)` | весь рендер-тик: выдача пересечённых кадров (фильтр дублей → JSON-очередь), интерполяция, шаг предикта; возвращает длину hot-буфера |
| `hot_ptr()` / `hot_values()` | zero-copy указатель на hot-буфер (web) / копия (nodejs) |
| `take_frames()` | событийные кадры JSON-строкой `[{game, camera}, …]` (форма `applyShot`); очередь очищается |
| `apply_input(action, key, localNow)` | ввод в историю предикта |
| `try_fire(localNow)` | локальный визуальный выстрел; гейты (кулдаун/патроны/pending-бомба/жив/активен) внутри; JSON спавна либо `undefined` |
| `cycle_weapon(back)` | локальный цикл смены оружия (авторитетное подтверждение — панелью) |
| `set_model(name)` / `set_active(bool)` / `set_map(json)` / `sync_panel(json)` / `reset()` | зеркала портов клиента: авторизация, KEYSET, MAP_DATA, PANEL_DATA, CLEAR |
| `decode_frame(bytes)` | чистая распаковка v3 → JSON формы кадра (тесты/харнесс); `'null'` при чужой версии |

**Раскладка hot-буфера** (Float32, плоский, переиспользуемый):
`[0]` — флаги (`HOT_FLAGS` в `opcodes.js`: game/camera/predicted/frames),
`[1..2]` — камера x/y (уже разрешённая ядром: предсказанная позиция либо
интерполированная), `[3]` — N танков, далее N×12
(`keyId, gameId, x, y, angle, gun, vx, vy, engineLoad, condition, size,
teamId`), затем M динамики × 5 (`keyId, index, x, y, angle`); последней —
predicted-запись своего танка. Этот хвост движок пишет дословно из
`RenderOverlay.tail`, которую собирает `GameClientDef::render_overlay`, —
движку известны только камера (`RenderOverlay.camera`) и флаг наличия, не
раскладка полей хвоста (`TanksClient::render_overlay` собирает те же 12
значений тем же порядком — байты не изменились после распила на трейт).
`keyId` — числовые id из снапшот-схемы игры
(`games/tanks/src/config/snapshot.js`); клиентский JS читает записи
generic-разбором по той же схеме (ширина записи = 2 служебных поля +
число `fields` ключа).

**motion.rs** — общие mass-free формулы тика движения (башня, дроссель,
боковое сцепление, тяга/торможение, нагрузка двигателя, поворот):
авторитетный путь (`Tank::update`) домножает их на массу/инерцию для
импульсов Rapier, реплика предикта интегрирует вручную (позиция скоростью
ДО демпфирования → `v *= 1/(1+dt·d)` — эмпирический порядок Rapier).
Реплика не может разойтись с авторитетным путём по формулам; паритет
интеграции закрепляют cargo-тесты `client::predictor::parity` (6 сценариев).
⚠️ **Любая правка движения в ядре или `models.js` — обязательный прогон
`npm run core:test`.**

## Детерминизм

- `rapier2d` собирается с `enhanced-determinism` (бит-в-бит на всех
  платформах при одинаковом вводе);
- вся случайность (разброс оружия, решения ботов) — через встроенный
  SplitMix64 PRNG с сидом из конфига (`seed`), без `Math.random`;
- handoff-дамп восстанавливает симуляцию бит-в-бит (закреплено тестами
  `state_dump_restores_identical_simulation` в Rust и JS).

## Тесты

| Слой | Где | Что покрывает |
| --- | --- | --- |
| Rust unit | `packages/engine/core/src/*` + `games/tanks/core/src/*` (`#[cfg(test)]`) | PRNG, BodyTag, раскладка кадра, нав-сетка, A*, пространственная сетка; клиентский модуль: round-trip unpack, интерполятор (seq/дедуп/late/лерп), предикт (replay/visualError/freeze), выстрелы (гейты/дубли/RTT), raycast, hot-буфер |
| Паритет реплики | `games/tanks/core/src/client/predictor.rs` (`mod parity`) | реплика движения предикта против Rapier-мира (6 сценариев) — **обязателен к прогону при любой правке движения в ядре или `models.js`** |
| Rust интеграция | `games/tanks/core/tests/sim.rs` | сценарии симуляции: езда, стены, hitscan-килл, friendly fire, бомба, смена оружия, боты (патруль и бой), очистки, handoff |
| JS↔WASM харнесс | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | ABI на реальном конфиге/картах, round-trip кадров через `decode_frame`; e2e клиентского ядра: интерполяция, реордер seq, предикт (сходимость с ядром на реальном конфиге), try_fire и подавление дублей |

Тесты `tests/core/` входят в `npm test` и **пропускаются**, если
`games/tanks/core/pkg-node/` не собран (JS-разработка возможна без Rust-тулчейна).
CI собирает ядро и гоняет оба слоя.

## Известные технические особенности

- **Свежесозданное тело попадает в broad-phase на первом шаге мира**: выстрел
  в том же тике, что и спавн, цель «не видит» (в тестах — прогрев одним
  `step`). На реальных сценариях (спавн в начале раунда) не проявляется.
- `remove_actor` сам ставит null-маркер удаления в следующий кадр.

---

[← Предыдущая: Браузерный хост](host.md) · [Следующая: Клиентские модули →](client.md)
