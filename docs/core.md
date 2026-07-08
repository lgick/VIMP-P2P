# Rust-ядро симуляции (core/)

Единое ядро симуляции P2P-миграции (Этап 2 [P2P-PLAN.md](../P2P-PLAN.md)):
физика, танки, оружие, боты и упаковка бинарных снапшотов перенесены на Rust
и компилируются в WASM. Ядро будет работать и у браузерного хоста (Этап 4),
и на клиенте (финальный срез 2.6); до этого текущий авторитетный сервер
(`src/server/`) живёт параллельно и служит эталоном поведения.

**Граница ядра — симуляция, а не мета** (рамка плана): чат, голосования,
статистика, панель, оркестрация раундов, реестр участников и auth остаются
на JS. Мета управляет ядром командами и питается его событиями.

## Структура

```
core/
├── Cargo.toml            # rapier2d (enhanced-determinism, serde), wasm-bindgen
├── src/
│   ├── lib.rs            # публичный ABI (wasm-bindgen): GameCore
│   ├── game.rs           # GameState — порт Game.js: тик, урон, детонация, hitscan
│   ├── tank.rs           # Tank — порт Tank.js + BaseModel.js (движение, башня,
│   │                     #   здоровье/боезапас/кулдауны — в ядре, не в панели)
│   ├── bomb.rs           # Bomb — тело снаряда (детонация в game.rs)
│   ├── map.rs            # GameMap — порт Map.js + масштабирование карт
│   ├── snapshot.rs       # SnapshotPacker — бинарный кадр v3 (байт-в-байт
│   │                     #   с src/lib/snapshotCodec.js)
│   ├── events.rs         # CoreEvent — события для JS-меты
│   ├── config.rs         # serde-структуры init-конфига
│   ├── physics.rs        # BodyTag (user_data тел), округления, углы
│   ├── rng.rs            # детерминированный PRNG (SplitMix64)
│   └── bots/             # порт src/server/modules/bots/
│       ├── controller.rs # BotBrain — ИИ бота (ввод генерируется внутри ядра)
│       ├── navigation.rs # нав-сетка + граф (NavigationSystem)
│       ├── pathfinder.rs # A*
│       └── spatial.rs    # пространственная сетка поиска целей
├── tests/sim.rs          # интеграционные сценарии симуляции (cargo test)
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

В `npm run build` сборка ядра пока не входит: рантайм его не потребляет до
Этапа 4 (браузерный хост). На вехе Этапа 4 `core:build:web` включается в
клиентскую сборку.

## ABI: команды, события, кадры

Единственный экспортируемый класс — `GameCore`. Данные при инициализации
передаются JSON-строками; конфиг собирает `src/lib/coreConfig.js`
(`buildCoreConfig()`), карты экспортируются в JSON скриптом
`npm run maps:export` (общий шаг с Этапом 5.1 — раздача карт без пересборки).

```js
import { buildCoreConfig } from '../src/lib/coreConfig.js';
const { GameCore } = require('../core/pkg-node/vimp_core.js'); // nodejs-таргет

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // масштабирование внутри ядра
```

### Команды

| Метод | Аналог в src/server | Назначение |
| --- | --- | --- |
| `new GameCore(config_json)` | конструктор `Game` | мир Rapier, оружие, модели, клавиши, реестр снапшот-ключей |
| `load_map(map_json)` | `Game.createMap` + `Bots.createMap` | тела карты + нав-граф ботов; масштаб — `scale` карты или `mapScale` конфига |
| `map_info()` | `scaledMapData` | JSON: `setId`, `step`, размеры, масштабированные `respawns` |
| `spawn_tank(id, model, teamId, x, y, angle°)` | `Game.createPlayer` | танк; эмитит `activeWeapon` + `health` |
| `remove_tank(id)` | `Game.removePlayer` + `removedPlayersList` | удаление + null-маркер в следующем кадре |
| `reset_tank(id, teamId, x, y, angle°)` | `Game.changePlayerData` | респаун/смена команды (клавиши/газ сброшены, здоровье — нет) |
| `reset_all_vitals()` | `Panel.reset` | здоровье/боезапас к дефолтам (новый раунд) |
| `add_bot(id, model, teamId, x, y, angle°)` / `remove_bot(id)` | `BotManager.createBots/_removeBotById` | танк + ИИ-контроллер внутри ядра |
| `apply_input(id, seq, action, name)` | `Game.updateKeys` | ввод `'down'/'up'` + имя клавиши; `seq` подтверждается в player-блоке |
| `step(dt)` | `Game.updateData` + `Bots.updateBots` | фикс-шаги физики + ИИ ботов + пространственная сетка |
| `clear()` | `Game.clear` | полная очистка мира (смена карты) |
| `remove_players_and_shots()` | `Game.removePlayersAndShots` | JSON-массив имён для очистки полотна клиентов |
| `players_data()` | `Game.getPlayersData` | JSON `{ model: { id: [x,y,angle,gun,vx,vy,engineLoad,condition,size,team] } }` для первого кадра (`FIRST_SHOT_DATA`); читает кеш, накопители не дренирует |
| `body_has_events()` | — | содержал ли последний `pack_body()` событийные блоки (трассеры/бомбы/взрывы/удаления); Worker хоста классифицирует канал WebRTC (события → meta, позиции → state) без изменения сигнатуры `pack_body` |
| `serialize_state()` / `deserialize_state(dump)` | — (Spike B) | дамп/восстановление симуляции для Worker Handoff (Этап 5.2); перед дампом дренировать `pack_body()` |

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

Здоровье и боезапас — **источник истины в ядре** (в текущем сервере ими
владеет `Panel`): панель на JS становится проекцией этих событий.

### Кадры (v3, байт-в-байт с JS-кодеком)

- `pack_body()` — broadcast-тело один раз на отправляемый кадр; **дренирует**
  накопители событий снапшота (выстрелы/взрывы/удаления копятся в ядре между
  отправками — throttle частоты, как у `SnapshotManager`, остаётся на JS);
- `pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId)`
  — per-user кадр: заголовок + камера + player-блок (`playerId >= 0` и танк
  существует) + копия тела; возвращает длину;
- `frame_ptr()` — указатель для zero-copy чтения из браузера:
  `new Uint8Array(wasm.memory.buffer, ptr, len)` (память отдаёт `init()`
  web-таргета);
- `frame_bytes()` — копия кадра (nodejs-таргет память наружу не отдаёт).

Клиент распаковывает кадры существующим `unpackFrame`
(`src/lib/snapshotCodec.js`) без изменений — совместимость закреплена
round-trip-тестами `tests/core/core.test.js`.

### Запросы состояния

`is_alive(id)`, `position_of(id)` (скруглено до 2 знаков, как
`Game.getPosition`), `last_input_seq(id)`, `alive_players()` (плоский массив
`[id, teamId, x, y, ...]`).

## Детерминизм

- `rapier2d` собирается с `enhanced-determinism` (Spike C: бит-в-бит на всех
  платформах при одинаковом вводе);
- вся случайность (разброс оружия, решения ботов) — через встроенный
  SplitMix64 PRNG с сидом из конфига (`seed`), без `Math.random`;
- handoff-дамп восстанавливает симуляцию бит-в-бит (закреплено тестами
  `state_dump_restores_identical_simulation` в Rust и JS).

## Тесты

| Слой | Где | Что покрывает |
| --- | --- | --- |
| Rust unit | `core/src/*` (`#[cfg(test)]`) | PRNG, BodyTag, раскладка кадра, нав-сетка, A*, пространственная сетка |
| Rust интеграция | `core/tests/sim.rs` | сценарии симуляции: езда, стены, hitscan-килл, friendly fire, бомба, смена оружия, боты (патруль и бой), очистки, handoff |
| JS↔WASM харнесс | `tests/core/core.test.js` | ABI на реальном конфиге/картах + round-trip кадров через `unpackFrame` |
| Паритет с сервером | `tests/core/serverParity.test.js` | траектории ядра против реального `Tank` в Rapier-compat (эталон — текущий сервер) |
| Паритет реплики | `tests/core/predictorParity.test.js` | `TankPredictor` против ядра — переориентация `TankPredictorParity` (п. 2.5); оригинал против Rapier-compat живёт до демонтажа сервера |

Тесты `tests/core/` входят в `npm test` и **пропускаются**, если
`core/pkg-node/` не собран (JS-разработка возможна без Rust-тулчейна).
CI собирает ядро и гоняет оба слоя.

## Известные отличия от JS-версии (зафиксированы осознанно)

- **Rapier 0.34 (нативный) вместо compat 0.19**: траектории совпадают в
  допуске паритет-тестов (0.5 юнита на 120 тиков), но не бит-в-бит с текущим
  сервером; после жёсткой замены эталоном становится само ядро.
- **Здоровье/боезапас в ядре**, а не в панели (см. события) — панель и
  боты берут значения из ядра.
- **Свежесозданное тело попадает в broad-phase на первом шаге мира**: выстрел
  в том же тике, что и спавн, цель «не видит» (в тестах — прогрев одним
  `step`). На реальных сценариях (спавн в начале раунда) не проявляется.
- `remove_tank` сам ставит null-маркер удаления в следующий кадр (в текущем
  сервере это делает `RoundManager.removedPlayersList` + `VIMP._onShotTick`).
