# Rust-ядро симуляции (core/)

Единое ядро симуляции: физика, танки, оружие, боты и упаковка бинарных
снапшотов написаны на Rust и компилируются в WASM. Ядро работает у
браузерного хоста (`GameCore`, [host.md](host.md)) **и у каждого клиента**
(`ClientCore` — клиентская математика: интерполяция, предикт, визуальный
спавн снарядов, распаковка кадров).

**Граница ядра — симуляция, а не мета**: чат, голосования,
статистика, панель, оркестрация раундов, реестр участников и auth остаются
на JS. Мета управляет ядром командами и питается его событиями.

## Структура

```
core/
├── Cargo.toml            # rapier2d (enhanced-determinism, serde), wasm-bindgen
├── src/
│   ├── lib.rs            # публичный ABI (wasm-bindgen): GameCore + ClientCore
│   ├── game.rs           # GameState — тик, урон, детонация, hitscan
│   ├── tank.rs           # Tank — движение, башня,
│   │                     #   здоровье/боезапас/кулдауны — в ядре, не в панели
│   ├── motion.rs         # общие формулы движения (mass-free): один код для
│   │                     #   авторитетного пути (импульсы Rapier) и реплики предикта
│   ├── bomb.rs            # Bomb — тело снаряда (детонация в game.rs)
│   ├── map.rs             # GameMap — масштабирование карт
│   ├── snapshot.rs        # SnapshotPacker — упаковка бинарного кадра v3
│   ├── events.rs          # CoreEvent — события для JS-меты
│   ├── config.rs          # serde-структуры init-конфигов (CoreConfig + ClientConfig)
│   ├── physics.rs         # BodyTag (user_data тел), округления, углы
│   ├── rng.rs             # детерминированный PRNG (SplitMix64)
│   ├── bots/              # ИИ ботов
│   │   ├── controller.rs  # BotBrain — ИИ бота (ввод генерируется внутри ядра)
│   │   ├── navigation.rs  # нав-сетка + граф (NavigationSystem)
│   │   ├── pathfinder.rs  # A*
│   │   └── spatial.rs     # пространственная сетка поиска целей
│   └── client/            # клиентский режим ядра
│       ├── mod.rs         # ClientState — конвейер sample(), hot-буфер
│       ├── unpack.rs      # декодер кадра v3 + JSON-формы
│       ├── interpolator.rs # буфер снапшотов, seq, лерп
│       ├── predictor.rs   # реплика движения на motion.rs
│       ├── shot.rs        # гейты, дубли, мир raycast
│       └── raycast.rs     # DDA по тайлам + OBB slab-тест
├── tests/
│   └── sim.rs            # интеграционные сценарии симуляции (cargo test)
├── pkg-web/              # сборка для браузера/Worker (генерируется, не в git)
└── pkg-node/             # сборка для Node.js/Vitest (генерируется, не в git)
```

## Сборка

Требуется Rust-тулчейн (см. [getting-started.md](getting-started.md#rust-тулчейн-ядро-core)):

```bash
npm run core:build        # оба таргета (web + nodejs)
npm run core:build:web    # браузер/Worker → core/pkg-web/
npm run core:build:node   # Node.js (тесты) → core/pkg-node/
npm run core:test         # Rust-тесты ядра (cargo test)
```

`npm run build` включает `core:build:web`: WASM-бинарь нужен и Worker'у
хоста, и клиенту (один ассет в сборке Vite).

## ABI: команды, события, кадры

Экспортируются два класса: **`GameCore`** (авторитетная симуляция хоста) и
**`ClientCore`** (клиентский режим, см. ниже). Данные при инициализации
передаются JSON-строками; конфиг `GameCore` собирает `packages/engine/src/lib/coreConfig.js`
(`buildCoreConfig()`), карты экспортируются в JSON скриптом
`npm run maps:export` (общий шаг с раздачей карт без пересборки клиента).

```js
import { buildCoreConfig } from '../packages/engine/src/lib/coreConfig.js';
const { GameCore } = require('../core/pkg-node/vimp_core.js'); // nodejs-таргет

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // масштабирование внутри ядра
```

### Команды

| Метод | Назначение |
| --- | --- |
| `new GameCore(config_json)` | мир Rapier, оружие, модели, клавиши, реестр снапшот-ключей |
| `load_map(map_json)` | тела карты + нав-граф ботов; масштаб — `scale` карты или `mapScale` конфига |
| `map_info()` | JSON: `setId`, `step`, размеры, масштабированные `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | танк; эмитит `activeWeapon` + `health` |
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

JSON-массив; буфер очищается при чтении. Топливо для RoundManager
(`kill`), Panel (`health`/`ammo`/`activeWeapon`), кадровой меты (`shake`):

```json
[
  { "type": "kill", "victim": 2, "killer": 1 },
  { "type": "health", "id": 2, "value": 60.0 },
  { "type": "ammo", "id": 1, "weapon": "w1", "value": 199.0 },
  { "type": "activeWeapon", "id": 1, "weapon": "w2" },
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

Кадры распаковывает клиентское ядро (`core/src/client/unpack.rs`) — pack и
unpack живут в одном crate, расхождение раскладок исключено по построению;
формы закреплены round-trip-тестами (`#[cfg(test)]` в `unpack.rs` +
`tests/core/core.test.js` и `tests/core/clientCore.test.js`).

### Запросы состояния

`is_alive(id)`, `position_of(id)` (скруглено до 2 знаков), `last_input_seq(id)`,
`alive_players()` (плоский массив `[id, teamId, x, y, ...]`).

## ClientCore — клиентский режим ядра

Второй wasm-bindgen класс того же бинаря; живёт в главном потоке вкладки
клиента (у хоста-игрока — второй инстанс WASM рядом с Worker'ом). Конфиг
собирает [packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) из
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
predicted-запись своего танка (12, тем же форматом — перекрывает
интерполированную). `keyId` — числовые id из `SNAPSHOT_KEYS`.

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
| Rust unit | `core/src/*` (`#[cfg(test)]`) | PRNG, BodyTag, раскладка кадра, нав-сетка, A*, пространственная сетка; клиентский модуль: round-trip unpack, интерполятор (seq/дедуп/late/лерп), предикт (replay/visualError/freeze), выстрелы (гейты/дубли/RTT), raycast, hot-буфер |
| Паритет реплики | `core/src/client/predictor.rs` (`mod parity`) | реплика движения предикта против Rapier-мира (6 сценариев) — **обязателен к прогону при любой правке движения в ядре или `models.js`** |
| Rust интеграция | `core/tests/sim.rs` | сценарии симуляции: езда, стены, hitscan-килл, friendly fire, бомба, смена оружия, боты (патруль и бой), очистки, handoff |
| JS↔WASM харнесс | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | ABI на реальном конфиге/картах, round-trip кадров через `decode_frame`; e2e клиентского ядра: интерполяция, реордер seq, предикт (сходимость с ядром на реальном конфиге), try_fire и подавление дублей |

Тесты `tests/core/` входят в `npm test` и **пропускаются**, если
`core/pkg-node/` не собран (JS-разработка возможна без Rust-тулчейна).
CI собирает ядро и гоняет оба слоя.

## Известные технические особенности

- **Свежесозданное тело попадает в broad-phase на первом шаге мира**: выстрел
  в том же тике, что и спавн, цель «не видит» (в тестах — прогрев одним
  `step`). На реальных сценариях (спавн в начале раунда) не проявляется.
- `remove_actor` сам ставит null-маркер удаления в следующий кадр.

---

[← Предыдущая: Браузерный хост](host.md) · [Следующая: Клиентские модули →](client.md)
